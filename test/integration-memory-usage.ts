import assert from "node:assert/strict";
import postgres from "postgres";
import { authenticateStoredSecret, issueToken } from "../gateway/src/auth";
import { agentOnboardingChecks, listConnections } from "../gateway/src/connections";
import { applyContextBudget, mcpResultBytes, recordMcpUsage } from "../gateway/src/memory-usage";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";

// Called only after integration-postgres.ts verifies its disposable sandbox.
export async function checkMemoryUsage(db: postgres.Sql): Promise<number> {
  let checks = 0;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  for (const id of [1001, 1002]) await db`INSERT INTO orgs(id,name,slug,kind,brain_db,data_db,home_dir,policies,provisioning_status)
    VALUES(${id},'Context budget fixture',${`budget-${id}`},'team',${`brain_org_${id}`},${`brain_org_${id}`},${`org-${id}`},${db.json(DEFAULT_POLICIES)},'ready')`;
  const agent = (await authenticateStoredSecret(await issueToken(1001, "budget-agent", true, null, db), db))!;
  const foreign = (await authenticateStoredSecret(await issueToken(1002, "budget-agent", true, null, db), db))!;
  const owner = normalizeToken({ name: "budget-owner", orgId: 1001, kind: "session", role: "owner", email: "budget-owner@example.test" });
  const payload = (index: number) => ({ content: [{ type: "text", text: JSON.stringify({ results: [{ slug: `notes/decision-${index}`, snippet: "Private decision only in result. 🌿".repeat(18) }] }) }] });
  const first = await applyContextBudget(agent, "recall", { query: "private recall query" }, payload(0), { runId: "task:budget", maxBytes: 4096, db });
  equal((first._meta?.engramContext as any).available, true, "Real SQL transaction stores a scoped retrieval");
  equal((first._meta?.engramContext as any).responseBytes, mcpResultBytes(first), "Byte counts include the serialized MCP envelope and diagnostics");
  // A different pool simulates another gateway replica/restart. Durable state,
  // not a process map, must suppress the same response in the same task.
  const url = process.env.ENGRAM_TEST_DB_URL_TEMPLATE!.replace("__DB__", "engram_gateway");
  const replica = postgres(url, { max: 2, onnotice: () => {} });
  try {
    const duplicate = await applyContextBudget(agent, "recall", { query: "a different query" }, payload(0), { runId: "task:budget", db: replica });
    equal((duplicate._meta?.engramContext as any).duplicate, true, "A second gateway pool deduplicates the same delivered result");
    equal(duplicate.content[0].text!.includes("Private decision"), false, "Duplicate receipts never reinject memory text");
    equal((duplicate._meta?.engramContext as any).usedBytes, (first._meta?.engramContext as any).usedBytes, "A duplicate control receipt does not consume the retrieval budget");
    equal(Number((await db`SELECT delivered_bytes FROM memory_context_runs WHERE org_id = 1001`)[0].delivered_bytes), mcpResultBytes(first), "Durable retrieval bytes remain unchanged after a duplicate");
    equal(Number((await db`SELECT response_bytes FROM memory_connection_usage WHERE org_id = 1001 AND actor_name = ${agent.name}`)[0].response_bytes), mcpResultBytes(first) + mcpResultBytes(duplicate), "Duplicate control bytes remain visible in response-overhead diagnostics");
    const race = await Promise.all(Array.from({ length: 14 }, (_, index) => applyContextBudget(agent, "recall", {}, payload(index + 1), { runId: "task:budget", maxBytes: 16384, db: index % 2 ? replica : db })));
    const [ledger] = await db`SELECT max_bytes, delivered_bytes, fingerprints FROM memory_context_runs WHERE org_id = 1001`;
    equal(ledger.max_bytes, 4096, "Concurrent requests cannot increase the original run budget");
    equal(Number(ledger.delivered_bytes) <= 4096, true, "Advisory transactions enforce cumulative retrieval bytes across replicas");
    equal(race.some(response => (response._meta?.engramContext as any).budgetStopped), true, "Exhausted runs get a small control receipt instead of more memory");
    equal(race.filter(response => (response._meta?.engramContext as any).budgetStopped).every(response => !response.content[0].text!.includes("Private decision")), true, "Budget-stop receipts contain no retrieved data");
    const foreignRead = await applyContextBudget(foreign, "recall", {}, payload(0), { runId: "task:budget", db: replica });
    equal((foreignRead._meta?.engramContext as any).duplicate, false, "An identical run and actor name in another workspace has independent state");
    equal((foreignRead._meta?.engramContext as any).budgetStopped, false, "One workspace cannot consume another workspace's run budget");
    await recordMcpUsage(agent, "remember", { content: [{ type: "text", text: '{"ok":true}' }] }, { runId: "task:budget", db });
    const connection = (await listConnections(owner, db)).connections.find(row => row.name === agent.name)!;
    equal(connection.memoryUse.available, true, "Private connection details expose measured memory usage");
    equal(connection.memoryUse.duplicateRecalls, 1, "Connection diagnostics count suppressed duplicate responses");
    equal(connection.memoryUse.remembers, 1, "Successful memory-write receipts populate save counts");
    equal(connection.memoryUse.lastRecallAt !== null && connection.memoryUse.lastRememberAt !== null, true, "Successful recall/save dates are separately visible");
    equal(connection.memoryUse.budgetStops! >= 1, true, "Connection diagnostics disclose exhausted context budgets");
    equal(connection.memoryUse.tokenEstimate, "utf8-bytes-divided-by-4", "Token estimates are labeled as a byte heuristic, never model billing");
    const records = await db`SELECT * FROM memory_context_runs WHERE org_id = 1001`;
    equal(JSON.stringify(records).includes("Private decision"), false, "Persistent run rows contain no retrieved text");
    equal(JSON.stringify(records).includes("private recall query"), false, "Persistent run rows contain no queries");
    equal(JSON.stringify(records).includes("task:budget"), false, "Persistent run identifiers are hashed");
    const before = Number((await db`SELECT count(*) AS n FROM memory_context_runs WHERE org_id = 1001`)[0].n);
    const unscoped = await applyContextBudget(agent, "recall", {}, payload(99), { db: replica });
    equal((unscoped._meta?.engramContext as any).scope, "response", "Clients without run metadata get a truthful per-response cap");
    equal(Number((await db`SELECT count(*) AS n FROM memory_context_runs WHERE org_id = 1001`)[0].n), before, "Unscoped calls never create a shared time bucket that can block other tasks");
    await db`UPDATE memory_context_runs SET updated_at = now() - interval '8 days' WHERE org_id = 1001`;
    await applyContextBudget(agent, "recall", {}, payload(100), { runId: "task:new", db: replica });
    equal(Number((await db`SELECT count(*) AS n FROM memory_context_runs WHERE org_id = 1001`)[0].n), 1, "Expired run rows are removed within the authenticated workspace");
    equal(Number((await db`SELECT count(*) AS n FROM memory_context_runs WHERE org_id = 1002`)[0].n), 1, "Retention cleanup cannot delete another workspace's rows");

    const blocked = (await authenticateStoredSecret(await issueToken(1001, "budget-no-delivered-recall", true, null, db), db))!;
    for (let index = 0; index < 8; index++) await applyContextBudget(blocked, "list_pages", {}, payload(index + 200), { runId: "task:stop-proof", db });
    await db`INSERT INTO audit_log(org_id,token_name,tool,arg_summary,outcome) VALUES(1001,${blocked.name},'recall','upstream succeeded but delivery stopped','ok')`;
    const stopped = await applyContextBudget(blocked, "recall", {}, payload(500), { runId: "task:stop-proof", db });
    equal((stopped._meta?.engramContext as any).budgetStopped, true, "The proof fixture stops retrieval after non-recall reads consume the run budget");
    equal((await agentOnboardingChecks(1001, db)).memoryRecalled, true, "A different eligible agent retains its genuine delivered-recall proof");
    // Isolate the blocked credential without changing its usage history.
    await db`UPDATE tokens SET revoked_at = now() WHERE org_id = 1001 AND name = ${agent.name}`;
    const stoppedProof = await agentOnboardingChecks(1001, db);
    equal(stoppedProof.agentConnected, true, "Successful upstream contact can prove connectivity even when memory is skipped");
    equal(stoppedProof.memoryRecalled, false, "A post-feature upstream audit success cannot claim delivered memory after a budget stop");
    await db`INSERT INTO audit_log(org_id,token_name,tool,arg_summary,outcome) VALUES(1001,${blocked.name},'get_page','upstream succeeded but projection failed','ok')`;
    await applyContextBudget(blocked, "get_page", {}, { content: [{ type: "text", text: "Page cannot fit the response boundary" }], isError: true }, { runId: "task:error-proof", db });
    equal((await agentOnboardingChecks(1001, db)).memoryRecalled, false, "A final error result cannot advance recall onboarding");
    // Pre-feature, unambiguous successful audits remain valid historical proof.
    await db`UPDATE tokens SET created_at = (SELECT memory_usage_started_at FROM engram_schema_state WHERE id = true) - interval '2 days' WHERE org_id = 1001 AND name = ${blocked.name}`;
    await db`INSERT INTO audit_log(org_id,token_name,tool,arg_summary,outcome,ts)
      SELECT 1001, ${blocked.name}, 'recall', 'legacy successful receipt', 'ok', memory_usage_started_at - interval '1 day' FROM engram_schema_state WHERE id = true`;
    equal((await agentOnboardingChecks(1001, db)).memoryRecalled, true, "Pre-feature successful audits retain their historical recall proof");

    await db`UPDATE memory_connection_usage SET updated_at = now() - interval '40 days' WHERE org_id = 1002`;
    await db`INSERT INTO memory_connection_usage (org_id, actor_key, actor_name, actor_kind)
      SELECT 1002, md5('capacity-left-' || n::text) || md5('capacity-right-' || n::text), 'capacity-retained-' || n::text, 'token'
      FROM generate_series(1, 4095) n`;
    equal(await recordMcpUsage(foreign, "remember", { content: [{ type: "text", text: '{"ok":true}' }] }, { db }), true, "Existing actors can update numeric receipts at the 4096-actor limit");
    const [retained] = await db`SELECT recalls, remembers FROM memory_connection_usage WHERE org_id = 1002 AND actor_name = ${foreign.name}`;
    equal(Number(retained.recalls), 1, "Inactivity does not erase durable delivered-recall proof");
    equal(Number(retained.remembers), 1, "Existing actors keep recording successful saves when the diagnostic inventory is full");
    const newActor = (await authenticateStoredSecret(await issueToken(1002, "budget-capacity-new", true, null, db), db))!;
    equal(await recordMcpUsage(newActor, "remember", { content: [{ type: "text", text: '{"ok":true}' }] }, { db }), false, "A full diagnostic inventory reports unavailable measurements for a new actor");
    equal(Number((await db`SELECT count(*) AS n FROM memory_connection_usage WHERE org_id = 1002`)[0].n), 4096, "Diagnostic row capacity remains bounded without evicting existing proof");
    const unknown = (await listConnections(normalizeToken({ ...owner, orgId: 1002 }), db)).connections.find(row => row.name === newActor.name)!;
    equal([unknown.memoryUse.available, unknown.memoryUse.recalls, unknown.memoryUse.responseBytes], [false, null, null], "Private inventory distinguishes unavailable new measurements from measured zero");

    const integration = { id: "engram-sdk-fixture", version: "0.1.0", runtime: "integration-test", capabilities: ["task-context", "explicit-deltas"] };
    const context = { runId: "task:compatibility", integration, credentialKey: "c".repeat(64), db };
    const whoami = { content: [{ type: "text", text: JSON.stringify({ token: agent.name }) }] };
    const verify = async (change: Record<string, unknown>) => {
      const response = await applyContextBudget(agent, "whoami", {}, whoami, { ...context, ...change });
      equal(response.isError === true, false, "Explicit verification control returns a bounded successful receipt");
      equal(mcpResultBytes(response) <= 4096, true, "Verification controls stay inside the MCP wire budget");
      return JSON.parse(response.content[0].text!).verification;
    };
    const begun = await verify({ verification: "begin" });
    equal(/^emp_[A-Za-z0-9_-]{32}$/.test(begun.probeId), true, "Gateway issues the compatibility nonce");
    equal([begun.status, begun.recallVerified, begun.saveVerified, begun.automaticWorkflowVerified], ["pending", false, false, null], "A client declaration alone proves no read, save or automatic workflow");
    const checked = { ...context, probeId: begun.probeId };
    await applyContextBudget(agent, "recall", {}, { content: [{ type: "text", text: "Not delivered" }], isError: true }, checked);
    equal((await verify({ verification: "status", probeId: begun.probeId })).recallVerified, false, "A failed final read never advances a compatibility check");
    await applyContextBudget(agent, "recall", {}, payload(900), checked);
    const afterRead = await verify({ verification: "status", probeId: begun.probeId });
    equal([afterRead.status, afterRead.recallVerified, afterRead.saveVerified], ["pending", true, false], "An actual delivered read proves only recall");
    await applyContextBudget(agent, "remember", {}, { content: [{ type: "text", text: '{"ok":true,"slug":"notes/explicit-fixture-decision"}' }] }, checked);
    const passed = await verify({ verification: "status", probeId: begun.probeId });
    equal([passed.status, passed.recallVerified, passed.saveVerified, passed.automaticWorkflowVerified], ["passed", true, true, null], "Correlated actual gateway receipts verify a test sequence without attesting automatic invocation");
    for (const change of [
      { runId: "other-task" }, { credentialKey: "d".repeat(64) },
      { integration: { ...integration, version: "0.2.0" } },
    ]) equal((await verify({ verification: "status", probeId: begun.probeId, ...change })).status, "not-found", "A probe cannot mix task, credential or integration version scopes");
    // Restore the original declaration, then explicitly begin a new isolated check.
    const expiring = await verify({ verification: "begin" });
    await db`UPDATE memory_integration_checks SET started_at = now() - interval '30 minutes', expires_at = now() - interval '15 minutes' WHERE org_id = 1001`;
    await applyContextBudget(agent, "recall", {}, payload(901), { ...context, probeId: expiring.probeId });
    const expired = await verify({ verification: "status", probeId: expiring.probeId });
    equal([expired.status, expired.recallVerified], ["expired", false], "Expired probes never absorb later receipts");
    const diagnostic = (await listConnections(owner, db)).connections.find(row => row.name === agent.name)!.memoryUse.integration;
    equal([diagnostic.connected, diagnostic.recallVerified, diagnostic.saveVerified, diagnostic.workflowCheck, diagnostic.automaticWorkflowVerified], [true, true, true, "expired", null], "Private diagnostics separate actual receipts, expired check and unknown automatic use");
    equal(diagnostic.declaration, { ...integration, capabilities: ["explicit-deltas", "task-context"] }, "Private diagnostics retain only a bounded normalized client declaration");
    const probeRows = await db`SELECT * FROM memory_integration_checks WHERE org_id = 1001`;
    equal(JSON.stringify(probeRows).includes(begun.probeId) || JSON.stringify(probeRows).includes(context.runId), false, "Probe storage hashes raw nonce and task identifiers");
  } finally { await replica.end({ timeout: 2 }); }
  return checks;
}
