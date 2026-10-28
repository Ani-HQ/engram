import { createHash, createHmac } from "node:crypto";
import type postgres from "postgres";
import { sql } from "./db";
import { failureCode } from "./diagnostics";

// First-party, cookieless site analytics. It counts page views, a few named
// calls to action and sign-up submissions with their campaign source. It stores
// no IP address, email or account identity: a visitor is a keyed hash of
// address and browser that rotates every UTC day, so visits cannot be joined
// across days or to a person. Do Not Track and Global Privacy Control are
// honoured in the browser and here.

export const SITE_EVENTS = ["pageview", "cta", "signup_submitted"] as const;
export type SiteEventName = typeof SITE_EVENTS[number];
export const CTA_IDS = ["ask-invite", "redeem-invite", "sign-in", "self-host", "pricing", "how-it-works", "source", "support"] as const;
const RETENTION_DAYS = 395;
const MAX_BODY = 2_048;
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|httpclient|go-http|axios|node-fetch|bun\//i;

export interface Attribution { utmSource?: string; utmMedium?: string; utmCampaign?: string; referrerHost?: string; landingPath?: string }
export interface SiteEvent extends Attribution { name: SiteEventName; path: string; cta?: string }

function token(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase().slice(0, max);
  return /^[a-z0-9][a-z0-9._+-]*$/.test(trimmed) ? trimmed : undefined;
}

export function cleanPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return undefined;
  // Never keep a query or fragment: they can carry invite codes or tokens.
  const path = value.split(/[?#]/)[0].slice(0, 120);
  return /^\/[A-Za-z0-9/_.-]*$/.test(path) ? path : undefined;
}

export function cleanHost(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "").slice(0, 100) || undefined;
  } catch { return undefined; }
}

export function parseAttribution(raw: unknown): Attribution {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const result: Attribution = {};
  const source = token(input.utmSource), medium = token(input.utmMedium), campaign = token(input.utmCampaign);
  const referrer = cleanHost(input.referrerHost), landing = cleanPath(input.landingPath);
  if (source) result.utmSource = source;
  if (medium) result.utmMedium = medium;
  if (campaign) result.utmCampaign = campaign;
  if (referrer) result.referrerHost = referrer;
  if (landing) result.landingPath = landing;
  return result;
}

export function parseSiteEvent(raw: unknown): SiteEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.name !== "pageview" && input.name !== "cta") return null;
  const path = cleanPath(input.path);
  if (!path) return null;
  const cta = input.name === "cta" ? (CTA_IDS as readonly string[]).find(id => id === input.cta) : undefined;
  if (input.name === "cta" && !cta) return null;
  return { name: input.name, path, ...(cta ? { cta } : {}), ...parseAttribution(input) };
}

function optedOut(req: Request): boolean {
  return req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1";
}

/** A keyed daily hash. The key never leaves the server and the day is part of
 * the input, so yesterday's visitor and today's cannot be linked. */
export function clientAddress(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function visitorFor(req: Request, secret: string, now = new Date()): string {
  const address = clientAddress(req);
  const day = now.toISOString().slice(0, 10);
  return createHmac("sha256", createHash("sha256").update(`engram-site-analytics\n${secret}`).digest())
    .update(`${day}\n${address}\n${req.headers.get("user-agent") ?? ""}`).digest("hex").slice(0, 24);
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

// A small per-process ceiling stops one client from flooding the table.
const recent = new Map<string, number[]>();
function limited(visitor: string, now = Date.now()): boolean {
  const times = (recent.get(visitor) ?? []).filter(time => now - time < 60_000);
  if (times.length >= 30) return true;
  times.push(now); recent.set(visitor, times);
  if (recent.size > 10_000) recent.clear();
  return false;
}

export interface SiteAnalyticsDeps { db?: postgres.Sql; secret?: string; now?: Date }

export async function recordSiteEvent(event: SiteEvent | (Attribution & { name: "signup_submitted"; path: string }), req: Request, deps: SiteAnalyticsDeps = {}): Promise<boolean> {
  if (optedOut(req) || BOT.test(req.headers.get("user-agent") ?? "")) return false;
  const visitor = visitorFor(req, deps.secret ?? process.env.ENGRAM_TENANT_CREDENTIAL_KEY ?? "engram", deps.now);
  if (limited(visitor)) return false;
  const db = deps.db ?? sql;
  try {
    await db`
      INSERT INTO site_events (name, path, cta, referrer_host, utm_source, utm_medium, utm_campaign, landing_path, visitor)
      VALUES (${event.name}, ${event.path}, ${(event as SiteEvent).cta ?? null}, ${event.referrerHost ?? null}, ${event.utmSource ?? null},
              ${event.utmMedium ?? null}, ${event.utmCampaign ?? null}, ${event.landingPath ?? null}, ${visitor})`;
    if (Math.random() < 0.002) await db`DELETE FROM site_events WHERE at < now() - make_interval(days => ${RETENTION_DAYS})`;
    return true;
  } catch (error) {
    // Analytics never breaks a page or a sign-up.
    console.warn("[site-analytics] event not recorded:", failureCode(error));
    return false;
  }
}

/** POST /api/e from the bundled first-party script. Always answers 204. */
export async function handleSiteEvent(req: Request, deps: SiteAnalyticsDeps = {}): Promise<Response> {
  const done = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST" || !sameOrigin(req) || Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return done;
  let raw: unknown;
  try { const text = await req.text(); if (text.length > MAX_BODY) return done; raw = JSON.parse(text); } catch { return done; }
  const event = parseSiteEvent(raw);
  if (event) await recordSiteEvent(event, req, deps);
  return done;
}

/** Operator report: top of funnel from site_events, the rest from records the
 * product already keeps. Counts only; no emails, names or memory text. */
export async function siteReport(days: number, db: postgres.Sql = sql) {
  const since = db`now() - make_interval(days => ${days})`;
  const [traffic, pages, referrers, campaigns, ctas, funnel] = await Promise.all([
    db`SELECT count(*) FILTER (WHERE name = 'pageview')::int AS pageviews, count(DISTINCT visitor) FILTER (WHERE name = 'pageview')::int AS visitor_days,
              count(*) FILTER (WHERE name = 'signup_submitted')::int AS signups_submitted FROM site_events WHERE at > ${since}`,
    db`SELECT path, count(*)::int AS views, count(DISTINCT visitor)::int AS visitor_days FROM site_events WHERE name = 'pageview' AND at > ${since} GROUP BY path ORDER BY views DESC LIMIT 15`,
    db`SELECT coalesce(referrer_host, '(direct)') AS referrer, count(DISTINCT visitor)::int AS visitor_days FROM site_events WHERE name = 'pageview' AND at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
    db`SELECT coalesce(utm_source, '-') AS source, coalesce(utm_medium, '-') AS medium, coalesce(utm_campaign, '-') AS campaign,
              count(DISTINCT visitor) FILTER (WHERE name = 'pageview')::int AS visitor_days,
              count(*) FILTER (WHERE name = 'cta' AND cta = 'ask-invite')::int AS invite_requests,
              count(*) FILTER (WHERE name = 'signup_submitted')::int AS signups_submitted
       FROM site_events WHERE at > ${since} AND (utm_source IS NOT NULL OR utm_campaign IS NOT NULL) GROUP BY 1, 2, 3 ORDER BY visitor_days DESC LIMIT 20`,
    db`SELECT cta, count(*)::int AS clicks FROM site_events WHERE name = 'cta' AND at > ${since} GROUP BY cta ORDER BY clicks DESC`,
    db`WITH cohort AS (SELECT id FROM orgs WHERE created_at > ${since} AND id <> 1)
       SELECT (SELECT count(*) FROM cohort)::int AS workspaces_created,
         (SELECT count(DISTINCT a.org_id) FROM audit_log a JOIN cohort c ON c.id = a.org_id WHERE a.outcome = 'ok')::int AS with_agent_call,
         (SELECT count(DISTINCT a.org_id) FROM audit_log a JOIN cohort c ON c.id = a.org_id WHERE a.outcome = 'ok' AND a.tool = 'remember')::int AS saved_memory,
         (SELECT count(DISTINCT a.org_id) FROM audit_log a JOIN cohort c ON c.id = a.org_id WHERE a.outcome = 'ok' AND a.tool = 'recall')::int AS recalled_memory,
         (SELECT count(DISTINCT a.org_id) FROM audit_log a JOIN cohort c ON c.id = a.org_id WHERE a.outcome = 'ok' AND a.tool = 'checkpoint_task')::int AS saved_handoff,
         (SELECT count(DISTINCT a.org_id) FROM audit_log a JOIN cohort c ON c.id = a.org_id WHERE a.outcome = 'ok' AND a.tool = 'resume_task')::int AS resumed_handoff,
         (SELECT count(*) FROM workspace_billing b JOIN cohort c ON c.id = b.org_id WHERE b.checkout_generation > 0 OR b.checkout_session_id IS NOT NULL)::int AS started_checkout,
         (SELECT count(*) FROM workspace_billing b JOIN cohort c ON c.id = b.org_id WHERE b.status = 'active')::int AS paying`,
  ]);
  return { days, traffic: traffic[0], funnel: funnel[0], ctas, pages, referrers, campaigns,
    notes: ["Visitor counts are visitor-days: a visitor hash rotates daily and cannot be followed across days.", "Funnel steps after sign-up come from workspace records and observed Engram calls, for workspaces created in this window.", "Browsers sending Do Not Track or Global Privacy Control are not counted."] };
}
