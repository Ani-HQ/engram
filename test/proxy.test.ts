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

mock.module("../gateway/src/brain", () => ({
  brainClient: () => brain,
}));

mock.module("../gateway/src/audit", () => ({
  audit: async (...args: any[]) => {
    auditCalls.push(args);
  },
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
    ]);
  });

  test("whoami returns only the token name", async () => {
    const result = await callTool(token, "whoami", {});
    expect(result).toEqual({
      content: [{ type: "text", text: "{\"token\":\"agent\"}" }],
    });
    expect(forwardedCalls).toEqual([]);
    expect(auditCalls).toEqual([["agent", "whoami", "{}", "ok"]]);
  });

  test("forwards allowlisted tools to the brain", async () => {
    const args = { query: "deployment", limit: 3 };
    const result = await callTool(token, "search", args);

    expect(forwardedCalls).toEqual([{ name: "search", arguments: args }]);
    expect(JSON.parse(result.content[0].text)).toEqual({
      forwarded: { name: "search", arguments: args },
    });
    expect(auditCalls).toEqual([["agent", "search", JSON.stringify(args), "ok"]]);
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
    ]]);
  });

  test("denies removed tools", async () => {
    for (const name of ["remember", "recall", "promote", "secret_get"]) {
      const result = await callTool(token, name, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`Unknown or disallowed tool: ${name}`);
    }
    expect(forwardedCalls).toEqual([]);
    expect(auditCalls.map(call => call[1])).toEqual(["remember", "recall", "promote", "secret_get"]);
    expect(auditCalls.every(call => call[3] === "denied")).toBe(true);
  });
});
