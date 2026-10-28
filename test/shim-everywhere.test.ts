import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const memory = require("../shim/memory.js");
const checks = { tools: [{ name: "whoami" }, { name: "remember" }, { name: "record_action" }] };
let root: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engram-everywhere-test-")));
  previous = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"].map(key => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.XDG_DATA_HOME = path.join(root, "data");
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

const repo = (name: string) => { const dir = path.join(root, "code", name); mkdirSync(path.join(dir, ".git"), { recursive: true }); mkdirSync(path.join(dir, "src", "deep"), { recursive: true }); return dir; };
const install = (runtime: string, options: Record<string, unknown> = {}) =>
  memory.install(runtime, { everywhere: true, host: "http://127.0.0.1:1", token: `eng_${runtime}`, ...options }, { checks });

test("one computer-wide install covers every repository with its own topic and state", async () => {
  await install("claude");
  const config = JSON.parse(readFileSync(memory.configFile(), "utf8"));
  expect(config.bindings).toEqual([expect.objectContaining({ project: "*", runtime: "claude" })]);
  expect(config.bindings[0].topic).toBeUndefined();
  const settings = JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  expect(Object.keys(settings.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);

  const a = repo("pricing-site"), b = repo("billing-api");
  const inA = memory.bindingFor(path.join(a, "src", "deep"), "claude");
  const inB = memory.bindingFor(b, "claude");
  expect([inA.topic, inA.repoRoot, inA.everywhere]).toEqual(["pricing-site", a, true]);
  expect(inB.topic).toBe("billing-api");
  expect(inA.scope).not.toBe(inB.scope);
  expect(memory.bindingFor(path.join(a, "src"), "claude").scope).toBe(inA.scope);
});

test("folders outside a repository use the folder name, and home is general context", async () => {
  await install("cursor");
  const loose = path.join(root, "notes"); mkdirSync(loose);
  expect(memory.bindingFor(loose, "cursor").topic).toBe("notes");
  expect(memory.bindingFor(root, "cursor").topic).toBe("General");
});

test("a binding for a specific project still wins over the computer-wide one", async () => {
  await install("codex");
  const a = repo("client-work");
  await memory.install("codex", { project: a, topic: "Client work", host: "http://127.0.0.1:1", token: "eng_specific" }, { checks });
  expect(memory.bindingFor(a, "codex")).toEqual(expect.objectContaining({ topic: "Client work", token: "eng_specific" }));
  expect(memory.bindingFor(repo("other"), "codex")).toEqual(expect.objectContaining({ topic: "other", token: "eng_codex" }));
});

test("each runtime gets its own computer-wide binding and reinstalling replaces it", async () => {
  await install("claude");
  await install("cursor");
  await install("claude", { token: "eng_claude_new" });
  const bindings = JSON.parse(readFileSync(memory.configFile(), "utf8")).bindings;
  expect(bindings.map((item: any) => `${item.runtime}:${item.token}`).sort()).toEqual(["claude:eng_claude_new", "cursor:eng_cursor"]);
  const r = repo("x");
  expect(memory.bindingFor(r, "cursor").token).toBe("eng_cursor");
  expect(memory.bindingFor(r, "claude").token).toBe("eng_claude_new");
});

test("computer-wide setup is limited to runtimes with user-level hooks", async () => {
  await expect(install("copilot")).rejects.toThrow(/Claude Code, Codex and Cursor/);
  await expect(install("claude", { portable: true })).rejects.toThrow(/Claude Code, Codex and Cursor/);
});
