import { failureCode } from "./diagnostics";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { audit, provenance, provenanceFor, recentActivity } from "./audit";
import { ActionError, listActions, recordAction } from "./actions";
import { handleActivitiesApi } from "./activities";
import { handleConnectionsApi } from "./connections";
import { handleAgentIdentitiesApi } from "./agent-identity";
import { authenticateSecret, type TokenRecord } from "./auth";
import { brainClient, ensureBrain } from "./brain";
import {
  clearSessionCookie,
  parseSessionCookie,
  serializeSessionCookie,
} from "./cookies";
import { getMemoryEntry, upsertMemoryEntry } from "./memory-entries";
import { authenticateRequest } from "./auth";
import { handlePublicDeviceApi, isDeviceConsolePath } from "./device-auth";
import { handleOrgApi, handlePublicOrgApi, ingestTrailRequest, onboardingState, sessionActor } from "./org-api";
import { resolveOrg, withOrg } from "./orgs";
import { signupPolicy } from "./signup-invites";
import { canDelete, isHuman, normalizeToken } from "./policies";
import { handleSiteEvent } from "./site-analytics";
import { handleTasksApi, isTasksPath } from "./continuation";
import { callTool } from "./proxy";
import { resolveReview } from "./review/apply";
import { getReviewItem, listReviewItems } from "./review/store";
import { handlePublicShowcase, handleShowcaseApi } from "./showcase";
import { BillingError, handleBillingApi, handleBillingWebhook, publicPlans, requireHostedWriteAccess, requiresHostedEntitlement } from "./billing";
import { triggerProvisioning } from "./provisioning-trigger";
import { processingOrg } from "./privacy";
import { PUBLIC_PAGE_FILES } from "./site-routes";
import { handleInsightsApi } from "./insights";
import { handleMailUnsubscribe } from "./mail-series";
import { approvedTeamContextPages, isSharedContextSlug, sharedPageSummary } from "./shared-context-read";

export { SESSION_COOKIE_MAX_AGE, SESSION_COOKIE_NAME } from "./cookies";
export { clearSessionCookie, parseSessionCookie, serializeSessionCookie };

const PAGE_SORTS = new Set(["updated_desc", "updated_asc", "created_desc", "slug"]);
const HARD_EXCLUDED_SLUG_PREFIXES = ["test/", "attachments/", ".raw/"];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export class ToolTextError extends Error {
  text: string;

  constructor(text: string) {
    super(text);
    this.text = text;
  }
}

export interface PagesQuery {
  limit: number;
  offset: number;
  sort: string;
  tag: string | null;
}

export interface SearchQuery {
  q: string;
  limit: number;
}

export function hasConsoleHeader(headers: { get(name: string): string | null }): boolean {
  return headers.get("x-engram-console") === "1";
}

export function needsConsoleHeader(_method: string, pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function parseToolText(result: any): any {
  const raw = firstTextBlock(result) ?? "";
  if (result?.isError) throw new ToolTextError(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

export function coerceBoundedInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function coerceOffset(value: string | null): number {
  if (!value?.trim()) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function coercePagesQuery(params: URLSearchParams): PagesQuery | null {
  const sort = textParam(params, "sort") ?? "updated_desc";
  if (!PAGE_SORTS.has(sort)) return null;
  return {
    limit: coerceBoundedInt(params.get("limit"), 50, 1, 100),
    offset: coerceOffset(params.get("offset")),
    sort,
    tag: textParam(params, "tag"),
  };
}

export function coerceSearchQuery(params: URLSearchParams): SearchQuery | null {
  const q = textParam(params, "q");
  if (!q) return null;
  return {
    q,
    limit: coerceBoundedInt(params.get("limit"), 20, 1, 50),
  };
}

export function generateCaptureSlug(title: string | null, text: string, date: Date | string = new Date()): string {
  const day = typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
  const textStem = kebab(text.trim().split(/\s+/).slice(0, 6).join(" "));
  const stem = (title?.trim() ? kebab(title) : "") || textStem || "capture";
  const prefix = `notes/${day}-`;
  return prefix + trimSlugStem(stem, 60 - prefix.length);
}

export function captureMarkdown(title: string, text: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${text}`;
}

export function defaultWebDir(): string {
  return resolve(resolve(import.meta.dir, "../.."), process.env.ENGRAM_WEB_DIR ?? "web");
}

export function resolveStaticPath(pathname: string, webDir = defaultWebDir()): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\0")) return null;

  const root = resolve(webDir);
  const relativePath = decoded === "/" ? "index.html" : decoded.slice(1);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

export function contentTypeFor(pathname: string): string {
  return CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

export function forbiddenResponse(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

export async function handleWeb(req: Request): Promise<Response> {
  const response = await routeWeb(req);
  if (new URL(req.url).pathname.startsWith("/api/") && !response.headers.has("Cache-Control")) {
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
}

async function routeWeb(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/email/unsubscribe") return handleMailUnsubscribe(req);
  if (url.pathname === "/source" && req.method === "GET") return Response.redirect("https://github.com/Ani-HQ/engram", 302);
  if (url.pathname === "/hosted" && req.method === "GET") return Response.redirect("https://engram.ani.computer/pricing", 302);
  if (url.pathname === "/api/billing/webhook") return handleBillingWebhook(req);
  if (url.pathname === "/api/e") return handleSiteEvent(req);
  // The installer starts and polls without cookies or the console header.
  const deviceSignIn = await handlePublicDeviceApi(req, url);
  if (deviceSignIn) return deviceSignIn;
  if (url.pathname === "/api/plans" && ["GET", "HEAD"].includes(req.method)) {
    return new Response(req.method === "HEAD" ? null : JSON.stringify(publicPlans()), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/api/signup-policy" && ["GET", "HEAD"].includes(req.method)) {
    return new Response(req.method === "HEAD" ? null : JSON.stringify(signupPolicy()), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const showcase = await handlePublicShowcase(req);
  if (showcase) return showcase;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    if ((url.pathname === "/api/billing" || url.pathname.startsWith("/api/billing/")) && req.headers.get("authorization")) {
      const token = await authenticateRequest(req);
      if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
      const actor = normalizeToken(token), org = await resolveOrg(actor);
      return withOrg(org, actor, () => handleBillingApi(req, actor));
    }
    if (url.pathname === "/api/showcase" && req.headers.get("authorization")) {
      const token = await authenticateRequest(req);
      if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
      const actor = normalizeToken(token);
      const org = await resolveOrg(actor);
      return withOrg(org, actor, () => handleShowcaseApi(req, actor));
    }
    if (url.pathname === "/api/actions" && ["GET", "POST"].includes(req.method) && req.headers.get("authorization")) {
      return handleBearerActions(req, url);
    }
    if ((url.pathname === "/api/activities" || url.pathname.startsWith("/api/activities/")) && req.headers.get("authorization")) {
      const token = await authenticateRequest(req);
      if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
      const actor = normalizeToken(token);
      const expectedWorkspace = req.headers.get("x-engram-workspace");
      if (expectedWorkspace && expectedWorkspace !== String(actor.orgId)) return Response.json({ error: "The selected workspace changed. Please start the request again." }, { status: 409 });
      return withOrg(await resolveOrg(actor), actor, () => handleActivitiesApi(req, actor));
    }
    if (url.pathname === "/api/insights" && req.headers.get("authorization")) {
      const token = await authenticateRequest(req);
      if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
      const actor = normalizeToken(token);
      const expected = req.headers.get("x-engram-workspace");
      if (expected && expected !== String(actor.orgId)) return Response.json({ error: "The selected workspace changed. Please retry." }, { status: 409 });
      const org = await processingOrg(await resolveOrg(actor), actor);
      return withOrg(org, actor, () => handleInsightsApi(req, actor));
    }
    if (req.method === "POST" && url.pathname === "/api/trails" && req.headers.get("authorization")) {
      return handleBearerTrail(req);
    }
    return handleApi(req, url);
  }
  // Static files and the SPA shell answer GET/HEAD only. Without this, any method
  // on any unknown path returned the console HTML with a 200 — so a client still
  // POSTing to the deleted /t/<token>/mcp route got HTML and a success code
  // instead of a clear failure.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return serveStatic(url.pathname, req.method === "HEAD");
}

async function handleBearerTrail(req: Request): Promise<Response> {
  const token = await authenticateRequest(req);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  const actor = normalizeToken(token);
  const org = await processingOrg(await resolveOrg(actor), actor);
  return withOrg(org, actor, async () => {
    try { await requireHostedWriteAccess(actor); }
    catch (error) {
      if (error instanceof BillingError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
    await ensureBrain(org);
    return ingestTrailRequest(req, actor, org);
  });
}

async function handleBearerActions(req: Request, url: URL): Promise<Response> {
  const token = await authenticateRequest(req);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  const actor = normalizeToken(token);
  const org = await resolveOrg(actor);
  return withOrg(org, actor, () => actionsResponse(req, url, actor));
}

async function actionsResponse(req: Request, url: URL, token: TokenRecord): Promise<Response> {
  try {
    if (req.method === "GET") return Response.json(await listActions(token, url.searchParams));
    await requireHostedWriteAccess(token);
    if (Number(req.headers.get("content-length")) > 100_000) {
      return Response.json({ error: "Action payload is too large" }, { status: 413 });
    }
    return Response.json(await recordAction(token, await jsonObject(req)), { status: 201 });
  } catch (error) {
    if (error instanceof BillingError) return Response.json({ error: error.message, code: "subscription_required" }, { status: error.status });
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[actions] request failed");
    return Response.json({ error: "Action history is temporarily unavailable" }, { status: 503 });
  }
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  // The custom header is the CSRF boundary; browsers cannot send it cross-origin
  // without a preflight, and this gateway never emits CORS headers.
  if (needsConsoleHeader(req.method, url.pathname) && !hasConsoleHeader(req.headers)) {
    return forbiddenResponse();
  }

  if (req.method === "POST" && url.pathname === "/api/session") return postSession(req);
  if (req.method === "DELETE" && url.pathname === "/api/session") return deleteSession();

  const publicOrg = await handlePublicOrgApi(req, url);
  if (publicOrg) return publicOrg;

  let route: ((req: Request, url: URL, token: TokenRecord) => Response | Promise<Response>) | null = null;
  if (req.method === "GET" && url.pathname === "/api/me") route = getMe;
  else if (url.pathname === "/api/billing" || url.pathname.startsWith("/api/billing/")) route = (req, _url, actor) => handleBillingApi(req, actor);
  else if (url.pathname === "/api/showcase") route = (req, _url, actor) => handleShowcaseApi(req, actor);
  else if (["GET", "POST"].includes(req.method) && url.pathname === "/api/actions") route = actionsResponse;
  else if (url.pathname === "/api/connections") route = (req, _url, actor) => handleConnectionsApi(req, actor);
  else if (url.pathname === "/api/agent-identities") route = (req, _url, actor) => handleAgentIdentitiesApi(req, actor);
  else if (url.pathname === "/api/activities" || url.pathname.startsWith("/api/activities/")) route = (req, _url, actor) => handleActivitiesApi(req, actor);
  else if (url.pathname === "/api/insights") route = (req, _url, actor) => handleInsightsApi(req, actor);
  else if (isTasksPath(url.pathname)) route = (req, _url, actor) => handleTasksApi(req, actor);
  else if (req.method === "GET" && url.pathname === "/api/pages") route = getPages;
  else if (req.method === "GET" && url.pathname === "/api/search") route = getSearch;
  else if (req.method === "GET" && url.pathname === "/api/activity") route = getActivity;
  else if (req.method === "GET" && url.pathname === "/api/graph") route = getGraph;
  else if (req.method === "GET" && url.pathname === "/api/page") route = getPage;
  else if (req.method === "DELETE" && url.pathname === "/api/page") route = deletePage;
  else if (req.method === "POST" && url.pathname === "/api/page/restore") route = postRestorePage;
  else if (req.method === "POST" && url.pathname === "/api/capture") route = postCapture;
  else if (req.method === "GET" && url.pathname === "/api/review") route = getReview;
  else if (req.method === "GET" && url.pathname === "/api/review/item") route = getReviewDetail;
  else if (req.method === "POST" && url.pathname === "/api/review/approve") route = postReviewApprove;
  else if (req.method === "POST" && url.pathname === "/api/review/reject") route = postReviewReject;
  else if (req.method === "POST" && url.pathname === "/api/review/defer") route = postReviewDefer;
  const adminSignup = url.pathname === "/api/admin/signup-invites" || url.pathname.startsWith("/api/admin/signup-invites/");
  const workspaceMetadata = url.pathname === "/api/workspace";
  const deviceApproval = isDeviceConsolePath(url.pathname);
  const token = adminSignup && req.headers.get("authorization") ? await authenticateRequest(req) : await authenticateCookie(req);
  if (!token) {
    if (!route && !workspaceMetadata && !deviceApproval) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const actor = normalizeToken(token);
  const expectedWorkspace = req.headers.get("x-engram-workspace");
  if (expectedWorkspace && expectedWorkspace !== String(actor.orgId)) return Response.json({ error: "The selected workspace changed. Please start the export again." }, { status: 409 });
  const storedOrg = await resolveOrg(actor);
  // Account metadata and provisioning progress must remain available before a
  // tenant database exists. Every content route stays outside that context.
  const provisioningStatus = storedOrg.provisioningStatus ?? "ready";
  // A switch reads account metadata for a different authorized workspace. Keep
  // it outside the source tenant context, even when that source is ready; target
  // onboarding checks must not inherit the source workspace's isolation scope.
  if ((req.method === "POST" && url.pathname === "/api/session/switch") || adminSignup) {
    return await handleOrgApi(req, url, actor, storedOrg) ?? Response.json({ error: "not found" }, { status: 404 });
  }
  if (req.method === "GET" && (url.pathname === "/api/me" || url.pathname === "/api/provisioning")) {
    if (provisioningStatus !== "ready") await triggerProvisioning();
    return Response.json(await sessionActor(actor, storedOrg, { onboarding: await onboardingState(storedOrg) }), {
      status: provisioningStatus === "ready" ? 200 : 202,
      headers: { "Cache-Control": "no-store", ...(provisioningStatus === "ready" ? {} : { "Retry-After": "4" }) },
    });
  }
  if (provisioningStatus !== "ready") return Response.json({ error: "Your workspace is still being prepared. Please check again shortly.", code: "workspace_provisioning", provisioningStatus }, {
    status: 202, headers: { "Cache-Control": "no-store", "Retry-After": "4" },
  });
  // Workspace display metadata lives centrally and must not depend on tenant
  // storage, the memory engine, or a paid content-write entitlement.
  if (workspaceMetadata) return await handleOrgApi(req, url, actor, storedOrg) ?? Response.json({ error: "not found" }, { status: 404 });
  const org = ["/api/search", "/api/page", "/api/pages", "/api/capture", "/api/insights"].includes(url.pathname) ? await processingOrg(storedOrg, actor) : storedOrg;
  const lightweight = deviceApproval || isTasksPath(url.pathname) || url.pathname === "/api/sharing" || url.pathname.startsWith("/api/sharing/") || url.pathname === "/api/activities" || url.pathname.startsWith("/api/activities/") || url.pathname === "/api/insights" || ["/api/jev", "/api/actions", "/api/showcase", "/api/billing", "/api/billing/checkout", "/api/billing/portal", "/api/policies", "/api/tokens", "/api/connections", "/api/agent-identities", "/api/tokens/write", "/api/tokens/source", "/api/tokens/revoke", "/api/members", "/api/invites", "/api/wiring", "/api/me", "/api/onboarding"].includes(url.pathname);
  return withOrg(org, actor, async () => {
    if (url.pathname === "/api/billing" || url.pathname.startsWith("/api/billing/")) return handleBillingApi(req, actor);
    // Keep reads, billing recovery, revocation, privacy controls, deletion and
    // unpublishing available after a trial or subscription ends.
    if (requiresHostedEntitlement(req.method, url.pathname)) {
      try { await requireHostedWriteAccess(actor); }
      catch (error) {
        if (error instanceof BillingError) return Response.json({ error: error.message, code: "subscription_required" }, { status: error.status });
        throw error;
      }
    }
    const snapshotRead = req.method === "GET" && url.pathname === "/api/page" && isSharedContextSlug(url.searchParams.get("slug"));
    if (!lightweight && !snapshotRead) await ensureBrain(org);
    const orgRoute = await handleOrgApi(req, url, actor, org);
    if (orgRoute) return orgRoute;
    if (!route) return Response.json({ error: "not found" }, { status: 404 });
    return route(req, url, actor);
  });
}

async function postSession(req: Request): Promise<Response> {
  if (!signupPolicy().tokenSignInAllowed) {
    return Response.json({ error: "Sign in with email to use the hosted console.", code: "token_sign_in_disabled" }, { status: 403 });
  }
  const body = await jsonObject(req);
  const rawToken = typeof body?.token === "string" && body.token.trim() ? body.token.trim() : null;
  if (!rawToken) return Response.json({ error: "bad request" }, { status: 400 });
  const token = await authenticateSecret(rawToken);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  const org = await resolveOrg(token);
  return Response.json(await sessionActor(token, org, { onboarding: await onboardingState(org) }), {
    status: org.provisioningStatus && org.provisioningStatus !== "ready" ? 202 : 200,
    headers: { "Set-Cookie": serializeSessionCookie(rawToken) },
  });
}

function deleteSession(): Response {
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

async function getMe(_req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  const org = await resolveOrg(token);
  return Response.json(await sessionActor(token, org, { onboarding: await onboardingState(org) }));
}

async function getPages(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const query = coercePagesQuery(url.searchParams);
  if (!query) return Response.json({ error: "bad request" }, { status: 400 });

  const args: Record<string, unknown> = {
    limit: query.limit + query.offset + 1,
    offset: 0,
    sort: query.sort,
  };
  if (query.tag) args.tag = query.tag;

  // The browser/export window has its own bounded pagination. The MCP proxy's
  // 25-result context cap would silently truncate every larger browser request.
  let data: any;
  try { data = await brainTool("list_pages", args); await auditConsole(token, "list_pages", args, "ok"); }
  catch { return Response.json({ error: "Memory is temporarily unavailable" }, { status: 503 }); }
  const shared = query.tag ? [] : (await approvedTeamContextPages()).map(sharedPageSummary);
  const pages = normalizePageSummaries([...normalizePageSummaries(data).filter(page => !isSharedContextSlug(page.slug)), ...shared]);
  const window = sortPageSummaries(pages, query.sort).slice(query.offset, query.offset + query.limit);
  // One grouped query for the whole window, not one per row: the list is the hot path
  // and N round trips to answer a decoration would be the wrong trade.
  const provenances = await provenanceFor(window.map(page => String(page.slug)));
  return Response.json({
    pages: window.map(page => ({
      ...page,
      provenance: provenances.get(String(page.slug)) ?? { origin: null, contributors: [] },
    })),
    more: pages.length > query.offset + query.limit,
    scopes: ["shared"],
  });
}

async function getSearch(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const query = coerceSearchQuery(url.searchParams);
  if (!query) return Response.json({ error: "bad request" }, { status: 400 });

  const data = await readTool(token, "search", {
    query: query.q,
    limit: query.limit,
  });
  const results = normalizeSearchResults(data);
  return Response.json({ results: results.slice(0, query.limit) });
}

// The graph needs every page's body to find its links, which is one call per page.
// That is fine for a brain of this size and would not be at ten thousand, so it is
// capped and the answer says when it was cut rather than quietly returning half.
async function getActivity(_req: Request, url: URL, _token: TokenRecord): Promise<Response> {
  const asked = Number(url.searchParams.get("window"));
  return Response.json({ active: await recentActivity(Number.isFinite(asked) ? asked : 90) });
}

const GRAPH_MAX_NODES = 150;
const GRAPH_BATCH = 8;

async function getGraph(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const asked = Number(url.searchParams.get("limit"));
  const limit = Math.min(Number.isFinite(asked) && asked > 0 ? asked : GRAPH_MAX_NODES, GRAPH_MAX_NODES);

  const listed = normalizePageSummaries(
    await readTool(token, "list_pages", { limit: limit + 1, offset: 0, sort: "updated_desc" }),
  );
  const truncated = listed.length > limit;
  const pages = listed.slice(0, limit);
  const slugs = pages.map(page => String(page.slug));
  const known = new Set(slugs);

  const provenances = await provenanceFor(slugs);

  const edges: { source: string; target: string }[] = [];
  const seenEdge = new Set<string>();
  // gbrain multiplexes over its stdio channel, so a small batch is meaningfully
  // faster than one at a time without swamping the child.
  for (let i = 0; i < slugs.length; i += GRAPH_BATCH) {
    const batch = slugs.slice(i, i + GRAPH_BATCH);
    const bodies = await Promise.all(batch.map(async slug => {
      try {
        const page = normalizePageResult(await readTool(token, "get_page", { slug }), slug);
        return { slug, body: typeof page?.body === "string" ? page.body : "" };
      } catch {
        // A page that will not load costs its edges, not the whole graph.
        return { slug, body: "" };
      }
    }));
    for (const { slug, body } of bodies) {
      for (const link of deriveBodyLinks(body)) {
        if (link.slug === slug || !known.has(link.slug)) continue;
        // Undirected: one edge per pair, however many times they mention each other.
        const key = [slug, link.slug].sort().join("\u0000");
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push({ source: slug, target: link.slug });
      }
    }
  }

  const nodes = pages.map(page => {
    const slug = String(page.slug);
    const provenance = provenances.get(slug) ?? { origin: null, contributors: [] };
    return {
      slug,
      title: page.title || slug,
      type: page.type ?? "page",
      updated_at: page.updated_at ?? null,
      // Everything before the first slash. That is how these slugs are already
      // organised, so the clusters are the ones a person already thinks in.
      cluster: slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "other",
      origin: provenance.origin,
      contributors: provenance.contributors.map(who => who.name),
    };
  });

  return Response.json({ nodes, edges, truncated });
}

async function getPage(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const slug = textParam(url.searchParams, "slug");
  if (!slug) return Response.json({ error: "bad request" }, { status: 400 });

  const data = await readTool(token, "get_page", { slug });
  const normalized = normalizePageResult(data, slug);
  if (!normalized) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ...normalized, provenance: isSharedContextSlug(slug) ? { origin: null, contributors: [] } : await provenance(slug) });
}

async function deletePage(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const org = await resolveOrg(token);
  if (!canDelete(token, org.policies)) return forbiddenResponse();
  const slug = textParam(url.searchParams, "slug");
  if (isSharedContextSlug(slug)) return Response.json({ error: "Approved shared context is read-only. Its owner manages access." }, { status: 403 });
  if (!slug) {
    await auditConsole(token, "delete_page", {}, "bad_request");
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const args = { slug };
  try {
    const data = await brainTool("delete_page", args);
    const status = textField(data, "status");
    if (status === "soft_deleted" || status === "already_soft_deleted") {
      await auditConsole(token, "delete_page", args, "ok");
      return Response.json({
        ok: true,
        slug: textField(data, "slug") ?? slug,
        recoverable: true,
      });
    }

    await auditConsole(token, "delete_page", args, "error");
    return Response.json({ error: "bad request" }, { status: 400 });
  } catch (e) {
    const notFound = isPageNotFoundError(e);
    await auditConsole(token, "delete_page", args, notFound ? "not_found" : "error");
    if (notFound) return Response.json({ error: "not found" }, { status: 404 });
    console.error("[web] delete_page failed:", failureCode(e));
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

async function postRestorePage(req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  const org = await resolveOrg(token);
  if (!canDelete(token, org.policies)) return forbiddenResponse();
  const body = await jsonObject(req);
  const slug = optionalText(body?.slug);
  if (isSharedContextSlug(slug)) return Response.json({ error: "Approved shared context is read-only. Its owner manages access." }, { status: 403 });
  if (!slug) {
    await auditConsole(token, "restore_page", {}, "bad_request");
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const args = { slug };
  try {
    await brainTool("restore_page", args);
    await auditConsole(token, "restore_page", args, "ok");
    return Response.json({ ok: true, slug });
  } catch (e) {
    const notFound = isPageNotFoundError(e);
    await auditConsole(token, "restore_page", args, notFound ? "not_found" : "error");
    if (notFound) return Response.json({ error: "not found" }, { status: 404 });
    console.error("[web] restore_page failed:", failureCode(e));
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

async function postCapture(req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  const body = await jsonObject(req);
  const text = typeof body?.text === "string" ? body.text : null;
  if (!text?.trim()) return Response.json({ error: "bad request" }, { status: 400 });

  const title = captureTitle(optionalText(body?.title), text);
  const requestedSlug = optionalText(body?.slug);
  const slug = requestedSlug ?? await availableCaptureSlug(
    token,
    generateCaptureSlug(title, text),
  );
  const reason = rejectedSlugReason(slug);
  if (reason) return Response.json({ error: "bad request", message: reason }, { status: 400 });

  const args: Record<string, unknown> = { slug, content: captureMarkdown(title, text), expected_hash: null };

  try {
    parseToolText(await callTool(token, "put_page", args));
    await upsertMemoryEntry({
      slug,
      rawText: text.trim(),
      tokenName: token.name,
      topicHint: title,
    });
    return Response.json({ ok: true, slug });
  } catch (e) {
    if (String(e).toLowerCase().includes("denied")) return forbiddenResponse();
    console.error("[web] capture failed:", failureCode(e));
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

async function getReview(_req: Request, url: URL, _token: TokenRecord): Promise<Response> {
  const items = await listReviewItems({
    state: textParam(url.searchParams, "state") ?? "pending",
    kind: textParam(url.searchParams, "kind"),
    limit: coerceBoundedInt(url.searchParams.get("limit"), 40, 1, 100),
    offset: coerceOffset(url.searchParams.get("offset")),
  });
  return Response.json({ items, more: items.length === coerceBoundedInt(url.searchParams.get("limit"), 40, 1, 100) });
}

async function getReviewDetail(_req: Request, url: URL, _token: TokenRecord): Promise<Response> {
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id) || id < 1) return Response.json({ error: "bad request" }, { status: 400 });
  const item = await getReviewItem(id);
  if (!item) return Response.json({ error: "not found" }, { status: 404 });
  const entry = item.entryId ? await getMemoryEntry(item.entryId) : null;
  return Response.json({ item, entry: entry ? { id: entry.id, slug: entry.slug, rawText: entry.rawText, status: entry.status } : null });
}

async function postReviewApprove(req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  return resolveReviewResponse(req, token, "approve");
}

async function postReviewReject(req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  return resolveReviewResponse(req, token, "reject");
}

async function postReviewDefer(req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  return resolveReviewResponse(req, token, "defer");
}

async function resolveReviewResponse(
  req: Request,
  token: TokenRecord,
  action: "approve" | "reject" | "defer",
): Promise<Response> {
  const body = await jsonObject(req);
  const id = Number(body?.id);
  if (!Number.isFinite(id) || id < 1) return Response.json({ error: "bad request" }, { status: 400 });
  const result = await resolveReview(token, id, action);
  if (result.error === "not found") return Response.json({ error: "not found" }, { status: 404 });
  if (result.error) return Response.json({ error: result.error, item: result.item }, { status: 400 });
  return Response.json({ ok: true, item: result.item });
}

function isPublicBrandAsset(pathname: string): boolean {
  return pathname === "/brand" || pathname.startsWith("/brand/") || ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/site.webmanifest"].includes(pathname);
}

async function serveStatic(pathname: string, head = false): Promise<Response> {
  const webDir = defaultWebDir();
  const legacyClientRoute = pathname.startsWith("/workspace/");
  pathname = PUBLIC_PAGE_FILES[pathname] ?? pathname;
  const staticPath = resolveStaticPath(pathname, webDir);
  const notFound = () => new Response(head ? null : "Not Found", { status: 404, headers: { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
  if (!staticPath) return notFound();
  // Classify the resolved path, so an encoded /brand/../ path cannot grant CORS
  // to unrelated app files.
  const assetPath = `/${relative(webDir, staticPath).replaceAll("\\", "/")}`;
  const publicBrandAsset = isPublicBrandAsset(assetPath);
  if (await isFile(staticPath)) return fileResponse(staticPath, head, publicBrandAsset);
  if (publicBrandAsset || assetPath === "/oauth.css") return notFound();

  // Retain the existing legacy client path without turning arbitrary missing
  // pages and assets into successful HTML responses (soft 404s).
  const indexPath = legacyClientRoute ? resolveStaticPath("/index.html", webDir) : null;
  if (indexPath && await isFile(indexPath)) return fileResponse(indexPath, head);
  const missingPage = !extname(pathname) ? resolveStaticPath("/not-found.html", webDir) : null;
  if (missingPage && await isFile(missingPage)) return fileResponse(missingPage, head, false, 404);
  return notFound();
}

function fileResponse(pathname: string, head = false, publicBrandAsset = false, status = 200): Response {
  return new Response(head ? null : Bun.file(pathname), {
    status,
    headers: { "Content-Type": contentTypeFor(pathname), "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", ...(publicBrandAsset ? { "Access-Control-Allow-Origin": "*" } : {}) },
  });
}

async function authenticateCookie(req: Request): Promise<TokenRecord | null> {
  const rawToken = parseSessionCookie(req.headers.get("cookie"));
  const actor = rawToken ? await authenticateSecret(rawToken) : null;
  // Hosted console authority comes from email verification and live membership.
  // Agent tokens remain valid bearer credentials, including on self-hosted installs.
  if (!signupPolicy().tokenSignInAllowed && (actor?.kind !== "session" || !actor.email || !isHuman(actor))) return null;
  return actor;
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

async function isFile(pathname: string): Promise<boolean> {
  try {
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

async function readTool(
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  try {
    return parseToolText(await callTool(token, name, args));
  } catch (e) {
    console.error(`[web] ${name} failed:`, failureCode(e));
    return null;
  }
}

async function brainTool(name: string, args: Record<string, unknown>): Promise<any> {
  return parseToolText(await brainClient().callTool({ name, arguments: args }));
}

async function auditConsole(
  token: TokenRecord,
  tool: string,
  args: Record<string, unknown>,
  outcome: string,
): Promise<void> {
  const slug = typeof args?.slug === "string" ? args.slug : null;
  await audit(token.name, tool, summarizeArgs(args), outcome, slug);
}

function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {}).slice(0, 200);
}

export function normalizePageSummaries(data: any) {
  return arrayFrom(data, ["pages", "results", "items", "data"]).map(row => ({
    slug: textField(row, "slug") ?? "",
    title: textField(row, "title") ?? textField(row, "slug") ?? "",
    type: textField(row, "type") ?? "note",
    source_id: textField(row, "source_id") ?? textField(row, "sourceId") ?? "default",
    updated_at: timestampField(row, "updated_at") ?? timestampField(row, "updatedAt") ?? "",
    created_at: timestampField(row, "created_at") ?? timestampField(row, "createdAt") ?? "",
  })).filter(page => page.slug);
}

export function normalizeSearchResults(data: any) {
  return arrayFrom(data, ["results", "pages", "items", "matches", "data"]).map(row => ({
    slug: textField(row, "slug") ?? "",
    title: textField(row, "title") ?? textField(row, "slug") ?? "",
    updated_at:
      timestampField(row, "updated_at") ??
      timestampField(row, "updatedAt") ??
      timestampField(row, "effective_date") ??
      timestampField(row, "effectiveDate") ??
      "",
    snippet: textField(row, "chunk_text") ?? textField(row, "snippet") ?? textField(row, "excerpt") ?? "",
  })).filter(result => result.slug);
}

export function normalizePageResult(data: any, slug: string) {
  if (typeof data?.error === "string" && data.error.toLowerCase().includes("not found")) return null;

  const source = data?.page && typeof data.page === "object" ? data.page : data;
  const body =
    textField(source, "body") ??
    textField(source, "content") ??
    textField(source, "compiled_truth") ??
    textField(data, "text") ??
    "";
  if (!body && !textField(source, "slug")) return null;

  return {
    page: {
      slug: textField(source, "slug") ?? slug,
      title: textField(source, "title") ?? slug,
      type: textField(source, "type") ?? "note",
      updated_at: timestampField(source, "updated_at") ?? timestampField(source, "updatedAt") ?? "",
      body,
    },
    links: deriveBodyLinks(body),
    timeline: normalizeTimeline(data?.timeline ?? source?.timeline),
  };
}

export function rejectedSlugReason(slug: string | null): string | null {
  if (!slug) return null;
  if (isSharedContextSlug(slug)) return "approved shared context is read-only";
  const prefix = HARD_EXCLUDED_SLUG_PREFIXES.find(p => slug.startsWith(p));
  return prefix ? `slug prefix '${prefix}' is hard-excluded from search` : null;
}

export function sortPageSummaries(pages: any[], sort: string): any[] {
  return [...pages].sort((a, b) => {
    if (sort === "slug") return a.slug.localeCompare(b.slug);
    const key = sort === "created_desc" ? "created_at" : "updated_at";
    const aDate = sort === "created_desc" ? a[key] || a.updated_at : a[key];
    const bDate = sort === "created_desc" ? b[key] || b.updated_at : b[key];
    const diff = timeValue(aDate) - timeValue(bDate);
    return sort === "updated_asc" ? diff : -diff;
  }).map(({ created_at: _createdAt, ...page }) => page);
}

export function deriveBodyLinks(body: string) {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const add = (target: string) => {
    const slug = cleanInternalTarget(target);
    if (!slug || seen.has(slug) || slugs.length >= 12) return;
    seen.add(slug);
    slugs.push(slug);
  };

  for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    add(match[1].split("|")[0]);
  }
  for (const match of body.matchAll(/\[[^\]]*]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    add(match[1]);
  }

  return slugs.map(slug => ({
    slug,
    title: titleFromSlug(slug),
    relation: "body",
  }));
}

export function normalizeTimeline(value: any) {
  if (typeof value === "string") {
    return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(parseTimelineLine);
  }
  return Array.isArray(value) ? value.map(item => ({
    at: timestampField(item, "at") ?? timestampField(item, "created_at") ?? "",
    text: textField(item, "text") ?? textField(item, "body") ?? "",
  })).filter(item => item.text) : [];
}

function textParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstTextBlock(result: any): string | null {
  if (Array.isArray(result?.content)) {
    const block = result.content.find((c: any) => c?.type === "text" && typeof c.text === "string");
    return block?.text ?? null;
  }
  return typeof result?.content === "string" ? result.content : null;
}

function isPageNotFoundError(error: unknown): boolean {
  const text = error instanceof ToolTextError ? error.text : String(error);
  return text.toLowerCase().includes("page_not_found");
}

function arrayFrom(data: any, keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function textField(value: any, key: string): string | null {
  const text = value?.[key];
  return typeof text === "string" ? text : null;
}

function timestampField(value: any, key: string): string | null {
  const text = textField(value, key);
  return text ? text : null;
}

function captureTitle(title: string | null, text: string): string {
  return title ?? text.trim().split(/\s+/).slice(0, 6).join(" ");
}

async function availableCaptureSlug(token: TokenRecord, baseSlug: string): Promise<string> {
  if (!await pageExists(token, baseSlug)) return baseSlug;

  for (let i = 0; i < 8; i += 1) {
    const candidate = suffixedSlug(baseSlug, randomSuffix());
    if (!await pageExists(token, candidate)) return candidate;
  }
  return suffixedSlug(baseSlug, randomSuffix());
}

async function pageExists(token: TokenRecord, slug: string): Promise<boolean> {
  try {
    const data = parseToolText(await callTool(token, "get_page", { slug }));
    return normalizePageResult(data, slug) !== null;
  } catch {
    return false;
  }
}

function kebab(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function trimSlugStem(stem: string, maxLength: number): string {
  return stem.slice(0, maxLength).replace(/-+$/g, "") || "capture";
}

function suffixedSlug(baseSlug: string, suffix: string): string {
  return `${trimSlugStem(baseSlug, 60 - suffix.length - 1)}-${suffix}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6) || "x";
}

function cleanInternalTarget(target: string): string | null {
  const withoutAlias = target.trim().replace(/^<|>$/g, "").split("#")[0].split("?")[0];
  if (!withoutAlias || withoutAlias.startsWith("#") || withoutAlias.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutAlias)) return null;
  return withoutAlias.includes("/") ? withoutAlias.replace(/^\/+/, "") : null;
}

function titleFromSlug(slug: string): string {
  const last = slug.split("/").filter(Boolean).pop() ?? slug;
  return last.replace(/[-_]+/g, " ");
}

function parseTimelineLine(line: string) {
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?)(?:\s*(?:-|\u2014|:)\s*|\s+)?(.*)$/,
  );
  return match ? { at: match[1], text: match[2] } : { at: "", text: line };
}

function timeValue(value: unknown): number {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isNaN(parsed) ? 0 : parsed;
}
