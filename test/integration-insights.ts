import assert from "node:assert/strict";
import type postgres from "postgres";
import { handleInsightsApi, runInsightWorkerOnce } from "../gateway/src/insights";
import { reserveWorkspaceInference } from "../gateway/src/insights-budget";
import { config } from "../gateway/src/config";
import { withOrg, type Org } from "../gateway/src/orgs";
import type { TokenRecord } from "../gateway/src/policies";
import { logicalActivityId, analyzeActions } from "../gateway/src/insights-engine";
import { listActions } from "../gateway/src/actions";
import { upsertMemoryEntry } from "../gateway/src/memory-entries";
import { reconcileMemoryInsights } from "../gateway/src/insights-reconcile";

// Called only by the guarded disposable PostgreSQL integration script. This
// module never selects credentials, starts a server or contacts any provider.
export async function checkInsights(input: { db: postgres.Sql; orgA: Org; orgB: Org; actorA: TokenRecord; actorB: TokenRecord }): Promise<number> {
  const { db, orgA, orgB, actorA, actorB } = input;
  let checks = 0;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  const ok = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
  const request = (body: unknown) => new Request("http://localhost/api/insights", { method: "POST", body: JSON.stringify(body) });
  await db`DELETE FROM insight_jobs WHERE org_id IN (${orgA.id},${orgB.id})`;
  const queued = await withOrg(orgA, actorA, () => handleInsightsApi(request({ q: "package" }), actorA, db));
  equal(queued.status, 202, "A real authenticated workspace queues durable activity checks without provider consent");
  const queuedBody = await queued.json();
  equal(queuedBody.external.consented, false, "External processing stays disabled by default");
  equal(queuedBody.external.jevConsented, false, "Jev consent is independently disabled by default");
  const coalesced = await withOrg(orgA, actorA, () => handleInsightsApi(request({ q: "package" }), actorA, db));
  equal((await coalesced.json()).job.id, queuedBody.job.id, "Identical concurrent workspace checks reuse one durable job");
  const foreign = await withOrg(orgB, actorB, () => handleInsightsApi(new Request(`http://localhost/api/insights?jobId=${queuedBody.job.id}`), actorB, db));
  equal(foreign.status, 404, "Knowing a job UUID cannot cross a workspace boundary");
  let ran = 0;
  await runInsightWorkerOnce({ db, process: async job => {
    equal(job.orgId, orgA.id, "Worker claims only the stored tenant identity"); ran++;
    return analyzeActions({ actions: [], now: new Date("2026-10-22T12:00:00Z") });
  } });
  equal(ran, 1, "A real PostgreSQL lease executes the queued job once");
  const completed = await withOrg(orgA, actorA, () => handleInsightsApi(new Request(`http://localhost/api/insights?jobId=${queuedBody.job.id}`), actorA, db));
  const completedBody = await completed.json();
  equal(completedBody.job.status, "completed", "Leased completion becomes readable by its workspace");
  equal(completedBody.result.brief.method, "extractive", "The no-provider pipeline produces an extractive brief");
  equal(await runInsightWorkerOnce({ db }), false, "Completed jobs are not replayed");

  await db`UPDATE insight_jobs SET status='running',attempts=1,lease_until=now()-interval '1 second',lease_token=gen_random_uuid() WHERE id=${queuedBody.job.id}`;
  equal(await runInsightWorkerOnce({ db, process: async () => analyzeActions({ actions: [] }) }), true, "A dead process's expired lease is recoverable");
  equal(Number((await db`SELECT attempts FROM insight_jobs WHERE id=${queuedBody.job.id}`)[0].attempts), 2, "Lease recovery increments the durable attempt count");
  await db`UPDATE insight_jobs SET status='running',attempts=3,lease_until=now()-interval '1 second',lease_token=gen_random_uuid() WHERE id=${queuedBody.job.id}`;
  await runInsightWorkerOnce({ db });
  equal((await db`SELECT status FROM insight_jobs WHERE id=${queuedBody.job.id}`)[0].status, "failed", "Exhausted crashed jobs end with a visible failure instead of running forever");

  const history = await listActions(actorA, { limit: 20 }, db);
  const keyed = history.actions.find(action => action.actionKey);
  if (keyed) {
    const rows = await db`SELECT 'action:' || encode(sha256(convert_to(json_build_array(${keyed.agent}::text,${keyed.actionKey}::text)::text,'UTF8')),'hex') AS id`;
    equal(logicalActivityId({ ...keyed, runId: null }), rows[0].id, "Insight citations use exactly the same stable activity IDs as PostgreSQL");
  }
  await db`DELETE FROM insight_provider_budgets WHERE org_id IN (${orgA.id},${orgB.id})`;
  equal(await reserveWorkspaceInference(orgA.id, db), false, "A configured operator cannot bypass absent workspace consent");
  const policies = (await db`SELECT policies FROM orgs WHERE id=${orgA.id}`)[0].policies;
  await db`UPDATE orgs SET policies=${db.json({ ...policies, externalAiProcessing: true })} WHERE id=${orgA.id}`;
  try {
    equal(await reserveWorkspaceInference(orgA.id, db, "jev"), false, "Legacy external-AI consent does not authorize Jev");
    const memory = await withOrg(orgA, actorA, () => upsertMemoryEntry({ slug: "projects/insight-recovery", rawText: "A committed memory whose process stopped before enqueue.", tokenName: actorA.name }));
    ok(memory, "A real tenant memory is committed independently of its outbox job");
    await reconcileMemoryInsights({ db, configured: true });
    equal(Number((await db`SELECT count(*) AS count FROM insight_jobs WHERE org_id=${orgA.id} AND kind='memory' AND dedup_key=${memory!.id}`)[0].count), 0, "Legacy consent does not queue Jev memory analysis");
    await db`UPDATE orgs SET policies=${db.json({ ...policies, externalAiProcessing: false, jevProcessing: true })} WHERE id=${orgA.id}`;
    await reconcileMemoryInsights({ db, configured: true });
    equal(Number((await db`SELECT count(*) AS count FROM insight_jobs WHERE org_id=${orgA.id} AND kind='memory' AND dedup_key=${memory!.id}`)[0].count), 1, "A bounded reconciliation pass recovers a post-commit enqueue gap");
    await reconcileMemoryInsights({ db, configured: true });
    equal(Number((await db`SELECT count(*) AS count FROM insight_jobs WHERE org_id=${orgA.id} AND kind='memory' AND dedup_key=${memory!.id}`)[0].count), 1, "Repeated reconciliation remains delivery-idempotent");
    ok((await db`SELECT scanned_id FROM insight_memory_cursors WHERE org_id=${orgA.id}`)[0]?.scanned_id, "A durable tenant cursor advances beyond processed memory rows");
    await db`UPDATE orgs SET policies=${db.json({ ...policies, externalAiProcessing: false, jevProcessing: true, jevMayPropose: false })} WHERE id=${orgA.id}`;
    equal(await reserveWorkspaceInference(orgA.id, db), false, "Jev consent does not authorize a legacy embedding/brief provider");
    const reservations = await Promise.all(Array.from({ length: config.insights.dailyProviderCalls + 4 }, () => reserveWorkspaceInference(orgA.id, db, "jev")));
    equal(reservations.filter(Boolean).length, config.insights.dailyProviderCalls, "Concurrent workers share one exact durable daily provider budget");
    equal(await reserveWorkspaceInference(orgB.id, db, "jev"), false, "Another workspace never inherits Jev consent or budget state");
    await db`UPDATE orgs SET policies=${db.json(policies)} WHERE id=${orgA.id}`;
    equal(await reserveWorkspaceInference(orgA.id, db, "jev"), false, "Jev revocation is read again immediately before the next provider reservation");
    ok(!(await db`SELECT 1 FROM insight_jobs WHERE org_id=${orgB.id}`).length, "Private checks never enqueue foreign tenant work");
  } finally {
    await db`UPDATE orgs SET policies=${db.json(policies)} WHERE id=${orgA.id}`;
    await db`DELETE FROM insight_provider_budgets WHERE org_id IN (${orgA.id},${orgB.id})`;
  }
  return checks;
}
