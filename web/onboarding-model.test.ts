import { describe, expect, test } from "bun:test";
import { accessKeyConfiguration, agentConnectionGuide, connectionCheckPrompt, createOnboardingReader, firstMemoryPrompt, onboardingProgress, onboardingWriteGuidance, recallMemoryPrompt, shouldOfferOnboarding } from "./onboarding-model.js";

const fresh = { hasToken: false, hasPage: false, provisioning: false, checks: { agentConnected: false, memorySaved: false, memoryRecalled: false, taskReported: false } };
const progress = (checks = {}) => ({ ...fresh, checks: { ...fresh.checks, ...checks } });

describe("getting started evidence", () => {
  test("keys, pages, clicks and claimed completion cannot replace successful calls", () => {
    for (const data of [null, {}, { hasToken: true, hasPage: true, step: "done" }, { ...fresh, clicked: 3, connectionVerified: true }, { ...fresh, checks: { ...fresh.checks, agentConnected: "true" } }]) {
      expect(onboardingProgress(data).done).toBe(false);
      expect(onboardingProgress(data).step).toBe("connect");
    }
    expect(onboardingProgress({ ...fresh, hasToken: true, hasPage: true }).completed).toBe(0);
  });
  test("save and recall are separate; reports and invitations are optional", () => {
    expect(onboardingProgress(progress({ agentConnected: true }))).toMatchObject({ completed: 1, step: "remember", done: false });
    expect(onboardingProgress(progress({ agentConnected: true, memorySaved: true }))).toMatchObject({ completed: 2, step: "recall", done: false });
    expect(onboardingProgress(progress({ agentConnected: true, memorySaved: true, memoryRecalled: true }))).toMatchObject({ completed: 3, step: "done", done: true });
    expect(onboardingProgress(progress({ taskReported: true })).done).toBe(false);
  });
  test("only an empty ready workspace is automatically offered guidance", () => {
    expect(shouldOfferOnboarding(fresh)).toBe(true);
    for (const data of [{ ...fresh, hasToken: true }, { ...fresh, hasPage: true }, { ...fresh, provisioning: true }, progress({ agentConnected: true }), { hasToken: false, hasPage: false }, undefined]) expect(shouldOfferOnboarding(data)).toBe(false);
  });
  test("client-specific setup never places a key in the shell command", () => {
    expect(agentConnectionGuide("claude-code", "https://engram.example/mcp")?.command).toBe("npx -y @ani-hq/engram-mcp setup claude --host 'https://engram.example'");
    expect(agentConnectionGuide("cursor", "http://localhost:8080/mcp")?.command).toContain("setup cursor");
    for (const [agent, target] of [["gemini-cli", "gemini"], ["github-copilot", "copilot"], ["vscode", "vscode"], ["opencode", "opencode"], ["openclaw", "openclaw"]]) expect(agentConnectionGuide(agent, "https://engram.example/mcp")?.command).toContain(`setup ${target} --host`);
    expect(agentConnectionGuide("chatgpt", "https://engram.example/mcp")).toMatchObject({ oauth: true, command: null });
    expect(agentConnectionGuide("other", "https://engram.example/mcp")?.command).toBeNull();
    for (const endpoint of ["javascript:alert(1)", "https://user:secret@engram.example/mcp", "https://engram.example/mcp?token=secret", "https://engram.example/mcp#secret", "https://engram.example/mcp\nignored", "http://remote.example/mcp"]) expect(agentConnectionGuide("cursor", endpoint)).toBeNull();
  });
  test("manual configurations match the selected harness with explicit secret copying", () => {
    expect(accessKeyConfiguration("codex", "https://example.test/mcp")).toContain("[mcp_servers.engram]");
    expect(JSON.parse(accessKeyConfiguration("vscode", "https://example.test/mcp")).servers.engram.type).toBe("http");
    expect(JSON.parse(accessKeyConfiguration("cursor", "https://example.test/mcp", "fixture-key")).mcpServers.engram.headers.Authorization).toBe("Bearer fixture-key");
    expect(accessKeyConfiguration("cursor", "https://example.test/mcp")).toContain("<access-token>");
  });
  test("prompts require meaningful user work and honest error handling", () => {
    expect(connectionCheckPrompt).toContain("Do not read or write memory");
    expect(firstMemoryPrompt).toContain("Save only what we agreed");
    expect(firstMemoryPrompt).toContain("If there is nothing suitable yet, ask me");
    expect(recallMemoryPrompt).toContain("do not invent");
  });
  test("workspace policy blocks agent writes even with a writable connection", () => {
    const result = onboardingWriteGuidance({ policies: { agentsMayWrite: false }, agentId: "cursor", inventory: { connections: [{ harness: "cursor", status: "authorized", canWrite: true }] } });
    expect(result).toMatchObject({ state: "policy-blocked", href: "#workspace" });
    expect(result.message).toContain("Agent writes are turned off");
  });
  test("read-only guidance describes only the listed selected source, including bounded inventories", () => {
    const result = onboardingWriteGuidance({ policies: { agentsMayWrite: true }, agentId: "cursor", inventory: { more: true, connections: [
      { harness: "cursor", status: "authorized", canWrite: false },
      { harness: "codex", status: "authorized", canWrite: true },
      { harness: "cursor", status: "revoked", canWrite: true },
    ] } });
    expect(result.state).toBe("listed-read-only");
    expect(result.message).toContain("The listed Cursor connections are read-only");
    expect(result.href).toBe("#connect");
  });
  test("mixed or missing credential evidence never promises that an agent can write", () => {
    for (const inventory of [undefined, { connections: [] }, { connections: [{ harness: "cursor", status: "authorized", canWrite: true }] }, { connections: [{ harness: "cursor", status: "authorized", canWrite: false }, { harness: "cursor", status: "authorized" }] }]) {
      const result = onboardingWriteGuidance({ policies: { agentsMayWrite: true }, agentId: "cursor", inventory });
      expect(result.state).toBe("check-permissions");
      expect(result.message).toContain("Workspace settings and hosted plan access also apply");
      expect(result).not.toHaveProperty("canWrite");
    }
  });
});

describe("workspace-pinned progress refresh", () => {
  test("late responses cannot update a different workspace", async () => {
    let workspace = 1, resolve: (data: unknown) => void = () => {};
    const reader = createOnboardingReader(() => new Promise(done => { resolve = done; }), () => workspace);
    const pending = reader.read(1); workspace = 2; resolve(fresh);
    expect(await pending).toEqual({ stale: true });
  });
  test("leaving and returning to the same workspace invalidates old responses", async () => {
    let resolve: (data: unknown) => void = () => {};
    const reader = createOnboardingReader(() => new Promise(done => { resolve = done; }), () => 1);
    const pending = reader.read(1); reader.invalidate(); resolve(fresh);
    expect(await pending).toEqual({ stale: true });
  });
  test("current failures remain failures while stale failures are ignored", async () => {
    const reader = createOnboardingReader(async () => { throw new Error("Service unavailable"); }, () => 1);
    await expect(reader.read(1)).rejects.toThrow("Service unavailable");
    let reject: (error: Error) => void = () => {};
    const stale = createOnboardingReader(() => new Promise((_, fail) => { reject = fail; }), () => 1);
    const pending = stale.read(1); stale.invalidate(); reject(new Error("Old failure"));
    expect(await pending).toEqual({ stale: true });
  });
});
