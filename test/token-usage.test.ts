import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { compactNumber } from "../gateway/src/compact-number";
import { runWithContext } from "../gateway/src/context";
import { DEFAULT_POLICIES, normalizeToken, parsePolicies, type TokenRecord } from "../gateway/src/policies";
import { BillingError } from "../gateway/src/billing";
import { publicActivitySnapshot, publicTokens, renderShowcaseCard, renderShowcasePage, type ShowcaseProfile } from "../gateway/src/showcase-view";
import { handleTokenUsageRequest, parseTokenUsage, recordTokenUsage, tokenUsageDeltas, usageHour, TOKEN_USAGE_BODY_LIMIT, TOKEN_USAGE_NEW_SESSIONS_PER_HOUR, type TokenUsageReport } from "../gateway/src/token-usage";

const session = "a".repeat(64);
const report = { harness: "claude-code", session, model: "claude-opus-5-5", input: 100, output: 20, cacheRead: 3000, cacheWrite: 40, occurredAt: "2026-11-16T10:00:00.000Z" };
const agent = normalizeToken({ name: "laptop-claude", orgId: 7, role: "agent", kind: "token" });
const now = new Date("2026-11-16T10:20:00.000Z");
const org = (id = 7, policies = DEFAULT_POLICIES) => ({ id, name: "Team", slug: `team-${id}`, kind: "team" as const, brainDb: `brain_org_${id}`, dataDb: `brain_org_${id}`, homeDir: `org-${id}`, policies, createdAt: "2026-01-01T00:00:00Z", provisioningStatus: "ready" as const, provisioningError: null });

// A small stateful stand-in for the two usage tables. Each begin() rolls back
// its writes when the callback throws, like a real transaction.
function usageDatabase() {
  type Row = { harness: string; model: string | null; input: number; output: number; cache_read: number; cache_write: number; first_seen_at: string; updated_at: string };
  let sessions = new Map<string, Row>();
  let hourly = new Map<string, { input: number; output: number; cache_read: number; cache_write: number }>();
  const queries: { query: string; values: any[] }[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    queries.push({ query, values });
    const key = (v: any[]) => JSON.stringify(v.slice(0, 3));
    if (query.includes("FROM token_usage_sessions") && query.includes("FOR UPDATE")) {
      const row = sessions.get(key(values));
      return Promise.resolve(row ? [{ ...row }] : []);
    }
    if (query.includes("SELECT count(*)::int AS n FROM token_usage_sessions")) {
      const since = Date.parse(values[2]) - 3_600_000;
      return Promise.resolve([{ n: [...sessions].filter(([k, row]) => k.startsWith(JSON.stringify(values.slice(0, 2)).slice(0, -1)) && Date.parse(row.first_seen_at) > since).length }]);
    }
    if (query.includes("INSERT INTO token_usage_sessions")) {
      if (!sessions.has(key(values))) sessions.set(key(values), { harness: values[3], model: values[4], input: 0, output: 0, cache_read: 0, cache_write: 0, first_seen_at: values[5], updated_at: values[6] });
      return Promise.resolve([]);
    }
    if (query.includes("DELETE FROM token_usage_hourly")) return Promise.resolve([]);
    if (query.includes("UPDATE token_usage_sessions SET model")) {
      const row = sessions.get(JSON.stringify(values.slice(1, 4)))!;
      row.model = values[0];
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE token_usage_sessions SET")) {
      const row = sessions.get(JSON.stringify(values.slice(6, 9)))!;
      row.input = Math.max(row.input, values[0]); row.output = Math.max(row.output, values[1]);
      row.cache_read = Math.max(row.cache_read, values[2]); row.cache_write = Math.max(row.cache_write, values[3]);
      row.model = values[4] ?? row.model; row.updated_at = values[5];
      return Promise.resolve([]);
    }
    if (query.includes("INSERT INTO token_usage_hourly")) {
      const k = JSON.stringify(values.slice(0, 3));
      const bucket = hourly.get(k) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      bucket.input += values[3]; bucket.output += values[4]; bucket.cache_read += values[5]; bucket.cache_write += values[6];
      hourly.set(k, bucket);
      return Promise.resolve([]);
    }
    return Promise.reject(new Error("Unexpected test query"));
  }) as any;
  tag.begin = async (fn: (tx: any) => Promise<unknown>) => {
    const saved = [structuredClone(sessions), structuredClone(hourly)] as const;
    try { return await fn(tag); } catch (error) { [sessions, hourly] = [saved[0], saved[1]]; throw error; }
  };
  return { db: tag as postgres.Sql, queries, sessions: () => sessions, hourly: () => hourly };
}

describe("token usage reports", () => {
  test("accepts exactly the contract fields and maps unknown harnesses to other", () => {
    expect(parseTokenUsage(report, now)).toEqual({ ...report });
    expect(parseTokenUsage({ ...report, harness: "codex", model: undefined, occurredAt: undefined }, now)).toMatchObject({ harness: "codex", model: null, occurredAt: null });
    for (const harness of ["my-private-tool", "other", "constructor", "__proto__"]) expect(parseTokenUsage({ ...report, harness }, now).harness).toBe("other");
    const invalid = [null, [], "text", {}, { ...report, extra: 1 }, { ...report, agent: "spoofed" }, { ...report, harness: 1 }, { ...report, harness: "x".repeat(81) },
      { ...report, session: "A".repeat(64) }, { ...report, session: "a".repeat(63) }, { ...report, session: undefined },
      { ...report, model: "Claude Opus" }, { ...report, model: "" }, { ...report, model: null }, { ...report, model: "x".repeat(81) },
      { ...report, input: -1 }, { ...report, output: 1.5 }, { ...report, cacheRead: "10" }, { ...report, cacheWrite: 1e12 + 1 }, { ...report, input: undefined },
      { ...report, occurredAt: "yesterday" }, { ...report, occurredAt: 123 }, { ...report, occurredAt: "2026-11-18T10:00:00.000Z" }];
    for (const value of invalid) expect(() => parseTokenUsage(value, now)).toThrow("invalid_usage");
    expect(parseTokenUsage({ ...report, input: 1e12 }, now).input).toBe(1e12);
  });

  test("computes per-column positive deltas from cumulative totals", () => {
    const previous = { input: 100, output: 20, cacheRead: 3000, cacheWrite: 40 };
    expect(tokenUsageDeltas(previous, { input: 150, output: 20, cacheRead: 2000, cacheWrite: 41 })).toEqual({ input: 50, output: 0, cacheRead: 0, cacheWrite: 1, total: 51 });
    expect(tokenUsageDeltas(previous, previous).total).toBe(0);
    expect(usageHour(new Date("2026-11-16T10:59:59.999Z")).toISOString()).toBe("2026-11-16T10:00:00.000Z");
  });

  test("stores monotonic totals, adds only growth to the receipt hour, and tolerates retries and reordering", async () => {
    const store = usageDatabase();
    const first = parseTokenUsage(report, now);
    expect(await recordTokenUsage(agent, first, { db: store.db, now })).toEqual({ added: 3160 });
    expect(await recordTokenUsage(agent, first, { db: store.db, now })).toEqual({ added: 0 });
    const later = parseTokenUsage({ ...report, input: 160, cacheRead: 3500 }, now);
    const earlier = parseTokenUsage({ ...report, input: 120, output: 25, cacheRead: 3100 }, now);
    const next = new Date("2026-11-16T11:05:00.000Z");
    expect(await recordTokenUsage(agent, later, { db: store.db, now: next })).toEqual({ added: 560 });
    // Arrives late: only its larger output counts, nothing is subtracted.
    expect(await recordTokenUsage(agent, earlier, { db: store.db, now: next })).toEqual({ added: 5 });
    const row = [...store.sessions().values()][0];
    expect([row.input, row.output, row.cache_read, row.cache_write, row.harness]).toEqual([160, 25, 3500, 40, "claude-code"]);
    expect(Object.fromEntries(store.hourly())).toEqual({
      [JSON.stringify([7, "2026-11-16T10:00:00.000Z", "claude-code"])]: { input: 100, output: 20, cache_read: 3000, cache_write: 40 },
      [JSON.stringify([7, "2026-11-16T11:00:00.000Z", "claude-code"])]: { input: 60, output: 5, cache_read: 500, cache_write: 0 },
    });
    // A session keeps its first harness; the credential, not the body, is the agent.
    await recordTokenUsage(agent, parseTokenUsage({ ...report, harness: "codex", input: 170 }, now), { db: store.db, now: next });
    expect(store.hourly().has(JSON.stringify([7, "2026-11-16T11:00:00.000Z", "codex"]))).toBe(false);
    expect([...store.sessions().keys()]).toEqual([JSON.stringify([7, "laptop-claude", session])]);
  });

  test("rejects a report whose total growth exceeds the cap without storing anything", async () => {
    const store = usageDatabase();
    await expect(recordTokenUsage(agent, parseTokenUsage({ ...report, input: 1e9, output: 1e9, cacheRead: 1, cacheWrite: 0 }, now), { db: store.db, now })).rejects.toThrow("invalid_usage");
    expect(store.sessions().size).toBe(0);
    expect(store.hourly().size).toBe(0);
    await recordTokenUsage(agent, parseTokenUsage({ ...report, input: 1e9, output: 1e9, cacheRead: 0, cacheWrite: 0 }, now), { db: store.db, now });
    await expect(recordTokenUsage(agent, parseTokenUsage({ ...report, input: 3e9 + 1, output: 1e9, cacheRead: 0, cacheWrite: 0 }, now), { db: store.db, now })).rejects.toThrow("invalid_usage");
    expect([...store.sessions().values()][0].input).toBe(1e9);
  });

  test("limits new sessions per credential per hour while known sessions keep reporting", async () => {
    const store = usageDatabase();
    for (let index = 0; index < TOKEN_USAGE_NEW_SESSIONS_PER_HOUR; index++) {
      await recordTokenUsage(agent, parseTokenUsage({ ...report, session: index.toString(16).padStart(64, "0") }, now), { db: store.db, now });
    }
    await expect(recordTokenUsage(agent, parseTokenUsage({ ...report, session: "f".repeat(64) }, now), { db: store.db, now })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(recordTokenUsage(agent, parseTokenUsage({ ...report, session: "0".repeat(64), input: 500 }, now), { db: store.db, now })).resolves.toEqual({ added: 400 });
  });
});

describe("POST /api/usage", () => {
  function call(body: unknown, options: { auth?: string | null; token?: TokenRecord; contextOrg?: ReturnType<typeof org>; method?: string; entitlement?: () => Promise<void>; raw?: string } = {}) {
    const store = usageDatabase();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.auth !== null) headers.Authorization = options.auth ?? "Bearer valid";
    const request = new Request("https://engram.example/api/usage", { method: options.method ?? "POST", headers, ...(options.method === "GET" ? {} : { body: options.raw ?? JSON.stringify(body) }) });
    const token = options.token ?? agent;
    const response = handleTokenUsageRequest(request, {
      db: store.db, now: () => now,
      authenticate: async req => req.headers.get("authorization") === "Bearer valid" ? token : null,
      resolveOrg: async () => options.contextOrg ?? org(token.orgId),
      withOrg: async (current, actor, fn) => runWithContext({ org: current, token: { ...actor, orgId: current.id }, dataSql: store.db }, fn),
      entitlement: options.entitlement ?? (async () => {}),
    });
    return { store, response };
  }

  test("stores a valid bearer report and answers the contract body", async () => {
    const { store, response } = call(report);
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(store.sessions().size).toBe(1);
  });

  test("requires a valid bearer credential and POST", async () => {
    for (const auth of [null, "Bearer invalid"]) {
      const { store, response } = call(report, { auth });
      const result = await response;
      expect([result.status, await result.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
      expect(store.queries).toHaveLength(0);
    }
    const result = await call(report, { method: "GET" }).response;
    expect([result.status, result.headers.get("allow")]).toEqual([405, "POST"]);
  });

  test("refuses read-only credentials, agent writes disabled by policy, OAuth read scope, other workspaces and ended trials", async () => {
    const cases = [
      { token: normalizeToken({ ...agent, canWrite: false }), error: "forbidden" },
      { token: agent, contextOrg: org(7, parsePolicies({ agentsMayWrite: false })), error: "forbidden" },
      { token: normalizeToken({ ...agent, kind: "oauth", scopes: ["memory:read"] }), error: "forbidden" },
      { token: normalizeToken({ ...agent, orgId: 8 }), contextOrg: org(7), error: "forbidden" },
      { token: agent, entitlement: async () => { throw new BillingError("needs subscription", 402, "subscription_required"); }, error: "subscription_required" },
    ];
    for (const { error, ...options } of cases) {
      const { store, response } = call(report, options);
      const result = await response;
      expect([result.status, await result.json()]).toEqual([403, { ok: false, error }]);
      expect(store.queries).toHaveLength(0);
    }
  });

  test("rejects malformed, oversized and over-cap reports as invalid_usage", async () => {
    const big = JSON.stringify({ ...report, model: "x" }) + " ".repeat(TOKEN_USAGE_BODY_LIMIT);
    for (const options of [{ raw: "not json" }, { raw: big }, { raw: JSON.stringify({ ...report, input: -5 }) }, { raw: JSON.stringify({ ...report, input: 2e9 + 1, output: 0, cacheRead: 0, cacheWrite: 0 }) }]) {
      const result = await call(null, options).response;
      expect([result.status, await result.json()]).toEqual([400, { ok: false, error: "invalid_usage" }]);
    }
  });

  test("hides storage failures behind a retryable 503", async () => {
    const { store, response: _ } = call(report);
    const request = new Request("https://engram.example/api/usage", { method: "POST", headers: { Authorization: "Bearer valid" }, body: JSON.stringify(report) });
    const failing = Object.assign(((..._args: any[]) => Promise.reject(new Error("private connection details"))) as any, { begin: async () => { throw new Error("private connection details"); } });
    const result = await handleTokenUsageRequest(request, { db: failing, authenticate: async () => agent, resolveOrg: async () => org(), withOrg: async (current, actor, fn) => runWithContext({ org: current, token: actor, dataSql: store.db }, fn), entitlement: async () => {} });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private connection");
  });
});

describe("public token counters", () => {
  const profile: ShowcaseProfile = { slug: "my-agents", displayName: "Ada", bio: "", published: true, showActivity: false, showTokens: true, layout: "studio", highlights: [], photo: null };
  const tokenRow = {
    input: "1000000000", output: "200000000", cache_read: "1", cache_write: "0", today: "5000", last_hour: "1200", updated_at: "2026-11-16T10:19:00Z",
    products: [{ product: "claude-code", tokens: "900000000" }, { product: "codex", tokens: "300000000" }, { product: "secret-internal-tool", tokens: "1" }, { product: "other", tokens: "0" }],
    daily: [{ date: "2026-11-16", count: "5000" }, { date: "2026-08-25", count: "7" }, { date: "2026-08-24", count: "99" }, { date: "bad", count: "1" }],
  };

  test("projects totals, an 84-day series aligned with activity, and allowlisted products", () => {
    const snapshot = publicActivitySnapshot(profile, { completed_tasks: "12" }, now, { tokens: tokenRow });
    expect(snapshot.stats.completedTasks).toBe(12);
    const { daily, ...tokens } = snapshot.tokens;
    expect(tokens).toEqual({
      enabled: true, total: 1_200_000_001, input: 1_000_000_000, output: 200_000_000, cacheRead: 1, cacheWrite: 0, today: 5000, lastHour: 1200,
      agents: [{ product: "claude-code", label: "Claude Code", tokens: 900_000_000 }, { product: "codex", label: "Codex", tokens: 300_000_000 }, { product: "other", label: "Agent", tokens: 1 }],
      updatedAt: "2026-11-16T10:19:00.000Z", source: "local-session-logs",
    });
    expect(daily.map(day => day.date)).toEqual(snapshot.daily.map(day => day.date));
    expect([daily[0], daily.at(-1)]).toEqual([{ date: "2026-08-25", count: 7 }, { date: "2026-11-16", count: 5000 }]);
    expect(JSON.stringify(snapshot)).not.toContain("secret-internal-tool");
  });

  test("publishes zeros and empty arrays when the owner hides tokens, but previews what would show", () => {
    const hidden = publicActivitySnapshot({ ...profile, showTokens: false }, {}, now, { tokens: tokenRow });
    expect(hidden.tokens).toEqual({ enabled: false, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, today: 0, lastHour: 0, daily: [], agents: [], updatedAt: null, source: "local-session-logs" });
    const preview = publicActivitySnapshot({ ...profile, showTokens: false }, {}, now, { tokens: tokenRow, preview: true });
    expect([preview.tokens.enabled, preview.tokens.total]).toEqual([false, 1_200_000_001]);
    // Legacy profiles without the field show tokens by default.
    const { showTokens: _, ...legacy } = profile;
    expect(publicActivitySnapshot(legacy, {}, now, { tokens: tokenRow }).tokens.enabled).toBe(true);
    expect(publicTokens(true, {}, new Date("2026-11-16T00:00:00Z")).daily).toHaveLength(84);
  });

  test("puts a compact total in the page text, description and share card only when enabled", () => {
    const shown = publicActivitySnapshot(profile, { total_actions: "3400", active_agents: "12" }, now, { tokens: tokenRow });
    const page = renderShowcasePage(shown, "https://engram.example");
    expect(page).toContain("1.2B tokens · 3,400 actions · 12 agents");
    expect(page).toContain("1.2B tokens from agents&#39; local session logs and 3,400 agent actions");
    const card = renderShowcaseCard(shown);
    expect(card).toContain(">1.2B</text>");
    expect(card).toContain(">Tokens</text>");
    expect(card).not.toContain("Active days");
    const hidden = publicActivitySnapshot({ ...profile, showTokens: false }, { total_actions: "3400", active_agents: "12" }, now, { tokens: tokenRow });
    expect(renderShowcasePage(hidden, "https://engram.example")).not.toMatch(/tokens/i);
    expect(renderShowcaseCard(hidden)).not.toContain("Tokens");
    const empty = publicActivitySnapshot(profile, { total_actions: "3400", active_agents: "12" }, now, { tokens: {} });
    expect(renderShowcasePage(empty, "https://engram.example")).toContain("<p>3,400 actions · 12 agents</p>");
  });

  test("formats compact counters without overstating", () => {
    expect([0, 999, 1000, 1999, 2300, 999_999, 1_000_000, 2.3e9, 1_250_000_000, 9.99e9, 12_345_678_901, 1e12, -5, Number.NaN].map(compactNumber))
      .toEqual(["0", "999", "1K", "1.9K", "2.3K", "999K", "1M", "2.3B", "1.2B", "9.9B", "12B", "1T", "0", "0"]);
  });
});
