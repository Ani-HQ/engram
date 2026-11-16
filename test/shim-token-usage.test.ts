import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const memory = require("../shim/memory.js");
const adapters = require("../shim/runtime-adapters.js");
const usage = require("../shim/token-usage.js");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const SECRET = "SECRET_PROMPT_TEXT_never_leaves";
let root: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engram-usage-test-")));
  previous = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"].map(key => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  // Never let a test touch a real home directory.
  if (!memory.stateRoot().startsWith(root)) throw new Error("state root escaped the temporary home");
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

function logFile(name = "session.jsonl", dir = path.join(root, ".claude", "projects", "repo")) {
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
const assistant = (id: string | null, input: number, output: number, cacheRead = 0, cacheWrite = 0, model = "claude-opus-5-5") => JSON.stringify({
  type: "assistant", sessionId: "s",
  message: { ...(id ? { id } : {}), model, role: "assistant", content: [{ type: "text", text: SECRET }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, service_tier: "standard" } },
}) + "\n";
const userLine = () => JSON.stringify({ type: "user", message: { role: "user", content: `${SECRET} "usage" mentioned in text` } }) + "\n";
const codexCount = (input: number, cached: number, output: number, reasoning: number, cacheWrite = 0) => JSON.stringify({
  timestamp: "2026-11-16T10:00:00.000Z", type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output }, last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 }, model_context_window: 475000 }, rate_limits: { plan_type: "pro" } },
}) + "\n";
const totals = (state: any) => usage.totalsOf(state);

function fakeFetch(status = 200) {
  const calls: any[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false }), { status });
  };
  return { calls, fetchImpl };
}
const binding = (extra: any = {}) => ({ project: path.join(root, "project"), host: "https://engram.example", endpoint: "https://engram.example/mcp", token: "eng_fixture_token", topic: "repo", budget: 4096, scope: hash("usage-fixture"), reportAvailable: true, ...extra });

describe("reading token counts from a Claude Code session log", () => {
  test("repeated lines for one message count once, keeping the last usage", () => {
    const file = logFile();
    writeFileSync(file, userLine() + assistant("msg_1", 10, 1, 100, 5) + assistant("msg_1", 10, 7, 100, 5) + assistant("msg_2", 3, 4, 50, 0) + assistant(null, 1, 1) + userLine());
    const state = usage.readUsage("claude-code", file, null);
    expect(totals(state)).toEqual({ input: 14, output: 12, cacheRead: 150, cacheWrite: 5, model: "claude-opus-5-5" });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(JSON.stringify(state)).not.toContain("msg_1");
  });

  test("reads only new bytes and waits for a partial last line", () => {
    const file = logFile();
    writeFileSync(file, assistant("a", 1, 1));
    let state = usage.readUsage("claude-code", file, null);
    const offset = state.file.offset;
    expect(offset).toBe(readFileSync(file).length);
    const line = assistant("b", 2, 2);
    appendFileSync(file, line.slice(0, 40));
    state = usage.readUsage("claude-code", file, state);
    expect(state.file.offset).toBe(offset);
    expect(totals(state).input).toBe(1);
    appendFileSync(file, line.slice(40));
    state = usage.readUsage("claude-code", file, state);
    expect(totals(state)).toMatchObject({ input: 3, output: 3 });
    // A message ID seen again in a later chunk still replaces, never adds.
    appendFileSync(file, assistant("b", 2, 9));
    state = usage.readUsage("claude-code", file, JSON.parse(JSON.stringify(state)));
    expect(totals(state)).toMatchObject({ input: 3, output: 10 });
  });

  test("skips malformed lines and lines longer than one read", () => {
    const file = logFile();
    writeFileSync(file, '{"type":"assistant","usage":\n' + "not json\n" + JSON.stringify({ type: "assistant", message: { id: "x", usage: { input_tokens: "12", output_tokens: -4, cache_read_input_tokens: 1.5 } } }) + "\n" + assistant("ok", 5, 6));
    expect(totals(usage.readUsage("claude-code", file, null))).toMatchObject({ input: 5, output: 6, cacheRead: 0 });

    const big = logFile("big.jsonl");
    writeFileSync(big, JSON.stringify({ type: "user", text: "z".repeat(5000), usage: 1 }) + "\n" + assistant("after", 7, 8));
    let state: any = null;
    for (let i = 0; i < 10; i++) state = usage.readUsage("claude-code", big, state, { maxBytes: 1024 });
    expect(totals(state)).toMatchObject({ input: 7, output: 8 });
    expect(state.file.offset).toBe(readFileSync(big).length);
  });

  test("a rotated or truncated log starts over; a new log path carries earlier counts", () => {
    const file = logFile();
    writeFileSync(file, assistant("a", 10, 10) + assistant("b", 10, 10));
    let state = usage.readUsage("claude-code", file, null);
    expect(totals(state).input).toBe(20);
    truncateSync(file, 0);
    writeFileSync(file, assistant("c", 4, 4));
    state = usage.readUsage("claude-code", file, state);
    expect(totals(state).input).toBe(4);
    unlinkSync(file);
    writeFileSync(file, assistant("d", 6, 6) + assistant("e", 6, 6) + assistant("f", 6, 6));
    state = usage.readUsage("claude-code", file, state);
    expect(totals(state).input).toBe(18);
    const next = logFile("next.jsonl");
    writeFileSync(next, assistant("g", 2, 2, 0, 0, "claude-sonnet-5"));
    state = usage.readUsage("claude-code", next, state);
    expect(totals(state)).toMatchObject({ input: 20, model: "claude-sonnet-5" });
  });

  test("old message IDs fold into a bounded settled total", () => {
    const file = logFile();
    writeFileSync(file, Array.from({ length: 200 }, (_, i) => assistant(`m${i}`, 1, 2)).join(""));
    const state = usage.readUsage("claude-code", file, null);
    expect(state.file.recent.length).toBe(usage.RECENT_IDS);
    expect(totals(state)).toMatchObject({ input: 200, output: 400 });
  });

  test("refuses logs outside home, through symbolic links, or not ending in .jsonl", () => {
    const real = logFile();
    writeFileSync(real, assistant("a", 1, 1));
    const link = path.join(root, "link.jsonl");
    symlinkSync(real, link);
    const linkedDir = path.join(root, "linked");
    symlinkSync(path.dirname(real), linkedDir);
    const text = logFile("notes.txt");
    writeFileSync(text, assistant("a", 1, 1));
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "engram-usage-outside-")));
    writeFileSync(path.join(outside, "s.jsonl"), assistant("a", 1, 1));
    try {
      for (const file of [link, path.join(linkedDir, "session.jsonl"), text, path.join(outside, "s.jsonl"), "relative.jsonl", `${path.dirname(real)}/../repo/session.jsonl`]) {
        expect(totals(usage.readUsage("claude-code", file, null)).input).toBe(0);
      }
      expect(totals(usage.readUsage("claude-code", real, null)).input).toBe(1);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("reading token counts from a Codex rollout log", () => {
  test("uses the latest cumulative total and maps cached input and reasoning", () => {
    const file = logFile("rollout-2026-11-16.jsonl", path.join(root, ".codex", "sessions", "2026", "11", "16"));
    const turn = JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol", cwd: "/x", summary: SECRET } }) + "\n";
    const message = JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text: `${SECRET} token_count` }] } }) + "\n";
    const empty = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }) + "\n";
    writeFileSync(file, turn + empty + message + codexCount(39791, 14208, 136, 40) + codexCount(79740, 53248, 214, 90));
    const state = usage.readUsage("codex", file, null);
    // input = input_tokens - cached; reasoning is already inside output_tokens.
    expect(totals(state)).toEqual({ input: 79740 - 53248, output: 214, cacheRead: 53248, cacheWrite: 0, model: "gpt-6.1-sol" });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    appendFileSync(file, codexCount(100, 0, 10, 0, 5));
    // Cumulative totals never move backwards.
    expect(totals(usage.readUsage("codex", file, state))).toMatchObject({ input: 26492, output: 214, cacheRead: 53248, cacheWrite: 5 });
  });

  test("Codex cache writes are not counted twice as input", () => {
    const file = logFile("rollout.jsonl", path.join(root, ".codex", "sessions"));
    writeFileSync(file, codexCount(1000, 300, 50, 10, 200));
    expect(totals(usage.readUsage("codex", file, null))).toMatchObject({ input: 500, cacheRead: 300, cacheWrite: 200, output: 50 });
  });
});

describe("reporting token counts", () => {
  test("the request body has exactly the contract keys and no text", () => {
    const body = usage.usageBody("claude-code", "session-1", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: "claude-opus-5-5" }, Date.parse("2026-11-16T10:00:00.000Z"));
    expect(Object.keys(body)).toEqual(usage.BODY_KEYS);
    expect(body).toEqual({ harness: "claude-code", session: hash("claude-code:session-1"), model: "claude-opus-5-5", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, occurredAt: "2026-11-16T10:00:00.000Z" });
    expect(body.session).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(usage.usageBody("codex", "s", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: null }, 0))).toEqual(usage.BODY_KEYS.filter((key: string) => key !== "model"));
    expect(usage.usageUrl("https://engram.example/mcp")).toBe("https://engram.example/api/usage");
  });

  test("Claude Code PostToolUse reports throttled liveness and Stop reports every change", async () => {
    const file = logFile();
    writeFileSync(file, userLine() + assistant("msg_1", 10, 20, 30, 40));
    const { calls, fetchImpl } = fakeFetch();
    let now = Date.parse("2026-11-16T10:00:00.000Z");
    const deps = { binding: binding(), fetchImpl, now: () => now };
    const event = (name: string) => memory.claudeHook({ hook_event_name: name, session_id: "claude-session", cwd: root, transcript_path: file, tool_name: "Bash", tool_input: { command: SECRET }, tool_response: { stdout: SECRET } }, deps);

    expect(await event("PostToolUse")).toEqual({});
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://engram.example/api/usage");
    expect(call.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(call.init.headers).toEqual({ Authorization: "Bearer eng_fixture_token", "Content-Type": "application/json", "User-Agent": "engram-memory-lifecycle/1" });
    expect(Object.keys(call.body)).toEqual(usage.BODY_KEYS);
    expect(call.body).toEqual({ harness: "claude-code", session: hash("claude-code:claude-session"), model: "claude-opus-5-5", input: 10, output: 20, cacheRead: 30, cacheWrite: 40, occurredAt: "2026-11-16T10:00:00.000Z" });
    expect(call.init.body).not.toContain(SECRET);
    expect(Buffer.byteLength(call.init.body)).toBeLessThan(2048);

    // Within 20 seconds, liveness does no work at all.
    appendFileSync(file, assistant("msg_2", 1, 1));
    now += 5000;
    expect(await event("PostToolUse")).toEqual({});
    expect(calls).toHaveLength(1);
    // Stop is not throttled.
    expect(await event("Stop")).toEqual({});
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ input: 11, output: 21 });
    // Unchanged totals are not sent again.
    now += 30000;
    expect(await event("PostToolUse")).toEqual({});
    expect(await event("Stop")).toEqual({});
    expect(calls).toHaveLength(2);
    appendFileSync(file, assistant("msg_3", 1, 1));
    now += 21000;
    expect(await event("PostToolUse")).toEqual({});
    expect(calls).toHaveLength(3);

    const dir = path.join(memory.stateRoot(), deps.binding.scope);
    for (const name of readdirSync(dir)) expect(readFileSync(path.join(dir, name), "utf8")).not.toContain(SECRET);
  });

  test("a failed send is retried only by the next natural hook; 401 stops reporting", async () => {
    const file = logFile();
    writeFileSync(file, assistant("a", 1, 1));
    let now = 1_800_000_000_000;
    const failing = fakeFetch(503);
    const deps = { binding: binding(), fetchImpl: failing.fetchImpl, now: () => now };
    const stop = () => memory.claudeHook({ hook_event_name: "Stop", session_id: "s2", cwd: root, transcript_path: file }, deps);
    expect(await stop()).toEqual({});
    expect(failing.calls).toHaveLength(1);
    const ok = fakeFetch(200);
    deps.fetchImpl = ok.fetchImpl;
    expect(await stop()).toEqual({});
    expect(ok.calls).toHaveLength(1);
    appendFileSync(file, assistant("b", 1, 1));
    const denied = fakeFetch(401);
    deps.fetchImpl = denied.fetchImpl;
    await stop();
    appendFileSync(file, assistant("c", 1, 1));
    now += 60000;
    await stop();
    expect(denied.calls).toHaveLength(1);
    // Network errors are silent.
    const thrown = { binding: binding({ scope: hash("other") }), fetchImpl: async () => { throw new Error("offline"); }, now: () => now };
    expect(await memory.claudeHook({ hook_event_name: "PostToolUse", session_id: "s3", cwd: root, transcript_path: file }, thrown)).toEqual({});
  });

  test("respects blocked or read-only runs and missing bindings", async () => {
    const file = logFile();
    writeFileSync(file, assistant("a", 1, 1));
    const { calls, fetchImpl } = fakeFetch();
    const scoped = binding();
    const runId = `em_${"a".repeat(64)}`;
    const dir = path.join(memory.stateRoot(), scoped.scope);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, `session-${hash("claude-code\nblocked-session")}.json`), JSON.stringify({ runId }));
    writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ version: 1, runId, blocked: true }));
    expect(await memory.claudeHook({ hook_event_name: "PostToolUse", session_id: "blocked-session", cwd: root, transcript_path: file }, { binding: scoped, fetchImpl })).toEqual({});
    expect(await memory.claudeHook({ hook_event_name: "PostToolUse", session_id: "read-only", cwd: root, transcript_path: file }, { binding: binding({ reportAvailable: false }), fetchImpl })).toEqual({});
    // No binding for this folder: nothing is read or sent.
    mkdirSync(path.join(root, "unbound"));
    expect(await memory.claudeHook({ hook_event_name: "Stop", session_id: "unbound", cwd: path.join(root, "unbound"), transcript_path: file }, { fetchImpl })).toEqual({});
    expect(calls).toHaveLength(0);
  });

  test("Codex PostToolUse and Stop report codex counts and return nothing", async () => {
    const file = logFile("rollout.jsonl", path.join(root, ".codex", "sessions", "2026", "11", "16"));
    writeFileSync(file, codexCount(1000, 400, 70, 30));
    const { calls, fetchImpl } = fakeFetch();
    let now = 1_800_000_000_000;
    const deps = { binding: binding(), fetchImpl, now: () => now };
    const input = (name: string) => ({ hook_event_name: name, session_id: "codex-session", cwd: root, transcript_path: file, model: "gpt-6.1-sol", turn_id: "t", tool_name: "shell", tool_input: { command: SECRET }, tool_response: SECRET, tool_use_id: "u" });
    expect(await adapters.nativeHook("codex", input("PostToolUse"), "PostToolUse", deps)).toEqual({});
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].body)).toEqual(usage.BODY_KEYS.filter((key: string) => key !== "model"));
    expect(calls[0].body).toMatchObject({ harness: "codex", session: hash("codex:codex-session"), input: 600, output: 70, cacheRead: 400, cacheWrite: 0 });
    expect(calls[0].init.body).not.toContain(SECRET);
    appendFileSync(file, codexCount(2000, 900, 100, 30));
    now += 1000;
    expect(await adapters.nativeHook("codex", input("PostToolUse"), "PostToolUse", deps)).toEqual({});
    expect(calls).toHaveLength(1);
    expect(await adapters.nativeHook("codex", input("Stop"), "Stop", deps)).toEqual({});
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ input: 1100, cacheRead: 900, output: 100 });
  });

  test("installs a background Claude Code PostToolUse hook beside the existing ones", async () => {
    const project = path.join(root, "project");
    mkdirSync(project);
    const checks = { tools: [{ name: "whoami" }, { name: "record_action" }, { name: "remember" }] };
    await memory.install("claude", { project, topic: "repo", host: "https://engram.example", token: "eng_fixture_token" }, { checks });
    const settings = JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
    const hook = settings.hooks.PostToolUse[0].hooks[0];
    expect(hook).toMatchObject({ type: "command", async: true, timeout: 6 });
    expect(hook.command).toEndWith(" memory hook claude PostToolUse");
    expect(settings.hooks.Stop[0].hooks[0].async).toBeUndefined();
    // Reinstalling replaces, never duplicates.
    await memory.install("claude", { project, topic: "repo", host: "https://engram.example", token: "eng_fixture_token" }, { checks });
    expect(JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).hooks.PostToolUse).toHaveLength(1);
  });
});
