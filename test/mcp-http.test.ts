import { describe, expect, test } from "bun:test";
import { mcpMethodNotAllowed } from "../gateway/src/mcp-http";

describe("GET /mcp", () => {
  test("browsers get a hint that this URL is for connectors", async () => {
    const res = mcpMethodNotAllowed(new Request("https://engram.ani.computer/mcp", {
      headers: { accept: "text/html" },
    }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.text()).toContain("custom connector");
  });

  test("MCP probes still get a plain 405", async () => {
    const res = mcpMethodNotAllowed(new Request("https://engram.ani.computer/mcp", {
      headers: { accept: "text/event-stream" },
    }));
    expect(res.status).toBe(405);
    expect(await res.text()).toBe("Method Not Allowed");
  });
});
