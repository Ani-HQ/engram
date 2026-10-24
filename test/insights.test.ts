import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { analyzeActions, enrichInsights, logicalActivityId, providerSnippet, type InsightAction } from "../gateway/src/insights-engine";
import { handleInsightsApi, parseInsightRequest, runInsightWorkerOnce, startInsightWorker } from "../gateway/src/insights";
import { confidenceOf, validateAnswers, choiceOf, noulValue, scoreOf } from "../gateway/src/reflex/answers";
import { TypesafeReflexClient } from "../gateway/src/reflex/client";
import { parseClassification } from "../gateway/src/reflex/tasks/classify";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { runWithContext } from "../gateway/src/context";
import type { ReflexClient } from "../gateway/src/reflex/types";

const now = new Date("2026-10-22T12:00:00Z");
function action(id: string, input: Partial<InsightAction> = {}): InsightAction {
  return { id, activityId: `event:${id}`, agent: "alpha", tool: "files.write", summary: "Update release manifest", resource: "release/manifest", status: "completed",
    evidence: "reported", runId: null, actionKey: null, eventId: null, occurredAt: now.toISOString(), recordedAt: now.toISOString(), startedAt: now.toISOString(), detail: null, approach: null, ...input };
}
describe("typed inference boundary", () => {
  test("abstains on nonfinite, missing and out-of-range confidence and values", () => {
    for (const confidence of [NaN, Infinity, -0.1, 1.1, undefined, "0.9"]) {
      const answer = { type: "choice", choice: "yes", confidence } as any;
      expect(confidenceOf(answer)).toBeNull(); expect(choiceOf({ x: answer }, "x", 0.7)).toBeNull();
    }
    for (const value of [NaN, Infinity, -1, 1.01]) expect(noulValue({ x: { type: "noul", noul: value } }, "x", 0.5)).toBeNull();
    for (const value of [NaN, Infinity, -1, 4]) expect(scoreOf({ x: { type: "score", score: value, confidence: 0.9 } }, "x", 0.7, 3)).toBeNull();
  });
  test("validates transport answers against exact requested choices and score scale", () => {
    const questions = { x: { type: "choice" as const, instructions: "x", criteria: { yes: "Yes", no: "No" } }, y: { type: "score" as const, instructions: "y", criteria: ["low", "high"] } };
    expect(validateAnswers({ x: { type: "choice", choice: "yes", confidence: 0.8 } }, questions)).not.toBeNull();
    for (const raw of [{ invented: { type: "noul", noul: 0.9 } }, { x: { type: "choice", choice: "admin", confidence: 1 } }, { y: { type: "score", score: 2, confidence: 1 } }, { x: { type: "score", score: 0, confidence: 1 } }]) expect(validateAnswers(raw, questions)).toBeNull();
  });
  test("importance and confidence remain different quantities", () => {
    const result = parseClassification({ kind: { type: "choice", choice: "decision", confidence: 0.8 }, importance: { type: "score", score: 2, confidence: 0.9 } }, "jev-1.13.0");
    expect(result.importance).toBe(2); expect(result.confidence).toBe(0.8);
  });
  test("pins requested version, records model provenance and rejects a silently changed model", async () => {
    let sent: any;
    const provider = new TypesafeReflexClient(async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ model: "jev-1.13.0", answers: { x: { type: "noul", noul: 0.9 } } }); }, Date.now, { apiKey: "fixture-key", model: "jev-1.13.0" });
    const result = await provider.evaluate({ state: { text: 'email me@example.com token {"password":"fixture-secret"}' }, questions: { x: { type: "noul", instructions: "x" } } });
    expect(sent.model).toBe("jev-1.13.0"); expect(JSON.stringify(sent)).not.toContain("fixture-secret");
    expect(result).toMatchObject({ model: "jev-1.13.0", requestedModel: "jev-1.13.0", modelReported: true });
    const mismatch = new TypesafeReflexClient(async () => Response.json({ model: "jev-1.14.0", answers: { x: { type: "noul", noul: 0.9 } } }), Date.now, { apiKey: "fixture-key", model: "jev-1.13.0" });
    expect(await mismatch.evaluate({ state: {}, questions: { x: { type: "noul", instructions: "x" } } })).toBeNull();
  });
  test("does not transmit without workspace consent even when a key is present", async () => {
    let calls = 0;
    const provider = new TypesafeReflexClient(async () => { calls++; return Response.json({}); }, Date.now, { apiKey: "fixture-key" });
    await runWithContext({ org: { id: 2, name: "A", slug: "a", kind: "team", brainDb: "brain_org_2", dataDb: "brain_org_2", homeDir: "org-2", policies: DEFAULT_POLICIES }, token: normalizeToken({ name: "a", orgId: 2 }), dataSql: {} as postgres.Sql }, async () => {
      expect(await provider.evaluate({ state: {}, questions: { x: { type: "noul", instructions: "x" } } })).toBeNull();
    });
    expect(calls).toBe(0);
  });
  test("forwards cancellation and makes no retry after the overall deadline", async () => {
    let calls = 0, signal: AbortSignal | undefined;
    const provider = new TypesafeReflexClient(async (_url, init) => {
      calls++; signal = init!.signal as AbortSignal;
      await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      return Response.json({});
    }, Date.now, { apiKey: "fixture-key" });
    expect(await provider.evaluate({ state: {}, questions: { x: { type: "noul", instructions: "x" } }, signal: AbortSignal.timeout(10), maxAttempts: 1 })).toBeNull();
    expect(signal?.aborted).toBe(true); expect(calls).toBe(1);
  });
});

describe("evidence-linked activity analysis", () => {
  test("stale receipts mean unknown outcome, not invented failure or completion", () => {
    const stale = action("stale", { status: "running", recordedAt: "2026-10-22T11:45:00Z" }), fresh = action("fresh", { status: "running", recordedAt: "2026-10-22T11:45:00.001Z" });
    const result = analyzeActions({ actions: [stale, fresh], now });
    expect(result.insights).toHaveLength(1); expect(result.insights[0]).toMatchObject({ kind: "stalled", sources: ["stale"], activityIds: ["event:stale"], method: "rule", confidence: null });
    expect(result.insights[0].description).toContain("outcome is unknown"); expect(stale.status).toBe("running");
  });
  test("requires three distinct failures on the same tool and resource inside one day", () => {
    const actions = [action("a", { status: "failed" }), action("b", { status: "failed" }), action("c", { status: "failed" }), action("old", { status: "failed", recordedAt: "2026-10-20T00:00:00Z" }), action("other", { status: "failed", resource: "other" })];
    expect(analyzeActions({ actions, now }).insights.find(item => item.kind === "repeated_failure")?.sources).toEqual(["a", "b", "c"]);
    expect(analyzeActions({ actions: actions.slice(0, 2), now }).insights).toHaveLength(0);
  });
  test("similar-work rule requires distinct contributors, identical reports and a five-minute window", () => {
    const a = action("a"), b = action("b", { agent: "beta", occurredAt: "2026-10-22T11:55:00Z" });
    expect(analyzeActions({ actions: [a, b], now }).insights[0].kind).toBe("duplicate");
    expect(analyzeActions({ actions: [a, { ...b, agent: a.agent }], now }).insights).toHaveLength(0);
    expect(analyzeActions({ actions: [a, { ...b, occurredAt: "2026-10-22T11:54:59Z" }], now }).insights).toHaveLength(0);
  });
  test("local search and handoff cite only actual reports and bound coverage", () => {
    const actions = [action("calendar", { summary: "Schedule the meeting", tool: "calendar.create" }), action("deploy", { summary: "Repair the failed deployment", approach: "Compared release manifests" })];
    const result = analyzeActions({ actions, q: "deployment", now, truncated: true });
    expect(result.search?.matches[0]).toMatchObject({ actionId: "deploy", activityId: "event:deploy" });
    expect(result.brief.method).toBe("extractive"); expect(result.brief.text).toContain("[reported]"); expect(result.brief.text).toContain("Compared release manifests");
    expect(result.coverage).toEqual({ actionsChecked: 2, maxActions: 200, truncated: true });
    expect(result.brief.sources.every(id => result.sourceActions.some(item => item.id === id))).toBe(true);
    expect(analyzeActions({ actions, q: "unrelated-query", now }).search?.matches).toEqual([]);
  });
  test("stable activity IDs match the PostgreSQL pair serialization and isolate contributor keys", () => {
    expect(logicalActivityId(action("a", { runId: "release" }))).toBe("run:release");
    expect(logicalActivityId(action("a"))).toBe("event:a");
    const keyed = action("a", { actionKey: "build" });
    expect(logicalActivityId(keyed)).toMatch(/^action:[a-f0-9]{64}$/);
    expect(logicalActivityId({ ...keyed, id: "new-event" })).toBe(logicalActivityId(keyed));
    expect(logicalActivityId({ ...keyed, agent: "beta" })).not.toBe(logicalActivityId(keyed));
  });
  test("keeps all cited evidence previews when many notices compete with an older search match", () => {
    const actions = Array.from({ length: 80 }, (_, index) => action(`item-${index}`, { summary: index === 79 ? "Unique historical migration evidence" : `Recent work ${index}`, resource: `resource-${index}`, status: "running", recordedAt: "2026-10-22T10:00:00Z" }));
    const result = analyzeActions({ actions, q: "historical migration", now });
    expect(result.search?.matches[0].actionId).toBe("item-79");
    const cited = [...result.brief.sources, ...result.insights.flatMap(item => item.sources), ...result.search!.matches.map(item => item.actionId)];
    expect(cited.every(id => result.sourceActions.some(action => action.id === id))).toBe(true);
    expect(result.sourceActions.length).toBeLessThanOrEqual(30);
  });
  test("model relations need high confidence, minimal redacted input and explicit suggestion labels", async () => {
    const actions = [action("a", { summary: 'Set release target alpha {"password":"method-secret"} contact private@example.test https://private.example.test' }), action("b", { agent: "beta", summary: "Set release target beta" })];
    let sent = "";
    const client: ReflexClient = { enabled: () => true, available: () => true, async evaluate(input) { sent = JSON.stringify(input); return { model: "jev-1.13.0", requestedModel: "jev-1.13.0", modelReported: true, answers: { pair0: { type: "choice", choice: "conflict", confidence: 0.9 } } }; } };
    const result = await enrichInsights(analyzeActions({ actions, now }), actions, client);
    expect(sent).not.toContain("method-secret"); expect(sent).not.toContain("private@example.test"); expect(sent).not.toContain("private.example.test"); expect(sent).not.toContain('"agent"');
    expect(result.insights[0]).toMatchObject({ kind: "conflict", method: "model", confidence: 0.9, sources: ["a", "b"] });
    expect(result.insights[0].description).toContain("not a verified outcome"); expect(result.provenance[0].requestedModel).toBe("jev-1.13.0");
    expect(providerSnippet("me@example.test https://example.test password=abc")).not.toContain("me@example");
  });
});

function jobsDatabase() {
  const queries: { text: string; values: any[] }[] = [], jobs: any[] = [];
  const db = ((strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join("?"); queries.push({ text, values });
    if (text.includes("SELECT pg_advisory")) return Promise.resolve([]);
    if (text.includes("SELECT count(*)")) return Promise.resolve([{ count: jobs.length }]);
    if (text.includes("SELECT * FROM insight_jobs")) {
      if (text.includes("status IN")) return Promise.resolve(jobs.filter(job => job.org_id === values[0] && ["queued", "running"].includes(job.status)).slice(-1));
      return Promise.resolve(jobs.filter(job => job.org_id === values[0] && (!text.includes("id =") || job.id === values[1])).slice(-1));
    }
    if (text.includes("INSERT INTO insight_jobs")) { const job = { id: values[0], org_id: values[1], actor_name: values[2], request: values[3], status: "queued", created_at: now, updated_at: now }; jobs.push(job); return Promise.resolve([job]); }
    if (text.includes("RETURNING *") && text.includes("status='running'")) { const job = jobs.find(job => job.status === "queued"); if (!job) return Promise.resolve([]); job.status = "running"; job.lease_token = values[0]; return Promise.resolve([job]); }
    if (text.includes("status='completed'")) { const job = jobs.find(job => job.id === values[1] && job.lease_token === values[2] && job.status === "running"); if (job) { job.result = values[0]; job.status = "completed"; } }
    if (text.includes("status='failed'") && text.includes("processing_unavailable")) { const job = jobs.find(job => job.id === values[0]); if (job) job.status = "failed"; }
    if (text.includes("status='failed'") && text.includes("job_timeout")) { const job = jobs.find(job => job.id === values[0] && job.lease_token === values[1]); if (job) job.status = "failed"; }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  (db as any).begin = (fn: any) => fn(db); (db as any).json = (value: any) => value;
  return { db, jobs, queries };
}
describe("durable private insight jobs", () => {
  const actor = normalizeToken({ name: "owner", orgId: 7, role: "owner", canWrite: true });
  const post = (input: unknown) => new Request("http://localhost/api/insights", { method: "POST", body: JSON.stringify(input) });
  test("validates request bounds and rejects arbitrary model, org or contributor claims", () => {
    for (const input of [{ q: "a".repeat(501) }, { orgId: 9 }, { model: "unsafe" }, { activityId: "arbitrary" }]) expect(() => parseInsightRequest(input)).toThrow();
  });
  test("creates one scoped durable job, coalesces identical requests and does not leak to another workspace", async () => {
    const store = jobsDatabase();
    const response = await handleInsightsApi(post({ q: "deployment" }), actor, store.db), body = await response.json();
    expect(response.status).toBe(202); expect(body.job.status).toBe("queued"); expect(store.jobs[0].org_id).toBe(7);
    expect((await handleInsightsApi(post({ q: "deployment" }), actor, store.db)).status).toBe(202); expect(store.jobs).toHaveLength(1);
    expect((await handleInsightsApi(post({ q: "different" }), actor, store.db)).status).toBe(409);
    expect((await handleInsightsApi(new Request(`http://localhost/api/insights?jobId=${body.job.id}`), { ...actor, orgId: 8 }, store.db)).status).toBe(404);
    expect((await handleInsightsApi(new Request("http://localhost/api/insights?jobId=bad"), actor, store.db)).status).toBe(400);
  });
  test("enforces read/write scopes before storage", async () => {
    const store = jobsDatabase();
    expect((await handleInsightsApi(post({}), { ...actor, canWrite: false }, store.db)).status).toBe(403);
    expect((await handleInsightsApi(new Request("http://localhost/api/insights"), { ...actor, kind: "oauth", scopes: ["memory:none"] }, store.db)).status).toBe(403);
    expect(store.queries).toHaveLength(0);
  });
  test("claims work using a database lease and conditionally stores the completed result", async () => {
    const store = jobsDatabase(); await handleInsightsApi(post({}), actor, store.db);
    let calls = 0;
    expect(await runInsightWorkerOnce({ db: store.db, process: async input => { calls++; expect(input.orgId).toBe(7); return analyzeActions({ actions: [], now }); } })).toBe(true);
    expect(calls).toBe(1); expect(store.jobs[0].status).toBe("completed");
    expect(store.queries.some(query => query.text.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(store.queries.some(query => query.text.includes("lease_token=? AND status='running'"))).toBe(true);
    expect(await runInsightWorkerOnce({ db: store.db })).toBe(false);
  });
  test("holds worker slots until actual work settles instead of stacking abandoned work", async () => {
    const store = jobsDatabase();
    for (let i = 0; i < 5; i++) store.jobs.push({ id: `job${i}`, org_id: 7, status: "queued", request: { q: null, activityId: null } });
    const releases: (() => void)[] = []; let calls = 0;
    const worker = startInsightWorker({ db: store.db, process: async () => { calls++; await new Promise<void>(resolve => releases.push(resolve)); return analyzeActions({ actions: [], now }); } });
    await Bun.sleep(2100);
    expect(calls).toBe(2);
    const closing = worker.close(); releases.forEach(resolve => resolve()); await closing;
    expect(calls).toBe(2); expect(store.jobs.filter(job => job.status === "queued")).toHaveLength(3);
  });
  test("marks a stalled job failed but retains its actual work lease until settlement", async () => {
    const store = jobsDatabase(); await handleInsightsApi(post({}), actor, store.db);
    let release!: () => void, settled = false;
    const running = runInsightWorkerOnce({ db: store.db, jobTimeoutMs: 10, process: async () => { await new Promise<void>(resolve => { release = resolve; }); return analyzeActions({ actions: [], now }); } }).finally(() => { settled = true; });
    await Bun.sleep(30);
    expect(store.jobs[0].status).toBe("failed"); expect(settled).toBe(false);
    release(); await running;
    expect(store.jobs[0].status).toBe("failed"); expect(store.jobs[0].result).toBeUndefined();
  });
});
