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
  previous = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "DEVIN_PROJECT_DIR"].map(key => [key, process.env[key]]));
  process.env.HOME = root;
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key.toLowerCase());
  delete process.env.CODEX_HOME;
  delete process.env.DEVIN_PROJECT_DIR;
  // Never run against a real home: every config, hook and plugin path setup
  // writes or reads must be inside the temp root.
  const written = [
    ...computer.KEY_HOLDERS.map((harness: string) => shim.configPathForList(harness)),
    require("../shim/memory.js").configFile(),
    path.join(process.env.HOME!, ".claude", "settings.json"), path.join(process.env.HOME!, ".codex", "hooks.json"), path.join(process.env.HOME!, ".cursor", "hooks.json"),
    path.join(process.env.HOME!, ".hermes", "config.yaml"), path.join(process.env.HOME!, ".config", "devin", "config.json"),
    path.join(process.env.XDG_CONFIG_HOME!, "amp", "plugins"), path.join(process.env.XDG_CONFIG_HOME!, "engram"), path.join(process.env.XDG_DATA_HOME!, "engram-mcp"),
  ];
  for (const file of written) if (!file || !file.startsWith(root)) throw new Error(`Refusing to run: ${file || "a config path"} is outside the test home`);
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

/** A fake Engram: device approval plus the identity and catalog the installer verifies. */
function fakeEngram(decision: "approved" | "denied" | "expired" | "pending", options: { omit?: string; legacy?: boolean } = {}) {
  const seen: any = { starts: [], polls: 0, bearer: new Set<string>(), retired: [] as string[] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/device/retire") {
      seen.retired.push(req.headers.get("authorization"));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/device/start") {
      const body = await req.json() as any;
      // A server from before 0.8.0 rejects any agent it does not know.
      if (options.legacy && body.agents.some((agent: any) => !["claude-code", "codex", "cursor"].includes(agent.harness))) { seen.rejected = (seen.rejected || 0) + 1; return Response.json({ error: "bad_request" }, { status: 400 }); }
      seen.starts.push(body);
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

const original = () => computer.AGENTS.filter((agent: any) => ["claude", "codex", "cursor"].includes(agent.harness));
const added = () => computer.AGENTS.filter((agent: any) => ["openclaw", "hermes", "amp", "devin"].includes(agent.harness));
const write = (file: string, text: string) => { const { mkdirSync, writeFileSync } = require("node:fs"); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

test("one approval connects every detected agent for every repository", async () => {
  const engram = fakeEngram("approved");
  const result = await run(engram.host, original());
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

const hermesBefore = [
  "# My Hermes settings",
  "model:",
  "  default: anthropic/claude-opus",
  "",
  "mcp_servers:",
  "  github:",
  "    command: npx",
  "",
  "hooks:",
  "  pre_llm_call:",
  "    - command: ~/bin/notify.sh",
  "      timeout: 5",
  "",
].join("\n");

test("OpenClaw, Hermes Agent, Amp and Devin CLI connect with their own keys and keep existing settings", async () => {
  write(path.join(root, ".hermes", "config.yaml"), hermesBefore);
  write(path.join(root, ".config", "amp", "settings.json"), JSON.stringify({ "amp.notifications.enabled": false, "amp.mcpServers": { other: { url: "https://other.example/mcp" } } }));
  write(path.join(root, ".config", "devin", "config.json"), JSON.stringify({ read_config_from: { cursor: false }, hooks: { PreToolUse: [{ matcher: "exec", hooks: [{ type: "command", command: "./check.sh" }] }] } }));
  write(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify({ model: "keep-me" }));
  const engram = fakeEngram("approved");
  const result = await run(engram.host, added());
  expect(result.code).toBe(0);
  expect(engram.seen.starts[0].agents).toEqual([{ harness: "openclaw", label: "OpenClaw" }, { harness: "hermes", label: "Hermes Agent" }, { harness: "amp", label: "Amp" }, { harness: "devin", label: "Devin CLI" }]);
  expect(result.text).toContain("✓ OpenClaw\n✓ Hermes Agent\n✓ Amp\n✓ Devin CLI");
  expect(result.text).toContain("Hermes asks once before running a new hook");
  expect(result.text).toContain("Restart the OpenClaw gateway");
  expect(result.text).not.toContain("_key");

  // Hermes: one YAML file holds the MCP server and the hook; nothing else changes.
  const hermes = readFileSync(path.join(root, ".hermes", "config.yaml"), "utf8");
  expect(hermes.startsWith("# My Hermes settings\nmodel:\n  default: anthropic/claude-opus\n\nmcp_servers:\n  github:\n    command: npx\n  engram:\n")).toBe(true);
  expect(hermes).toContain(`    url: "${engram.host}/mcp"\n    headers:\n      Authorization: "Bearer eng_hermes_key"\n`);
  expect(hermes).toContain("  pre_llm_call:\n    - command: ~/bin/notify.sh\n      timeout: 5\n    - command: ");
  expect(hermes).toMatch(/memory hook hermes pre_llm_call"\n      timeout: 10\n$/);
  expect(shim.readHarnessConnection("hermes")).toEqual({ host: `${engram.host}/mcp`, token: "eng_hermes_key", authentication: "bearer" });

  // Amp: user settings key plus a system plugin.
  const amp = JSON.parse(readFileSync(path.join(root, ".config", "amp", "settings.json"), "utf8"));
  expect(amp["amp.notifications.enabled"]).toBe(false);
  expect(amp["amp.mcpServers"]).toEqual({ other: { url: "https://other.example/mcp" }, engram: { url: `${engram.host}/mcp`, headers: { Authorization: "Bearer eng_amp_key" } } });
  const plugin = readFileSync(path.join(process.env.XDG_CONFIG_HOME!, "amp", "plugins", "engram-memory.js"), "utf8");
  expect(plugin).toContain("Engram managed native adapter");
  expect(plugin).toContain("amp.on('agent.start'");
  expect(plugin).not.toContain("eng_");

  // Devin CLI: MCP in mcp_config.json, hooks in config.json beside existing settings.
  expect(JSON.parse(readFileSync(path.join(root, ".config", "devin", "mcp_config.json"), "utf8")).mcpServers.engram).toEqual({ url: `${engram.host}/mcp`, transport: "http", headers: { Authorization: "Bearer eng_devin_key" } });
  const devin = JSON.parse(readFileSync(path.join(root, ".config", "devin", "config.json"), "utf8"));
  expect(devin.read_config_from).toEqual({ cursor: false });
  expect(devin.hooks.PreToolUse).toEqual([{ matcher: "exec", hooks: [{ type: "command", command: "./check.sh" }] }]);
  expect(Object.keys(devin.hooks).sort()).toEqual(["PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  expect(devin.hooks.UserPromptSubmit[0].hooks[0].command).toContain(" memory hook devin UserPromptSubmit");

  // OpenClaw: MCP and plugin in one file, existing settings kept.
  const openclaw = JSON.parse(readFileSync(path.join(root, ".openclaw", "openclaw.json"), "utf8"));
  expect(openclaw.model).toBe("keep-me");
  expect(openclaw.mcp.servers.engram).toEqual({ url: `${engram.host}/mcp`, transport: "streamable-http", headers: { Authorization: "Bearer eng_openclaw_key" } });
  expect(openclaw.plugins.entries["engram-memory"]).toMatchObject({ enabled: true, hooks: { allowPromptInjection: true, allowConversationAccess: true } });

  const bindings = JSON.parse(readFileSync(require("../shim/memory.js").configFile(), "utf8")).bindings;
  expect(bindings.map((item: any) => `${item.runtime}:${item.project}`).sort()).toEqual(["amp:*", "devin:*", "hermes:*", "openclaw:*"]);
  expect([...engram.seen.bearer].sort()).toEqual(["Bearer eng_amp_key", "Bearer eng_devin_key", "Bearer eng_hermes_key", "Bearer eng_openclaw_key"]);

  // Running again changes nothing but the keys: one entry and one hook each.
  const again = await run(fakeEngram("approved").host, added());
  expect(again.code).toBe(0);
  const hermesAgain = readFileSync(path.join(root, ".hermes", "config.yaml"), "utf8");
  expect(hermesAgain.match(/^  engram:$/gm)).toHaveLength(1);
  expect(hermesAgain.match(/memory hook hermes/g)).toHaveLength(1);
  expect(hermesAgain).toContain("~/bin/notify.sh");
  expect(JSON.parse(readFileSync(path.join(root, ".config", "devin", "config.json"), "utf8")).hooks.SessionStart).toHaveLength(1);
});

test("an older key held by a new agent is turned off on reconnect", async () => {
  const engram = fakeEngram("approved");
  write(path.join(root, ".hermes", "config.yaml"), `mcp_servers:\n  engram:\n    url: ${engram.host}/mcp\n    headers:\n      Authorization: 'Bearer eng_old_hermes'\n`);
  write(path.join(root, ".config", "devin", "mcp_config.json"), JSON.stringify({ mcpServers: { engram: { url: `${engram.host}/mcp`, headers: { Authorization: "Bearer eng_old_devin" } } } }));
  const result = await run(engram.host, added().filter((agent: any) => ["hermes", "devin"].includes(agent.harness)));
  expect(result.code).toBe(0);
  expect(engram.seen.retired.sort()).toEqual(["Bearer eng_old_devin", "Bearer eng_old_hermes"]);
});

test("a Hermes config setup cannot edit safely fails only Hermes and stays untouched", async () => {
  const flow = "mcp_servers: {github: {command: npx}}\n";
  write(path.join(root, ".hermes", "config.yaml"), flow);
  const result = await run(fakeEngram("approved").host, added().filter((agent: any) => ["hermes", "amp"].includes(agent.harness)));
  expect(result.code).toBe(1);
  expect(result.text).toContain("✗ Hermes Agent: ");
  expect(result.text).toContain("Setup preserved the file");
  expect(result.text).toContain("✓ Amp");
  expect(readFileSync(path.join(root, ".hermes", "config.yaml"), "utf8")).toBe(flow);
});

test("an older Engram server still connects the agents it knows", async () => {
  const engram = fakeEngram("approved", { legacy: true });
  const result = await run(engram.host, computer.AGENTS.filter((agent: any) => ["claude", "hermes", "devin"].includes(agent.harness)));
  expect(result.code).toBe(0);
  expect(engram.seen.rejected).toBe(1);
  expect(result.text).toContain("This Engram server can't connect Hermes Agent and Devin CLI yet. Connecting the others.");
  expect(engram.seen.starts[0].agents).toEqual([{ harness: "claude-code", label: "Claude Code" }]);
  expect(result.text).toContain("✓ Claude Code");
  expect(existsSync(path.join(root, ".hermes"))).toBe(false);
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
  expect(found(["/h/.openclaw", "/h/.hermes", "/h/.config/amp", "/h/.config/devin"])).toEqual(["openclaw", "hermes", "amp", "devin"]);
  // "hermes" and "amp" are common program names, so a command alone is not enough.
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), "engram-bin-")));
  try {
    const { writeFileSync } = require("node:fs");
    for (const name of ["hermes", "amp", "devin", "openclaw"]) writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    expect(found([], bin)).toEqual(["openclaw", "devin"]);
  } finally { rmSync(bin, { recursive: true, force: true }); }
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
