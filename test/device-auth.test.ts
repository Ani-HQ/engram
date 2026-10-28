import { describe, expect, test } from "bun:test";
import {
  clientHash, DEVICE_AGENT_LABELS, DEVICE_AGENT_LIMIT, deviceStatus, deviceTokenName, formatUserCode, generateUserCode, handleDeviceConsoleApi, handlePublicDeviceApi,
  isDeviceConsolePath, normalizeUserCode, parseDeviceCode, parseDeviceStart, pollTooFast, publicDeviceRequest, USER_CODE_ALPHABET,
} from "../gateway/src/device-auth";
import { requiresHostedEntitlement } from "../gateway/src/billing";
import { normalizeToken } from "../gateway/src/policies";

describe("device sign-in input", () => {
  test("accepts a computer name and each supported agent once", () => {
    expect(parseDeviceStart({ device: "  Ada's   MacBook ", agents: [{ harness: "claude-code" }, { harness: "codex", label: " Codex desktop " }, { harness: "cursor", label: "" }] })).toEqual({
      device: "Ada's MacBook",
      agents: [{ harness: "claude-code", label: null }, { harness: "codex", label: "Codex desktop" }, { harness: "cursor", label: null }],
    });
    expect(parseDeviceStart({ device: "x".repeat(80), agents: [{ harness: "codex" }] })?.device).toHaveLength(80);
    const every = Object.keys(DEVICE_AGENT_LABELS).map(harness => ({ harness }));
    expect(every.map(agent => agent.harness)).toEqual(["claude-code", "codex", "cursor", "openclaw", "hermes", "amp", "devin"]);
    expect(parseDeviceStart({ device: "Laptop", agents: every })?.agents).toHaveLength(DEVICE_AGENT_LIMIT);
    expect(deviceTokenName("hermes", "Laptop")).toBe("Hermes Agent on Laptop");
    expect(deviceTokenName("devin", "Laptop")).toBe("Devin CLI on Laptop");
  });

  test("rejects missing, oversized, unprintable, duplicate or unsupported input", () => {
    const agents = [{ harness: "codex" }];
    for (const body of [
      null, [], "text", {}, { device: "", agents }, { device: "   ", agents }, { device: "x".repeat(81), agents }, { device: "bad\nname", agents }, { device: 7, agents },
      { device: "Laptop" }, { device: "Laptop", agents: [] }, { device: "Laptop", agents: Array(DEVICE_AGENT_LIMIT + 1).fill({ harness: "codex" }) },
      { device: "Laptop", agents: [{ harness: "codex" }, { harness: "codex" }] }, { device: "Laptop", agents: [{ harness: "windsurf" }] },
      { device: "Laptop", agents: [{ harness: "toString" }] }, { device: "Laptop", agents: ["codex"] },
      { device: "Laptop", agents: [{ harness: "codex", label: "y".repeat(81) }] }, { device: "Laptop", agents: [{ harness: "codex", label: 4 }] },
    ]) expect(parseDeviceStart(body)).toBeNull();
  });

  test("device codes are 32 base64url bytes", () => {
    expect(parseDeviceCode({ deviceCode: "A".repeat(43) })).toBe("A".repeat(43));
    for (const body of [null, {}, { deviceCode: "A".repeat(42) }, { deviceCode: "A".repeat(44) }, { deviceCode: `${"A".repeat(42)}=` }, { deviceCode: 5 }]) expect(parseDeviceCode(body)).toBeNull();
  });
});

describe("user codes", () => {
  test("are eight characters from an unambiguous alphabet, uniformly sampled", () => {
    expect(USER_CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
    for (let i = 0; i < 200; i++) expect(generateUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    // Bytes at or above 240 would bias the first characters, so they are skipped.
    let calls = 0;
    const code = generateUserCode(size => { calls++; return Uint8Array.from({ length: size }, (_, index) => calls === 1 && index < 4 ? 250 : index); });
    expect(code).toBe("GHJKLMNP");
  });

  test("display with a hyphen and normalize case-insensitively with optional separators", () => {
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
    for (const input of ["BCDF-GHJK", "bcdf-ghjk", "bcdfghjk", " bcdf ghjk ", "BcDf-GhJk"]) expect(normalizeUserCode(input)).toBe("BCDFGHJK");
    for (const input of ["BCDF-GHJ", "BCDF-GHJKL", "ABCD-EFGH", "BCDF-GHJ1", "", null, 12345678, "B".repeat(40)]) expect(normalizeUserCode(input)).toBeNull();
  });
});

describe("state transitions", () => {
  const now = new Date("2026-10-28T12:00:00Z"), later = new Date("2026-10-28T12:05:00Z"), earlier = new Date("2026-10-28T11:55:00Z");
  test("pending and approved requests expire; denied and consumed are final", () => {
    expect(deviceStatus({ status: "pending", expiresAt: later }, now)).toBe("pending");
    expect(deviceStatus({ status: "pending", expiresAt: earlier }, now)).toBe("expired");
    expect(deviceStatus({ status: "pending", expiresAt: now }, now)).toBe("expired");
    expect(deviceStatus({ status: "approved", expiresAt: later }, now)).toBe("approved");
    expect(deviceStatus({ status: "approved", expiresAt: earlier }, now)).toBe("expired");
    expect(deviceStatus({ status: "denied", expiresAt: earlier }, now)).toBe("denied");
    expect(deviceStatus({ status: "consumed", expiresAt: earlier }, now)).toBe("consumed");
  });

  test("polling faster than the interval, with a little jitter allowed, slows down", () => {
    expect(pollTooFast(null, now)).toBe(false);
    expect(pollTooFast(new Date(now.getTime() - 1000), now)).toBe(true);
    expect(pollTooFast(new Date(now.getTime() - 2600), now)).toBe(false);
    expect(pollTooFast(new Date(now.getTime() - 3000), now)).toBe(false);
  });

  test("public request detail uses the display code and product labels", () => {
    expect(publicDeviceRequest({ id: 1, status: "pending", device: "Desk", agents: [{ harness: "codex", label: null }, { harness: "cursor", label: "Cursor app" }], userCode: "BCDFGHJK", orgId: null, decidedByEmail: null, createdAt: earlier, expiresAt: later, lastPolledAt: null }, now)).toEqual({
      userCode: "BCDF-GHJK", device: "Desk", agents: [{ harness: "codex", label: "Codex" }, { harness: "cursor", label: "Cursor app" }],
      createdAt: earlier.toISOString(), expiresAt: later.toISOString(), status: "pending",
    });
  });
});

describe("key names", () => {
  test("name the agent and computer, stay unique and fit the 100-character limit", () => {
    expect(deviceTokenName("claude-code", "Ada's MacBook")).toBe("Claude Code on Ada's MacBook");
    expect(deviceTokenName("codex", "Desk", ["Codex on Desk"])).toBe("Codex on Desk (2)");
    expect(deviceTokenName("codex", "Desk", ["Codex on Desk", "Codex on Desk (2)"])).toBe("Codex on Desk (3)");
    const long = deviceTokenName("cursor", "x".repeat(80), []);
    expect(long.length).toBeLessThanOrEqual(100);
    const second = deviceTokenName("claude-code", "y".repeat(80), ["Claude Code on " + "y".repeat(80)].map(name => name.slice(0, 100)));
    expect(second.length).toBeLessThanOrEqual(100); expect(second.endsWith(" (2)")).toBe(true);
  });
});

describe("routing boundaries", () => {
  const url = (path: string) => new URL(`https://engram.example${path}`);
  test("public start and poll validate input before touching storage", async () => {
    const post = (path: string, body: string) => handlePublicDeviceApi(new Request(`https://engram.example${path}`, { method: "POST", body }), url(path));
    for (const [path, body] of [["/api/device/start", "{"], ["/api/device/start", JSON.stringify({ device: "Laptop", agents: [] })], ["/api/device/poll", "{}"], ["/api/device/poll", JSON.stringify({ deviceCode: "short" })], ["/api/device/start", "x".repeat(5000)]]) {
      const response = await post(path, body);
      expect(response?.status).toBe(400);
      expect((await response!.json()).error).toBe("bad_request");
    }
    expect((await handlePublicDeviceApi(new Request("https://engram.example/api/device/poll"), url("/api/device/poll")))?.status).toBe(405);
    expect(await handlePublicDeviceApi(new Request("https://engram.example/api/device"), url("/api/device"))).toBeNull();
  });

  test("console routes require a human console person and a valid code", async () => {
    const org = { id: 2, name: "Team" } as any;
    const agent = normalizeToken({ name: "agent", orgId: 2, role: "agent", kind: "token" });
    const oauth = normalizeToken({ name: "chat", orgId: 2, role: "owner", kind: "oauth", email: "a@example.test" });
    const person = normalizeToken({ name: "a", orgId: 2, role: "member", kind: "session", email: "a@example.test" });
    for (const actor of [agent, oauth]) expect((await handleDeviceConsoleApi(new Request("https://engram.example/api/device?code=BCDF-GHJK"), url("/api/device?code=BCDF-GHJK"), actor, org))?.status).toBe(403);
    expect((await handleDeviceConsoleApi(new Request("https://engram.example/api/device?code=nope"), url("/api/device?code=nope"), person, org))?.status).toBe(400);
    expect((await handleDeviceConsoleApi(new Request("https://engram.example/api/device/approve", { method: "POST", body: "{}" }), url("/api/device/approve"), person, org))?.status).toBe(400);
    const unpinned = await handleDeviceConsoleApi(new Request("https://engram.example/api/device/approve", { method: "POST", body: JSON.stringify({ userCode: "BCDF-GHJK" }) }), url("/api/device/approve"), person, org);
    expect([unpinned?.status, (await unpinned!.json()).code]).toEqual([400, "workspace_required"]);
    expect(isDeviceConsolePath("/api/device")).toBe(true); expect(isDeviceConsolePath("/api/device/start")).toBe(false);
  });

  test("approval has the same hosted write gating as creating an access key", () => {
    expect(requiresHostedEntitlement("POST", "/api/device/approve")).toBe(true);
    expect(requiresHostedEntitlement("POST", "/api/tokens")).toBe(true);
    expect(requiresHostedEntitlement("POST", "/api/device/deny")).toBe(false);
  });

  test("client addresses are keyed hashes", () => {
    const req = (ip: string) => new Request("https://engram.example/", { headers: { "CF-Connecting-IP": ip } });
    expect(clientHash(req("203.0.113.1"), "k")).toBe(clientHash(req("203.0.113.1"), "k"));
    expect(clientHash(req("203.0.113.1"), "k")).not.toBe(clientHash(req("203.0.113.2"), "k"));
    expect(clientHash(req("203.0.113.1"), "k")).not.toContain("203.0.113");
  });
});
