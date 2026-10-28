import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const shim = require("../shim/index.js");
const computer = require("../shim/connect-computer.js");
let root: string;
let previous: Record<string, string | undefined>;
const servers: any[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engram-computer-test-")));
  previous = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME"].map(key => [key, process.env[key]]));
  process.env.HOME = root;
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key.toLowerCase());
  delete process.env.CODEX_HOME;
  // Never run against a real home: every config path must be inside the temp root.
  for (const harness of ["claude", "codex", "cursor"]) if (!shim.configPathForList(harness).startsWith(root)) throw new Error(`Refusing to run: ${harness} config is outside the test home`);
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

/** A fake Engram: device approval plus the identity and catalog the installer verifies. */
function fakeEngram(decision: "approved" | "denied" | "expired" | "pending", options: { omit?: string } = {}) {
  const seen: any = { starts: [], polls: 0, bearer: new Set<string>(), retired: [] as string[] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/device/retire") {
      seen.retired.push(req.headers.get("authorization"));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/device/start") {
      seen.starts.push(await req.json());
      return Response.json({ deviceCode: "device-secret", userCode: "BCDF-GHJK", verificationUri: `${url.origin}/app#device`, verificationUriComplete: `${url.origin}/app#device=BCDF-GHJK`, expiresIn: 600, interval: 1 });
    }
    if (url.pathname === "/api/device/poll") {
      seen.polls++;
      if (seen.polls < 2) return Response.json({ status: "pending" });
      if (decision !== "approved") return Response.json({ status: decision });
      const agents = seen.starts[0].agents.filter((agent: any) => agent.harness !== options.omit);
      return Response.json({ status: "approved", host: url.origin, workspace: { id: 7, name: "Ani" }, tokens: agents.map((agent: any) => ({ harness: agent.harness, name: `${agent.label} on lab`, token: `eng_${agent.harness}_key` })) });
    }
    if (url.pathname === "/mcp") {
      seen.bearer.add(req.headers.get("authorization"));
      const message = await req.json() as any;
      if (message.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: ["whoami", "recall", "remember", "record_action", "checkpoint_task"].map(name => ({ name })) } });
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ token: "Ani" }) }] } });
    }
    return new Response("not found", { status: 404 });
  } });
  servers.push(server);
  return { host: `http://127.0.0.1:${server.port}`, seen };
}

async function run(host: string, agents = computer.AGENTS, ask?: (label: string) => Promise<string>) {
  let text = "";
  const opened: string[] = [];
  const code = await computer.connectComputer(["--host", host], {
    ...(ask ? { ask } : {}),
    output: { write: (chunk: string) => { text += chunk; } },
    env: { ENGRAM_DEVICE_NAME: "lab" },
    detect: () => agents,
    open: (url: string) => opened.push(url),
    sleep: () => Promise.resolve(),
    planConnection: shim.planHarnessConnection,
  });
  return { code, text, opened };
}

test("one approval connects every detected agent for every repository", async () => {
  const engram = fakeEngram("approved");
  const result = await run(engram.host);
  expect(result.code).toBe(0);
  expect(engram.seen.starts[0]).toEqual({ device: "lab", agents: [{ harness: "claude-code", label: "Claude Code" }, { harness: "codex", label: "Codex" }, { harness: "cursor", label: "Cursor" }] });
  expect(result.opened).toEqual([`${engram.host}/app#device=BCDF-GHJK`]);
  expect(result.text).toContain("Check the code matches: BCDF-GHJK");
  expect(result.text).toContain("✓ Claude Code\n✓ Codex\n✓ Cursor");
  expect(result.text).toContain("every repo on this computer");
  expect(result.text).toContain("/hooks");
  expect(result.text).not.toContain("_key");

  // Each agent has its own key in its own native config, plus user-level hooks.
  expect(JSON.parse(readFileSync(path.join(root, ".claude.json"), "utf8")).mcpServers.engram.headers.Authorization).toBe("Bearer eng_claude-code_key");
  expect(JSON.parse(readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8")).mcpServers.engram.headers.Authorization).toBe("Bearer eng_cursor_key");
  expect(readFileSync(path.join(root, ".codex", "config.toml"), "utf8")).toContain("eng_codex_key");
  expect(existsSync(path.join(root, ".claude", "settings.json"))).toBe(true);
  expect(existsSync(path.join(root, ".cursor", "hooks.json"))).toBe(true);
  expect(existsSync(path.join(root, ".codex", "hooks.json"))).toBe(true);
  const bindings = JSON.parse(readFileSync(require("../shim/memory.js").configFile(), "utf8")).bindings;
  expect(bindings.map((item: any) => `${item.runtime}:${item.project}`).sort()).toEqual(["claude:*", "codex:*", "cursor:*"]);
  expect([...engram.seen.bearer].sort()).toEqual(["Bearer eng_claude-code_key", "Bearer eng_codex_key", "Bearer eng_cursor_key"]);
});

test("a denied or expired request changes nothing", async () => {
  for (const decision of ["denied", "expired"] as const) {
    const engram = fakeEngram(decision);
    await expect(run(engram.host)).rejects.toThrow(decision === "denied" ? /denied/ : /expired/);
    expect(existsSync(path.join(root, ".claude.json"))).toBe(false);
    expect(existsSync(path.join(root, ".cursor"))).toBe(false);
  }
});

test("one agent failing does not block the others", async () => {
  const engram = fakeEngram("approved", { omit: "codex" });
  const result = await run(engram.host);
  expect(result.code).toBe(1);
  expect(result.text).toContain("✓ Claude Code\n✗ Codex: no key was issued\n✓ Cursor");
  expect(result.text).toContain("Run this again later to finish Codex.");
  expect(existsSync(path.join(root, ".codex", "config.toml"))).toBe(false);
});

test("no supported agent means no request", async () => {
  const engram = fakeEngram("approved");
  const result = await run(engram.host, []);
  expect(result.code).toBe(1);
  expect(result.text).toContain("No supported agents found");
  expect(engram.seen.starts).toHaveLength(0);
});

test("detection finds agents by command, config folder or desktop app", () => {
  const found = (paths: string[], PATH = "") => computer.detectAgents({ env: { PATH }, home: "/h", exists: (p: string) => paths.includes(p) }).map((agent: any) => agent.harness);
  expect(found([])).toEqual([]);
  expect(found(["/h/.cursor"])).toEqual(["cursor"]);
  expect(found(["/Applications/Claude.app", "/Applications/ChatGPT.app/Contents/Resources/codex-cli"])).toEqual(["claude", "codex"]);
  expect(computer.listNames(["A", "B", "C"])).toBe("A, B and C");
  expect(computer.computerName({ ENGRAM_DEVICE_NAME: "Ani’s MacBook.local" })).toBe("Anis MacBook");
});

test("reconnecting Codex keeps per-tool preferences and replaces connection details", () => {
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(path.join(root, ".codex"), { recursive: true });
  writeFileSync(path.join(root, ".codex", "config.toml"), [
    'model = "gpt"', "", "[mcp_servers.other]", 'url = "https://other.example/mcp"', "",
    "[mcp_servers.engram]", 'url = "https://old.example/mcp"', "",
    "[mcp_servers.engram.http_headers]", 'Authorization = "Bearer eng_old"', "",
    "[mcp_servers.engram.tools.remember]", 'approval_mode = "approve"', "",
  ].join("\n"));
  const plan = shim.planHarnessConnection("codex", "https://engram.example/mcp", "eng_new");
  const toml: string = plan.value;
  expect(toml).toContain('url = "https://engram.example/mcp"');
  expect(toml).toContain("eng_new");
  expect(toml).not.toContain("eng_old");
  expect(toml).not.toContain("[mcp_servers.engram.http_headers]");
  expect(toml).toContain('[mcp_servers.engram.tools.remember]\napproval_mode = "approve"');
  expect(toml).toContain('[mcp_servers.other]\nurl = "https://other.example/mcp"');
  expect(toml.match(/^\[mcp_servers\.engram\]$/gm)).toHaveLength(1);
});

test("Codex hooks carry readable Engram labels", async () => {
  const engram = fakeEngram("approved");
  await run(engram.host, computer.AGENTS.filter((agent: any) => agent.harness === "codex"));
  const hooks = JSON.parse(readFileSync(path.join(root, ".codex", "hooks.json"), "utf8")).hooks;
  expect(hooks.SessionStart[0].hooks[0].statusMessage).toBe("Engram: loading project context");
  expect(Object.values(hooks).every((entries: any) => entries[0].hooks[0].statusMessage.startsWith("Engram: "))).toBe(true);
});

describe("earlier per-folder setups", () => {
  const seed = async (host = "http://127.0.0.1:1") => {
    const memory = require("../shim/memory.js");
    const { mkdirSync } = require("node:fs");
    for (const name of ["a", "b"]) {
      const dir = path.join(root, "code", name); mkdirSync(dir, { recursive: true });
      await memory.install("claude", { project: dir, topic: name, host, token: `eng_old_${name}` }, { checks: { tools: [{ name: "whoami" }, { name: "remember" }] } });
    }
    return memory;
  };
  const projects = (memory: any) => JSON.parse(readFileSync(memory.configFile(), "utf8")).bindings.map((item: any) => `${item.runtime}:${item.project === "*" ? "*" : path.basename(item.project)}`).sort();

  test("are switched to the new connection when the person agrees", async () => {
    const memory = await seed();
    const asked: string[] = [];
    const result = await run(fakeEngram("approved").host, computer.AGENTS.filter((agent: any) => agent.harness === "claude"), async label => { asked.push(label); return ""; });
    expect(asked[0]).toContain("2 project folders have an earlier Engram setup");
    expect(result.text).toContain("Switched 2 project folders to this connection.");
    expect(projects(memory)).toEqual(["claude:*"]);
  });

  test("are kept when the person declines or there is no terminal", async () => {
    const memory = await seed();
    const declined = await run(fakeEngram("approved").host, computer.AGENTS.filter((agent: any) => agent.harness === "claude"), async () => "n");
    expect(declined.text).toContain("still applies there. Run this again to switch them.");
    expect(projects(memory)).toEqual(["claude:*", "claude:a", "claude:b"]);
    const silent = await run(fakeEngram("approved").host, computer.AGENTS.filter((agent: any) => agent.harness === "claude"));
    expect(silent.text).toContain("still applies there");
  });
});

describe("older keys", () => {
  const claudeOnly = () => computer.AGENTS.filter((agent: any) => agent.harness === "claude");
  const writeJson = (file: string, value: unknown) => { const { mkdirSync, writeFileSync } = require("node:fs"); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  const seedProjects = async (host: string) => {
    const memory = require("../shim/memory.js");
    const { mkdirSync } = require("node:fs");
    for (const name of ["a", "b"]) {
      const dir = path.join(root, "code", name); mkdirSync(dir, { recursive: true });
      await memory.install("claude", { project: dir, topic: name, host, token: `eng_old_${name}` }, { checks: { tools: [{ name: "whoami" }, { name: "remember" }] } });
    }
  };

  test("reconnecting turns off the key each agent used before", async () => {
    const engram = fakeEngram("approved");
    writeJson(path.join(root, ".claude.json"), { mcpServers: { engram: { type: "http", url: `${engram.host}/mcp`, headers: { Authorization: "Bearer eng_old_claude" } } } });
    const result = await run(engram.host, claudeOnly());
    expect(result.code).toBe(0);
    expect(engram.seen.retired).toEqual(["Bearer eng_old_claude"]);
    expect(result.text).toContain("Turned off 1 older key this computer no longer uses.");
    expect(result.text).not.toContain("eng_old");
  });

  test("keys of switched folders are turned off, kept folders keep theirs", async () => {
    const switched = fakeEngram("approved");
    await seedProjects(switched.host);
    await run(switched.host, claudeOnly(), async () => "y");
    expect(switched.seen.retired.sort()).toEqual(["Bearer eng_old_a", "Bearer eng_old_b"]);

    rmSync(require("../shim/memory.js").configFile(), { force: true });
    const kept = fakeEngram("approved");
    await seedProjects(kept.host);
    await run(kept.host, claudeOnly(), async () => "n");
    expect(kept.seen.retired).toEqual([]);
  });

  test("a key another agent still uses is left on", async () => {
    const engram = fakeEngram("approved");
    const old = { url: `${engram.host}/mcp`, headers: { Authorization: "Bearer eng_shared" } };
    writeJson(path.join(root, ".claude.json"), { mcpServers: { engram: { type: "http", ...old } } });
    writeJson(path.join(root, ".gemini", "settings.json"), { mcpServers: { engram: { httpUrl: old.url, headers: old.headers } } });
    const result = await run(engram.host, claudeOnly());
    expect(engram.seen.retired).toEqual([]);
    expect(result.text).not.toContain("older key");
  });

  test("an unreachable server is reported, not fatal", async () => {
    const engram = fakeEngram("approved");
    writeJson(path.join(root, ".claude.json"), { mcpServers: { engram: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer eng_elsewhere" } } } });
    const result = await run(engram.host, claudeOnly());
    expect(result.code).toBe(0);
    expect(result.text).toContain("Couldn't reach Engram to turn off 1 older key. Revoke it under Connections.");
  });
});
