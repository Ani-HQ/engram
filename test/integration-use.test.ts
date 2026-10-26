import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { INTEGRATION_CHECKS_PER_ACTOR, INTEGRATION_CHECKS_PER_ORG, integrationVerification, mapIntegrationUse, recordIntegrationDeclaration, recordIntegrationReceipt } from "../gateway/src/integration-use";
import { normalizeToken } from "../gateway/src/policies";

const actor = normalizeToken({ orgId: 7, name: "custom-runtime", kind: "token" });
const integration = { id: "custom-sdk", version: "0.1.0", runtime: "custom-runtime", capabilities: ["task-context", "explicit-deltas"] };
const options = { runId: "task:test", integration, credentialKey: "c".repeat(64) };
function database() {
  const calls: { query: string; values: any[] }[] = [];
  const checks = new Map<string, any>();
  let capacity = false, expired = false;
  const db = (async (parts: TemplateStringsArray, ...values: any[]) => {
    const query = parts.join("?"); calls.push({ query, values });
    if (query.includes("INSERT INTO memory_integration_checks")) {
      if (capacity) return [];
      const [org, actor, probe, run, credential, declaration] = values;
      const row = { org, actor, probe, run, credential, declaration, started_at: new Date(), expires_at: new Date(Date.now() + 900000), recall_at: null, save_at: null };
      checks.set(probe, row); return [row];
    }
    if (query.includes("SELECT started_at")) {
      const [org, actor, probe, run, credential, declaration] = values, row = checks.get(probe);
      return row && row.org === org && row.actor === actor && row.run === run && row.credential === credential && row.declaration === declaration ? [row] : [];
    }
    if (query.includes("UPDATE memory_integration_checks")) {
      const [recall, save, org, actor, probe, run, credential, declaration] = values, row = checks.get(probe);
      if (!row || expired || row.org !== org || row.actor !== actor || row.run !== run || row.credential !== credential || row.declaration !== declaration) return [];
      if (recall) row.recall_at ||= new Date(); if (save) row.save_at ||= new Date(); return [row];
    }
    return [];
  }) as unknown as postgres.Sql;
  db.json = ((value: any) => value) as any;
  return { db, calls, checks, capacity() { capacity = true; }, expire() { expired = true; for (const row of checks.values()) row.expires_at = new Date(Date.now() - 1); } };
}
describe("private integration compatibility receipts", () => {
  test("issues an opaque nonce and correlates real receipts without attesting automatic invocation", async () => {
    const store = database(), begun = await integrationVerification(store.db, actor, "a".repeat(64), { ...options, verification: "begin" });
    expect(begun.verification).toMatchObject({ status: "pending", recallVerified: false, saveVerified: false, automaticWorkflowVerified: null });
    expect(begun.nonce).toMatch(/^emp_[A-Za-z0-9_-]{32}$/);
    const context = { ...options, probeId: begun.nonce };
    await recordIntegrationReceipt(store.db, actor, "a".repeat(64), context, true, false);
    const read = await integrationVerification(store.db, actor, "a".repeat(64), { ...context, verification: "status" });
    expect(read.verification).toMatchObject({ status: "pending", recallVerified: true, saveVerified: false });
    await recordIntegrationReceipt(store.db, actor, "a".repeat(64), context, false, true);
    const saved = await integrationVerification(store.db, actor, "a".repeat(64), { ...context, verification: "status" });
    expect(saved.verification).toMatchObject({ status: "passed", recallVerified: true, saveVerified: true, automaticWorkflowVerified: null });
    expect(saved.verification.checkedAt).not.toBeNull();
    expect(JSON.stringify(store.calls)).not.toContain(begun.nonce);
    expect(JSON.stringify(store.calls)).not.toContain(options.runId);
    const inserted = store.calls.find(call => call.query.includes("INSERT INTO memory_integration_checks"))!;
    expect(inserted.values.at(-3)).toBe(INTEGRATION_CHECKS_PER_ACTOR);
    expect(inserted.values.at(-1)).toBe(INTEGRATION_CHECKS_PER_ORG);
  });
  test("a nonce cannot combine actors, workspaces, runs, credentials, versions or expired receipts", async () => {
    const store = database(), key = "a".repeat(64), begun = await integrationVerification(store.db, actor, key, { ...options, verification: "begin" });
    const context = { ...options, probeId: begun.nonce };
    for (const [identity, actorKey, changed] of [
      [{ ...actor, orgId: 8 }, key, context], [actor, "b".repeat(64), context],
      [actor, key, { ...context, runId: "different" }], [actor, key, { ...context, credentialKey: "d".repeat(64) }],
      [actor, key, { ...context, integration: { ...integration, version: "0.2.0" } }],
    ] as const) {
      await recordIntegrationReceipt(store.db, identity, actorKey, changed, true, true);
      expect((await integrationVerification(store.db, identity, actorKey, { ...changed, verification: "status" })).verification.status).toBe("not-found");
    }
    store.expire();
    await recordIntegrationReceipt(store.db, actor, key, context, true, true);
    expect((await integrationVerification(store.db, actor, key, { ...context, verification: "status" })).verification).toMatchObject({ status: "expired", recallVerified: false, saveVerified: false });
    expect(store.calls.find(call => call.query.includes("DELETE FROM memory_integration_checks"))!.values).toEqual([7]);
  });
  test("capacity abstains and declarations cannot create verification evidence", async () => {
    const store = database(); store.capacity();
    await expect(integrationVerification(store.db, actor, "a".repeat(64), { ...options, verification: "begin" })).rejects.toThrow("capacity");
    await recordIntegrationDeclaration(store.db, actor, "a".repeat(64), options);
    expect(mapIntegrationUse({ integration_data: { declaration: { ...integration, automaticWorkflowVerified: true } } }).automaticWorkflowVerified).toBeNull();
    expect(mapIntegrationUse({ integration_data: { declaration: integration } })).toMatchObject({ declaration: { ...integration, capabilities: ["explicit-deltas", "task-context"] }, workflowCheck: "not-checked", automaticWorkflowVerified: null });
    expect(mapIntegrationUse()).toMatchObject({ connected: false, recallVerified: false, saveVerified: false, workflowCheck: "not-checked", automaticWorkflowVerified: null });
    const future = new Date(Date.now() + 100000).toISOString(), past = new Date(Date.now() - 100000).toISOString();
    expect(mapIntegrationUse({ integration_data: { check: { status: "passed", startedAt: future, expiresAt: future, checkedAt: past } } }).workflowCheck).toBe("not-checked");
    expect(mapIntegrationUse({ integration_data: { check: { status: "pending", startedAt: past, expiresAt: past } } }).workflowCheck).toBe("expired");
    const before = store.calls.length;
    await recordIntegrationDeclaration(store.db, actor, "a".repeat(64), { credentialKey: options.credentialKey });
    expect(store.calls[before].query).toContain("integration_check = NULL");
    expect(store.calls[before].values).toEqual([options.credentialKey, 7, "a".repeat(64), options.credentialKey]);
  });
});
