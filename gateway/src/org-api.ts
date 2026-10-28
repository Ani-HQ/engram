import { failureCode } from "./diagnostics";
import { parseAttribution, recordSiteEvent } from "./site-analytics";
import { config } from "./config";
import type postgres from "postgres";
import { agentOnboardingChecks, handleConnectionsApi } from "./connections";
import { parseReportedSource } from "./agent-source";
import { sql } from "./db";
import {
  authenticateSecret,
  createLoginInvite,
  createSession,
  createSignupInvite,
  issueToken,
  listTokens,
  revokeToken,
  setTokenWrite,
  setTokenSource,
  type TokenRecord,
} from "./auth";
import {
  acceptInvite,
  createInvite,
  findMemberByEmail,
  getOrg,
  listInvites,
  listMembers,
  removeMember,
  cancelInvites,
  listMemberships,
  mcpUrlFrom,
  memberInOrg,
  normalizeEmail,
  onboardingStep,
  orgHasAgentToken,
  orgHasRecordedPage,
  parseWorkspaceName,
  publicUrlFrom,
  renameWorkspace,
  updatePolicies,
  type Org,
} from "./orgs";
import {
  canManageOrg,
  canWrite,
  DEFAULT_POLICIES,
  isHuman,
  normalizeToken,
  parsePolicies,
  parseShareLevel,
} from "./policies";
import { serializeSessionCookie } from "./cookies";
import { loginLinkResponse, sendMail } from "./mail";
import { renderEmail } from "./mail-templates";
import { handleJevApi } from "./jev";
import { handleDeviceConsoleApi, isDeviceConsolePath } from "./device-auth";
import { getWorkspaceAccessSummary } from "./billing";
import { oauthEnabled } from "./oauth";
import { canManageSignupInvites, createSignupVerification, issueSignupInvite, listSignupInvites, revokeSignupInvite, signupInviteLink, SignupInviteError } from "./signup-invites";
import { triggerProvisioning } from "./provisioning-trigger";
import { handleContextSharingApi } from "./context-sharing";
import {
  getShareRule,
  createShareRule,
  updateShareRule,
  revokeShareRule,
  listShareRules,
  previewShare,
  publicRule,
  shareOne,
  unshareTrail,
  parseShareMatch,
  assertCanShare,
} from "./sharing";
import {
  ingestTrail,
  listTrails,
  listRepos,
  getTrail,
  parseTrailIngest,
  publicTrail,
} from "./trails";

export function publicOrg(org: Org) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    kind: org.kind,
    policies: org.policies,
    provisioningStatus: org.provisioningStatus ?? "ready",
    provisioningError: org.provisioningError ?? null,
  };
}

export function publicActor(token: TokenRecord, org: Org, extra: Record<string, unknown> = {}) {
  const actor = normalizeToken(token);
  return {
    name: actor.name,
    role: actor.role,
    canWrite: actor.canWrite,
    email: actor.email,
    org: publicOrg(org),
    orgs: extra.orgs ?? [],
    ...extra,
  };
}

export async function sessionActor(token: TokenRecord, org: Org, extra: Record<string, unknown> = {}) {
  const orgs = isConsolePerson(token) && token.email
    ? (await listMemberships(token.email)).map(item => ({
      id: item.id,
      name: item.name,
      slug: item.slug,
      kind: item.kind,
      role: item.role,
    }))
    : [];
  const capabilities = { manageSignupInvites: await canManageSignupInvites(token) };
  const access = isConsolePerson(token) ? await getWorkspaceAccessSummary(token) : undefined;
  return publicActor(token, org, { orgs, ...extra, capabilities, access });
}

export async function onboardingState(org: Org, db: postgres.Sql = sql) {
  if (org.provisioningStatus && org.provisioningStatus !== "ready") return {
    step: "provisioning", provisioning: true, hasToken: false, hasPage: false,
    checks: { agentConnected: false, memorySaved: false, memoryRecalled: false, taskReported: false },
  };
  const [hasToken, hasPage, checks] = await Promise.all([orgHasAgentToken(org.id, db), orgHasRecordedPage(org.id, db), agentOnboardingChecks(org.id, db)]);
  const step = onboardingStep({ checks });
  return { step, provisioning: false, hasToken, hasPage, checks };
}

async function jsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function text(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function handlePublicOrgApi(req: Request, url: URL): Promise<Response | null> {
  if (req.method === "POST" && url.pathname === "/api/orgs") return postOrg(req);
  if (req.method === "POST" && url.pathname === "/api/login/email") return postLoginEmail(req);
  if (req.method === "POST" && url.pathname === "/api/invites/accept") return postAcceptInvite(req);
  return null;
}

export async function handleOrgApi(
  req: Request,
  url: URL,
  token: TokenRecord,
  org: Org,
): Promise<Response | null> {
  if (token.orgId !== org.id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (url.pathname === "/api/sharing" || url.pathname.startsWith("/api/sharing/")) return handleContextSharingApi(req, token, org);
  if (url.pathname === "/api/jev") return handleJevApi(req, token);
  if (isDeviceConsolePath(url.pathname)) return handleDeviceConsoleApi(req, url, token, org);
  if (url.pathname === "/api/workspace") {
    return req.method === "PUT" ? putWorkspace(req, token, org) : Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "PUT" } });
  }
  if (url.pathname === "/api/admin/signup-invites" || url.pathname.startsWith("/api/admin/signup-invites/")) {
    return handleSignupInviteAdmin(req, url, token);
  }
  if (req.method === "GET" && url.pathname === "/api/onboarding") {
    return Response.json(await onboardingState(org));
  }
  if (url.pathname === "/api/connections") return handleConnectionsApi(req, token);
  if (req.method === "GET" && url.pathname === "/api/tokens") {
    if (!isConsolePerson(token)) return forbidden();
    return Response.json({ tokens: await listTokens(org.id), mcp: mcpUrlFrom(req) });
  }
  if (req.method === "POST" && url.pathname === "/api/tokens") return postToken(req, token, org);
  if (req.method === "POST" && url.pathname === "/api/tokens/revoke") return postRevokeToken(req, token, org);
  if (req.method === "POST" && url.pathname === "/api/tokens/write") return postTokenWrite(req, token, org);
  if (req.method === "POST" && url.pathname === "/api/tokens/source") return postTokenSource(req, token, org);
  if (req.method === "GET" && url.pathname === "/api/policies") {
    return Response.json({ policies: org.policies });
  }
  if (req.method === "PUT" && url.pathname === "/api/policies") return putPolicies(req, token, org);
  if (req.method === "GET" && url.pathname === "/api/members") {
    if (!isConsolePerson(token)) return forbidden();
    return Response.json({
      members: await listMembers(org.id),
      invites: await listInvites(org.id),
    });
  }
  if (req.method === "DELETE" && url.pathname === "/api/members") return deleteMember(req, token, org);
  if (req.method === "POST" && url.pathname === "/api/invites") return postInvite(req, token, org);
  if (req.method === "DELETE" && url.pathname === "/api/invites") return deleteInvites(req, token, org);
  if (req.method === "GET" && url.pathname === "/api/wiring") {
    return Response.json(wiringPayload(req, null));
  }
  if (req.method === "GET" && url.pathname === "/api/orgs") {
    const orgs = isConsolePerson(token) && token.email
      ? (await listMemberships(token.email)).map(item => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        kind: item.kind,
        role: item.role,
      }))
      : [];
    return Response.json({ orgs });
  }
  if (req.method === "POST" && url.pathname === "/api/session/switch") {
    return postSwitchOrg(req, token, org);
  }
  if (req.method === "GET" && url.pathname === "/api/trails") return getTrails(url, org);
  if (req.method === "GET" && url.pathname.startsWith("/api/trails/")) {
    return getTrailDetail(url, org);
  }
  if (req.method === "POST" && url.pathname === "/api/trails") {
    return postTrail(req, token, org);
  }
  if (req.method === "POST" && url.pathname.match(/^\/api\/trails\/[^/]+\/share$/)) {
    return postShareTrail(req, url, token, org);
  }
  if (req.method === "POST" && url.pathname.match(/^\/api\/trails\/[^/]+\/unshare$/)) {
    return postUnshareTrail(req, url, token, org);
  }
  if (req.method === "GET" && url.pathname === "/api/share/rules") return getShareRules(token, org);
  if (req.method === "POST" && url.pathname === "/api/share/rules") return postShareRule(req, token, org);
  if (req.method === "POST" && url.pathname === "/api/share/preview") return postSharePreview(req, org);
  if (req.method === "PATCH" && url.pathname.match(/^\/api\/share\/rules\/\d+$/)) {
    return patchShareRule(req, url, token, org);
  }
  if (req.method === "POST" && url.pathname.match(/^\/api\/share\/rules\/\d+\/pause$/)) {
    return pauseShareRule(url, token, org, true);
  }
  if (req.method === "POST" && url.pathname.match(/^\/api\/share\/rules\/\d+\/resume$/)) {
    return pauseShareRule(url, token, org, false);
  }
  if (req.method === "DELETE" && url.pathname.match(/^\/api\/share\/rules\/\d+$/)) {
    return deleteShareRule(url, token, org);
  }
  return null;
}

async function postOrg(req: Request): Promise<Response> {
  const body = await jsonObject(req);
  const email = normalizeEmail(text(body, "email") ?? "");
  if (!email) return Response.json({ error: "bad request" }, { status: 400 });
  const name = text(body, "name") ?? `${email.split("@")[0]}'s memory`;
  const inviteCode = text(body, "inviteCode");
  if (name.length > 100) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const existing = await findMemberByEmail(email);
    if (!existing && config.signupMode === "invite-only" && !inviteCode) {
      return Response.json({ error: "An invitation code is required to create a workspace.", code: "signup_invite_required" }, { status: 403 });
    }
    const invite = inviteCode ? await createSignupVerification(email, name, inviteCode, publicUrlFrom(req)) : existing
      ? await createLoginInvite(email, publicUrlFrom(req))
      : await createSignupInvite(email, name, publicUrlFrom(req));
    if (!invite) return Response.json({ error: "could not create org" }, { status: 400 });
    const delivery = await sendMail({
      to: email,
      ...renderEmail({ template: inviteCode || !existing ? "verify-signup" : "login", url: invite.url, orgName: name }),
    });
    const result = loginLinkResponse(delivery, invite.url);
    // Count a new sign-up and its first-touch campaign; never the email.
    if (!existing && result.status < 300) await recordSiteEvent({ name: "signup_submitted", path: "/app", ...parseAttribution(body?.attribution) }, req);
    return Response.json(result.body, { status: result.status });
  } catch (e) {
    if (e instanceof SignupInviteError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("[org] create failed:", failureCode(e));
    return Response.json({ error: "could not create org" }, { status: 400 });
  }
}

async function handleSignupInviteAdmin(req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
  try {
    const link = url.pathname.match(/^\/api\/admin\/signup-invites\/([^/]+)\/link$/);
    if (link) {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
      if (req.headers.get("x-engram-console") !== "1") return json({ error: "forbidden" }, 403);
      const pin = req.headers.get("x-engram-workspace");
      if (!pin) return json({ error: "Select a workspace and try again." }, 400);
      if (pin !== String(token.orgId)) return json({ error: "The selected workspace changed. Please try again." }, 409);
      if (!await canManageSignupInvites(token)) throw new SignupInviteError("Only the signup operator can manage invitation codes.", 403, "forbidden");
      const body = await jsonObject(req);
      if (!body || Object.keys(body).length) return json({ error: "Link copying does not accept invitation or account overrides." }, 400);
      return json(await signupInviteLink(token, link[1], publicUrlFrom(req)));
    }
    if (req.method === "GET" && url.pathname === "/api/admin/signup-invites") return Response.json(await listSignupInvites(token));
    const body = await jsonObject(req);
    if (!body) return Response.json({ error: "Provide a JSON object." }, { status: 400 });
    if (req.method === "POST" && url.pathname === "/api/admin/signup-invites") {
      if (Object.keys(body).some(key => !["email", "expiresAt"].includes(key))) return Response.json({ error: "Only email and invitation expiry may be supplied." }, { status: 400 });
      if (body.email !== undefined && body.email !== null && typeof body.email !== "string") return Response.json({ error: "Provide an email or leave it blank for a single-use invitation link." }, { status: 400 });
      const result = await issueSignupInvite(token, text(body, "email"), body.expiresAt);
      return Response.json({ ...result, inviteUrl: `${publicUrlFrom(req).replace(/\/$/, "")}/app#invite=${result.inviteCode}` }, { status: 201 });
    }
    const revoke = url.pathname.match(/^\/api\/admin\/signup-invites\/([a-f0-9-]+)\/revoke$/);
    if (req.method === "POST" && revoke) {
      if (Object.keys(body).length) return Response.json({ error: "Revocation does not accept account or workspace overrides." }, { status: 400 });
      const result = await revokeSignupInvite(token, revoke[1]);
      if (result.revocationPending) await triggerProvisioning({ force: true });
      return Response.json(result);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof SignupInviteError) return json({ error: error.message, code: error.code }, error.status);
    console.error("[signup-invites] request failed:", failureCode(error));
    return json({ error: "Signup invitations are temporarily unavailable.", code: "signup_unavailable" }, 503);
  }
}

async function postLoginEmail(req: Request): Promise<Response> {
  const body = await jsonObject(req);
  const email = normalizeEmail(text(body, "email") ?? "");
  if (!email) return Response.json({ error: "bad request" }, { status: 400 });
  const invite = await createLoginInvite(email, publicUrlFrom(req));
  if (!invite) return Response.json({ error: "not found" }, { status: 404 });
  const delivery = await sendMail({
    to: email,
    ...renderEmail({ template: "login", url: invite.url }),
  });
  const result = loginLinkResponse(delivery, invite.url);
  return Response.json(result.body, { status: result.status });
}

async function postAcceptInvite(req: Request): Promise<Response> {
  const body = await jsonObject(req);
  const raw = text(body, "token");
  if (!raw) return Response.json({ error: "bad request" }, { status: 400 });
  let accepted;
  try { accepted = await acceptInvite(raw); }
  catch (error) {
    if (error instanceof SignupInviteError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
  if (!accepted) return Response.json({ error: "unauthorized" }, { status: 401 });
  const payload = await sessionActor(normalizeToken({
    name: accepted.member.email,
    orgId: accepted.org.id,
    role: accepted.member.role,
    kind: "session",
    email: accepted.member.email,
  }), accepted.org, { onboarding: await onboardingState(accepted.org) });
  const session = await createSession({
    orgId: accepted.org.id,
    name: accepted.member.email,
    role: accepted.member.role,
    email: accepted.member.email,
  });
  return Response.json(payload, {
    status: accepted.org.provisioningStatus === "ready" ? 200 : 202,
    headers: { "Set-Cookie": serializeSessionCookie(session) },
  });
}

async function postToken(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!isConsolePerson(token)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await jsonObject(req);
  const name = text(body, "name");
  if (!name) return Response.json({ error: "bad request" }, { status: 400 });
  const canWrite = body?.canWrite !== false;
  let source: ReturnType<typeof parseReportedSource>;
  try {
    source = parseReportedSource(body?.harness, body?.sourceLabel);
    if (source.sourceLabel && !source.harness) throw new Error("harness is required for a source label");
  } catch {
    return Response.json({ error: "Invalid connection source" }, { status: 400 });
  }
  try {
    // Console issuance always belongs to the current person. Only the direct
    // operator CLI may deliberately create an unbound service credential.
    if (!token.email) return forbidden();
    const raw = await issueToken(org.id, name, canWrite, token.email, sql, source.harness ? { harness: source.harness, label: source.sourceLabel } : undefined);
    return Response.json({
      name,
      canWrite,
      harness: source.harness,
      sourceLabel: source.sourceLabel,
      token: raw,
      ...wiringPayload(req, raw),
    });
  } catch (e) {
    console.error("[org] token issue failed:", failureCode(e));
    return Response.json({ error: "could not mint token" }, { status: 400 });
  }
}

async function postTokenSource(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) || !isConsolePerson(token)) return forbidden();
  const body = await jsonObject(req), name = text(body, "name");
  if (!name) return Response.json({ error: "Connection name is required" }, { status: 400 });
  let source: ReturnType<typeof parseReportedSource>;
  try {
    source = parseReportedSource(body?.harness, body?.sourceLabel);
    if (source.sourceLabel && !source.harness) throw new Error("harness is required for a source label");
  } catch { return Response.json({ error: "Invalid connection source" }, { status: 400 }); }
  const updated = await setTokenSource(org.id, name, source);
  return updated ? Response.json(updated) : Response.json({ error: "Connection not found" }, { status: 404 });
}

async function postRevokeToken(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) || !isConsolePerson(token)) return forbidden();
  const name = text(await jsonObject(req), "name");
  if (!name) return Response.json({ error: "bad request" }, { status: 400 });
  const ok = await revokeToken(org.id, name);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}

async function postTokenWrite(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) || !isConsolePerson(token)) return forbidden();
  const body = await jsonObject(req);
  const name = text(body, "name");
  if (!name) return Response.json({ error: "bad request" }, { status: 400 });
  const ok = await setTokenWrite(org.id, name, body?.canWrite !== false);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}

async function putPolicies(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) || !isConsolePerson(token)) return forbidden();
  const body = await jsonObject(req);
  // The generic privacy form cannot grant Jev processing or accept a price.
  // updatePolicies also preserves the latest database value under concurrency.
  const next = parsePolicies({ ...DEFAULT_POLICIES, ...org.policies, ...(body?.policies ?? body ?? {}), jevProcessing: org.policies.jevProcessing });
  const updated = await updatePolicies(org.id, next);
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ policies: updated.policies });
}

async function putWorkspace(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (token.kind !== "session" || !canManageOrg(token) || !isHuman(token) || !token.email || !token.canWrite) return forbidden();
  const pin = req.headers.get("x-engram-workspace");
  if (!pin) return Response.json({ error: "Select the workspace before changing its name." }, { status: 400 });
  if (pin !== String(org.id)) return Response.json({ error: "The selected workspace changed. Please retry." }, { status: 409 });
  const body = await jsonObject(req);
  const name = parseWorkspaceName(body?.name);
  if (!body || Object.keys(body).some(key => key !== "name") || !name) {
    return Response.json({ error: "Use a workspace name between 1 and 100 characters without control characters." }, { status: 400 });
  }
  try {
    const updated = await renameWorkspace(org.id, token.email, name);
    return updated ? Response.json({ org: publicOrg(updated) }) : forbidden();
  } catch (error) {
    console.error("[workspace] rename failed:", failureCode(error));
    return Response.json({ error: "The workspace name could not be updated. Please try again." }, { status: 503 });
  }
}

async function postInvite(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) || !isConsolePerson(token)) return forbidden();
  const body = await jsonObject(req);
  const email = normalizeEmail(text(body, "email") ?? "");
  if (!email) return Response.json({ error: "bad request" }, { status: 400 });
  const role = text(body, "role") === "owner" ? "owner" : "member";
  try {
    const invite = await createInvite(org.id, email, role, token.name, publicUrlFrom(req));
    const delivery = await sendMail({
      to: email,
      ...renderEmail({ template: "team-invite", orgName: org.name, invitedBy: token.name, url: invite.url }),
    });
    if (delivery === "sent") return Response.json({ email, role, sent: true });
    const result = loginLinkResponse(delivery, invite.url);
    return Response.json({ email, role, ...result.body }, { status: result.status });
  } catch (e) {
    console.error("[org] invite failed:", failureCode(e));
    return Response.json({ error: "could not invite" }, { status: 400 });
  }
}

async function deleteMember(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) || !isConsolePerson(token)) return forbidden();
  const email = normalizeEmail(text(await jsonObject(req), "email") ?? "");
  if (!email) return Response.json({ error: "email required" }, { status: 400 });
  if (email === token.email) return Response.json({ error: "you cannot remove yourself" }, { status: 403 });
  const result = await removeMember(org.id, email);
  if (result === "owner") return Response.json({ error: "owners cannot be removed" }, { status: 403 });
  if (result === "not-found") return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}

async function deleteInvites(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) || !isConsolePerson(token)) return forbidden();
  const email = normalizeEmail(text(await jsonObject(req), "email") ?? "");
  if (!email) return Response.json({ error: "email required" }, { status: 400 });
  return Response.json({ ok: true, cancelled: await cancelInvites(org.id, email) });
}

export function wiringPayload(req: Request, token: string | null) {
  const mcp = mcpUrlFrom(req);
  const shown = token ?? "<token>";
  return {
    mcp,
    cursor: {
      mcpServers: {
        engram: {
          url: mcp,
          headers: { Authorization: `Bearer ${shown}` },
        },
      },
    },
    claudeCode: `claude mcp add --scope user --transport http engram ${mcp} --header "Authorization: Bearer ${shown}"`,
    chatConnectors: oauthEnabled()
      ? `Add a custom connector pointed at ${mcp}. Sign in when the client asks. Cursor and Claude Code can still use a bearer token.`
      : "Claude, ChatGPT, and Grok connectors need OAuth. Cursor and Claude Code work now.",
  };
}

export async function sessionFromBody(req: Request): Promise<TokenRecord | null> {
  const body = await jsonObject(req);
  const raw = text(body, "token");
  return raw ? authenticateSecret(raw, "") : null;
}

export async function ingestTrailRequest(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  return postTrail(req, token, org);
}

async function postSwitchOrg(req: Request, token: TokenRecord, _org: Org): Promise<Response> {
  if (token.kind !== "session" || !isHuman(token) || !token.email) return forbidden();
  const body = await jsonObject(req);
  const orgId = Number(body?.orgId ?? body?.org_id);
  if (!Number.isSafeInteger(orgId) || orgId < 1) return Response.json({ error: "bad request" }, { status: 400 });
  const member = await memberInOrg(orgId, token.email);
  const next = await getOrg(orgId);
  if (!member || !next) return Response.json({ error: "not found" }, { status: 404 });
  const payload = await sessionActor(normalizeToken({
    name: token.email,
    orgId: next.id,
    role: member.role,
    kind: "session",
    email: token.email,
  }), next, { onboarding: await onboardingState(next) });
  const session = await createSession({
    orgId: next.id,
    name: token.email,
    role: member.role,
    email: token.email,
  });
  return Response.json(payload, {
    headers: { "Set-Cookie": serializeSessionCookie(session) },
  });
}

// Connected OAuth clients receive memory scopes. Those scopes must not turn
// into console credentials capable of issuing broader tokens or switching the
// client into a different workspace.
function isConsolePerson(token: TokenRecord): boolean {
  return isHuman(token) && token.kind !== "oauth";
}

function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

async function getTrails(url: URL, _org: Org): Promise<Response> {
  const includeTranscript = _org.kind === "personal";
  const trails = await listTrails({
    repo: url.searchParams.get("repo"),
    harness: url.searchParams.get("harness"),
    authorEmail: url.searchParams.get("author"),
    limit: Number(url.searchParams.get("limit") ?? 40),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });
  return Response.json({
    trails: trails.map(trail => publicTrail(trail, includeTranscript)),
    repos: await listRepos(),
    more: trails.length === Number(url.searchParams.get("limit") ?? 40),
  });
}

async function getTrailDetail(url: URL, org: Org): Promise<Response> {
  const id = url.pathname.slice("/api/trails/".length).split("/")[0];
  if (!id) return Response.json({ error: "bad request" }, { status: 400 });
  const trail = await getTrail(id);
  if (!trail) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ trail: publicTrail(trail, org.kind === "personal" || Boolean(trail.transcript)) });
}

async function postTrail(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (org.kind !== "personal") {
    return Response.json({ error: "capture writes to a personal brain" }, { status: 400 });
  }
  if (!canWrite(token, org.policies)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await jsonObject(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const parsed = parseTrailIngest(body);
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
  try {
    const trail = await ingestTrail(parsed, token.email);
    return Response.json({ trail: publicTrail(trail, true) });
  } catch (e) {
    console.error("[trails] ingest failed:", failureCode(e));
    return Response.json({ error: "could not save trail" }, { status: 400 });
  }
}

async function getShareRules(token: TokenRecord, org: Org): Promise<Response> {
  if (org.kind !== "personal") return Response.json({ rules: [] });
  if (!isHuman(token) || !token.email) {
    return Response.json({ rules: [], repos: await listRepos() });
  }
  const rules = await listShareRules(org.id, token.email);
  return Response.json({ rules: rules.map(publicRule), repos: await listRepos() });
}

async function postShareRule(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!isHuman(token) || !token.email) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await jsonObject(req);
  const targetOrgId = Number(body?.targetOrgId ?? body?.target_org);
  if (!Number.isFinite(targetOrgId)) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const rule = await createShareRule({
      ownerEmail: token.email,
      sourceOrg: org,
      targetOrgId,
      match: shareMatchFromBody(body, ["targetOrgId", "target_org", "level"]),
      level: parseShareLevel(body?.level),
    });
    return Response.json({ rule: publicRule(rule) });
  } catch (e) {
    return Response.json({ error: String(e).replace(/^Error: /, "").slice(0, 160) }, { status: 400 });
  }
}

async function postSharePreview(req: Request, org: Org): Promise<Response> {
  const body = await jsonObject(req);
  try {
    const preview = await previewShare({ sourceOrg: org, match: shareMatchFromBody(body, []) });
    return Response.json(preview);
  } catch { return Response.json({ error: "Choose supported sharing filters; sharing everything requires matchAll: true." }, { status: 400 }); }
}

async function patchShareRule(req: Request, url: URL, token: TokenRecord, org: Org): Promise<Response> {
  const rule = await ownedRule(url, token, org);
  if (!rule) return Response.json({ error: "not found" }, { status: 404 });
  const body = await jsonObject(req);
  try {
    if (!body || Object.keys(body).some(key=>!["match","level"].includes(key))) throw new Error("Unsupported sharing fields.");
    const updated = await updateShareRule(rule, {
      match: Object.hasOwn(body,"match") ? parseShareMatch(body.match) : undefined,
      level: body.level ? parseShareLevel(body.level) : undefined,
    });
    return Response.json({ rule: publicRule(updated) });
  } catch { return Response.json({ error: "Choose supported sharing filters; sharing everything requires matchAll: true." }, { status: 400 }); }
}

function shareMatchFromBody(body: Record<string,unknown> | null, envelope: string[]) {
  if (!body) throw new Error("A structured sharing match is required.");
  if (Object.hasOwn(body,"match")) {
    if (Object.keys(body).some(key=>key!=="match" && !envelope.includes(key))) throw new Error("Unsupported sharing fields.");
    return parseShareMatch(body.match);
  }
  return parseShareMatch(Object.fromEntries(Object.entries(body).filter(([key])=>!envelope.includes(key))));
}

async function pauseShareRule(url: URL, token: TokenRecord, org: Org, paused: boolean): Promise<Response> {
  const rule = await ownedRule(url, token, org);
  if (!rule) return Response.json({ error: "not found" }, { status: 404 });
  const updated = await updateShareRule(rule, { paused });
  return Response.json({ rule: publicRule(updated) });
}

async function deleteShareRule(url: URL, token: TokenRecord, org: Org): Promise<Response> {
  const rule = await ownedRule(url, token, org);
  if (!rule) return Response.json({ error: "not found" }, { status: 404 });
  await revokeShareRule(rule.id);
  return Response.json({
    ok: true,
    warning: "Teammates' agents may already have read what was shared.",
  });
}

async function postShareTrail(req: Request, url: URL, token: TokenRecord, org: Org): Promise<Response> {
  if (!isHuman(token) || !token.email) return Response.json({ error: "forbidden" }, { status: 403 });
  const trailId = url.pathname.split("/")[3];
  const body = await jsonObject(req);
  const targetOrgId = Number(body?.targetOrgId ?? body?.target_org);
  if (!trailId || !Number.isFinite(targetOrgId)) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    await assertCanShare(token.email, org, targetOrgId);
    const rule = await shareOne({
      ownerEmail: token.email,
      sourceOrg: org,
      targetOrgId,
      trailId,
      level: parseShareLevel(body?.level),
    });
    return Response.json({ rule: publicRule(rule) });
  } catch (e) {
    return Response.json({ error: String(e).replace(/^Error: /, "").slice(0, 160) }, { status: 400 });
  }
}

async function postUnshareTrail(req: Request, url: URL, token: TokenRecord, org: Org): Promise<Response> {
  if (!isHuman(token) || !token.email) return Response.json({ error: "forbidden" }, { status: 403 });
  const trailId = url.pathname.split("/")[3];
  const body = await jsonObject(req);
  const targetOrgId = Number(body?.targetOrgId ?? body?.target_org);
  const count = await unshareTrail({
    ownerEmail: token.email,
    sourceOrg: org.id,
    trailId,
    targetOrgId: Number.isFinite(targetOrgId) ? targetOrgId : undefined,
  });
  return Response.json({
    ok: true,
    count,
    warning: "Teammates' agents may already have read this conversation.",
  });
}

export function ownsShareRule(
  token: TokenRecord,
  orgId: number,
  rule: { sourceOrg: number; ownerEmail: string } | null,
): boolean {
  return Boolean(
    rule
    && rule.sourceOrg === orgId
    && isHuman(token)
    && token.email
    && rule.ownerEmail === token.email,
  );
}

async function ownedRule(url: URL, token: TokenRecord, org: Org) {
  const match = url.pathname.match(/^\/api\/share\/rules\/(\d+)/);
  const id = Number(match?.[1]);
  if (!Number.isFinite(id)) return null;
  const rule = await getShareRule(id);
  return ownsShareRule(token, org.id, rule) ? rule : null;
}
