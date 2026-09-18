import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const forwardedCalls: any[] = [];
const auditCalls: any[] = [];

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
      content: [{
        type: "text",
        text: JSON.stringify({ forwarded: request }),
      }],
    };
  },
};

// Spread the real module: mock.module is process-global, so listing only the export
// this suite needs would delete the others for every file evaluated after it.
const realBrain = await import("../gateway/src/brain");

mock.module("../gateway/src/brain", () => ({
  ...realBrain,
  brainClient: () => brain,
}));

// Spread for the same reason as the others, and override the two provenance
// readers explicitly: the real ones query Postgres, which no unit test wants.
const realAudit = await import("../gateway/src/audit");

mock.module("../gateway/src/audit", () => ({
  ...realAudit,
  audit: async (...args: any[]) => {
    auditCalls.push(args);
  },
  provenance: async () => ({ origin: null, contributors: [] }),
  provenanceFor: async () => new Map(),
}));

const { callTool, listTools } = await import("../gateway/src/proxy");

describe("proxy tool surface", () => {
  const token = { name: "agent" };

  beforeEach(() => {
    forwardedCalls.length = 0;
    auditCalls.length = 0;
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
    ]);
  });

  test("every served description stays short enough to ship in a system prompt", async () => {
    const tools = await listTools(token);
    for (const tool of tools) {
      expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
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
