import {
  authenticateSecret,
  createLoginInvite,
  createSession,
  issueToken,
  listTokens,
  revokeToken,
  setTokenWrite,
  type TokenRecord,
} from "./auth";
import {
  acceptInvite,
  createInvite,
  createOrg,
  listInvites,
  listMembers,
  mcpUrlFrom,
  normalizeEmail,
  onboardingStep,
  orgHasAgentToken,
  orgHasPage,
  publicUrlFrom,
  updatePolicies,
  type Org,
} from "./orgs";
import {
  canManageOrg,
  DEFAULT_POLICIES,
  isHuman,
  normalizeToken,
  parsePolicies,
} from "./policies";
import { serializeSessionCookie } from "./cookies";

export function publicActor(token: TokenRecord, org: Org, extra: Record<string, unknown> = {}) {
  const actor = normalizeToken(token);
  return {
    name: actor.name,
    role: actor.role,
    canWrite: actor.canWrite,
    email: actor.email,
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      policies: org.policies,
    },
    ...extra,
  };
}

export async function onboardingState(org: Org) {
  const hasToken = await orgHasAgentToken(org.id);
  const hasPage = await orgHasPage(org);
  const step = onboardingStep({ hasToken, hasPage });
  return { step, hasToken, hasPage };
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
  if (req.method === "GET" && url.pathname === "/api/onboarding") {
    return Response.json(await onboardingState(org));
  }
  if (req.method === "GET" && url.pathname === "/api/tokens") {
    return Response.json({ tokens: await listTokens(org.id), mcp: mcpUrlFrom(req) });
  }
  if (req.method === "POST" && url.pathname === "/api/tokens") return postToken(req, token, org);
  if (req.method === "POST" && url.pathname === "/api/tokens/revoke") return postRevokeToken(req, token, org);
  if (req.method === "POST" && url.pathname === "/api/tokens/write") return postTokenWrite(req, token, org);
  if (req.method === "GET" && url.pathname === "/api/policies") {
    return Response.json({ policies: org.policies });
  }
  if (req.method === "PUT" && url.pathname === "/api/policies") return putPolicies(req, token, org);
  if (req.method === "GET" && url.pathname === "/api/members") {
    return Response.json({
      members: await listMembers(org.id),
      invites: await listInvites(org.id),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/invites") return postInvite(req, token, org);
  if (req.method === "GET" && url.pathname === "/api/wiring") {
    return Response.json(wiringPayload(req, null));
  }
  return null;
}

async function postOrg(req: Request): Promise<Response> {
  const body = await jsonObject(req);
  const name = text(body, "name");
  const email = text(body, "email");
  if (!name || !normalizeEmail(email ?? "")) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const org = await createOrg(name, email!);
    const session = await createSession({
      orgId: org.id,
      name: normalizeEmail(email!)!,
      role: "owner",
      email: normalizeEmail(email!),
    });
    return Response.json({
      ...publicActor(normalizeToken({
        name: normalizeEmail(email!)!,
        orgId: org.id,
        role: "owner",
        kind: "session",
        email: normalizeEmail(email!),
      }), org, { onboarding: await onboardingState(org) }),
    }, {
      headers: { "Set-Cookie": serializeSessionCookie(session) },
    });
  } catch (e) {
    console.error("[org] create failed:", String(e).slice(0, 200));
    return Response.json({ error: "could not create org" }, { status: 400 });
  }
}

async function postLoginEmail(req: Request): Promise<Response> {
  const body = await jsonObject(req);
  const email = normalizeEmail(text(body, "email") ?? "");
  if (!email) return Response.json({ error: "bad request" }, { status: 400 });
  const invite = await createLoginInvite(email, publicUrlFrom(req));
  if (!invite) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    sent: true,
    url: invite.url,
  });
}

async function postAcceptInvite(req: Request): Promise<Response> {
  const body = await jsonObject(req);
  const raw = text(body, "token");
  if (!raw) return Response.json({ error: "bad request" }, { status: 400 });
  const accepted = await acceptInvite(raw);
  if (!accepted) return Response.json({ error: "unauthorized" }, { status: 401 });
  const session = await createSession({
    orgId: accepted.org.id,
    name: accepted.member.email,
    role: accepted.member.role,
    email: accepted.member.email,
  });
  return Response.json(publicActor(normalizeToken({
    name: accepted.member.email,
    orgId: accepted.org.id,
    role: accepted.member.role,
    kind: "session",
    email: accepted.member.email,
  }), accepted.org, { onboarding: await onboardingState(accepted.org) }), {
    headers: { "Set-Cookie": serializeSessionCookie(session) },
  });
}

async function postToken(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token) && !isHuman(token)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await jsonObject(req);
  const name = text(body, "name");
  if (!name) return Response.json({ error: "bad request" }, { status: 400 });
  const canWrite = body?.canWrite !== false;
  try {
    const raw = await issueToken(org.id, name, canWrite);
    return Response.json({
      name,
      canWrite,
      token: raw,
      ...wiringPayload(req, raw),
    });
  } catch (e) {
    console.error("[org] token issue failed:", String(e).slice(0, 160));
    return Response.json({ error: "could not mint token" }, { status: 400 });
  }
}

async function postRevokeToken(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token)) return Response.json({ error: "forbidden" }, { status: 403 });
  const name = text(await jsonObject(req), "name");
  if (!name) return Response.json({ error: "bad request" }, { status: 400 });
  const ok = await revokeToken(org.id, name);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}

async function postTokenWrite(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token)) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await jsonObject(req);
  const name = text(body, "name");
  if (!name) return Response.json({ error: "bad request" }, { status: 400 });
  const ok = await setTokenWrite(org.id, name, body?.canWrite !== false);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}

async function putPolicies(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token)) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await jsonObject(req);
  const next = parsePolicies({ ...DEFAULT_POLICIES, ...org.policies, ...(body?.policies ?? body ?? {}) });
  const updated = await updatePolicies(org.id, next);
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ policies: updated.policies });
}

async function postInvite(req: Request, token: TokenRecord, org: Org): Promise<Response> {
  if (!canManageOrg(token)) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await jsonObject(req);
  const email = normalizeEmail(text(body, "email") ?? "");
  if (!email) return Response.json({ error: "bad request" }, { status: 400 });
  const role = text(body, "role") === "owner" ? "owner" : "member";
  try {
    const invite = await createInvite(org.id, email, role, token.name, publicUrlFrom(req));
    return Response.json({ email, role, url: invite.url });
  } catch (e) {
    console.error("[org] invite failed:", String(e).slice(0, 160));
    return Response.json({ error: "could not invite" }, { status: 400 });
  }
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
    chatConnectors: "Claude, ChatGPT, and Grok connectors need OAuth. Cursor and Claude Code work now.",
  };
}

export async function sessionFromBody(req: Request): Promise<TokenRecord | null> {
  const body = await jsonObject(req);
  const raw = text(body, "token");
  return raw ? authenticateSecret(raw, "") : null;
}
