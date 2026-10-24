// Local, in-memory demo only. Production APIs and authentication live in gateway/.
import { extname, normalize } from "node:path";
import { createHash } from "node:crypto";
import { PLANS } from "../gateway/src/plans";
import { parsePolicies } from "../gateway/src/policies";
import { parseReportedSource } from "../gateway/src/agent-source";
import { activityDetail, activityPage, latestLogicalActions } from "./activity-model.js";
import { analyzeActions, logicalActivityId } from "../gateway/src/insights-engine";
import { reviewPlan } from "./insight-model.js";
import { createShowcaseStreamManager } from "../gateway/src/showcase-stream";
import { ShowcaseError, parseShowcaseInput, publicActivitySnapshot, renderShowcaseCard, renderShowcasePage, renderShowcasePng, renderUnavailableShowcasePage, showcaseCategory, showcaseUrls, validShowcaseSlug, type ShowcaseProfile } from "../gateway/src/showcase-view";

// The standalone demo uses parser code only. Its in-memory handlers never call
// database/provider operations, and a local preview cannot inherit hosted DB
// provisioning settings or require production credentials just to start.
if (import.meta.main) {
  process.env.ENGRAM_DEPLOYMENT_MODE = "self-hosted";
  process.env.ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS = "1";
  process.env.ENGRAM_DB_URL_TEMPLATE = "postgresql://engram_demo:demo@127.0.0.1:1/__DB__";
}
const { ActionError, actionInputFingerprint, parseActionInput, parseActionsQuery } = await import("../gateway/src/actions");
const { parseInsightRequest } = await import("../gateway/src/insights");
const { oauthActorName } = await import("../gateway/src/oauth");

const PORT = Number(Bun.env.PORT || 8099);
const demoSelfHosted = Bun.env.ENGRAM_DEMO_SELF_HOSTED === "1";
const root = new URL("./", import.meta.url);
const session = { ...await fixture("session.json"), demo: true };
const workspacePolicies = new Map<number, ReturnType<typeof parsePolicies>>(session.orgs.map((org: any) => [org.id, parsePolicies(org.id === session.org.id ? session.org.policies : {})]));
session.org.policies = workspacePolicies.get(session.org.id)!;
const memoryFixture = await fixture("pages.json");
const detailFixture = await fixture("page-detail.json");
let pages = memoryFixture.pages;
const pageWorkspaces = new Map<string, number>(pages.map((page: any) => [page.slug, session.org.id]));
const sampleActions = (await fixture("actions.json")).actions;
const sampleTimeShift = Date.now() - 20_000 - Math.max(...sampleActions.map((action: any) => Date.parse(action.recordedAt)));
let actions = sampleActions.map((action: any) => ({ ...action,
  occurredAt: new Date(Date.parse(action.occurredAt) + sampleTimeShift).toISOString(),
  recordedAt: new Date(Date.parse(action.recordedAt) + sampleTimeShift).toISOString(),
}));
const actionWorkspaces = new Map<string, number>(actions.map((action: any) => [action.id, session.org.id]));
const details = new Map([[detailFixture.page.slug, detailFixture]]);
const forgotten = new Map<string, any>();
const showcaseProfiles = new Map<number, ShowcaseProfile>();
const showcaseRevisions = new Map<number, number>();
const demoEvents = new Map<string, { fingerprint: string; action: any }>();
const insightJobs = new Map<string, { workspaceId: number; job: { id: string; status: string; createdAt: string; updatedAt: string }; request: ReturnType<typeof parseInsightRequest>; result: ReturnType<typeof analyzeActions> | null; readyAt: number }>();
const reviewEntries = new Map([
  ["demo-entry-evidence", { id: "demo-entry-evidence", slug: "action-evidence", rawText: pages.find((page: any) => page.slug === "action-evidence")?.body || "Keep observed and reported evidence distinct.", status: "active" }],
  ["demo-entry-deployment", { id: "demo-entry-deployment", slug: "deployment-approvals", rawText: pages.find((page: any) => page.slug === "deployment-approvals")?.body || "Request approval before production deployment.", status: "active" }],
]);
const sampleReviewTime = new Date().toISOString();
const demoReviews = [
  { id: 1, fingerprint: "demo-duplicate-evidence", entryId: "demo-entry-evidence", kind: "refine", state: "pending", confidence: 0.84, payload: { otherSlug: "engram-direction", otherText: "Engram gives agents one shared history with explicit evidence and attribution.", relation: "refine" }, runId: null, resolvedAt: null, resolvedBy: null, createdAt: sampleReviewTime },
  { id: 2, fingerprint: "demo-stale-deployment", entryId: "demo-entry-deployment", kind: "stale", state: "pending", confidence: 0.71, payload: { slug: "deployment-approvals", text: "Confirm that this deployment policy still applies to previews." }, runId: null, resolvedAt: null, resolvedBy: null, createdAt: sampleReviewTime },
  { id: 3, fingerprint: "demo-cluster", entryId: null, kind: "cluster", state: "pending", confidence: null, payload: { clusterSlug: "agent-observability", title: "Agent observability", members: ["action-evidence", "engram-direction", "deployment-approvals"] }, runId: null, resolvedAt: null, resolvedBy: null, createdAt: sampleReviewTime },
];
const reviewWorkspaces = new Map(demoReviews.map(item => [item.id, session.org.id]));
function publicDemoProfile(slug: string) { return [...showcaseProfiles.entries()].find(([, profile]) => profile.slug === slug && profile.published); }
function demoPublication(slug: string) {
  const entry = publicDemoProfile(slug);
  return entry ? `${entry[0]}:${showcaseRevisions.get(entry[0]) || 0}` : null;
}
const demoStreams = createShowcaseStreamManager({
  publication: async slug => demoPublication(slug),
  snapshot: async (slug, publication) => {
    const entry = publicDemoProfile(slug);
    return entry && demoPublication(slug) === publication ? showcaseActivity(entry[1], entry[0]) : null;
  },
});
const invitations = new Map<number, any[]>();
const signupInvitations = new Map<string, any>();
const signupCodes = new Map<string, string>();
const signupLinks = new Map<string, string>();
const demoSession = () => ({ ...session, capabilities: { manageSignupInvites: session.org.id === 1 && session.role === "owner" }, onboarding: demoOnboarding() });
const tokens: any[] = [
  { id: 1, orgId: 1, name: "codex", harness: "codex", sourceLabel: null, canWrite: true, createdAt: "2026-10-20T09:00:00.000Z", revokedAt: null, lastUsedAt: "2026-10-21T09:42:00.000Z", issuerKind: "member", issuedBy: session.email },
  { id: 2, orgId: 1, name: "mac-claude", harness: "claude-code", sourceLabel: null, canWrite: true, createdAt: "2026-10-19T09:00:00.000Z", revokedAt: null, lastUsedAt: "2026-10-21T09:38:00.000Z", issuerKind: "member", issuedBy: session.email },
  { id: 3, orgId: 1, name: "old-laptop", harness: null, sourceLabel: null, canWrite: false, createdAt: "2026-10-18T09:00:00.000Z", revokedAt: "2026-10-20T08:00:00.000Z", lastUsedAt: "2026-10-19T12:00:00.000Z", issuerKind: "member", issuedBy: session.email },
];
// These are sign-in metadata fixtures, never usable OAuth grants or secrets.
const oauthConnections = [{ orgId: 1, email: session.email, clientId: "demo-chatgpt", name: "ChatGPT", harness: "chatgpt", sourceLabel: "ChatGPT", status: "authorized", canWrite: true, createdAt: "2026-10-20T12:00:00.000Z" }];
const demoHarnessLabels: Record<string, string> = { codex: "Codex", claude: "Claude", "claude-code": "Claude Code", chatgpt: "ChatGPT", cursor: "Cursor", grok: "Grok", "grok-bot": "GrokBot", openclaw: "OpenClaw", hermes: "Hermes" };

if (import.meta.main) {
  Bun.serve({ port: PORT, hostname: "127.0.0.1", idleTimeout: 120, fetch: devFetch });
  console.log(`engram demo: http://localhost:${PORT}/`);
}

export async function devFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/source") return Response.redirect("https://github.com/Ani-HQ/engram", 302);
  if (url.pathname === "/hosted") return Response.redirect("https://engram.ani.computer/pricing", 302);
  const showcase = await publicShowcase(req, url);
  if (showcase) return showcase;
  return url.pathname.startsWith("/api/") ? handleApi(req, url) : serveStatic(url, req.method === "HEAD");
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/plans") return json({ mode: "hosted", trialDays: 14, currency: "usd", checkoutAvailable: false, plans: PLANS, demo: true });
  if (route === "GET /api/signup-policy") return json({ mode: demoSelfHosted ? "open" : "invite-only", complimentary: true, verificationRequired: true, inviteCodeRequired: !demoSelfHosted, tokenSignInAllowed: demoSelfHosted, demo: true });
  if (route === "POST /api/session" && !demoSelfHosted) return json({ error: "Sign in with an email link. Access tokens connect agents only.", code: "token_sign_in_disabled" }, 403);
  if (route === "POST /api/session" || route === "POST /api/invites/accept") {
    const body = await bodyObject(req);
    if (!string(body?.token)) return json({ error: "A token is required." }, 400);
    const signupId = signupLinks.get(body.token), signup = signupId && signupInvitations.get(signupId);
    if (route === "POST /api/invites/accept" && body.token.startsWith("svf_") && !signup) return json({ error: "This preview verification link is unavailable." }, 400);
    if (signup) {
      if (signup.revokedAt || signup.redeemedAt || Date.parse(signup.expiresAt) <= Date.now()) return json({ error: "This preview verification link is unavailable." }, 400);
      signup.redeemedAt = new Date().toISOString(); signup.complimentaryAppliedAt = signup.redeemedAt; signup.redeemedOrgId = 2;
    }
    return json(demoSession(), 200, { "Set-Cookie": "engram_dev=1; Path=/; HttpOnly; SameSite=Lax" });
  }
  if (route === "DELETE /api/session") {
    return new Response(null, { status: 204, headers: { "Set-Cookie": "engram_dev=0; Path=/; HttpOnly; SameSite=Lax" } });
  }
  if (route === "POST /api/login/email" || route === "POST /api/orgs") {
    const body = await bodyObject(req);
    if (typeof body?.email !== "string" || !body.email.includes("@")) return json({ error: "An email is required." }, 400);
    if (route === "POST /api/orgs" && !demoSelfHosted && (body.inviteCode || body.email.toLowerCase() !== session.email.toLowerCase())) {
      const id = signupCodes.get(String(body.inviteCode || "")), invite = id && signupInvitations.get(id);
      if (!invite || invite.email !== body.email.trim().toLowerCase() || invite.revokedAt || Date.parse(invite.expiresAt) <= Date.now() || invite.redeemedAt) return json({ error: "Use an unexpired invite code issued for this email address.", code: "invite_invalid" }, 400);
      const token = `svf_demo_${crypto.randomUUID()}`; signupLinks.set(token, invite.id);
      return json({ sent: false, url: `${url.origin}/app#join=${token}`, demo: true });
    }
    return json({ sent: false, url: `${url.origin}/app#join=inv_dev`, demo: true });
  }
  // An initial visit is signed in to the demo. An explicit sign-out stays signed out.
  if (req.headers.get("cookie")?.split(";").some(value => value.trim() === "engram_dev=0")) {
    return json({ error: "unauthorized" }, 401);
  }
  if (route === "GET /api/me") return json(demoSession());
  const expectedWorkspace = req.headers.get("x-engram-workspace");
  if (expectedWorkspace && expectedWorkspace !== String(session.org.id)) return json({ error: "The selected workspace changed. Please start the export again." }, 409);
  const workspaceId = session.org.id;
  if (url.pathname.startsWith("/api/admin/signup-invites")) {
    if (!demoSession().capabilities.manageSignupInvites) return json({ error: "Operator access is required.", code: "forbidden" }, 403);
    if (route === "GET /api/admin/signup-invites") return json({ invites: [...signupInvitations.values()].reverse().slice(0, 100), more: signupInvitations.size > 100 });
    if (route === "POST /api/admin/signup-invites") {
      const body = await bodyObject(req);
      if (typeof body?.email !== "string" || !body.email.includes("@")) return json({ error: "An email is required." }, 400);
      const id = crypto.randomUUID(), inviteCode = `demo_signup_${crypto.randomUUID()}`;
      const invite = { id, email: body.email.trim().toLowerCase(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), revokedAt: null, redeemedAt: null, redeemedOrgId: null, accessExpiresAt: null, complimentaryAppliedAt: null, complimentaryRevokedAt: null };
      signupInvitations.set(id, invite); signupCodes.set(inviteCode, id);
      return json({ invite, inviteCode }, 201);
    }
    const revoke = url.pathname.match(/^\/api\/admin\/signup-invites\/([^/]+)\/revoke$/);
    if (req.method === "POST" && revoke) {
      const invite = signupInvitations.get(decodeURIComponent(revoke[1]));
      if (!invite) return json({ error: "Invite not found." }, 404);
      invite.revokedAt = new Date().toISOString();
      if (invite.complimentaryAppliedAt) invite.complimentaryRevokedAt = invite.revokedAt;
      return json({ invite, revocationPending: false });
    }
    return json({ error: "not found" }, 404);
  }
  if (route === "GET /api/billing") return json({ mode: "hosted", planId: "trial", status: "trial", canWrite: true, trialEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(), currentPeriodEndsAt: null, cancelAtPeriodEnd: false, checkoutAvailable: false, portalAvailable: false });
  if (route === "POST /api/billing/checkout" || route === "POST /api/billing/portal") return json({ error: "Payments are disabled in the local preview. No charge was made." }, 503);
  if (url.pathname === "/api/insights") return handleDemoInsights(req, url);
  if (url.pathname === "/api/review" || url.pathname.startsWith("/api/review/")) return handleDemoReview(req, url);
  if (url.pathname === "/api/showcase") {
    if (session.role !== "owner") return json({ error: "Only a workspace owner can manage showcase settings" }, 403);
    try {
      if (req.method !== "GET" && req.method !== "PUT") return json({ error: "method not allowed" }, 405, { Allow: "GET, PUT" });
      if (req.method === "PUT") {
        const profile = parseShowcaseInput(await bodyObject(req));
        if ([...showcaseProfiles].some(([orgId, value]) => orgId !== session.org.id && value.slug === profile.slug)) {
          return json({ error: "That showcase address is already taken" }, 409);
        }
        showcaseProfiles.set(session.org.id, profile);
        showcaseRevisions.set(session.org.id, (showcaseRevisions.get(session.org.id) || 0) + 1);
        await demoStreams.refresh();
      }
      const profile = showcaseProfiles.get(session.org.id) ?? { slug: "", displayName: "", bio: "", published: false };
      return json({ profile, urls: showcaseUrls(profile, url.origin), preview: showcaseActivity(profile) }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof ShowcaseError) return json({ error: error.message }, error.status);
      return json({ error: "Profile could not be saved" }, 400);
    }
  }
  if (route === "GET /api/actions") return listActions(url);
  if (route === "POST /api/actions") return recordAction(req);
  if (route === "GET /api/activities") return listActivities(url);
  if (req.method === "GET" && url.pathname.startsWith("/api/activities/")) return getActivity(url);
  if (route === "GET /api/pages") {
    const source = url.searchParams.get("fixture") === "empty" ? [] : pages.filter((page: any) => pageWorkspaces.get(page.slug) === session.org.id);
    const scope = url.searchParams.get("scope");
    const rows = source.filter((row: any) => !scope || row.scope === scope).sort((a: any, b: any) => b.updated_at.localeCompare(a.updated_at));
    return json({ ...windowRows(rows, url, "pages", 48), scopes: [...new Set(source.map((row: any) => row.scope))] });
  }
  if (route === "GET /api/search") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const scope = url.searchParams.get("scope");
    const results = q ? pages.filter((row: any) => pageWorkspaces.get(row.slug) === session.org.id && (!scope || row.scope === scope) && `${row.slug} ${row.title} ${row.body || ""}`.toLowerCase().includes(q)).map((row: any) => ({ ...row, snippet: row.body })) : [];
    return json({ results: results.slice(0, integer(url, "limit", 48, 100)) });
  }
  if (route === "GET /api/page") {
    const slug = url.searchParams.get("slug");
    const row = pages.find((page: any) => page.slug === slug && pageWorkspaces.get(page.slug) === session.org.id);
    return row ? json(details.get(slug!) || { page: row, links: [], timeline: [] }) : json({ error: "not found" }, 404);
  }
  if (route === "POST /api/capture") return capture(req);
  if (route === "DELETE /api/page") {
    const slug = url.searchParams.get("slug");
    const row = pages.find((page: any) => page.slug === slug && pageWorkspaces.get(page.slug) === session.org.id);
    if (!row) return json({ error: "not found" }, 404);
    forgotten.set(slug!, { row, detail: details.get(slug!), workspaceId: session.org.id });
    pages = pages.filter((page: any) => page.slug !== slug);
    details.delete(slug!);
    return json({ ok: true, slug, recoverable: true });
  }
  if (route === "POST /api/page/restore") {
    const body = await bodyObject(req);
    const record = forgotten.get(body?.slug);
    if (!record || record.workspaceId !== session.org.id) return json({ error: "not found" }, 404);
    pages.unshift(record.row);
    if (record.detail) details.set(body.slug, record.detail);
    forgotten.delete(body.slug);
    return json({ ok: true, slug: body.slug });
  }
  if (route === "GET /api/onboarding") return json(demoOnboarding());
  if (route === "GET /api/wiring") return json(wiring(url));
  if (url.pathname === "/api/connections") {
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (!["owner", "member"].includes(session.role)) return json({ error: "forbidden" }, 403, headers);
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405, { ...headers, Allow: "GET" });
    return json(demoConnections(workspaceId), 200, headers);
  }
  if (route === "GET /api/tokens") return json({ tokens: workspaceTokens(workspaceId).map(({ id: _, orgId: __, ...token }) => token), mcp: `${url.origin}/mcp` });
  if (route === "POST /api/tokens") {
    const body = await bodyObject(req);
    const name = string(body?.name);
    if (!name) return json({ error: "An agent name is required." }, 400);
    if (workspaceTokens(workspaceId).some(token => token.name === name)) return json({ error: "That agent name already exists." }, 400);
    let source;
    try {
      source = parseReportedSource(body?.harness, body?.sourceLabel);
      if (source.sourceLabel && !source.harness) throw new Error("harness is required for a source label");
    }
    catch { return json({ error: "Choose a valid agent source." }, 400); }
    const canWrite = body?.canWrite !== false;
    tokens.push({ id: Math.max(0, ...tokens.map(token => token.id)) + 1, orgId: workspaceId, name, canWrite, ...source, createdAt: new Date().toISOString(), revokedAt: null, lastUsedAt: null, issuerKind: "member", issuedBy: session.email });
    return json({ name, canWrite, ...source, token: "eng_demo_token_not_valid_in_production", ...wiring(url, "eng_demo_token_not_valid_in_production") });
  }
  if (route === "POST /api/tokens/source") {
    if (session.role !== "owner") return json({ error: "Only workspace owners can edit connection sources." }, 403);
    const body = await bodyObject(req), token = workspaceTokens(workspaceId).find(row => row.name === body?.name && !row.revokedAt);
    if (!token) return json({ error: "not found" }, 404);
    try {
      const source = parseReportedSource(body?.harness, body?.sourceLabel);
      if (source.sourceLabel && !source.harness) throw new Error("harness is required for a source label");
      Object.assign(token, source);
    }
    catch { return json({ error: "Choose a valid agent source." }, 400); }
    return json({ name: token.name, harness: token.harness, sourceLabel: token.sourceLabel });
  }
  if (route === "POST /api/tokens/revoke" || route === "POST /api/tokens/write") {
    if (session.role !== "owner") return json({ error: "Only workspace owners can manage connection access." }, 403);
    const body = await bodyObject(req);
    const token = workspaceTokens(workspaceId).find(row => row.name === body?.name && !row.revokedAt);
    if (!token) return json({ error: "not found" }, 404);
    if (route.endsWith("revoke")) token.revokedAt = new Date().toISOString();
    else token.canWrite = body?.canWrite !== false;
    return json({ ok: true });
  }
  if (route === "GET /api/policies") return json({ policies: session.org.policies });
  if (route === "PUT /api/policies") {
    const body = await bodyObject(req);
    session.org.policies = parsePolicies({ ...session.org.policies, ...(body?.policies || {}) });
    workspacePolicies.set(session.org.id, session.org.policies);
    return json({ policies: session.org.policies });
  }
  if (route === "GET /api/members") return json({ members: [{ id: 1, orgId: session.org.id, email: session.email, role: "owner" }], invites: invitations.get(session.org.id) || [] });
  if (route === "POST /api/invites") {
    const body = await bodyObject(req);
    if (typeof body?.email !== "string" || !body.email.includes("@")) return json({ error: "An email is required." }, 400);
    invitations.set(session.org.id, [...(invitations.get(session.org.id) || []), { email: body.email, role: "member" }]);
    return json({ email: body?.email, role: "member", url: `${url.origin}/app#join=inv_dev`, demo: true });
  }
  if (route === "DELETE /api/invites") {
    const body = await bodyObject(req);
    invitations.set(session.org.id, (invitations.get(session.org.id) || []).filter(invite => invite.email !== body?.email));
    return json({ ok: true });
  }
  if (route === "GET /api/orgs") return json({ orgs: session.orgs });
  if (route === "POST /api/session/switch") {
    const body = await bodyObject(req);
    const next = session.orgs.find((org: any) => org.id === Number(body?.orgId));
    if (!next) return json({ error: "not found" }, 404);
    session.org = { ...session.org, ...next, policies: workspacePolicies.get(next.id) || parsePolicies({}) };
    return json(demoSession());
  }
  return json({ error: "not found" }, 404);
}

function demoExternalStatus() {
  return { consented: session.org.policies.externalAiProcessing === true, configured: false, generativeConfigured: false };
}

async function handleDemoInsights(req: Request, url: URL) {
  const headers = { "Cache-Control": "no-store" };
  try {
    if (req.method === "GET") {
      const id = url.searchParams.get("jobId");
      if (id && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return json({ error: "Invalid job identifier" }, 400, headers);
      const own = [...insightJobs.values()].filter(record => record.workspaceId === session.org.id);
      const record = id ? own.find(record => record.job.id === id) : own.at(-1);
      if (id && !record) return json({ error: "Insight job not found" }, 404, headers);
      if (record && record.job.status === "queued" && Date.now() >= record.readyAt) {
        const source = latestDemoActions(record.workspaceId).map((action: any) => ({ ...action, activityId: logicalActivityId(action) }));
        const filtered = record.request.activityId ? source.filter((action: any) => action.activityId === record.request.activityId) : source;
        record.result = analyzeActions({ actions: filtered, q: record.request.q });
        record.job.status = "completed"; record.job.updatedAt = new Date().toISOString();
      }
      return json({ job: record?.job || null, result: record?.result || null, external: demoExternalStatus(), demo: true }, 200, headers);
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405, { ...headers, Allow: "GET, POST" });
    const text = await req.text();
    if (text.length > 2000) return json({ error: "Insight request too large" }, 413, headers);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400, headers); }
    const input = parseInsightRequest(body);
    if (input.activityId && !activityDetail(workspaceActions(), input.activityId)) return json({ error: "Activity not found" }, 404, headers);
    const pending = [...insightJobs.values()].find(record => record.workspaceId === session.org.id && ["queued", "running"].includes(record.job.status));
    if (pending) return JSON.stringify(pending.request) === JSON.stringify(input)
      ? json({ job: pending.job, external: demoExternalStatus(), demo: true }, 202, headers)
      : json({ error: "Another check is running. Wait for it to finish before starting a different check." }, 409, headers);
    const recentCount = [...insightJobs.values()].filter(record => record.workspaceId === session.org.id && Date.parse(record.job.createdAt) >= Date.now() - 3_600_000).length;
    if (recentCount >= 10) return json({ error: "Hourly check limit reached. Try again later." }, 429, headers);
    const createdAt = new Date().toISOString(), id = crypto.randomUUID();
    const record = { workspaceId: session.org.id, job: { id, status: "queued", createdAt, updatedAt: createdAt }, request: input, result: null, readyAt: Date.now() + 250 };
    insightJobs.set(id, record);
    return json({ job: record.job, external: demoExternalStatus(), demo: true }, 202, headers);
  } catch (error) {
    if (error instanceof ActionError) return json({ error: error.message }, error.status, headers);
    throw error;
  }
}

async function handleDemoReview(req: Request, url: URL) {
  const headers = { "Cache-Control": "no-store" };
  if (req.method === "GET" && url.pathname === "/api/review") {
    const state = url.searchParams.get("state") || "pending", kind = url.searchParams.get("kind");
    const rows = demoReviews.filter(item => reviewWorkspaces.get(item.id) === session.org.id && item.state === state && (!kind || item.kind === kind));
    return json({ ...windowRows(rows, url, "items", 40), demo: true }, 200, headers);
  }
  const id = req.method === "GET" ? Number(url.searchParams.get("id")) : Number((await bodyObject(req))?.id);
  if (!Number.isSafeInteger(id) || id < 1) return json({ error: "bad request" }, 400, headers);
  const item = demoReviews.find(item => item.id === id && reviewWorkspaces.get(item.id) === session.org.id);
  if (!item) return json({ error: "not found" }, 404, headers);
  const entry = item.entryId ? reviewEntries.get(item.entryId) || null : null;
  if (req.method === "GET" && url.pathname === "/api/review/item") return json({ item, entry, demo: true }, 200, headers);
  const action = url.pathname.slice("/api/review/".length);
  if (req.method !== "POST" || !["approve", "defer", "reject"].includes(action)) return json({ error: "not found" }, 404, headers);
  if (session.role !== "owner" && !(session.role === "member" && session.org.policies.reviewApprovers === "members")) return json({ error: "forbidden" }, 403, headers);
  if (item.state !== "pending") return json({ error: "already resolved", item }, 400, headers);
  if (action === "approve") {
    const plan = reviewPlan(item, entry);
    if (!plan.supported) return json({ error: "unsafe or incomplete proposal", item }, 400, headers);
    if (["duplicate", "refine", "contradict"].includes(item.kind) && entry) {
      const page = pages.find((page: any) => page.slug === entry.slug);
      const detail = details.get(entry.slug) || { page, links: [], timeline: [] };
      detail.links = [...(detail.links || []), { source: entry.slug, target: item.payload.otherSlug, relation: item.kind }];
      details.set(entry.slug, detail);
    } else if (item.kind === "supersede" && entry) entry.status = "superseded";
    else if (item.kind === "stale" && entry) {
      const page = pages.find((page: any) => page.slug === entry.slug);
      if (page) page.tags = [...new Set([...(page.tags || []), "stale"])];
    } else if (item.kind === "cluster") {
      const target = plan.target!, members = Array.isArray(item.payload.members) ? item.payload.members : [];
      const body = `# ${item.payload.title || target}\n\n${members.map(member => `- [[${member}]]`).join("\n")}\n`;
      const existing = pages.find((page: any) => page.slug === target);
      const page = { ...(existing || {}), slug: target, title: item.payload.title || target, body, type: "note", source_id: "demo", scope: "shared", updated_at: new Date().toISOString() };
      pages = [page, ...pages.filter((row: any) => row.slug !== target)]; pageWorkspaces.set(target, session.org.id); details.set(target, { page, links: [], timeline: [] });
    }
  }
  item.state = action === "approve" ? "applied" : action === "defer" ? "deferred" : "rejected";
  Object.assign(item, { resolvedAt: new Date().toISOString(), resolvedBy: session.name });
  return json({ ok: true, item, demo: true }, 200, headers);
}

function showcaseActivity(profile: ShowcaseProfile, workspaceId = session.org.id) {
  const rows = latestDemoActions(workspaceId).filter((row: any) => !["list_actions", "record_action", "whoami"].includes(row.tool));
  const now = new Date();
  const cutoff = now.getTime() - 15 * 60_000;
  const recent = (row: any) => new Date(row.recordedAt).getTime() >= cutoff;
  const days = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const row of rows) {
    const day = new Date(row.occurredAt).toISOString().slice(0, 10);
    const category = showcaseCategory(row.tool);
    days.set(day, (days.get(day) ?? 0) + 1);
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const latest = rows.map((row: any) => row.occurredAt).sort().at(-1) ?? null;
  return publicActivitySnapshot(profile, {
    total_actions: rows.length,
    completed_actions: rows.filter((row: any) => row.status === "completed").length,
    failed_actions: rows.filter((row: any) => row.status === "failed").length,
    running_actions: rows.filter((row: any) => row.status === "running").length,
    active_agents: new Set(rows.map((row: any) => row.agent)).size,
    active_days: days.size, updated_at: latest,
    working_agents: new Set(rows.filter((row: any) => row.status === "running" && recent(row)).map((row: any) => row.agent)).size,
    recently_active_agents: new Set(rows.filter(recent).map((row: any) => row.agent)).size,
    completed_agents: new Set(rows.filter((row: any) => row.status === "completed").map((row: any) => row.agent)).size,
    failed_agents: new Set(rows.filter((row: any) => row.status === "failed").map((row: any) => row.agent)).size,
    working_actions: rows.filter((row: any) => row.status === "running" && recent(row)).length,
    stale_actions: rows.filter((row: any) => row.status === "running" && !recent(row)).length,
    last_activity_at: rows.map((row: any) => row.recordedAt).sort().at(-1) || null,
    daily: [...days].map(([date, count]) => ({ date, count })),
    tools: [...categories].map(([category, count]) => ({ category, count })),
  }, now);
}

async function publicShowcase(req: Request, url: URL): Promise<Response | null> {
  const stream = /^\/api\/public\/activity\/([^/]+)\/stream$/.exec(url.pathname);
  if (stream) return demoStreams.handle(req, stream[1]);
  const api = /^\/api\/public\/activity\/([^/]+)(\/card\.(?:svg|png))?$/.exec(url.pathname);
  const page = /^\/u\/([^/]+)$/.exec(url.pathname);
  if (!api && !page) return null;
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (api && !api[2]) headers["Access-Control-Allow-Origin"] = "*";
  if (req.method === "OPTIONS" && api && !api[2]) return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  const slug = (api ?? page)![1];
  const entry = validShowcaseSlug(slug) ? publicDemoProfile(slug) : null;
  if (!entry) return new Response(req.method === "HEAD" ? null : page ? renderUnavailableShowcasePage() : "Not Found", { status: 404, headers: { ...headers, "X-Robots-Tag": "noindex", "Content-Type": page ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" } });
  const activity = showcaseActivity(entry[1], entry[0]);
  if (api && !api[2]) return new Response(req.method === "HEAD" ? null : JSON.stringify(activity), { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
  const card = Boolean(api?.[2]);
  const png = Boolean(api?.[2].endsWith("png"));
  return new Response(req.method === "HEAD" ? null : card ? png ? await renderShowcasePng(activity) : renderShowcaseCard(activity) : renderShowcasePage(activity, url.origin).replace("</head>", '<meta name="engram-demo" content="sample-data"></head>'), {
    headers: { ...headers, "Content-Type": card ? png ? "image/png" : "image/svg+xml; charset=utf-8" : "text/html; charset=utf-8" },
  });
}

function workspaceActions(workspaceId = session.org.id) {
  return actions.filter((action: any) => actionWorkspaces.get(action.id) === workspaceId);
}

function workspaceTokens(workspaceId = session.org.id) {
  return tokens.filter(token => token.orgId === workspaceId);
}

function demoOnboarding(workspaceId = session.org.id) {
  // Local preview evidence is explicitly simulated, never production verification.
  const receipts = workspaceActions(workspaceId);
  const success = receipts.filter((row: any) => row.evidence === "observed" && row.status === "completed");
  const tool = (row: any) => String(row.tool).replace(/^engram\./, "");
  const checks = { agentConnected: success.length > 0,
    memorySaved: success.some((row: any) => ["remember", "put_page"].includes(tool(row))),
    memoryRecalled: success.some((row: any) => ["recall", "search", "get_page"].includes(tool(row))),
    taskReported: receipts.some((row: any) => row.evidence === "reported") };
  const step = !checks.agentConnected ? "connect" : !checks.memorySaved ? "remember" : !checks.memoryRecalled ? "recall" : "done";
  return { step, provisioning: false, checks, hasToken: workspaceTokens(workspaceId).some(token => !token.revokedAt), hasPage: pages.some((page: any) => pageWorkspaces.get(page.slug) === workspaceId), demo: true };
}

function demoConnections(workspaceId: number, now = new Date()) {
  const metadata = [
    ...workspaceTokens(workspaceId).filter(token => !token.name.startsWith("operator-candidate-smoke-")).map(token => ({
      id: `token:${token.id}`, kind: "token", name: token.name,
      displayName: token.sourceLabel || (token.harness && Object.hasOwn(demoHarnessLabels, token.harness) ? demoHarnessLabels[token.harness] : token.name),
      agent: token.name, harness: token.harness, sourceLabel: token.sourceLabel,
      status: token.revokedAt ? "revoked" : "authorized", canWrite: token.canWrite,
      createdAt: token.createdAt, lastAuthenticatedAt: token.lastUsedAt,
    })),
    ...oauthConnections.filter(connection => connection.orgId === workspaceId).map(connection => ({
      id: `oauth:${createHash("sha256").update(JSON.stringify([workspaceId, connection.email, connection.clientId])).digest("hex")}`,
      kind: "oauth", name: connection.name, displayName: "ChatGPT",
      agent: oauthActorName({ sub: connection.email, client_id: connection.clientId }),
      harness: connection.harness, sourceLabel: connection.sourceLabel, status: connection.status,
      canWrite: connection.canWrite, createdAt: connection.createdAt, lastAuthenticatedAt: null,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.kind.localeCompare(b.kind) || b.id.localeCompare(a.id));
  // Count raw receipts, including lifecycle heartbeats, rather than grouped
  // logical actions. Sign-in metadata never invents contact or running work.
  const receipts = workspaceActions(workspaceId);
  const latest = (rows: any[]) => rows.map(row => row.recordedAt).filter(Boolean).sort().at(-1) || null;
  const connections = metadata.slice(0, 200).map(connection => {
    const own = receipts.filter((receipt: any) => receipt.agent === connection.agent);
    const observed = own.filter((receipt: any) => receipt.evidence === "observed");
    const memory = observed.filter((receipt: any) => !["whoami", "list_actions", "record_action"].includes(receipt.tool));
    const reported = own.filter((receipt: any) => receipt.evidence === "reported");
    return { ...connection, lastContactAt: latest([...observed, ...reported]), lastMemoryAt: latest(memory),
      lastTaskReportAt: latest(reported), memoryCalls: memory.length, taskReports: reported.length };
  });
  return { connections, more: metadata.length > 200, limit: 200, checkedAt: now.toISOString(), recentWindowSeconds: 900, demo: true };
}

function latestDemoActions(workspaceId = session.org.id) {
  return latestLogicalActions(workspaceActions(workspaceId));
}

function listActions(url: URL) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const exact = ["agent", "tool", "status", "runId"];
  const resource = (url.searchParams.get("resource") || "").toLowerCase();
  const rows = latestDemoActions().filter((row: any) => exact.every(key => !url.searchParams.get(key) || row[key] === url.searchParams.get(key)) && (!resource || String(row.resource || "").toLowerCase().includes(resource)) && (!q || [row.agent, row.tool, row.summary, row.resource, row.runId, row.detail].join(" ").toLowerCase().includes(q))).sort((a: any, b: any) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt));
  const all = latestDemoActions();
  return json({ ...windowRows(rows, url, "actions", 40), agents: [...new Set(all.map((row: any) => row.agent))].sort(), tools: [...new Set(all.map((row: any) => row.tool))].sort(), demo: true });
}

function listActivities(url: URL) {
  try {
    const kind = url.searchParams.get("kind") || "all";
    if (!["all", "tasks", "memory"].includes(kind)) return json({ error: "Invalid activity kind" }, 400);
    return json({ ...activityPage(workspaceActions(), { ...parseActionsQuery(url.searchParams), kind }), demo: true }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    if (error instanceof ActionError) return json({ error: error.message }, error.status);
    throw error;
  }
}

function getActivity(url: URL) {
  let id: string;
  try { id = decodeURIComponent(url.pathname.slice("/api/activities/".length)); }
  catch { return json({ error: "Invalid activity identifier" }, 400); }
  const activity = activityDetail(workspaceActions(), id);
  return activity ? json({ activity, demo: true }, 200, { "Cache-Control": "no-store" }) : json({ error: "not found" }, 404);
}

async function recordAction(req: Request) {
  const body = await bodyObject(req);
  let input: ReturnType<typeof parseActionInput>;
  try { input = parseActionInput(body); }
  catch (error) {
    if (error instanceof ActionError) return json({ error: error.message }, error.status);
    throw error;
  }
  const fingerprint = actionInputFingerprint(input);
  const eventKey = JSON.stringify([session.org.id, session.name, input.eventId]);
  if (input.eventId && demoEvents.has(eventKey)) {
    const previous = demoEvents.get(eventKey)!;
    return previous.fingerprint === fingerprint ? json({ action: previous.action, demo: true }, 201) : json({ error: "eventId was already used for a different report" }, 409);
  }
  const recordedAt = new Date().toISOString();
  const previous = input.actionKey && latestDemoActions().find((row: any) => row.agent === session.name && row.actionKey === input.actionKey);
  if (previous && previous.runId !== input.runId) return json({ error: "An actionKey cannot change runs. Use a new actionKey for a different run." }, 409);
  if (previous && (previous.status !== "running" || previous.tool !== input.tool || input.occurredAt < previous.occurredAt)) return json({ error: "This action cannot move backward or change tools. Use a new actionKey for a new attempt." }, 409);
  const { explicitOccurredAt: _, ...fields } = input;
  const action = { ...fields, id: `demo-${crypto.randomUUID()}`, agent: session.name, evidence: "reported", recordedAt, startedAt: input.occurredAt };
  actions.unshift(action);
  actionWorkspaces.set(action.id, session.org.id);
  if (input.eventId) demoEvents.set(eventKey, { fingerprint, action });
  await demoStreams.refresh();
  return json({ action, demo: true }, 201);
}

async function capture(req: Request) {
  const body = await bodyObject(req);
  const text = string(body?.text);
  if (!text) return json({ error: "A memory is required." }, 400);
  const title = (string(body?.title) || text.split("\n")[0]).replace(/^#+\s*/, "").slice(0, 80);
  const base = (string(body?.slug) || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 72) || "memory";
  let slug = base;
  let suffix = 2;
  while (pages.some((page: any) => page.slug === slug)) slug = `${base}-${suffix++}`;
  const updated_at = new Date().toISOString();
  const page = { slug, title, body: text, type: "capture", source_id: "demo", scope: string(body?.scope) || "shared", updated_at };
  pages.unshift(page);
  pageWorkspaces.set(slug, session.org.id);
  details.set(slug, { page, links: [], timeline: [{ at: updated_at, text: `Saved by ${session.name}.` }] });
  return json({ ok: true, slug });
}

function wiring(url: URL, token?: string) {
  const mcp = `${url.origin}/mcp`;
  const secret = token || "YOUR_ENGRAM_TOKEN";
  return { mcp, cursor: { mcpServers: { engram: { url: mcp, headers: { Authorization: `Bearer ${secret}` } } } }, claudeCode: `claude mcp add --scope user --transport http engram ${mcp} --header "Authorization: Bearer ${secret}"`, chatConnectors: "Use the MCP URL with a connected agent. Demo tokens work only in this local preview." };
}

function windowRows(rows: any[], url: URL, key: string, defaultLimit: number) {
  const limit = integer(url, "limit", defaultLimit, 100);
  const offset = integer(url, "offset", 0, Number.MAX_SAFE_INTEGER);
  return { [key]: rows.slice(offset, offset + limit), more: offset + limit < rows.length };
}

function integer(url: URL, key: string, fallback: number, max: number) {
  const value = Number(url.searchParams.get(key) ?? fallback);
  return Number.isSafeInteger(value) && value >= (key === "limit" ? 1 : 0) ? Math.min(value, max) : fallback;
}

async function serveStatic(url: URL, head = false): Promise<Response> {
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(head ? null : "Bad Request", { status: 400 }); }
  if (["/", "/app", "/app/"].includes(pathname)) pathname = "/index.html";
  pathname = ({ "/pricing": "/pricing.html", "/privacy": "/privacy.html", "/self-host": "/self-host.html" } as Record<string, string>)[pathname] ?? pathname;
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const fileUrl = new URL(`.${safe}`, root);
  if (!fileUrl.pathname.startsWith(root.pathname)) return new Response(head ? null : "Forbidden", { status: 403 });
  const file = Bun.file(fileUrl);
  if (!await file.exists()) return new Response(head ? null : "Not Found", { status: 404 });
  const type = ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml; charset=utf-8", ".woff2": "font/woff2", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" } as Record<string, string>)[extname(fileUrl.pathname)];
  const content = head ? null : extname(fileUrl.pathname) === ".html" ? (await file.text()).replace("</head>", '<meta name="engram-demo" content="sample-data"></head>') : file;
  const assetPath = fileUrl.pathname.slice(root.pathname.length - 1);
  const publicBrandAsset = assetPath.startsWith("/brand/") || ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/site.webmanifest"].includes(assetPath);
  return new Response(content, { headers: { ...(type ? { "Content-Type": type } : {}), "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", ...(publicBrandAsset ? { "Access-Control-Allow-Origin": "*" } : {}) } });
}

async function bodyObject(req: Request): Promise<any> {
  const body = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function json(data: unknown, status = 200, headers: Record<string, string> = {}) { return Response.json(data, { status, headers }); }
async function fixture(name: string) { return Bun.file(new URL(`./fixtures/${name}`, root)).json(); }
