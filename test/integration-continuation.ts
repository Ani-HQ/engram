// Called only by the marked disposable PostgreSQL integration runner.
import assert from "node:assert/strict";
import type postgres from "postgres";
import { closeOrgPool, ensureDatabase, migrateOrgDataTables, poolFor } from "../gateway/src/db";
import { getOrg, withOrg } from "../gateway/src/orgs";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { checkpointTask, exportTasks, findTasks, getTask, handleTasksApi, listTasks, resumeTask, setTaskState } from "../gateway/src/continuation";
import { callTool } from "../gateway/src/proxy";

export async function checkContinuation(db: postgres.Sql): Promise<number> {
  assert.equal((await db`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose, "engram-disposable-integration-v1");
  let checks = 1;
  const equal = (a: unknown, b: unknown, message: string) => { assert.deepEqual(a, b, message); checks++; };
  const ok = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
  const reject = async (fn: () => Promise<unknown>, code: string, message: string) => {
    await assert.rejects(fn, (error: any) => error.code === code, message); checks++;
  };
  const aId = 850001, bId = 850002;
  try {
    equal(Number((await db`SELECT count(*) AS n FROM orgs WHERE id IN (${aId}, ${bId})`)[0].n), 0, "Continuation fixtures must not replace an existing workspace");
    for (const id of [aId, bId]) {
      await db`INSERT INTO orgs (id, name, slug, kind, brain_db, data_db, home_dir, policies, provisioning_status)
        VALUES (${id}, ${`Continuation ${id}`}, ${`continuation-${id}`}, 'team', ${`brain_org_${id}`}, ${`brain_org_${id}`}, ${`org-${id}`}, ${db.json(DEFAULT_POLICIES)}, 'ready')`;
      await ensureDatabase(`brain_org_${id}`);
      await migrateOrgDataTables(poolFor(`brain_org_${id}`));
      await migrateOrgDataTables(poolFor(`brain_org_${id}`));
      await poolFor(`brain_org_${id}`)`TRUNCATE continuation_receipts, continuation_heads, continuation_checkpoints, continuation_tasks`;
      await poolFor(`brain_org_${id}`)`TRUNCATE memory_entries, trails, reflex_decisions, review_items, dream_runs RESTART IDENTITY CASCADE`;
    }
    const orgA = (await getOrg(aId, db))!, orgB = (await getOrg(bId, db))!;
    const claude = normalizeToken({ name: "claude-code", orgId: aId, canWrite: true });
    const codex = normalizeToken({ name: "codex", orgId: aId, canWrite: true });
    const reader = normalizeToken({ name: "read-only", orgId: aId, canWrite: false });
    const owner = normalizeToken({ name: "owner@example.test", orgId: aId, role: "owner", kind: "session", email: "owner@example.test" });
    const outsider = normalizeToken({ name: "claude-code", orgId: bId, canWrite: true });
    const inA = <T>(actor: any, fn: () => Promise<T>) => withOrg(orgA, actor, fn);

    const record = { objective: "Continue work across agents", next: "Write the storage layer", plan: [{ id: "s1", step: "Spec", status: "done" }, { id: "s2", step: "Storage", status: "doing" }] };
    const start = { requestId: "req_start_0001", title: "Continuation v1", project: "engram", record, harness: "claude-code", repo: "Ani-HQ/engram", branch: "feat/continuation-v1" };
    const created = await inA(claude, () => checkpointTask(claude, start));
    equal([created.created, created.revision, created.lineage, created.unchanged], [true, 1, "main", false], "Starting a task commits its first checkpoint");

    // A timeout after commit is retried with the same request: one task, one receipt.
    const retried = await inA(claude, () => checkpointTask(claude, start));
    equal([retried.taskId, retried.checkpointId, retried.duplicate], [created.taskId, created.checkpointId, true], "An identical retry returns the original receipt");
    await reject(() => inA(claude, () => checkpointTask(claude, { ...start, title: "Different" })), "request_conflict", "Reusing a request ID with a different body conflicts");
    // The same request ID from another credential is a different request, not a disclosure.
    const other = await inA(codex, () => checkpointTask(codex, start));
    ok(other.taskId !== created.taskId && other.created, "Request IDs are scoped to their writer");
    await inA(owner, () => setTaskState(owner, other.taskId, "delete"));

    // Codex continues Claude's task.
    const found = await inA(codex, () => findTasks(codex, { project: "ENGRAM" }));
    equal([found.tasks.length, found.ambiguous, found.tasks[0].id], [1, false, created.taskId], "A unique task in a project is found without ambiguity, and deleted tasks are hidden");
    const resumed: any = await inA(codex, () => resumeTask(codex, { taskId: created.taskId }));
    equal([resumed.checkpoint.id, resumed.checkpoint.savedBy, resumed.checkpoint.reportedSource, resumed.record.next], [created.checkpointId, "claude-code", "claude-code", "Write the storage layer"], "Resume returns the authoritative record with attributed source");
    ok(resumed.boundary.includes("No final handoff"), "An interrupted task says no handoff was recorded");

    const decision = { ...record, decisions: [{ text: "Checkpoints live in workspace storage", why: "One transaction with receipts" }] };
    const second = await inA(codex, () => checkpointTask(codex, { requestId: "req_codex_0001", taskId: created.taskId, expectedParent: created.checkpointId, trigger: "decision", record: decision, harness: "codex" }));
    equal([second.revision, second.created], [2, false], "A decision advances the lineage");
    const unchanged = await inA(codex, () => checkpointTask(codex, { requestId: "req_codex_0002", taskId: created.taskId, expectedParent: second.checkpointId, trigger: "handoff", record: decision }));
    equal([unchanged.unchanged, unchanged.checkpointId, unchanged.revision], [true, second.checkpointId, 2], "Unchanged content creates no new revision, even for a handoff");

    // Claude still holds revision 1. Its save must not overwrite Codex's plan.
    const stale = { requestId: "req_start_0002", taskId: created.taskId, expectedParent: created.checkpointId, trigger: "plan", record: { ...record, next: "Something else" } };
    await assert.rejects(() => inA(claude, () => checkpointTask(claude, stale)), (error: any) => error.code === "revision_conflict" && error.detail.currentCheckpointId === second.checkpointId); checks++;
    const fork = await inA(claude, () => checkpointTask(claude, { ...stale, lineage: "claude-alt" }));
    equal([fork.lineage, fork.revision], ["claude-alt", 2], "A stale writer can fork an explicit lineage from its parent");
    await reject(() => inA(codex, () => resumeTask(codex, { taskId: created.taskId })), "ambiguous_lineage", "Parallel lineages require an explicit choice");
    equal((await inA(codex, () => findTasks(codex, {}))).ambiguous, true, "Parallel lineages make discovery ambiguous");
    const main: any = await inA(codex, () => resumeTask(codex, { taskId: created.taskId, lineage: "main" }));
    equal([main.checkpoint.id, main.otherLineages], [second.checkpointId, 1], "A named lineage resumes its own head");
    const pinned: any = await inA(codex, () => resumeTask(codex, { taskId: created.taskId, checkpointId: created.checkpointId }));
    equal(pinned.newerCheckpointId, second.checkpointId, "Loading an older checkpoint points to the newer head");

    // Concurrent writers from the same head: exactly one wins.
    const race = await Promise.allSettled(["req_race_0001", "req_race_0002"].map(requestId => inA(codex, () => checkpointTask(codex, {
      requestId, taskId: created.taskId, expectedParent: second.checkpointId, trigger: "milestone", record: { ...decision, next: requestId },
    }))));
    equal(race.map(result => result.status).sort(), ["fulfilled", "rejected"], "Concurrent saves from one parent commit exactly once");
    const winner = (race.find(result => result.status === "fulfilled") as PromiseFulfilledResult<any>).value;

    // Access boundaries.
    await reject(() => inA(reader, () => checkpointTask(reader, { ...start, requestId: "req_reader_001" })), "write_denied", "A read-only connection cannot save");
    ok((await inA(reader, () => findTasks(reader, {}))).tasks.length > 0, "A read-only connection can still find tasks");
    await reject(() => withOrg(orgB, outsider, () => resumeTask(outsider, { taskId: created.taskId })), "task_not_found", "Another workspace cannot read the task, even with the same agent name");
    await reject(() => withOrg(orgB, outsider, () => checkpointTask(outsider, { requestId: "req_start_0001", taskId: created.taskId, expectedParent: created.checkpointId, record })), "task_not_found", "Another workspace cannot append to the task");
    equal((await withOrg(orgB, outsider, () => findTasks(outsider, {}))).tasks, [], "Discovery is workspace scoped");
    await reject(() => inA(codex, () => setTaskState(codex, created.taskId, "delete")), "forbidden", "Agent credentials cannot delete tasks");

    // Immutable history.
    await assert.rejects(() => poolFor(`brain_org_${aId}`)`UPDATE continuation_checkpoints SET record = '{}'::jsonb WHERE id = ${created.checkpointId}`, /immutable/); checks++;

    // Completion closes; closed tasks leave default discovery but stay resumable.
    const done = await inA(codex, () => checkpointTask(codex, { requestId: "req_done_00001", taskId: created.taskId, lineage: "main", expectedParent: winner.checkpointId, trigger: "completed", record: { ...decision, next: "Nothing; shipped" } }));
    equal(done.closed, true, "A completed trigger closes the task");
    equal((await inA(codex, () => findTasks(codex, { project: "engram" }))).tasks.length, 0, "Closed tasks are hidden by default");
    equal((await inA(codex, () => findTasks(codex, { project: "engram", includeClosed: true }))).tasks.length, 1, "Closed tasks are found on request");
    equal((await inA(owner, () => listTasks(owner, new URLSearchParams("status=closed")))).tasks.find(task => task.id === created.taskId)?.latest?.lineage, "main", "The console lists closed tasks with their latest checkpoint");
    const detail = await inA(owner, () => getTask(owner, created.taskId));
    equal([detail.lineages.length, detail.history.length, detail.task.status], [2, 5, "closed"], "Task detail shows lineages and full history");
    const exported = await inA(owner, () => exportTasks(owner, new URLSearchParams()));
    equal(exported.tasks.find(task => task.id === created.taskId)?.checkpoints.length, 5, "Export reads every authoritative checkpoint");

    // Console HTTP routes.
    const http = (path: string, method = "GET", actor: any = owner) => inA(actor, () => handleTasksApi(new Request(`https://integration.example${path}`, { method }), actor));
    const listed = await http("/api/tasks?status=all");
    equal([listed.status, listed.headers.get("cache-control")], [200, "no-store"], "The console lists tasks without caching");
    ok((await listed.json()).tasks.some((task: any) => task.id === created.taskId), "The console list includes the task");
    equal((await http(`/api/tasks/${created.taskId}/checkpoints/${created.checkpointId}`)).status, 200, "A single checkpoint is readable");
    equal((await http(`/api/tasks/${created.taskId}`, "DELETE", codex)).status, 403, "Agents cannot delete through HTTP");
    equal((await http("/api/tasks/not-a-task")).status, 400, "Malformed task IDs are rejected");
    equal((await http(`/api/tasks/${created.taskId}/explode`, "POST")).status, 404, "Unknown task actions are not found");

    // Soft deletion removes the task everywhere; a delayed retry cannot revive it.
    await inA(owner, () => setTaskState(owner, created.taskId, "delete"));
    await reject(() => inA(codex, () => resumeTask(codex, { taskId: created.taskId })), "task_deleted", "A deleted task never falls back to an older checkpoint");
    await reject(() => inA(claude, () => checkpointTask(claude, start)), "task_deleted", "A delayed retry cannot resurrect a deleted task");
    equal((await inA(owner, () => exportTasks(owner, new URLSearchParams()))).tasks.some(task => task.id === created.taskId), false, "Deleted tasks leave exports");
    await inA(owner, () => setTaskState(owner, created.taskId, "restore"));
    equal((await inA(owner, () => exportTasks(owner, new URLSearchParams()))).tasks.some(task => task.id === created.taskId), true, "An authorized person can restore a deleted task");

    // Meaning-based matching (judge injected; production uses Jev with consent).
    const pricing = await inA(codex, () => checkpointTask(codex, { requestId: "req_price_0001", title: "Pricing page copy refresh", project: "site", record: { objective: "Rewrite the pricing page around one flat plan.", next: "Draft three headlines.", decisions: [{ text: "Use a flat team price of $49." }] } }));
    const judge = async (_query: string, items: any[]) => new Map(items.map((item: any) => [item.id, item.id === pricing.taskId ? 3 : 0]));
    const vague = await inA(codex, () => findTasks(codex, { query: "the money page thing" }, undefined, 5, { judge }));
    equal([vague.ranking, vague.ambiguous, vague.tasks.map(task => task.id)], ["jev", false, [pricing.taskId]], "A judged match finds a task whose words differ from the request");
    const noJudge = await inA(codex, () => findTasks(codex, { query: "the money page thing" }, undefined, 5, { judge: async () => null }));
    equal([noJudge.ranking, noJudge.tasks.length], ["text", 0], "Without Jev, matching falls back to literal text");
    const tie = await inA(codex, () => findTasks(codex, { query: "anything", includeClosed: true }, undefined, 5, { judge: async (_q: string, items: any[]) => new Map(items.map((item: any) => [item.id, 3])) }));
    equal(tie.ambiguous, true, "Several equally strong matches stay ambiguous");

    // Memory saved after a checkpoint is counted; a judged contradiction is flagged.
    await poolFor(`brain_org_${aId}`)`INSERT INTO memory_entries (id, fingerprint, slug, raw_text, recorded_at) VALUES ('me_price_1', 'fp_price_1', 'projects/pricing', 'Decision: the team price is now $29 flat.', clock_timestamp())`;
    const plain: any = await inA(codex, () => resumeTask(codex, { taskId: pricing.taskId }, undefined, { judge: async () => null }));
    equal([plain.newerMemories, plain.freshness, plain.staleDecisions], [1, undefined, undefined], "Without Jev, resume only counts newer memory");
    ok(/recall it if relevant/.test(plain.boundary), "The boundary tells the agent to recall newer memory");
    const judged: any = await inA(codex, () => resumeTask(codex, { taskId: pricing.taskId }, undefined, { judge: async () => [{ decision: 0, memory: "projects/pricing", relation: "supersede" as const }] }));
    equal([judged.freshness, judged.staleDecisions], ["checked", [{ decision: 0, relation: "supersede", memory: "projects/pricing" }]], "A judged stale decision is flagged with its memory page");
    const { resumeEnvelopeBytes } = await import("../gateway/src/continuation");
    ok(resumeEnvelopeBytes(judged) <= 3840, "Resume with notes still fits one default read");

    // Through the MCP tool boundary, results stay bounded and errors are structured.
    const tool = await inA(codex, () => callTool(codex, "resume_task", { taskId: created.taskId, lineage: "main" }));
    const body = JSON.parse(tool.content[0].text);
    equal([tool.isError ?? false, body.task.id], [false, created.taskId], "resume_task works through the MCP boundary");
    const denied = await inA(reader, () => callTool(reader, "checkpoint_task", { ...start, requestId: "req_reader_002" }));
    ok(denied.isError && /denied/.test(denied.content[0].text), "A read-only save is denied at the tool boundary");
    ok(!/claude-code|Continue work/.test(JSON.stringify((await db`SELECT arg_summary FROM audit_log WHERE tool IN ('checkpoint_task', 'resume_task') ORDER BY id DESC LIMIT 4`).map(row => row.arg_summary))), "Audit metadata never copies task content");
    return checks;
  } finally {
    await Promise.all([closeOrgPool(`brain_org_${aId}`), closeOrgPool(`brain_org_${bId}`)]);
  }
}
