import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const {
  negotiateProtocolVersion,
  resolveMcpRouting,
  readClientMeta,
  toolsListCacheHints,
} = await import("../gateway/src/proxy");

describe("protocol version negotiation", () => {
  test("echoes 2026-07-28", () => {
    expect(negotiateProtocolVersion("2026-07-28")).toBe("2026-07-28");
  });

  test("echoes 2025-06-18", () => {
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
  });

  test("echoes older supported versions", () => {
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
    expect(negotiateProtocolVersion("2025-03-26")).toBe("2025-03-26");
  });

  test("unknown or absent version still yields 2025-06-18", () => {
    expect(negotiateProtocolVersion("not-a-version")).toBe("2025-06-18");
    expect(negotiateProtocolVersion("2025-11-25")).toBe("2025-06-18");
    expect(negotiateProtocolVersion(undefined)).toBe("2025-06-18");
    expect(negotiateProtocolVersion(null)).toBe("2025-06-18");
    expect(negotiateProtocolVersion("")).toBe("2025-06-18");
    expect(negotiateProtocolVersion(2026)).toBe("2025-06-18");
  });

  test("reads protocol version from params._meta when present", () => {
    expect(readClientMeta({
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    }).protocolVersion).toBe("2026-07-28");
    expect(readClientMeta({
      _meta: { "io.modelcontextprotocol/protocolVersion": "garbage" },
    }).protocolVersion).toBe("2025-06-18");
    expect(readClientMeta({}).protocolVersion).toBe("2025-06-18");
    expect(readClientMeta(undefined).protocolVersion).toBe("2025-06-18");
  });
});

describe("header vs body method resolution", () => {
  test("agreeing headers resolve to the same operation, no conflict", () => {
    const headers = new Headers({ "Mcp-Method": "tools/call", "Mcp-Name": "whoami" });
    const resolved = resolveMcpRouting(headers, {
      method: "tools/call",
      params: { name: "whoami" },
    });
    expect(resolved.method).toBe("tools/call");
    expect(resolved.name).toBe("whoami");
    expect(resolved.conflict).toBeNull();
  });

  test("falls back to the JSON body when headers are absent", () => {
    const resolved = resolveMcpRouting(new Headers(), {
      method: "tools/call",
      params: { name: "whoami" },
    });
    expect(resolved.method).toBe("tools/call");
    expect(resolved.name).toBe("whoami");
    expect(resolved.conflict).toBeNull();
  });

  test("empty headers do not override the body", () => {
    const headers = new Headers({ "Mcp-Method": "  ", "Mcp-Name": "" });
    const resolved = resolveMcpRouting(headers, {
      method: "tools/call",
      params: { name: "whoami" },
    });
    expect(resolved.method).toBe("tools/call");
    expect(resolved.name).toBe("whoami");
    expect(resolved.conflict).toBeNull();
  });

  test("a header may fill in what the body omits", () => {
    const resolved = resolveMcpRouting(new Headers({ "Mcp-Method": "tools/list" }), {});
    expect(resolved.method).toBe("tools/list");
    expect(resolved.conflict).toBeNull();
  });

  // The body is authoritative: a header that disagrees is a malformed request,
  // never a silent override. Otherwise engram could execute something other than
  // the JSON-RPC message says, diverging from body-inspecting upstream controls.
  test("a disagreeing Mcp-Name is a conflict and never overrides the body", () => {
    const headers = new Headers({ "Mcp-Method": "tools/call", "Mcp-Name": "search" });
    const resolved = resolveMcpRouting(headers, {
      method: "tools/call",
      params: { name: "secret_get" },
    });
    expect(resolved.name).toBe("secret_get");
    expect(resolved.conflict).toContain("disagrees");
  });

  test("a disagreeing Mcp-Method is a conflict and never overrides the body", () => {
    const resolved = resolveMcpRouting(new Headers({ "Mcp-Method": "tools/list" }), {
      method: "ping",
      params: {},
    });
    expect(resolved.method).toBe("ping");
    expect(resolved.conflict).toContain("disagrees");
  });
});

describe("tools/list cache-hint derivation", () => {
  const shareable = new Set(["public", "shared", "global"]);

  test("never produces a cross-token-shareable cacheScope", () => {
    const tokens = [
      { name: "ro", scopes: { shared: "r" }, secrets: false },
      { name: "secrets", scopes: { shared: "r" }, secrets: true },
      { name: "writer", scopes: { shared: "rw" }, secrets: false },
      { name: "admin", scopes: { shared: "rw", private: "rw" }, secrets: true },
    ];
    for (const token of tokens) {
      const hints = toolsListCacheHints(token, "2026-07-28");
      expect(typeof hints.ttlMs).toBe("number");
      expect(hints.ttlMs).toBeGreaterThanOrEqual(0);
      expect(shareable.has(hints.cacheScope)).toBe(false);
      expect(hints.cacheScope).toBe("private");
    }
  });

  test("emits no 2026-only fields to older clients", () => {
    const token = { name: "ro", scopes: { shared: "r" }, secrets: false };
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      expect(toolsListCacheHints(token, v)).toEqual({});
    }
  });
});
