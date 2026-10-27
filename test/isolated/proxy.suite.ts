import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const forwardedCalls: any[] = [];
const auditCalls: any[] = [];
let forwardedIsError = false;
let forwardedResponse: unknown = null;
let actionFixture: any = null;
let actionQueries: any[] = [];

const brain = {
  async listTools() {
    return {
      tools: [
        "search",
        "get_page",
        "list_pages",
        "put_page",
        "add_tag",
        "add_link",
        "add_timeline_entry",
        "recall",
      ].map(name => ({
        name,
        description: `${name} tool`,
        inputSchema: { type: "object", properties: {} },
      })),
    };
  },
  async callTool(request: any) {
    forwardedCalls.push(request);
    return {
      ...(forwardedIsError ? { isError: true } : {}),
      content: [{
        type: "text",
        text: JSON.stringify(forwardedResponse ?? { forwarded: request }),
      }],
    };
  },
};

// Spread the real module: mock.module is process-global, so listing only the export
// this suite needs would delete the others for every file evaluated after it.
const realBrain = await import("../../gateway/src/brain");

mock.module("../../gateway/src/brain", () => ({
  ...realBrain,
  brainClient: () => brain,
}));

// Spread for the same reason as the others, and override the two provenance
// readers explicitly: the real ones query Postgres, which no unit test wants.
const realAudit = await import("../../gateway/src/audit");

mock.module("../../gateway/src/audit", () => ({
  ...realAudit,
  audit: async (...args: any[]) => {
    auditCalls.push(args);
  },
  provenance: async () => ({ origin: null, contributors: [] }),
  provenanceFor: async () => new Map(),
}));

const realContextAccess = await import("../../gateway/src/context-sharing-access");
mock.module("../../gateway/src/context-sharing-access", () => ({ ...realContextAccess, listApprovedTeamItems: async () => [] }));
const realTrails = await import("../../gateway/src/trails");
mock.module("../../gateway/src/trails", () => ({ ...realTrails, attributionForSlugs: async () => new Map() }));
const realActions = await import("../../gateway/src/actions");
const originalListActions = realActions.listActions, originalRecordAction = realActions.recordAction;
mock.module("../../gateway/src/actions", () => ({ ...realActions,
  listActions: async (actor: any, args: any) => { if (!actionFixture) return originalListActions(actor, args); actionQueries.push(args); return { actions: [actionFixture], more: false, agents: [actor.name], tools: [actionFixture.tool] }; },
  recordAction: async (actor: any, args: any) => { if (!actionFixture) return originalRecordAction(actor, args); return { action: actionFixture }; },
}));
// Durable ledgers have their own database suite. This fixture has no SQL server.
const realUsage = await import("../../gateway/src/memory-usage");
mock.module("../../gateway/src/memory-usage", () => ({ ...realUsage, applyContextBudget: async (_token: any, _name: any, _args: any, result: any) => result }));
const proxy = await import("../../gateway/src/proxy");
const { runWithContext } = await import("../../gateway/src/context");
const { parsePolicies, normalizeToken } = await import("../../gateway/src/policies");
const org = { id: 7, name: "Test", slug: "test", kind: "team" as const, brainDb: "brain_org_7", dataDb: "brain_org_7", homeDir: "org-7", policies: parsePolicies({}) };
function inOrg(token: any, work: (actor: any) => any) {
  const actor = normalizeToken(token);
  return runWithContext({ org, token: actor, dataSql: {} as any }, () => work(actor));
}
const callTool = (token: any, name: string, args: any) => inOrg(token, actor => proxy.callTool(actor, name, args));
const listTools = (token: any) => inOrg(token, actor => proxy.listTools(actor));

describe("proxy tool surface", () => {
  const token = { name: "agent", orgId: 7 };

  beforeEach(() => {
    forwardedCalls.length = 0;
    auditCalls.length = 0;
    forwardedIsError = false;
    forwardedResponse = null;
    actionFixture = null;
    actionQueries = [];
  });

  test("verification controls cannot execute a memory mutation", async () => {
    const response = await inOrg(token, actor => proxy.callTool(actor, "put_page", { slug: "notes/should-not-write", expected_hash: null }, { verification: "begin" }));
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("whoami");
    expect(forwardedCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("lists only the shared tool surface", async () => {
    const tools = await listTools(token);
    expect(tools.map((tool: any) => tool.name)).toEqual([
      "search",
      "get_page",
      "list_pages",
      "put_page",
      "add_tag",
      "add_link",
      "add_timeline_entry",
      "whoami",
      "remember",
      "recall",
      "record_action",
      "list_actions",
      "checkpoint_task",
      "find_tasks",
      "resume_task",
    ]);
  });

  test("every served description stays short enough to ship in a system prompt", async () => {
    const tools = await listTools(token);
    for (const tool of tools) {
      expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
  });

  test("advertises an explicit atomic create-only/update contract through the real tool catalog", async () => {
    const tools = await listTools(token);
    const put = tools.find((tool: any) => tool.name === "put_page");
    expect(put.description).toContain("Atomically");
    expect(put.description).toContain("null is create-only");
    expect(put.inputSchema.required).toContain("expected_hash");
    expect(put.inputSchema.properties.expected_hash.type).toEqual(["string", "null"]);
    const description = put.inputSchema.properties.expected_hash.description;
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description).toContain("null creates only if absent");
    expect(description).toContain("cannot overwrite an existing page");
    expect(description).toContain("get_page's content_hash");
    expect(description).toContain("Stale hashes fail unchanged");
    expect(tools.find((tool: any) => tool.name === "get_page").description).toContain("content_hash");
  });

  test("retains upstream guard types and every existing requirement without mutating its schema", () => {
    const inputSchema = {
      type: "object", additionalProperties: false,
      properties: {
        slug: { type: "string", minLength: 1 },
        content: { type: "string" },
        expected_hash: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }], description: "Upstream explanation ".repeat(20) },
        no_embed: { type: "boolean", default: false },
      },
      required: ["slug", "content"],
    };
    const original = structuredClone(inputSchema);
    Object.freeze(inputSchema.required); Object.freeze(inputSchema.properties.expected_hash); Object.freeze(inputSchema.properties); Object.freeze(inputSchema);
    const put = proxy.shrinkToolDef({ name: "put_page", inputSchema });
    expect(put.inputSchema.required).toEqual(["slug", "content", "expected_hash"]);
    expect(put.inputSchema.properties.expected_hash.anyOf).toEqual(original.properties.expected_hash.anyOf);
    expect(put.inputSchema.properties.slug).toEqual(original.properties.slug);
    expect(put.inputSchema.properties.content).toEqual(original.properties.content);
    expect(put.inputSchema.properties.no_embed).toEqual(original.properties.no_embed);
    expect(put.inputSchema.additionalProperties).toBe(false);
    expect(inputSchema).toEqual(original);
    const again = proxy.shrinkToolDef(put);
    expect(again.inputSchema.required).toEqual(["slug", "content", "expected_hash"]);
    expect(again.inputSchema.properties.expected_hash.description).toBe(put.inputSchema.properties.expected_hash.description);
  });

  test("keeps other tools' required fields and existing compaction rules unchanged", () => {
    const schema = { type: "object", properties: { query: { type: "string", description: "Short query." }, limit: { type: "integer", maximum: 100 }, mode: { type: "string", description: "Long explanation ".repeat(20) } }, required: ["query"] };
    const original = structuredClone(schema);
    for (const name of ["search", "list_pages", "add_tag"]) {
      const shrunk = proxy.shrinkToolDef({ name, inputSchema: schema });
      expect(shrunk.inputSchema.required).toEqual(["query"]);
      expect(Object.keys(shrunk.inputSchema.properties)).toEqual(["query", "limit", "mode"]);
      expect(shrunk.inputSchema.properties.query.description).toBe("Short query.");
      expect(shrunk.inputSchema.properties.mode.description).toBeUndefined();
      expect(shrunk.inputSchema.properties.limit.maximum).toBe(100);
      if (name !== "add_tag") expect(shrunk.inputSchema.properties.limit.description).toBe("Max results (capped at 25).");
    }
    expect(schema).toEqual(original);
  });

  test("rejects omitted, inherited and mistyped put_page guards before execution or storage", async () => {
    const inherited = Object.assign(Object.create({ expected_hash: null }), { slug: "notes/new", content: "New page" });
    for (const args of [{ slug: "notes/new", content: "New page" }, inherited, ...[undefined, false, 0, [], {}].map(expected_hash => ({ slug: "notes/new", content: "New page", expected_hash }))]) {
      const result = await callTool(token, "put_page", args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("null to create only if absent");
      expect(result.content[0].text).toContain("content_hash from get_page");
    }
    expect(forwardedCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  test("forwards explicit null and string guards unchanged, preserving existing access checks", async () => {
    for (const expected_hash of [null, "a".repeat(64)]) {
      const args = { slug: "notes/guarded", content: "Guarded page", expected_hash };
      expect((await callTool(token, "put_page", args)).isError).toBeUndefined();
      expect(forwardedCalls.at(-1)).toEqual({ name: "put_page", arguments: args });
    }
    expect(forwardedCalls).toHaveLength(2);
    expect(auditCalls.map(call => call[3])).toEqual(["ok", "ok"]);
    const denied = await callTool({ ...token, canWrite: false }, "put_page", { slug: "notes/new", content: "Denied" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("denied");
    expect(forwardedCalls).toHaveLength(2);
    expect(auditCalls.at(-1)[3]).toBe("denied");
  });

  test("action tools validate input locally and do not forward to the brain", async () => {
    const report = await callTool(token, "record_action", { tool: "shell", summary: "Ran", agent: "spoofed" });
    expect(report.isError).toBe(true);
    expect(report.content[0].text).toBe("Unknown action field: agent");
    const listing = await callTool(token, "list_actions", { status: "unknown" });
    expect(listing.isError).toBe(true);
    expect(listing.content[0].text).toBe("status must be completed, failed, or running");
    expect(forwardedCalls).toEqual([]);
  });

  test("action reports require write permission and OAuth write scope", async () => {
    const input = { tool: "shell", summary: "Ran" };
    const readonly = await callTool({ ...token, canWrite: false }, "record_action", input);
    expect(readonly.isError).toBe(true);
    expect(readonly.content[0].text).toContain("denied");
    const oauth = await callTool({ ...token, kind: "oauth", scopes: ["memory:read"] }, "record_action", input);
    expect(oauth.isError).toBe(true);
    expect(oauth.content[0].text).toContain("denied");
    expect(forwardedCalls).toEqual([]);
  });

  test("a forwarded tool error is audited as failed, and credential arguments are redacted", async () => {
    forwardedIsError = true;
    await callTool(token, "search", { query: "x", password: "secret-value" });
    expect(auditCalls[0][3]).toBe("error");
    expect(auditCalls[0][2]).not.toContain("secret-value");
  });

  test("whoami returns only the token name", async () => {
    const result = await callTool(token, "whoami", {});
    expect(result).toEqual({
      content: [{ type: "text", text: "{\"token\":\"agent\"}" }],
    });
    expect(forwardedCalls).toEqual([]);
    // The fifth field is the page the call touched; whoami touches none.
    expect(auditCalls).toEqual([["agent", "whoami", "{}", "ok", null]]);
  });

  test("forwards allowlisted tools to the brain", async () => {
    const args = { query: "deployment", limit: 3 };
    const result = await callTool(token, "search", args);

    expect(forwardedCalls).toEqual([{ name: "search", arguments: args }]);
    expect(JSON.parse(result.content[0].text)).toEqual({
      forwarded: { name: "search", arguments: args },
    });
    expect(auditCalls).toEqual([["agent", "search", JSON.stringify(args), "ok", null]]);
  });

  test("denies non-allowlisted tools", async () => {
    const result = await callTool(token, "delete_page", { slug: "notes/x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown or disallowed tool: delete_page");
    expect(forwardedCalls).toEqual([]);
    expect(auditCalls).toEqual([[
      "agent",
      "delete_page",
      "{\"slug\":\"notes/x\"}",
      "denied",
      // A denied call still records which page it reached for, because a refusal is
      // part of the page's history too.
      "notes/x",
    ]]);
  });

  test("clamps an oversized limit before forwarding", async () => {
    await callTool(token, "search", { query: "x", limit: 500 });
    await callTool(token, "list_pages", { limit: 500 });
    await callTool(token, "search", { query: "x", limit: 3 });

    expect(forwardedCalls.map(call => call.arguments.limit)).toEqual([25, 25, 3]);
    expect(auditCalls.map(call => call[2])).toEqual([
      "{\"query\":\"x\",\"limit\":25}",
      "{\"limit\":25}",
      "{\"query\":\"x\",\"limit\":3}",
    ]);
  });

  test("MCP-only page arguments stay out of the engine call and full hashes survive pagination", async () => {
    forwardedResponse = { slug: "notes/page", title: "A", content_hash: "a".repeat(64), compiled_truth: "🧠decision\n".repeat(1000) };
    const response = await callTool(token, "get_page", { slug: "notes/page", offset: 0, length: 100, detail: true });
    expect(forwardedCalls).toEqual([{ name: "get_page", arguments: { slug: "notes/page" } }]);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(4096);
    const page = JSON.parse(response.content[0].text);
    expect(page.content_hash).toBe("a".repeat(64));
    expect(page._page).toMatchObject({ offset: 0, length: 99, partial: true });
    expect(page._page.next_cursor).toStartWith("v1.");
  });

  test("oversized remember text and topic fail before engine calls", async () => {
    const text = await callTool(token, "remember", { text: "💚".repeat(3000) });
    expect(text.isError).toBe(true);
    expect(text.content[0].text).toContain("8192 UTF-8 bytes");
    const topic = await callTool(token, "remember", { text: "Useful decision", topic: "x".repeat(513) });
    expect(topic.isError).toBe(true);
    expect(topic.content[0].text).toContain("512 UTF-8 bytes");
    expect(forwardedCalls).toEqual([]);
  });

  test("MCP action lists default to five summaries and explicit detail is paged", async () => {
    actionFixture = { id: "28c680a9-2338-452b-b275-2084c4b69457", agent: "agent", tool: "files.edit", summary: "Updated files", status: "completed", evidence: "reported", detail: "💚detail\n".repeat(3000) };
    const summary = await callTool(token, "list_actions", {});
    expect(actionQueries[0].limit).toBe(5);
    expect(JSON.parse(summary.content[0].text).actions[0].detail).toBeUndefined();
    const detail = await callTool(token, "list_actions", { detail: true, id: actionFixture.id });
    expect(actionQueries[1].limit).toBe(1);
    expect(JSON.parse(detail.content[0].text).actions[0]._detail.partial).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(4096);
    await callTool(token, "list_actions", { limit: 100 });
    expect(actionQueries[2].limit).toBe(10);
    const receipt = await callTool(token, "record_action", { tool: "files.edit", summary: "Updated" });
    expect(JSON.parse(receipt.content[0].text)).toEqual({ ok: true, id: actionFixture.id, status: "completed", evidence: "reported" });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(300);
  });

  test("recall exposes exact bounded passage citations and omits invalid metadata", async () => {
    const chunk_text = "Keep retry request IDs stable.", citation = { offset: 3300, length: chunk_text.length, total: 5000, source_hash: "b".repeat(64) };
    forwardedResponse = [{ slug: "projects/retry", title: "Retry policy", chunk_text, recall_passage: { ...citation, extra: "must be omitted" } }];
    const cited = JSON.parse((await callTool(token, "recall", { query: "retry" })).content[0].text).results[0];
    expect(cited.snippet).toBe(chunk_text);
    expect(cited.recall_passage).toEqual(citation);
    forwardedResponse = [{ slug: "projects/retry", title: "Retry policy", chunk_text, recall_passage: { ...citation, length: 1 } }];
    const invalid = JSON.parse((await callTool(token, "recall", { query: "retry" })).content[0].text).results[0];
    expect(invalid.recall_passage).toBeUndefined();
  });

  test("denies removed tools", async () => {
    for (const name of ["promote", "secret_get"]) {
      const result = await callTool(token, name, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`Unknown or disallowed tool: ${name}`);
    }
    expect(forwardedCalls).toEqual([]);
    expect(auditCalls.map(call => call[1])).toEqual(["promote", "secret_get"]);
    expect(auditCalls.every(call => call[3] === "denied")).toBe(true);
  });
});
