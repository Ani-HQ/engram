import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { getActivity, handleActivitiesApi, listActivities, validateActivityId } from "../gateway/src/activities";
import { runWithContext } from "../gateway/src/context";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";

const now = new Date("2026-10-22T12:00:00Z");
const actor = normalizeToken({ name: "agent-a", orgId: 7 });
const activity = {
  activity_id: "run:release/task", summary: "Prepare a release", status: "running", started_at: "2026-10-22T10:00:00Z", updated_at: now,
  agents: [
    { name: "agent-a", status: "completed", action_count: "1", last_active_at: now, working_actions: 0, stale_actions: 0 },
    { name: "agent-b", status: "running", action_count: "2", last_active_at: now, working_actions: 1, stale_actions: 1 },
  ],
  tools: ["code.build", "files.read"], approaches: [{ text: 'Compared local metadata {"password":"private-approach-value"}', agent: "agent-a", evidence: "reported" }],
  action_count: "3", run_id: "release/task", evidence: "reported", working_actions: "1", stale_actions: "1",
  actions: [{ id: "event-1", agent: "agent-a", tool: "code.build", summary: "Prepare a release", status: "completed", evidence: "reported", occurred_at: now, recorded_at: now, started_at: "2026-10-22T10:00:00Z", approach: "Compared file hashes" }],
};
function database() {
  const calls: { query: string; values: unknown[] }[] = [];
  let unavailable = false, missing = false;
  const db = ((strings: TemplateStringsArray, ...parameters: any[]) => {
    let query = strings[0]; const values: unknown[] = [];
    parameters.forEach((value, index) => {
      if (value?.fragment) { query += value.query; values.push(...value.values); }
      else { query += "?"; values.push(value); }
      query += strings[index + 1];
    });
    return { fragment: true, query, values, then(resolve: any, reject: any) {
      return Promise.resolve().then(() => {
        calls.push({ query, values });
        if (unavailable) throw new Error("private database details");
        return query.includes("AS activities") ? [{ activities: [activity, { ...activity, activity_id: "event:other" }], total: "4", running: "1", completed: "2", failed: "1", agents: ["agent-a", "agent-b"], tools: activity.tools }] : missing ? [] : [activity];
      }).then(resolve, reject);
    } };
  }) as unknown as postgres.Sql;
  return { db, calls, fail: () => { unavailable = true; }, missing: () => { missing = true; } };
}

describe("private grouped activity", () => {
  test("binds the authenticated tenant, filters complete groups before pagination, and preserves every contributor", async () => {
    const store = database();
    const result = await listActivities(actor, { q: "100%", agent: "agent-a", tool: "files.read", status: "running", resource: "private/file", runId: "release/task", limit: 1 }, store.db, now);
    expect(result.activities).toHaveLength(1); expect(result.more).toBe(true);
    expect(result.activities[0]).toMatchObject({ id: "run:release/task", status: "running", actionCount: 3, workingActions: 1, staleActions: 1 });
    expect(result.activities[0].agents.map(agent => agent.name)).toEqual(["agent-a", "agent-b"]);
    expect(result.activities[0].tools).toEqual(["code.build", "files.read"]);
    expect(result.activities[0].approaches[0].text).not.toContain("private-approach-value");
    expect(result.stats).toEqual({ running: 1, completed: 2, failed: 1, total: 4 });
    expect(result).toMatchObject({ checkedAt: now.toISOString(), freshnessSeconds: 900, agents: ["agent-a", "agent-b"] });
    const query = store.calls[0];
    expect(query.values.slice(0, 2)).toEqual([7, 7]);
    expect(query.query).toContain("PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)");
    expect(query.query).toContain("first_value(nullif(approach, ''))");
    expect(query.query).toContain("encode(sha256(convert_to(json_build_array(agent, action_key)::text");
    expect(query.query).toContain("EXISTS (SELECT 1 FROM ledger WHERE activity_id = grouped.activity_id");
    expect(query.query).toContain("FROM matching WHERE status = 'completed'");
    expect(query.query).not.toContain("ILIKE");
    expect(query.values).toContain("100%");
    expect(query.values).toContain("2026-10-22T11:45:00.000Z");
    expect(query.values.slice(-2)).toEqual([2, 0]);
  });

  test("returns one complete activity and its latest actions with preserved lifecycle start time", async () => {
    const store = database();
    const result = await getActivity(actor, "run:release/task", store.db, now);
    expect(result.activity.agents).toHaveLength(2);
    expect(result.activity.actions).toHaveLength(1);
    expect(result.activity.actions[0]).toMatchObject({ agent: "agent-a", approach: "Compared file hashes", startedAt: "2026-10-22T10:00:00.000Z" });
    expect(store.calls[0].values.slice(-1)).toEqual(["run:release/task"]);
    store.missing(); await expect(getActivity(actor, "event:missing", store.db, now)).rejects.toMatchObject({ status: 404 });
  });

  test("denies workspace context and OAuth scope mismatches before accessing private data", async () => {
    const store = database();
    await expect(listActivities(normalizeToken({ ...actor, kind: "oauth", scopes: ["memory:none"] }), {}, store.db)).rejects.toMatchObject({ status: 403 });
    await runWithContext({ org: { id: 8, name: "Other", slug: "other", kind: "team", brainDb: "brain_org_8", homeDir: "org-8", dataDb: "brain_org_8", policies: DEFAULT_POLICIES }, token: normalizeToken({ ...actor, orgId: 8 }), dataSql: store.db }, async () => {
      await expect(getActivity(actor, "run:release/task", store.db)).rejects.toMatchObject({ status: 403 });
    });
    expect(store.calls).toHaveLength(0);
  });

  test("bounds identifiers and query values, handles encoded run IDs, and contains storage errors", async () => {
    for (const value of [null, "", "run:", `run:${"x".repeat(201)}`, "action:bad", "event:", "run:hello\0world"]) expect(() => validateActivityId(value)).toThrow();
    expect(validateActivityId(`action:${"a".repeat(64)}`)).toStartWith("action:");
    const store = database();
    const response = await handleActivitiesApi(new Request("https://engram.example/api/activities/run%3Arelease%2Ftask"), actor, store.db);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).activity.id).toBe("run:release/task");
    expect((await handleActivitiesApi(new Request("https://engram.example/api/activities?status=unknown"), actor, store.db)).status).toBe(400);
    expect((await handleActivitiesApi(new Request("https://engram.example/api/activities/bad%ZZ"), actor, store.db)).status).toBe(400);
    expect((await handleActivitiesApi(new Request("https://engram.example/api/activities", { method: "POST" }), actor, store.db)).status).toBe(405);
    store.fail(); const failed = await handleActivitiesApi(new Request("https://engram.example/api/activities"), actor, store.db);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private database details");
  });
});

describe("task and memory stream boundaries", () => {
  test("selects whole groups before pagination and scopes facets to the selected stream", async () => {
    const store = database();
    await listActivities(actor, { kind: "tasks", limit: 1 }, store.db, now);
    const query = store.calls[0];
    expect(query.query).toContain("WITH all_ledger AS");
    expect(query.query).toContain("ledger AS (SELECT * FROM all_ledger candidate");
    expect(query.query).toContain("related.activity_id = candidate.activity_id AND related.evidence = 'reported'");
    expect(query.query.indexOf("ledger AS (SELECT")).toBeLessThan(query.query.indexOf("LIMIT"));
    expect(query.query).toContain("array_agg(DISTINCT resource ORDER BY resource)");
    expect(query.values.filter(value => value === "tasks")).toHaveLength(3);
    expect(query.query).toContain("AS agents,\n      (SELECT array_agg(DISTINCT tool ORDER BY tool) FROM ledger)");
    const bad = await handleActivitiesApi(new Request("https://engram.example/api/activities?kind=unknown"), actor, store.db);
    expect(bad.status).toBe(400);
  });
});
