import { createHash } from "node:crypto";
import type postgres from "postgres";
import { currentOrg } from "./context";
import { sql } from "./db";
import { boundMcpResult, contextMaxBytes } from "./mcp-context";
import { normalizeToken, type TokenRecord } from "./policies";
import { cacheIntegrationVerification, integrationVerification, mapIntegrationUse, recordIntegrationDeclaration, recordIntegrationReceipt, type IntegrationContext, type IntegrationUse } from "./integration-use";

export const CONTEXT_RUN_RETENTION_DAYS = 7;
export const CONTEXT_RUNS_PER_ACTOR = 128;
export const CONTEXT_RUNS_PER_ORG = 4096;
export const USAGE_ACTORS_PER_ORG = 4096;
export const TOKEN_ESTIMATE_METHOD = "utf8-bytes-divided-by-4";
const READS = new Set(["recall", "search", "get_page", "list_pages", "list_tags", "get_timeline", "list_actions", "get_activity", "list_activities"]);
const RECALLS = new Set(["recall", "search", "get_page"]);
const REMEMBERS = new Set(["remember", "put_page"]);
let pendingUsageTransactions = 0;
type McpResult = { content: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean; _meta?: Record<string, unknown>; [key: string]: unknown };
export type MemoryUsageOptions = IntegrationContext & { maxBytes?: unknown; db?: postgres.Sql };
export type MemoryUse = {
  available: boolean; trackingSince: string | null; lastRecallAt: string | null; lastRememberAt: string | null;
  recalls: number | null; remembers: number | null; responseBytes: number | null; estimatedTokens: number | null;
  tokenEstimate: typeof TOKEN_ESTIMATE_METHOD; duplicateRecalls: number | null; budgetStops: number | null;
  truncatedResponses: number | null; runScopedResponses: number | null; responseScopedResponses: number | null;
  integration: IntegrationUse;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const mcpResultBytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result), "utf8");
export function validContextRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}
function identity(token: TokenRecord) {
  const actor = normalizeToken(token);
  if ((currentOrg() && currentOrg()!.id !== actor.orgId) || !actor.name || Buffer.byteLength(actor.name) > 1024) throw new Error("Invalid memory usage actor");
  return { actor, key: hash([actor.orgId, actor.kind, actor.name, actor.email]) };
}
function truncated(result: McpResult): boolean {
  return result.content.some(block => {
    if (block.type !== "text" || typeof block.text !== "string") return false;
    try {
      const payload = JSON.parse(block.text);
      return payload?._context?.truncated === true || payload?._page?.partial === true ||
        (Array.isArray(payload?.actions) && payload.actions.some((action: any) => action?._detail?.partial === true));
    } catch { return false; }
  });
}
type ContextMeta = { scope: "run" | "response"; budgetBytes: number; usedBytes: number; remainingBytes: number;
  runScoped: boolean; duplicate: boolean; budgetStopped: boolean; truncated: boolean; available: boolean;
  responseBytes: number; estimatedTokens: number; tokenEstimate: string };
function withMeta(result: McpResult, meta: Omit<ContextMeta, "responseBytes" | "estimatedTokens" | "tokenEstimate">): McpResult {
  const context: ContextMeta = { ...meta, truncated: meta.truncated || truncated(result), responseBytes: 0, estimatedTokens: 0, tokenEstimate: TOKEN_ESTIMATE_METHOD };
  const output = { ...result, _meta: { ...result._meta, engramContext: context } };
  // The metric describes this exact serialized tool envelope, including itself.
  for (let i = 0; i < 12; i++) {
    const bytes = mcpResultBytes(output), estimate = Math.ceil(bytes / 4);
    const control = meta.budgetStopped || meta.duplicate;
    const used = control ? meta.usedBytes : meta.usedBytes + bytes;
    const remaining = control ? meta.remainingBytes : Math.max(0, meta.remainingBytes - bytes);
    if (bytes === context.responseBytes && estimate === context.estimatedTokens && used === context.usedBytes && remaining === context.remainingBytes) break;
    context.responseBytes = bytes; context.estimatedTokens = estimate;
    context.usedBytes = used; context.remainingBytes = remaining;
  }
  return output;
}
function receipt(reason: "duplicate_recall" | "context_budget_exhausted" | "context_usage_unavailable" | "context_run_capacity") : McpResult {
  return { content: [{ type: "text", text: JSON.stringify({ status: reason, ...(reason === "duplicate_recall" ? { message: "Already returned in this run. Reuse the earlier result." } : { message: "Memory context skipped. Continue the task with the context already available." }) }) }] };
}
type UsageEvent = { recall: boolean; remember: boolean; bytes: number; duplicate: boolean; budgetStopped: boolean; truncated: boolean; runScoped: boolean };
async function writeUsage(tx: postgres.Sql, actor: TokenRecord, key: string, event: UsageEvent, options: MemoryUsageOptions = {}) {
  // Called under the org lock: a high-cardinality client cannot grow this table
  // indefinitely. No prompt, query, tool arguments or retrieved text is stored.
  const rows = await tx`INSERT INTO memory_connection_usage (org_id, actor_key, actor_name, actor_kind,
      last_recall_at, last_remember_at, recalls, remembers, response_bytes, estimated_tokens,
      duplicate_recalls, budget_stops, truncated_responses, run_scoped_responses, response_scoped_responses)
    SELECT ${actor.orgId}, ${key}, ${actor.name}, ${actor.kind},
      CASE WHEN ${event.recall} THEN now() END, CASE WHEN ${event.remember} THEN now() END,
      ${Number(event.recall)}, ${Number(event.remember)}, ${event.bytes}, ${Math.ceil(event.bytes / 4)},
      ${Number(event.duplicate)}, ${Number(event.budgetStopped)}, ${Number(event.truncated)}, ${Number(event.runScoped)}, ${Number(!event.runScoped)}
    WHERE EXISTS (SELECT 1 FROM memory_connection_usage WHERE org_id = ${actor.orgId} AND actor_key = ${key})
       OR (SELECT count(*) FROM memory_connection_usage WHERE org_id = ${actor.orgId}) < ${USAGE_ACTORS_PER_ORG}
    ON CONFLICT (org_id, actor_key) DO UPDATE SET updated_at = now(),
      last_recall_at = coalesce(EXCLUDED.last_recall_at, memory_connection_usage.last_recall_at),
      last_remember_at = coalesce(EXCLUDED.last_remember_at, memory_connection_usage.last_remember_at),
      recalls = memory_connection_usage.recalls + EXCLUDED.recalls,
      remembers = memory_connection_usage.remembers + EXCLUDED.remembers,
      response_bytes = memory_connection_usage.response_bytes + EXCLUDED.response_bytes,
      estimated_tokens = memory_connection_usage.estimated_tokens + EXCLUDED.estimated_tokens,
      duplicate_recalls = memory_connection_usage.duplicate_recalls + EXCLUDED.duplicate_recalls,
      budget_stops = memory_connection_usage.budget_stops + EXCLUDED.budget_stops,
      truncated_responses = memory_connection_usage.truncated_responses + EXCLUDED.truncated_responses,
      run_scoped_responses = memory_connection_usage.run_scoped_responses + EXCLUDED.run_scoped_responses,
      response_scoped_responses = memory_connection_usage.response_scoped_responses + EXCLUDED.response_scoped_responses
    RETURNING actor_key`;
  if (!rows.length) return false;
  await recordIntegrationDeclaration(tx, actor, key, options);
  await recordIntegrationReceipt(tx, actor, key, options, event.recall, event.remember);
  return true;
}
async function transaction<T>(db: postgres.Sql, orgId: number, work: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  // Bound pool admission as well as SQL time. Timing out only the whole work
  // promise could leave a late transaction recording a recall never delivered.
  // A timed-out acquisition releases its eventual lease without running SQL.
  if (pendingUsageTransactions >= 16) throw new Error("Memory accounting capacity reached");
  pendingUsageTransactions++;
  let connection = db, release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof db.reserve === "function") {
    const acquiring = db.reserve();
    try {
      const reserved = await Promise.race([acquiring, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Memory accounting pool unavailable")), 500); })]);
      connection = reserved; release = () => reserved.release();
    } catch (error) {
      void acquiring.then(reserved => reserved.release(), () => {}).finally(() => { pendingUsageTransactions--; });
      throw error;
    } finally { clearTimeout(timer); }
  }
  const run = async (tx: postgres.Sql): Promise<T> => {
    // Hooks must not hang the main task on lock contention or a storage outage.
    await tx`SET LOCAL statement_timeout = '250ms'`;
    await tx`SET LOCAL lock_timeout = '150ms'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`engram/memory-usage/${orgId}`}, 0))`;
    return work(tx);
  };
  try {
    if (!release) return await db.begin(raw => run(raw as unknown as postgres.Sql)) as T;
    // postgres.js reserved clients intentionally expose the tagged-query API,
    // not the pool's begin() helper. Keep the entire transaction on this lease.
    await connection`BEGIN`;
    try {
      const value = await run(connection);
      await connection`COMMIT`;
      return value;
    } catch (error) {
      await connection`ROLLBACK`.catch(() => {});
      throw error;
    }
  } finally { release?.(); pendingUsageTransactions--; }
}
/** Numeric gateway output measurements. Never actual model/token billing data. */
export async function recordMcpUsage(token: TokenRecord, name: string, result: McpResult, options: MemoryUsageOptions = {}): Promise<boolean> {
  try {
    const { actor, key } = identity(token), bytes = mcpResultBytes(result);
    const context = result._meta?.engramContext as Partial<ContextMeta> | undefined;
    return await transaction(options.db ?? sql, actor.orgId, tx => writeUsage(tx, actor, key, {
      recall: RECALLS.has(name) && !result.isError && context?.budgetStopped !== true && context?.duplicate !== true,
      remember: REMEMBERS.has(name) && !result.isError,
      bytes, duplicate: context?.duplicate === true, budgetStopped: context?.budgetStopped === true,
      truncated: truncated(result) || context?.truncated === true, runScoped: context?.runScoped ?? validContextRunId(options.runId),
    }, options));
  } catch { return false; }
}

/** Bound delivered memory for authenticated actor+workspace+run across replicas. */
export async function applyContextBudget(token: TokenRecord, name: string, args: Record<string, unknown>, result: McpResult, options: MemoryUsageOptions = {}): Promise<McpResult> {
  if (options.verification !== undefined) {
    if (name !== "whoami" || result.isError) return boundMcpResult(name, args, { content: [{ type: "text", text: "Compatibility verification is available only through a successful whoami call." }], isError: true }, contextMaxBytes(options.maxBytes));
    try {
      const { actor, key } = identity(token);
      return await transaction(options.db ?? sql, actor.orgId, async tx => {
        const check = await integrationVerification(tx, actor, key, options);
        const payload = JSON.parse(result.content.find(block => block.type === "text")?.text ?? "{}");
        const output = boundMcpResult("whoami", {}, { content: [{ type: "text", text: JSON.stringify({ ...(typeof payload.token === "string" ? { token: payload.token } : {}), verification: check.verification }) }] }, contextMaxBytes(options.maxBytes)) as McpResult;
        if (output.isError) throw new Error("Verification receipt exceeded the response budget");
        if (!await writeUsage(tx, actor, key, { recall: false, remember: false, bytes: mcpResultBytes(output), duplicate: false, budgetStopped: false, truncated: false, runScoped: validContextRunId(options.runId) }, options)) throw new Error("Verification measurements unavailable");
        await cacheIntegrationVerification(tx, actor, key, check);
        return output;
      });
    } catch {
      return { content: [{ type: "text", text: "Compatibility check is unavailable. Continue without a verified workflow check." }], isError: true };
    }
  }
  if (!READS.has(name)) { await recordMcpUsage(token, name, result, options); return result; }
  const maxBytes = contextMaxBytes(options.maxBytes), runScoped = validContextRunId(options.runId);
  const base = { scope: runScoped ? "run" as const : "response" as const, budgetBytes: maxBytes, usedBytes: 0, remainingBytes: maxBytes,
    runScoped, duplicate: false, budgetStopped: false, truncated: truncated(result), available: true };
  let authenticated: ReturnType<typeof identity>;
  try { authenticated = identity(token); }
  catch { return withMeta(receipt("context_usage_unavailable"), { ...base, available: false, budgetStopped: true }); }
  // MCP-only clients without an adapter get an honest per-response limit. A
  // shared time bucket would block unrelated tasks and is not a task budget.
  if (!runScoped || result.isError) {
    const bounded = boundMcpResult(name, args, result, maxBytes - 512) as McpResult;
    let output = withMeta(bounded, { ...base, scope: "response", runScoped: false, truncated: truncated(bounded) });
    if (mcpResultBytes(output) > maxBytes) output = withMeta(receipt("context_budget_exhausted"), { ...base, scope: "response", runScoped: false, budgetStopped: true, truncated: true });
    await recordMcpUsage(token, name, output, { ...options, runId: undefined });
    return output;
  }
  try {
    const { actor, key } = authenticated, runHash = hash(options.runId);
    return await transaction(options.db ?? sql, actor.orgId, async tx => {
      await tx`DELETE FROM memory_context_runs WHERE org_id = ${actor.orgId} AND updated_at < now() - interval '7 days'`;
      await tx`INSERT INTO memory_context_runs (org_id, actor_key, run_hash, max_bytes)
        SELECT ${actor.orgId}, ${key}, ${runHash}, ${maxBytes}
        WHERE (SELECT count(*) FROM memory_context_runs WHERE org_id = ${actor.orgId} AND actor_key = ${key}) < ${CONTEXT_RUNS_PER_ACTOR}
          AND (SELECT count(*) FROM memory_context_runs WHERE org_id = ${actor.orgId}) < ${CONTEXT_RUNS_PER_ORG}
        ON CONFLICT (org_id, actor_key, run_hash) DO NOTHING`;
      const [row] = await tx`SELECT max_bytes, delivered_bytes, fingerprints FROM memory_context_runs
        WHERE org_id = ${actor.orgId} AND actor_key = ${key} AND run_hash = ${runHash} FOR UPDATE`;
      if (!row) return withMeta(receipt("context_run_capacity"), { ...base, available: false, budgetStopped: true });
      const budget = Math.min(Number(row.max_bytes), maxBytes), used = Number(row.delivered_bytes), remaining = Math.max(0, budget - used);
      const fingerprints: string[] = Array.isArray(row.fingerprints) ? row.fingerprints : [];
      const fingerprint = hash([name, result.content]);
      const duplicate = fingerprints.includes(fingerprint);
      let stopped = remaining < 1024 || fingerprints.length >= 128;
      let output = withMeta(stopped ? receipt("context_budget_exhausted") : duplicate ? receipt("duplicate_recall") : boundMcpResult(name, args, result, remaining - 512) as McpResult,
        { ...base, budgetBytes: budget, usedBytes: used, remainingBytes: remaining, duplicate, budgetStopped: stopped, truncated: stopped || truncated(result) });
      let bytes = mcpResultBytes(output);
      if (!stopped && bytes > remaining) {
        stopped = true;
        output = withMeta(receipt("context_budget_exhausted"), { ...base, budgetBytes: budget, usedBytes: used, remainingBytes: remaining, duplicate, budgetStopped: true, truncated: true });
        bytes = mcpResultBytes(output);
      }
      // Duplicate and exhausted responses contain only a small control receipt,
      // not retrieved memory. Its bytes still appear in overhead diagnostics.
      const delivered = stopped || duplicate ? 0 : bytes;
      await tx`UPDATE memory_context_runs SET updated_at = now(), delivered_bytes = delivered_bytes + ${delivered},
        fingerprints = ${tx.json(!stopped && !duplicate ? [...fingerprints, fingerprint] : fingerprints)}
        WHERE org_id = ${actor.orgId} AND actor_key = ${key} AND run_hash = ${runHash}`;
      await writeUsage(tx, actor, key, { recall: RECALLS.has(name) && !stopped && !duplicate && !output.isError, remember: false,
        bytes, duplicate: duplicate && !stopped, budgetStopped: stopped, truncated: truncated(output) || stopped || truncated(result), runScoped: true }, options);
      return output;
    });
  } catch {
    return withMeta(receipt("context_usage_unavailable"), { ...base, available: false, budgetStopped: true });
  }
}

function count(value: unknown): number { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number)) : 0; }
function date(value: unknown): string | null { const number = value ? new Date(value as string).getTime() : NaN; return Number.isFinite(number) ? new Date(number).toISOString() : null; }
export function mapMemoryUse(row?: Record<string, unknown>): MemoryUse {
  const metric = (key: string) => row ? count(row[key]) : null;
  return { available: !!row, trackingSince: date(row?.tracking_since), lastRecallAt: date(row?.last_recall_at), lastRememberAt: date(row?.last_remember_at),
    recalls: metric("recalls"), remembers: metric("remembers"), responseBytes: metric("response_bytes"), estimatedTokens: metric("estimated_tokens"),
    tokenEstimate: TOKEN_ESTIMATE_METHOD, duplicateRecalls: metric("duplicate_recalls"), budgetStops: metric("budget_stops"), truncatedResponses: metric("truncated_responses"),
    runScopedResponses: metric("run_scoped_responses"), responseScopedResponses: metric("response_scoped_responses"), integration: mapIntegrationUse(row) };
}
