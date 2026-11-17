import type postgres from "postgres";
import { sql } from "./db";
import { ActionError, actionActorFor } from "./actions";
import { authenticateRequest } from "./auth";
import { BillingError, requireHostedWriteAccess } from "./billing";
import { resolveOrg, withOrg } from "./orgs";
import { normalizeToken, type TokenRecord } from "./policies";
import { PRODUCTS } from "./public-activity";

// Connectors read token COUNTS from an agent's local session log and send
// cumulative per-session totals. Engram never sees the session's text, and it
// never observes these numbers itself: they are agent-side reports.
export const TOKEN_USAGE_BODY_LIMIT = 2048;
export const TOKEN_USAGE_MAX_COUNT = 1e12;
// One report may add at most this many tokens across all four counters, so a
// single corrupt or hostile report cannot dominate a public profile.
// Generous: a long session's first report after an upgrade can carry billions of cache reads.
export const TOKEN_USAGE_MAX_DELTA = 5e10;
// New sessions per credential per hour. Retries of known sessions are free.
export const TOKEN_USAGE_NEW_SESSIONS_PER_HOUR = 240;
// Hourly buckets feed the 84-day public series; all-time totals live on sessions.
export const TOKEN_USAGE_HOURLY_RETENTION_DAYS = 120;
export const TOKEN_USAGE_SOURCE = "local-session-logs";

const FIELDS = new Set(["harness", "session", "model", "input", "output", "cacheRead", "cacheWrite", "occurredAt"]);
const COUNTERS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type Counter = typeof COUNTERS[number];
export type TokenCounts = Record<Counter, number>;

export interface TokenUsageReport extends TokenCounts {
  harness: string;
  session: string;
  model: string | null;
  occurredAt: string | null;
}

export class TokenUsageError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

function invalid(): never { throw new TokenUsageError("invalid_usage", 400); }

export function knownHarness(value: unknown): string {
  return typeof value === "string" && value !== "other" && Object.hasOwn(PRODUCTS, value) ? value : "other";
}

export function parseTokenUsage(raw: unknown, now = new Date()): TokenUsageReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !FIELDS.has(key))) invalid();
  if (typeof input.harness !== "string" || input.harness.length > 80) invalid();
  if (typeof input.session !== "string" || !/^[a-f0-9]{64}$/.test(input.session)) invalid();
  if (input.model !== undefined && (typeof input.model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(input.model))) invalid();
  const counts = {} as TokenCounts;
  for (const key of COUNTERS) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > TOKEN_USAGE_MAX_COUNT) invalid();
    counts[key] = value;
  }
  let occurredAt: string | null = null;
  if (input.occurredAt !== undefined) {
    if (typeof input.occurredAt !== "string" || input.occurredAt.length > 40) invalid();
    const time = Date.parse(input.occurredAt);
    // Timestamps are informational; buckets use the server's receipt hour.
    if (!Number.isFinite(time) || time > now.getTime() + 86_400_000) invalid();
    occurredAt = new Date(time).toISOString();
  }
  return { harness: knownHarness(input.harness), session: input.session, model: input.model === undefined ? null : input.model, occurredAt, ...counts };
}

// Cumulative totals make retries and out-of-order delivery safe: only growth
// past the stored maximum counts, column by column.
export function tokenUsageDeltas(previous: TokenCounts, next: TokenCounts): TokenCounts & { total: number } {
  const deltas = {} as TokenCounts;
  for (const key of COUNTERS) deltas[key] = Math.max(0, next[key] - previous[key]);
  return { ...deltas, total: COUNTERS.reduce((sum, key) => sum + deltas[key], 0) };
}

export function usageHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

function stored(row: any): TokenCounts {
  return { input: Number(row?.input ?? 0), output: Number(row?.output ?? 0), cacheRead: Number(row?.cache_read ?? 0), cacheWrite: Number(row?.cache_write ?? 0) };
}

export async function recordTokenUsage(token: TokenRecord, report: TokenUsageReport, options: { db?: postgres.Sql; now?: Date } = {}): Promise<{ added: number }> {
  // The authenticated credential is the agent; usage is reported like record_action.
  const actor = actionActorFor(token, true);
  const db = options.db ?? sql;
  const at = options.now ?? new Date();
  const hour = usageHour(at).toISOString();
  const now = at.toISOString();
  return db.begin(async tx => {
    const lock = () => tx`
      SELECT harness, input, output, cache_read, cache_write FROM token_usage_sessions
      WHERE org_id = ${actor.orgId} AND agent = ${actor.name} AND session_hash = ${report.session} FOR UPDATE`;
    let [row] = await lock();
    if (!row) {
      const [recent] = await tx`
        SELECT count(*)::int AS n FROM token_usage_sessions
        WHERE org_id = ${actor.orgId} AND agent = ${actor.name} AND first_seen_at > ${now}::timestamptz - interval '1 hour'`;
      if (Number(recent?.n) >= TOKEN_USAGE_NEW_SESSIONS_PER_HOUR) throw new TokenUsageError("rate_limited", 429);
      await tx`
        INSERT INTO token_usage_sessions (org_id, agent, session_hash, harness, model, first_seen_at, updated_at)
        VALUES (${actor.orgId}, ${actor.name}, ${report.session}, ${report.harness}, ${report.model}, ${now}::timestamptz, ${now}::timestamptz)
        ON CONFLICT (org_id, agent, session_hash) DO NOTHING`;
      [row] = await lock();
      await tx`DELETE FROM token_usage_hourly WHERE org_id = ${actor.orgId} AND hour < ${hour}::timestamptz - make_interval(days => ${TOKEN_USAGE_HOURLY_RETENTION_DAYS}::int)`;
    }
    if (!row) throw new Error("token usage session was not stored");
    const delta = tokenUsageDeltas(stored(row), report);
    if (delta.total > TOKEN_USAGE_MAX_DELTA) invalid();
    if (delta.total === 0) {
      if (report.model) await tx`UPDATE token_usage_sessions SET model = ${report.model} WHERE org_id = ${actor.orgId} AND agent = ${actor.name} AND session_hash = ${report.session} AND model IS DISTINCT FROM ${report.model}`;
      return { added: 0 };
    }
    await tx`
      UPDATE token_usage_sessions SET
        input = GREATEST(input, ${report.input}), output = GREATEST(output, ${report.output}),
        cache_read = GREATEST(cache_read, ${report.cacheRead}), cache_write = GREATEST(cache_write, ${report.cacheWrite}),
        model = coalesce(${report.model}, model), updated_at = GREATEST(updated_at, ${now}::timestamptz)
      WHERE org_id = ${actor.orgId} AND agent = ${actor.name} AND session_hash = ${report.session}`;
    // A session keeps the harness it was first reported with.
    await tx`
      INSERT INTO token_usage_hourly (org_id, hour, harness, input, output, cache_read, cache_write)
      VALUES (${actor.orgId}, ${hour}::timestamptz, ${String(row.harness)}, ${delta.input}, ${delta.output}, ${delta.cacheRead}, ${delta.cacheWrite})
      ON CONFLICT (org_id, hour, harness) DO UPDATE SET
        input = token_usage_hourly.input + EXCLUDED.input, output = token_usage_hourly.output + EXCLUDED.output,
        cache_read = token_usage_hourly.cache_read + EXCLUDED.cache_read, cache_write = token_usage_hourly.cache_write + EXCLUDED.cache_write`;
    return { added: delta.total };
  }) as Promise<{ added: number }>;
}

async function readBody(req: Request): Promise<string> {
  if (Number(req.headers.get("content-length")) > TOKEN_USAGE_BODY_LIMIT) invalid();
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TOKEN_USAGE_BODY_LIMIT) { await reader.cancel(); invalid(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export interface TokenUsageHttpDependencies {
  db?: postgres.Sql;
  now?: () => Date;
  authenticate?: (req: Request) => Promise<TokenRecord | null>;
  resolveOrg?: typeof resolveOrg;
  withOrg?: typeof withOrg;
  entitlement?: (actor: TokenRecord, db: postgres.Sql) => Promise<void>;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

// POST /api/usage. Bearer credentials only: no cookies, no console header.
export async function handleTokenUsageRequest(req: Request, deps: TokenUsageHttpDependencies = {}): Promise<Response> {
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
  const db = deps.db ?? sql;
  try {
    const token = await (deps.authenticate ?? authenticateRequest)(req);
    if (!token) return reply(401, { ok: false, error: "unauthorized" });
    const actor = normalizeToken(token);
    const org = await (deps.resolveOrg ?? resolveOrg)(actor);
    return await (deps.withOrg ?? withOrg)(org, actor, async () => {
      try {
        // Check write authority before reading or validating untrusted input.
        actionActorFor(actor, true);
        await (deps.entitlement ?? ((current, database) => requireHostedWriteAccess(current, { db: database })))(actor, db);
        const raw = await readBody(req);
        let body: unknown;
        try { body = JSON.parse(raw); } catch { invalid(); }
        const now = deps.now?.() ?? new Date();
        await recordTokenUsage(actor, parseTokenUsage(body, now), { db, now });
        return reply(200, { ok: true });
      } catch (error) {
        if (error instanceof TokenUsageError) return reply(error.status, { ok: false, error: error.code }, error.status === 429 ? { "Retry-After": "60" } : {});
        if (error instanceof ActionError) return reply(error.status === 403 ? 403 : 400, { ok: false, error: error.status === 403 ? "forbidden" : "invalid_usage" });
        // A workspace that cannot add content (for example an ended trial) is read-only here too.
        if (error instanceof BillingError) return reply(error.status === 402 ? 403 : 503, { ok: false, error: error.status === 402 ? "subscription_required" : "unavailable" });
        throw error;
      }
    });
  } catch {
    console.error("[usage] report failed");
    return reply(503, { ok: false, error: "unavailable" }, { "Retry-After": "30" });
  }
}

// One cheap aggregate over the workspace's usage rows. The 84-day window
// matches the activity series: UTC days, today inclusive.
export async function tokenUsageRow(db: postgres.Sql, orgId: number, at: Date): Promise<any> {
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const start = new Date(today - 83 * 86_400_000).toISOString();
  const end = new Date(today + 86_400_000).toISOString();
  const previousHour = new Date(usageHour(at).getTime() - 3_600_000).toISOString();
  const rows = await db`
    WITH sessions AS (
      SELECT harness, sum(input) AS input, sum(output) AS output, sum(cache_read) AS cache_read, sum(cache_write) AS cache_write, max(updated_at) AS updated_at
      FROM token_usage_sessions WHERE org_id = ${orgId} GROUP BY harness
    ), hours AS (
      SELECT hour, input + output + cache_read + cache_write AS tokens
      FROM token_usage_hourly WHERE org_id = ${orgId} AND hour >= ${start}::timestamptz AND hour < ${end}::timestamptz
    ), days AS (
      SELECT to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, sum(tokens)::text AS count FROM hours GROUP BY 1
    ) SELECT
      (SELECT coalesce(sum(input), 0)::text FROM sessions) AS input,
      (SELECT coalesce(sum(output), 0)::text FROM sessions) AS output,
      (SELECT coalesce(sum(cache_read), 0)::text FROM sessions) AS cache_read,
      (SELECT coalesce(sum(cache_write), 0)::text FROM sessions) AS cache_write,
      (SELECT max(updated_at) FROM sessions) AS updated_at,
      (SELECT coalesce(json_agg(json_build_object('product', harness, 'tokens', (input + output + cache_read + cache_write)::text)), '[]'::json) FROM sessions) AS products,
      (SELECT coalesce(json_agg(days ORDER BY date), '[]'::json) FROM days) AS daily,
      (SELECT coalesce(sum(tokens), 0)::text FROM hours WHERE hour >= ${new Date(today).toISOString()}::timestamptz) AS today,
      (SELECT coalesce(sum(tokens), 0)::text FROM hours WHERE hour >= ${previousHour}::timestamptz) AS last_hour`;
  return rows[0] ?? {};
}
