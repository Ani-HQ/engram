import assert from "node:assert/strict";
import type postgres from "postgres";
import { authenticateStoredSecret, issueToken } from "../gateway/src/auth";
import { recordAction } from "../gateway/src/actions";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { getPublicActivity, getShowcaseSettings, updateShowcaseSettings } from "../gateway/src/showcase";
import { parseTokenUsage, recordTokenUsage } from "../gateway/src/token-usage";
import { TOKEN_USAGE_SCHEMA_VERSION } from "../gateway/src/token-usage-schema";

// Called only after integration-postgres.ts verifies its disposable sandbox.
export async function checkTokenUsage(db: postgres.Sql): Promise<number> {
  let checks = 0;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  for (const id of [1101, 1102]) await db`INSERT INTO orgs(id,name,slug,kind,brain_db,data_db,home_dir,policies,provisioning_status)
    VALUES(${id},'Token usage fixture',${`tokens-${id}`},'team',${`brain_org_${id}`},${`brain_org_${id}`},${`org-${id}`},${db.json(DEFAULT_POLICIES)},'ready')`;
  await db`INSERT INTO action_profiles (org_id, slug, display_name, bio, published) VALUES (1101, 'token-flex', 'Token fixture', '', true)`;
  equal((await db`SELECT token_usage_version FROM engram_schema_state WHERE id = true`)[0].token_usage_version, TOKEN_USAGE_SCHEMA_VERSION, "Token usage readiness is recorded");
  const column = (await db`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'action_profiles' AND column_name = 'show_tokens'`)[0];
  equal([column?.column_default, column?.is_nullable], ["true", "NO"], "Existing profiles acquire a non-null token switch that defaults on");
  equal((await db`SELECT show_tokens FROM action_profiles WHERE org_id = 1101`)[0].show_tokens, true, "New profiles show counters by default");

  const agent = (await authenticateStoredSecret(await issueToken(1101, "usage-laptop", true, null, db), db))!;
  const foreign = (await authenticateStoredSecret(await issueToken(1102, "usage-laptop", true, null, db), db))!;
  const session = "b".repeat(64);
  const base = { harness: "claude-code", session, model: "claude-opus-5-5", input: 1000, output: 200, cacheRead: 50_000, cacheWrite: 300 };
  const hour = (iso: string) => new Date(iso);
  equal(await recordTokenUsage(agent, parseTokenUsage(base), { db, now: hour("2026-11-16T09:10:00Z") }), { added: 51_500 }, "A new session counts its first cumulative totals");
  equal(await recordTokenUsage(agent, parseTokenUsage(base), { db, now: hour("2026-11-16T09:15:00Z") }), { added: 0 }, "An identical retry adds nothing");
  equal(await recordTokenUsage(agent, parseTokenUsage({ ...base, input: 1500, cacheRead: 60_000 }), { db, now: hour("2026-11-16T10:05:00Z") }), { added: 10_500 }, "Growth is counted once");
  equal(await recordTokenUsage(agent, parseTokenUsage({ ...base, input: 1200, output: 260 }), { db, now: hour("2026-11-16T10:06:00Z") }), { added: 60 }, "An out-of-order report adds only per-column growth");
  equal((await db`SELECT input, output, cache_read, cache_write, harness, model FROM token_usage_sessions WHERE org_id = 1101`).map(row => ({ ...row })), [{ input: "1500", output: "260", cache_read: "60000", cache_write: "300", harness: "claude-code", model: "claude-opus-5-5" }], "Stored totals are per-column maxima");
  equal((await db`SELECT to_char(hour AT TIME ZONE 'UTC', 'HH24:MI') AS hour, input, output, cache_read, cache_write FROM token_usage_hourly WHERE org_id = 1101 ORDER BY hour`).map(row => ({ ...row })), [
    { hour: "09:00", input: "1000", output: "200", cache_read: "50000", cache_write: "300" },
    { hour: "10:00", input: "500", output: "60", cache_read: "10000", cache_write: "0" },
  ], "Deltas land in the UTC receipt hour");
  await assert.rejects(() => recordTokenUsage(agent, parseTokenUsage({ ...base, session: "c".repeat(64), input: 5e10, output: 1 })), (error: any) => error.code === "invalid_usage"); checks++;
  equal(Number((await db`SELECT count(*) AS n FROM token_usage_sessions WHERE session_hash = ${"c".repeat(64)}`)[0].n), 0, "A rejected over-cap report stores no session row");

  // Concurrent deliveries of overlapping totals must not double count.
  const racing = "d".repeat(64);
  await Promise.all(Array.from({ length: 12 }, (_, index) => recordTokenUsage(agent, parseTokenUsage({ ...base, session: racing, harness: "codex", input: 100 * (index + 1), output: 0, cacheRead: 0, cacheWrite: 0 }), { db, now: hour("2026-11-16T10:30:00Z") })));
  equal(Number((await db`SELECT input FROM token_usage_sessions WHERE session_hash = ${racing}`)[0].input), 1200, "Concurrent reports keep the maximum cumulative total");
  equal(Number((await db`SELECT input FROM token_usage_hourly WHERE org_id = 1101 AND harness = 'codex'`)[0].input), 1200, "Row locks make concurrent growth add up exactly once");
  await recordTokenUsage(foreign, parseTokenUsage({ ...base, input: 9 }), { db, now: hour("2026-11-16T10:30:00Z") });
  equal(Number((await db`SELECT input FROM token_usage_sessions WHERE org_id = 1101 AND session_hash = ${session}`)[0].input), 1500, "A same-named credential and session in another workspace has independent totals");
  await assert.rejects(() => db`INSERT INTO token_usage_hourly (org_id, hour, harness) VALUES (1101, '2026-11-16T10:30:00Z', 'codex')`); checks++;

  // Completed tasks count each logical agent.task once, at its latest state.
  await recordAction(agent, { tool: "agent.task", summary: "Ship tokens", taskTitle: "Ship tokens", actionKey: "usage:task", status: "running" }, db);
  await recordAction(agent, { tool: "agent.task", summary: "Ship tokens", taskTitle: "Ship tokens", actionKey: "usage:task", status: "completed" }, db);
  await recordAction(agent, { tool: "agent.task", summary: "Still going", actionKey: "usage:other", status: "running" }, db);
  const now = hour("2026-11-16T10:40:00Z");
  const shown = (await getPublicActivity("token-flex", db, now))!;
  equal(shown.stats.completedTasks, 1, "Public stats count completed logical tasks");
  equal({ ...shown.tokens, daily: undefined }, {
    enabled: true, total: 63_260, input: 2_700, output: 260, cacheRead: 60_000, cacheWrite: 300, today: 63_260, lastHour: 63_260,
    daily: undefined, agents: [{ product: "claude-code", label: "Claude Code", tokens: 62_060 }, { product: "codex", label: "Codex", tokens: 1_200 }],
    updatedAt: "2026-11-16T10:30:00.000Z", source: "local-session-logs",
  }, "Real SQL builds all-time totals, today, the rolling hour and product totals");
  equal([shown.tokens.daily.length, shown.tokens.daily.at(-1)], [84, { date: "2026-11-16", count: 63_260 }], "The daily series uses the activity window");
  equal((await getPublicActivity("token-flex", db, hour("2026-11-16T11:40:00Z")))!.tokens.lastHour, 11_760, "The rolling hour covers the current and previous UTC hour buckets");
  const owner = normalizeToken({ name: "usage-owner", orgId: 1101, kind: "session", role: "owner", email: "usage-owner@example.test" });
  const profile = (await getShowcaseSettings(owner, "https://integration.example", db)).profile;
  await updateShowcaseSettings(owner, { ...profile, showTokens: false }, "https://integration.example", db);
  const hidden = (await getPublicActivity("token-flex", db, now))!;
  equal([hidden.tokens.enabled, hidden.tokens.total, hidden.tokens.daily, hidden.tokens.agents], [false, 0, [], []], "Hidden counters publish zeros and empty arrays");
  equal((await getShowcaseSettings(owner, "https://integration.example", db)).preview.tokens.total > 0, true, "The owner preview still shows what would publish");
  const { showTokens: _, ...legacy } = profile;
  equal((await updateShowcaseSettings(owner, { ...legacy, bio: "Old client" }, "https://integration.example", db)).profile.showTokens, false, "Legacy clients that omit showTokens preserve the stored choice");
  for (const table of ["token_usage_hourly", "token_usage_sessions"]) await db.unsafe(`DELETE FROM ${table} WHERE org_id IN (1101, 1102)`);
  return checks;
}
