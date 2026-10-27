import assert from "node:assert/strict";
import type postgres from "postgres";
import { authenticateStoredSecret, issueToken, sha256 } from "../gateway/src/auth";
import { observeConnectionClient } from "../gateway/src/connection-client";
import { listConnections } from "../gateway/src/connections";
import { normalizeToken } from "../gateway/src/policies";

// Only the guarded disposable-cluster harness invokes this suite.
export async function checkConnectionClients(db: postgres.Sql): Promise<number> {
  let checks = 0;
  function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
  const owner = normalizeToken({ name: "detect-owner", orgId: 2, role: "owner", kind: "session", email: "detect-owner@example.test" });
  const raw = await issueToken(2, "detected-client", false, null, db, { harness: "claude-code", label: "Manual laptop" });
  const foreignRaw = await issueToken(3, "detected-client", false, null, db);
  const actor = (await authenticateStoredSecret(raw, db))!, foreign = (await authenticateStoredSecret(foreignRaw, db))!;
  const modern = (name: string) => ({ _meta: { "io.modelcontextprotocol/clientInfo": { name, version: "unused-private-version" } } });
  const observe = (name: string) => observeConnectionClient(actor, sha256(raw), "tools/list", modern(name), db);
  const state = async (orgId: number, name = "detected-client") => (await db`SELECT client_names FROM tokens WHERE org_id = ${orgId} AND name = ${name}`)[0].client_names;
  const client = async (name = "detected-client") => (await listConnections(owner, db)).connections.find(row => row.name === name)!.client;
  equal(await state(2), [], "Existing and newly issued keys begin without invented client identity");
  equal(await client(), { state: "unknown", label: null, harness: null }, "A manual source label does not masquerade as client detection");
  await observeConnectionClient(actor, sha256(raw), "initialize", { clientInfo: { name: "OpenAI Codex", version: "ignored" } }, db);
  equal(await state(2), ["Codex"], "Legacy initialize records the declared client on this exact credential");
  equal(await client(), { state: "identified", label: "Codex", harness: "codex" }, "Inventory exposes the detected client separately from credential metadata");
  equal((await db`SELECT harness, source_label, can_write FROM tokens WHERE org_id=2 AND name='detected-client'`)[0], { harness: "claude-code", source_label: "Manual laptop", can_write: false }, "Client detection preserves manual source and read-only permission");
  await Promise.all(Array.from({ length: 16 }, () => observe("codex desktop")));
  equal(await state(2), ["Codex"], "Concurrent duplicate alias requests append only one canonical client");
  await observeConnectionClient(actor, sha256(raw), "tools/list", {}, db);
  await observe("mcp-remote");
  equal(await state(2), ["Codex"], "Missing and generic bridge metadata cannot erase a previously useful declaration");
  await observeConnectionClient(foreign, sha256(raw), "tools/list", modern("Goose"), db);
  equal(await state(2), ["Codex"], "An authenticated actor from another workspace cannot select this key by digest");
  equal(await state(3), [], "A same-named credential in another workspace stays untouched");
  await Promise.all([observe("Cursor"), observe("Claude Code")]);
  equal((await state(2)).sort(), ["Claude Code", "Codex", "Cursor"], "Concurrent distinct clients are all retained rather than overwriting one another");
  equal(await client(), { state: "multiple", label: "Multiple clients", harness: null }, "A shared key has no single last-writer client identity");
  await Promise.all([observe("Gemini CLI"), observe("Goose"), observe("Amp")]);
  equal((await state(2)).length, 4, "A credential cannot grow an unbounded client-name collection");
  equal((await client()).state, "multiple", "A saturated collection remains explicitly shared");

  await db`UPDATE tokens SET revoked_at=now(), name='detected-client-retired' WHERE org_id=2 AND name='detected-client'`;
  const replacement = await issueToken(2, "detected-client", true, null, db), replacementActor = (await authenticateStoredSecret(replacement, db))!;
  await observeConnectionClient(actor, sha256(raw), "tools/list", modern("Windsurf"), db);
  equal(await state(2), [], "Reusing a display name never transfers observations from a revoked immutable credential");
  await observeConnectionClient(replacementActor, sha256(replacement), "tools/list", modern("Cline"), db);
  equal(await client(), { state: "identified", label: "Cline", harness: "cline" }, "Only the replacement's own authenticated contact identifies it");
  equal((await state(2, "detected-client-retired")).length, 4, "Late revoked requests cannot modify the original credential either");

  const customRaw = await issueToken(2, "detected-custom", true, null, db), custom = (await authenticateStoredSecret(customRaw, db))!;
  await Promise.all(["My research client", "my research client", "My research client"].map(name => observeConnectionClient(custom, sha256(customRaw), "tools/list", modern(name), db)));
  equal((await state(2, "detected-custom")).length, 1, "Safe custom declarations are deduplicated case-insensitively in PostgreSQL");
  equal((await client("detected-custom")).harness, null, "A custom client name never acquires a guessed product brand");
  let releaseLock!: () => void, locked!: () => void;
  const lockReady = new Promise<void>(resolve => { locked = resolve; });
  const release = new Promise<void>(resolve => { releaseLock = resolve; });
  const holding = db.begin(async tx => {
    await tx`SELECT id FROM tokens WHERE org_id=2 AND name='detected-custom' FOR UPDATE`;
    locked(); await release;
  });
  await lockReady;
  const started = Date.now();
  try {
    await observeConnectionClient(custom, sha256(customRaw), "tools/list", modern("Windsurf"), db);
    equal(Date.now() - started < 2000, true, "Optional metadata abandons a locked credential promptly instead of stalling MCP");
  } finally { releaseLock(); await holding; }
  equal((await state(2, "detected-custom")).length, 1, "A timed-out observation leaves existing metadata intact");
  await observeConnectionClient(custom, sha256(customRaw), "tools/list", modern("Windsurf"), db);
  equal((await client("detected-custom")).state, "multiple", "A later request can record the client after the transient lock clears");
  for (const invalid of [["Codex", "Cursor", "Goose", "Amp", "Cline"], [{}], ["x".repeat(2100)], {}]) {
    await assert.rejects(async () => await db`UPDATE tokens SET client_names=${db.json(invalid)} WHERE org_id=2 AND name='detected-custom'`); checks++;
  }

  const email = "detected-removed-member@example.test";
  await db`INSERT INTO org_members(org_id,email,role) VALUES(2,${email},'member')`;
  const memberRaw = await issueToken(2, "detected-member", true, email, db), member = (await authenticateStoredSecret(memberRaw, db))!;
  await db`DELETE FROM org_members WHERE org_id=2 AND email=${email}`;
  await observeConnectionClient(member, sha256(memberRaw), "tools/list", modern("Cursor"), db);
  equal(await state(2, "detected-member"), [], "A stale authenticated actor cannot record client metadata after membership removal");
  return checks;
}
