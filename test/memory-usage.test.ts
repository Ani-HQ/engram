import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { applyContextBudget, mapMemoryUse, mcpResultBytes, recordMcpUsage, validContextRunId } from "../gateway/src/memory-usage";
import { ensureMemoryUsageSchema } from "../gateway/src/memory-usage-schema";
import { normalizeToken, DEFAULT_POLICIES } from "../gateway/src/policies";
import { runWithContext } from "../gateway/src/context";

const actor = normalizeToken({ name: "test-agent", orgId: 7, kind: "token" });
const result = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
function database() {
  const calls: Array<{ query: string; values: any[] }> = [], runs = new Map<string, any>();
  let tail = Promise.resolve(), fail = false, capacity = false, usageCapacity = false;
  const db = (async (parts: TemplateStringsArray, ...values: any[]) => {
    const query = parts.join("?"); calls.push({ query, values });
    if (fail) throw new Error("private database connection details");
    if (query.includes("INSERT INTO memory_context_runs")) {
      const [org, key, run, max] = values, identity = JSON.stringify([org, key, run]);
      if (!capacity && !runs.has(identity)) runs.set(identity, { max_bytes: max, delivered_bytes: 0, fingerprints: [] });
    }
    if (query.includes("SELECT max_bytes")) return [runs.get(JSON.stringify(values))].filter(Boolean);
    if (query.includes("UPDATE memory_context_runs")) {
      const [bytes, fingerprints, org, key, run] = values, row = runs.get(JSON.stringify([org, key, run]));
      row.delivered_bytes += bytes; row.fingerprints = fingerprints;
    }
    if (query.includes("INSERT INTO memory_connection_usage")) return usageCapacity ? [] : [{ actor_key: values[1] }];
    return [];
  }) as unknown as postgres.Sql;
  db.json = ((value: unknown) => value) as any;
  // Model the same serialization as the org advisory transaction lock.
  db.begin = ((work: (tx: postgres.Sql) => Promise<unknown>) => {
    const task = tail.then(() => work(db)); tail = task.then(() => {}, () => {}); return task;
  }) as any;
  return { db, calls, runs, fail: () => { fail = true; }, capacity: () => { capacity = true; }, usageCapacity: () => { usageCapacity = true; } };
}

describe("durable memory context accounting", () => {
  test("bounds UTF-8 and the complete unscoped envelope, and labels token heuristics", async () => {
    const store = database(), response = await applyContextBudget(actor, "recall", {}, result({ results: [{ slug: "notes/example", snippet: "秘密🌿".repeat(900) }] }), { db: store.db });
    expect(mcpResultBytes(response)).toBeLessThanOrEqual(4096);
    expect(response._meta?.engramContext).toMatchObject({ scope: "response", runScoped: false, responseBytes: mcpResultBytes(response), estimatedTokens: Math.ceil(mcpResultBytes(response) / 4), tokenEstimate: "utf8-bytes-divided-by-4" });
    expect(store.runs.size).toBe(0);
    expect(store.calls.some(call => call.query.includes("INSERT INTO memory_connection_usage"))).toBe(true);
  });
  test("a reused run deduplicates retrieval across module calls without retaining query or result text", async () => {
    const store = database(), secret = "PRIVATE_QUERY_OR_RESULT", data = result({ results: [{ slug: "notes/a", snippet: secret }] });
    const first = await applyContextBudget(actor, "recall", { query: secret, orgId: 88 }, data, { runId: "task:abc", db: store.db });
    const second = await applyContextBudget(actor, "recall", { query: "changed-query" }, data, { runId: "task:abc", db: store.db });
    expect(first.content[0].text).toContain(secret);
    expect(second.content[0].text).not.toContain(secret);
    expect(second._meta?.engramContext).toMatchObject({ scope: "run", duplicate: true, runScoped: true });
    expect(JSON.stringify(store.calls)).not.toContain(secret);
    expect(JSON.stringify(store.calls)).not.toContain("task:abc");
    expect(JSON.stringify(store.calls)).not.toContain("changed-query");
    expect(store.runs.size).toBe(1);
    const row = [...store.runs.values()][0];
    expect(row.delivered_bytes).toBe(mcpResultBytes(first));
    expect((second._meta?.engramContext as any).usedBytes).toBe((first._meta?.engramContext as any).usedBytes);
    expect((second._meta?.engramContext as any).usedBytes).toBe(row.delivered_bytes);
    expect((second._meta?.engramContext as any).remainingBytes).toBe(4096 - row.delivered_bytes);
    const duplicateUsage = store.calls.filter(call => call.query.includes("INSERT INTO memory_connection_usage"))[1];
    expect(duplicateUsage.values[8]).toBe(mcpResultBytes(second));
    expect(duplicateUsage.values[9]).toBe(Math.ceil(mcpResultBytes(second) / 4));
    expect(store.calls.filter(call => call.query.includes("INSERT INTO memory_context_runs")).every(call => call.values[0] === 7)).toBe(true);
  });
  test("concurrent reads share the sticky initial run ceiling and cannot replenish it", async () => {
    const store = database();
    const responses = await Promise.all(Array.from({ length: 18 }, (_, i) => applyContextBudget(actor, "recall", {}, result({ results: [{ slug: `notes/${i}`, snippet: "a".repeat(1500) }] }), { runId: "race", maxBytes: i ? 16384 : 4096, db: store.db })));
    expect(store.runs.size).toBe(1);
    const row = [...store.runs.values()][0];
    expect(row.max_bytes).toBe(4096);
    expect(row.delivered_bytes).toBeLessThanOrEqual(4096);
    expect(responses.some(response => (response._meta?.engramContext as any).budgetStopped)).toBe(true);
    for (const response of responses) expect(mcpResultBytes(response)).toBeLessThanOrEqual(4096);
  });
  test("organization and authenticated actor namespaces cannot reuse another run's budget or dedup state", async () => {
    const store = database(), payload = result({ results: [{ slug: "notes/shared", snippet: "same" }] });
    for (const user of [actor, normalizeToken({ ...actor, orgId: 8 }), normalizeToken({ ...actor, name: "other-agent" }), normalizeToken({ ...actor, kind: "session", role: "member" })]) {
      const response = await applyContextBudget(user, "recall", { orgId: 7 }, payload, { runId: "same-run", db: store.db });
      expect((response._meta?.engramContext as any).duplicate).toBe(false);
    }
    expect(store.runs.size).toBe(4);
    const foreign = normalizeToken({ ...actor, orgId: 8 });
    const before = store.calls.length;
    await runWithContext({ org: { id: 8, name: "Other", slug: "other", kind: "team", brainDb: "brain_org_8", dataDb: "brain_org_8", homeDir: "org-8", policies: DEFAULT_POLICIES }, token: foreign, dataSql: store.db }, async () => {
      const response = await applyContextBudget(actor, "recall", {}, payload, { runId: "scope", db: store.db });
      expect((response._meta?.engramContext as any).available).toBe(false);
      expect(response.content[0].text).not.toContain("notes/shared");
    });
    expect(store.calls.length).toBe(before);
  });
  test("invalid run metadata uses a per-response cap while outages and full scoped storage skip memory", async () => {
    const store = database();
    for (const value of [null, {}, "", "a".repeat(129), "space run", "../\nprivate"]) expect(validContextRunId(value)).toBe(false);
    expect(validContextRunId("agent/task:abc-123_4.5")).toBe(true);
    const unscoped = await applyContextBudget(actor, "recall", {}, result({ results: [] }), { runId: "bad run", db: store.db });
    expect((unscoped._meta?.engramContext as any).runScoped).toBe(false);
    store.capacity();
    const capacity = await applyContextBudget(actor, "recall", {}, result({ results: ["PRIVATE_RESULT"] }), { runId: "fresh", db: store.db });
    expect(capacity.content[0].text).toContain("context_run_capacity");
    store.fail();
    const unavailable = await applyContextBudget(actor, "recall", {}, result({ results: ["PRIVATE_RESULT"] }), { runId: "fresh", db: store.db });
    expect(unavailable.content[0].text).toContain("context_usage_unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("PRIVATE_RESULT");
    expect(JSON.stringify(unavailable)).not.toContain("database connection details");
  });
  test("write measurements cannot fail successful work and only successful memory writes count", async () => {
    const store = database();
    expect(await recordMcpUsage(actor, "remember", result({ ok: true }), { db: store.db })).toBe(true);
    let call = store.calls.find(call => call.query.includes("INSERT INTO memory_connection_usage"))!;
    expect(call.values.slice(4, 8)).toEqual([false, true, 0, 1]);
    const errorStore = database();
    await recordMcpUsage(actor, "remember", { ...result({ error: "not saved" }), isError: true }, { db: errorStore.db });
    call = errorStore.calls.find(call => call.query.includes("INSERT INTO memory_connection_usage"))!;
    expect(call.values.slice(4, 8)).toEqual([false, false, 0, 0]);
    store.fail();
    expect(await recordMcpUsage(actor, "remember", result({ ok: true }), { db: store.db })).toBe(false);
  });
  test("reserved leases use explicit transactions, and late pool admission never records a delivered recall", async () => {
    const store = database(); let releases = 0;
    // Actual postgres.js reserved clients have queries/release but no begin.
    const lease = ((parts: TemplateStringsArray, ...values: any[]) => store.db(parts, ...values)) as unknown as postgres.Sql;
    lease.json = store.db.json;
    store.db.reserve = (async () => Object.assign(lease, { release: () => { releases++; } })) as any;
    const response = await applyContextBudget(actor, "recall", {}, result({ results: [] }), { runId: "reserved", db: store.db });
    expect((response._meta?.engramContext as any).available).toBe(true);
    expect(store.calls.some(call => call.query === "BEGIN")).toBe(true);
    expect(store.calls.some(call => call.query === "COMMIT")).toBe(true);
    expect(releases).toBe(1);

    const blocked = database(); let finish: (lease: unknown) => void = () => {};
    blocked.db.reserve = (() => new Promise(resolve => { finish = resolve; })) as any;
    const skipped = await applyContextBudget(actor, "recall", {}, result({ results: ["not delivered"] }), { runId: "blocked", db: blocked.db });
    expect((skipped._meta?.engramContext as any).available).toBe(false);
    expect(blocked.calls).toHaveLength(0);
    finish(Object.assign(blocked.db, { release: () => { releases++; } }));
    await Promise.resolve(); await Promise.resolve();
    expect(releases).toBe(2);
    expect(blocked.calls).toHaveLength(0);
  });
  test("diagnostics distinguish no measurements from measured zero and migrations retain only bounded numeric metadata", async () => {
    expect(mapMemoryUse()).toMatchObject({ available: false, responseBytes: null, estimatedTokens: null, lastRecallAt: null });
    expect(mapMemoryUse({ response_bytes: "200", estimated_tokens: "51", recalls: 0, tracking_since: "2026-10-26T00:00:00Z" })).toMatchObject({ available: true, responseBytes: 200, estimatedTokens: 51, recalls: 0, trackingSince: "2026-10-26T00:00:00.000Z" });
    const store = database(); await ensureMemoryUsageSchema(store.db);
    const statements = store.calls.map(call => call.query).join("\n");
    expect(statements).toContain("jsonb_array_length(fingerprints) <= 128");
    expect(statements).toContain("delivered_bytes <= max_bytes");
    expect(statements).not.toMatch(/prompt|query_text|result_text|arguments|transcript/);
  });
  test("a full diagnostic inventory reports unknown new actors without expiring measured proof", async () => {
    const store = database(); store.usageCapacity();
    expect(await recordMcpUsage(actor, "remember", result({ ok: true }), { db: store.db })).toBe(false);
    const statement = store.calls.find(call => call.query.includes("INSERT INTO memory_connection_usage"))!;
    expect(statement.query).toContain("WHERE EXISTS (SELECT 1 FROM memory_connection_usage");
    expect(statement.query).toContain("ON CONFLICT (org_id, actor_key) DO UPDATE");
    expect(statement.values).toContain(4096);
    expect(store.calls.some(call => call.query.includes("DELETE FROM memory_connection_usage"))).toBe(false);
    expect(mapMemoryUse().available).toBe(false);
    expect(mapMemoryUse().recalls).toBeNull();
  });
});
