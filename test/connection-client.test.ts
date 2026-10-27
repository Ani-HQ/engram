import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { connectionClient, declaredConnectionClient, mcpConnectionClients, observeConnectionClient } from "../gateway/src/connection-client";
import { ensureConnectionClientSchema } from "../gateway/src/connection-client-schema";
import { normalizeToken, DEFAULT_POLICIES } from "../gateway/src/policies";
import { runWithContext } from "../gateway/src/context";

function database() {
  const calls: { query: string; values: unknown[] }[] = [];
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: parts.join("?"), values }); return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  db.json = ((value: unknown) => value) as any;
  db.begin = (async (work: (tx: postgres.Sql) => unknown) => work(db)) as any;
  return { db, calls };
}
const agent = normalizeToken({ name: "laptop", orgId: 7, role: "agent", kind: "token" });
const hash = "a".repeat(64);
const modern = (name: unknown) => ({ _meta: { "io.modelcontextprotocol/clientInfo": { name, version: "private-unused-version" } } });

describe("client-declared connection labels", () => {
  test("canonicalizes exact supported aliases and preserves safe custom names without branding them", () => {
    for (const [name, label, harness] of [["  OpenAI Codex  ", "Codex", "codex"], ["codex-mcp-client", "Codex", "codex"], ["Claude Code", "Claude Code", "claude-code"], ["GrokBot", "Grok Bot", "grok-bot"], ["Visual Studio Code", "VS Code", "vscode"], ["github-copilot-cli", "GitHub Copilot", "github-copilot"], ["Gemini CLI", "Gemini CLI", "gemini-cli"], ["Hermes Agent", "Hermes Agent", "hermes"]]) {
      expect(declaredConnectionClient(name)).toEqual({ label, harness });
    }
    expect(declaredConnectionClient("My research helper")).toEqual({ label: "My research helper", harness: null });
    expect(declaredConnectionClient("Codex-compatible client")).toEqual({ label: "Codex-compatible client", harness: null });
    expect(declaredConnectionClient("constructor")).toEqual({ label: "constructor", harness: null });
  });
  test("drops generic bridges, malformed names and credentials instead of persisting redacted strings", () => {
    for (const value of [undefined, null, {}, [], 3, "", "client", "connector", "mcp-client", "mcp-client 1.0", "mcp-remote", "mcp proxy", "engram-mcp", "engram-mcp-shim", "python-mcp-client", "fastmcp", "mcp-remote bridge", "https://private.test/client", "private@example.test", "secret\nCodex", "secret\tCodex", "C\u200bodex", "x".repeat(81), "eng_" + "a".repeat(43), "sk-ant-api03-" + "b".repeat(30), "Bearer abc", "<script>evil</script>"]) {
      expect(declaredConnectionClient(value)).toBeNull();
    }
    expect(connectionClient(["Codex-compatible client"]).harness).toBeNull();
  });
  test("reads both MCP generations, excludes unrelated fields and retains conflicting declarations as multiple clients", () => {
    expect(mcpConnectionClients("initialize", { clientInfo: { name: "Codex", version: "a" }, capabilities: { private: true } })).toEqual(["Codex"]);
    expect(mcpConnectionClients("tools/list", modern("cursor"))).toEqual(["Cursor"]);
    expect(mcpConnectionClients("tools/call", { ...modern("Codex"), clientInfo: { name: "Cursor" } })).toEqual(["Codex"]);
    expect(mcpConnectionClients("initialize", { ...modern("Codex"), clientInfo: { name: "Cursor" } })).toEqual(["Codex", "Cursor"]);
    expect(mcpConnectionClients("initialize", { ...modern("codex"), clientInfo: { name: "OpenAI Codex" } })).toEqual(["Codex"]);
    for (const [method, params] of [["bogus", modern("Codex")], [["tools/list"], modern("Codex")], [{ toString: null }, modern("Codex")], ["notifications/initialized", modern("Codex")], ["tools/call", { clientInfo: { name: "Codex" } }], ["initialize", null], ["initialize", []], ["tools/list", { _meta: [] }]]) expect(mcpConnectionClients(method, params)).toEqual([]);
  });
  test("maps unknown, single and shared keys without trusting stored malformed payloads or choosing the last client", () => {
    const unknown = { state: "unknown", label: null, harness: null };
    expect(connectionClient(undefined)).toEqual(unknown);
    expect(connectionClient([])).toEqual(unknown);
    expect(connectionClient(["mcp-client", {}, "https://private.test"])).toEqual(unknown);
    expect(connectionClient(["codex", "Codex", "OpenAI Codex"])).toEqual({ state: "identified", label: "Codex", harness: "codex" });
    expect(connectionClient(["Codex", "Cursor"])).toEqual({ state: "multiple", label: "Multiple clients", harness: null });
    expect(connectionClient(["Cursor", "Codex"])).toEqual({ state: "multiple", label: "Multiple clients", harness: null });
  });
  test("only authenticated token credentials and exact workspace digests can select a row, without changing registered source", async () => {
    const store = database(), registered = normalizeToken({ ...agent, source: { harness: "claude-code", label: "Manual label", kind: "registered" } });
    await observeConnectionClient(registered, hash, "initialize", { clientInfo: { name: "Codex" } }, store.db);
    expect(store.calls).toHaveLength(2);
    expect(store.calls[0].query).toContain("set_config('lock_timeout', '200ms', true)");
    expect(store.calls[0].query).toContain("set_config('statement_timeout', '500ms', true)");
    const { query, values } = store.calls[1];
    expect(values).toEqual([["Codex"], 7, hash, "laptop", 4, "Codex"]);
    expect(query).toContain("t.org_id ="); expect(query).toContain("t.sha256_hash ="); expect(query).toContain("t.revoked_at IS NULL");
    expect(query).toContain("m.id = t.issued_by_member_id"); expect(query).toContain("m.org_id = t.org_id AND m.email = t.issued_by_email");
    expect(query).toContain("jsonb_array_length(t.client_names)"); expect(query).toContain("jsonb_array_elements_text(t.client_names)");
    expect(query).not.toMatch(/SET (?:harness|source_label|name|role|can_write)/);
    expect(registered.source).toEqual({ harness: "claude-code", label: "Manual label", kind: "registered" });
    for (const [actor, digest] of [[normalizeToken({ ...agent, kind: "session" }), hash], [normalizeToken({ ...agent, kind: "oauth" }), hash], [agent, "not-a-hash"]] as const) await observeConnectionClient(actor, digest, "tools/list", modern("Codex"), store.db);
    const other = normalizeToken({ ...agent, orgId: 8 });
    await runWithContext({ org: { id: 8, name: "Other", slug: "other", kind: "team", brainDb: "brain_org_8", dataDb: "brain_org_8", homeDir: "org-8", policies: DEFAULT_POLICIES }, token: other, dataSql: store.db }, () => observeConnectionClient(agent, hash, "tools/list", modern("Codex"), store.db));
    expect(store.calls).toHaveLength(2);
  });
  test("missing identity causes no writes and metadata-storage failures remain best effort", async () => {
    const store = database();
    await observeConnectionClient(agent, hash, "initialize", { clientInfo: { name: "connector" } }, store.db);
    await observeConnectionClient(agent, hash, "tools/list", {}, store.db);
    expect(store.calls).toHaveLength(0);
    const broken = Object.assign(() => Promise.reject(new Error("private database details")), { json: (value: unknown) => value, begin: () => Promise.reject(new Error("private database details")) }) as unknown as postgres.Sql;
    await expect(observeConnectionClient(agent, hash, "tools/list", modern("Codex"), broken)).resolves.toBeUndefined();
  });
  test("schema bounds the additive JSON storage without altering authority or prior readiness markers", async () => {
    const store = database(); await ensureConnectionClientSchema(store.db);
    expect(store.calls[0].query).toContain("ADD COLUMN IF NOT EXISTS client_names jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(store.calls[1].query).toContain("jsonb_array_length(client_names) <= 4");
    expect(store.calls[1].query).toContain("octet_length(client_names::text) <= 2048");
    expect(store.calls[1].query).toContain('(@.type() != "string")');
    expect(store.calls.map(call => call.query).join(" ")).not.toMatch(/GRANT|CREATE TABLE|DROP|schema_state/);
  });
});
