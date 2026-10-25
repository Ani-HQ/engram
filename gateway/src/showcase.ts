import type postgres from "postgres";
import { ShowcaseError, parseShowcaseInput, publicActivitySnapshot, renderShowcaseCard, renderShowcasePage, renderShowcasePng, renderUnavailableShowcasePage, showcaseUrls, validShowcaseSlug, type ShowcaseProfile, type PublicActivity } from "./showcase-view";
export * from "./showcase-view";
import { config, databaseSecurity, dbUrl } from "./config";
import { currentOrg } from "./context";
import { sql } from "./db";
import { hasOauthScope, normalizeToken, type TokenRecord } from "./policies";
import { BillingError, requireHostedWriteAccess } from "./billing";
import { actionLedger } from "./actions";
import { createShowcaseStreamManager } from "./showcase-stream";
import { publicActivityLedger } from "./public-activity";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const PUBLIC_JSON_HEADERS = { ...NO_STORE, "Access-Control-Allow-Origin": "*" };

function owner(token: TokenRecord, write = false): TokenRecord {
  const actor = normalizeToken(token);
  if (actor.role !== "owner" || actor.kind === "oauth" || (currentOrg() && currentOrg()!.id !== actor.orgId) ||
      !hasOauthScope(actor, write ? "memory:write" : "memory:read") || (write && !actor.canWrite)) {
    throw new ShowcaseError("Only a workspace owner can " + (write ? "update" : "view") + " showcase settings", 403);
  }
  return actor;
}

function mapProfile(row: any): ShowcaseProfile {
  // Avoid publishing the workspace name or token identity as implicit defaults.
  if (!row) return { slug: "", displayName: "", bio: "", published: false, showActivity: false };
  return { slug: String(row.slug), displayName: String(row.display_name), bio: String(row.bio), published: row.published === true, showActivity: row.show_activity === true };
}

export async function getShowcaseSettings(token: TokenRecord, origin: string, db: postgres.Sql = sql) {
  const actor = owner(token);
  const rows = await db`SELECT slug, display_name, bio, published, show_activity FROM action_profiles WHERE org_id = ${actor.orgId}`;
  const profile = mapProfile(rows[0]);
  return { profile, urls: showcaseUrls(profile, config.publicUrl || origin), preview: await getOrgActivitySnapshot(profile, actor.orgId, db, undefined, true) };
}

export async function updateShowcaseSettings(token: TokenRecord, raw: unknown, origin: string, db: postgres.Sql = sql) {
  const actor = owner(token, true);
  const profile = parseShowcaseInput(raw);
  if (profile.published) await requireHostedWriteAccess(actor);
  try {
    await db`
      INSERT INTO action_profiles (org_id, slug, display_name, bio, published, show_activity)
      VALUES (${actor.orgId}, ${profile.slug}, ${profile.displayName}, ${profile.bio}, ${profile.published}, ${profile.showActivity === true})
      ON CONFLICT (org_id) DO UPDATE SET slug = EXCLUDED.slug, display_name = EXCLUDED.display_name,
        bio = EXCLUDED.bio, published = EXCLUDED.published, show_activity = EXCLUDED.show_activity, updated_at = now()`;
  } catch (error: any) {
    if (error?.code === "23505") throw new ShowcaseError("That showcase address is already taken", 409);
    throw error;
  }
  return { profile, urls: showcaseUrls(profile, config.publicUrl || origin), preview: await getOrgActivitySnapshot(profile, actor.orgId, db, undefined, true) };
}

export async function getPublicActivity(slug: string, db: postgres.Sql = sql, now?: Date): Promise<PublicActivity | null> {
  if (!validShowcaseSlug(slug)) return null;
  return publishedSnapshot(slug, db, now);
}

async function publishedSnapshot(slug: string, db: postgres.Sql, now?: Date, expectedPublication?: string): Promise<PublicActivity | null> {
  const published = await publishedProfile(slug, db);
  if (!published) return null;
  const binding = publicationKey(published);
  if (expectedPublication && binding !== expectedPublication) return null;
  const activity = await getOrgActivitySnapshot(mapProfile(published), Number(published.org_id), db, now);
  // Aggregation can outlive a publication change in another request/instance.
  // Do not return counts read after revocation or from a reassigned public slug.
  const current = await publishedProfile(slug, db);
  return current && publicationKey(current) === binding ? activity : null;
}

async function publishedProfile(slug: string, db: postgres.Sql) {
  const profiles = await db`
    SELECT org_id, slug, display_name, bio, published, show_activity, updated_at::text AS publication_revision FROM action_profiles
    WHERE slug = ${slug} AND published = true`;
  return profiles[0] ?? null;
}

const streamManagers = new WeakMap<postgres.Sql, ReturnType<typeof createShowcaseStreamManager>>();
function publicationKey(row: any): string {
  // This internal binding never enters the public projection or SSE frames.
  // Keep PostgreSQL's full timestamp precision instead of truncating to JS ms.
  return JSON.stringify([row.org_id, row.publication_revision, row.slug, row.display_name, row.bio, row.show_activity === true]);
}
function streams(db: postgres.Sql) {
  let manager = streamManagers.get(db);
  if (!manager) {
    manager = createShowcaseStreamManager({
      publication: async slug => {
        const published = await publishedProfile(slug, db);
        return published ? publicationKey(published) : null;
      },
      snapshot: (slug, expected) => publishedSnapshot(slug, db, undefined, expected),
    });
    streamManagers.set(db, manager);
  }
  return manager;
}

async function getOrgActivitySnapshot(profile: ShowcaseProfile, orgId: number, db: postgres.Sql, now?: Date, preview = false): Promise<PublicActivity> {
  const queryAt = now ?? new Date();
  const start = new Date(Date.UTC(queryAt.getUTCFullYear(), queryAt.getUTCMonth(), queryAt.getUTCDate()) - 83 * 86_400_000).toISOString();
  const end = new Date(Date.UTC(queryAt.getUTCFullYear(), queryAt.getUTCMonth(), queryAt.getUTCDate()) + 86_400_000).toISOString();
  const recent = new Date(queryAt.getTime() - 15 * 60_000).toISOString();
  const ledger = actionLedger(db, orgId, { aggregate: true });
  // This query returns aggregates. The optional ledger below passes through a
  // separate closed projection before any event enters a public response.
  const rows = await db`
    WITH ledger AS (${ledger}), bounds AS (SELECT ${recent}::timestamptz AS recent_cutoff), categorized AS (
      SELECT *, CASE
        WHEN tool IN ('search', 'get_page', 'list_pages', 'put_page', 'remember', 'recall', 'add_tag', 'add_link', 'add_timeline_entry') THEN 'memory'
        WHEN tool ~ '(calendar|gcal)' THEN 'calendar'
        WHEN tool ~ '(email|gmail|mail[._])' THEN 'email'
        WHEN tool ~ '(deploy|cloud|aws|azure|docker|kubernetes|vercel)' THEN 'cloud'
        WHEN tool ~ '(github|gitlab|commit|pull_request|code|shell|terminal|exec_command|build)' THEN 'code'
        WHEN tool ~ '(file|drive|dropbox|directory|read_text|write_text)' THEN 'files'
        WHEN tool ~ '(browser|browse|playwright|web[._]|search)' THEN 'browser'
        WHEN tool ~ '(sql|database|postgres|spreadsheet|sheets|query)' THEN 'data'
        WHEN tool ~ '(memory|remember|recall|page|add_tag|add_link|timeline)' THEN 'memory'
        ELSE 'other' END AS category FROM ledger
    ), days AS (
      SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, count(*) AS count
      FROM ledger WHERE occurred_at >= ${start}::timestamptz AND occurred_at < ${end}::timestamptz
      GROUP BY 1
    ), categories AS (
      SELECT category, count(*) AS count FROM categorized GROUP BY category
    ) SELECT count(*) AS total_actions,
      count(*) FILTER (WHERE status = 'completed') AS completed_actions,
      count(*) FILTER (WHERE status = 'failed') AS failed_actions,
      count(*) FILTER (WHERE status = 'running') AS running_actions,
      count(DISTINCT agent) AS active_agents,
      count(DISTINCT (occurred_at AT TIME ZONE 'UTC')::date) AS active_days,
      max(occurred_at) AS updated_at,
      count(DISTINCT agent) FILTER (WHERE status = 'running' AND recorded_at >= bounds.recent_cutoff) AS working_agents,
      count(DISTINCT agent) FILTER (WHERE recorded_at >= bounds.recent_cutoff) AS recently_active_agents,
      count(DISTINCT agent) FILTER (WHERE status = 'completed') AS completed_agents,
      count(DISTINCT agent) FILTER (WHERE status = 'failed') AS failed_agents,
      count(*) FILTER (WHERE status = 'running' AND recorded_at >= bounds.recent_cutoff) AS working_actions,
      count(*) FILTER (WHERE status = 'running' AND recorded_at < bounds.recent_cutoff) AS stale_actions,
      max(recorded_at) AS last_activity_at,
      (SELECT coalesce(json_agg(days ORDER BY date), '[]'::json) FROM days) AS daily,
      (SELECT coalesce(json_agg(categories), '[]'::json) FROM categories) AS tools
    FROM ledger CROSS JOIN bounds`;
  const events = profile.showActivity === true || preview ? await publicActivityLedger(db, orgId) : [];
  // Receipts may arrive while these reads are pending. Observe after the reads
  // so a newly received running event is not mistaken for a future timestamp.
  // An explicitly supplied clock remains fixed for deterministic callers.
  const observedAt = now ?? new Date();
  // A stable deployment secret keeps public IDs opaque across polls/restarts.
  // Legacy self-hosted installs use their existing server-only database URL.
  return publicActivitySnapshot(profile, rows[0], observedAt, { rows: events, scope: `${orgId}:${profile.slug}`, key: databaseSecurity.tenantCredentialKey || dbUrl("engram_gateway"), preview });
}

export async function handleShowcaseApi(req: Request, token: TokenRecord, db: postgres.Sql = sql): Promise<Response> {
  const origin = new URL(req.url).origin;
  try {
    if (req.method === "GET") return Response.json(await getShowcaseSettings(token, origin, db), { headers: NO_STORE });
    if (req.method !== "PUT") return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "GET, PUT" } });
    // Check identity before reading untrusted input or revealing validation errors.
    owner(token, true);
    if (Number(req.headers.get("content-length")) > 10_000) throw new ShowcaseError("Profile payload is too large", 413);
    const raw = await req.text();
    if (raw.length > 10_000) throw new ShowcaseError("Profile payload is too large", 413);
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new ShowcaseError("Expected a profile object"); }
    return Response.json(await updateShowcaseSettings(token, input, origin, db), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof BillingError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    if (error instanceof ShowcaseError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    console.error("[showcase] settings unavailable");
    return Response.json({ error: "Showcase settings are temporarily unavailable" }, { status: 503, headers: NO_STORE });
  }
}

export async function handlePublicShowcase(req: Request, db: postgres.Sql = sql): Promise<Response | null> {
  const url = new URL(req.url);
  const stream = /^\/api\/public\/activity\/([^/]+)\/stream$/.exec(url.pathname);
  if (stream) return streams(db).handle(req, stream[1]);
  const api = /^\/api\/public\/activity\/([^/]+)(\/card\.(?:svg|png))?$/.exec(url.pathname);
  const page = /^\/u\/([^/]+)$/.exec(url.pathname);
  if (!api && !page) return null;
  const headers = api && !api[2] ? PUBLIC_JSON_HEADERS : NO_STORE;
  if (req.method === "OPTIONS" && api && !api[2]) return new Response(null, {
    status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" },
  });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  try {
    const activity = await getPublicActivity((api ?? page)![1], db);
    if (!activity) return new Response(req.method === "HEAD" ? null : page ? renderUnavailableShowcasePage() : "Not Found", { status: 404, headers: { ...headers, "X-Robots-Tag": "noindex", "Content-Type": page ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" } });
    if (api && !api[2]) return new Response(req.method === "HEAD" ? null : JSON.stringify(activity), { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    const card = Boolean(api?.[2]);
    return new Response(req.method === "HEAD" ? null : card ? (api![2].endsWith("png") ? await renderShowcasePng(activity) : renderShowcaseCard(activity)) : renderShowcasePage(activity, config.publicUrl || url.origin), {
      headers: { ...headers, "Content-Type": card ? (api![2].endsWith("png") ? "image/png" : "image/svg+xml; charset=utf-8") : "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" },
    });
  } catch {
    console.error("[showcase] public activity unavailable");
    return new Response("Activity is temporarily unavailable", { status: 503, headers });
  }
}
