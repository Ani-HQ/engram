import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const memory = require("../shim/memory.js");
const registry = require("../shim/runtime-contracts.js");
const adapters = require("../shim/runtime-adapters.js");
const plugins = require("../shim/runtime-plugins.js");
let root: string, previous: Record<string, string | undefined>;
const servers: any[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engram-native-adapters-")));
  previous = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"].map(key => [key, process.env[key]]));
  process.env.HOME = root; process.env.XDG_CONFIG_HOME = path.join(root, "config"); process.env.XDG_STATE_HOME = path.join(root, "state");
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});
function gateway(options: { readOnly?: boolean; mcpWriteDenied?: boolean; now?: () => number } = {}) {
  const calls: any[] = [];
  const checks = new Map<string, any>();
  const clock = options.now || Date.now;
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any; body.fixtureAuth = request.headers.get("Authorization"); calls.push(body);
    const now = clock();
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "whoami" }, { name: "recall" }, { name: "remember" }, { name: "record_action" }] } });
    const name = body.params.name;
    if (options.readOnly && ["remember", "record_action"].includes(name)) return new Response("read only", { status: 403 });
    if (options.mcpWriteDenied && ["remember", "record_action"].includes(name)) return Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: `denied: ${name} is not allowed for this token` }] } });
    const context = body.params._meta?.["com.engram/context"];
    let check = context && checks.get(context.runId);
    let data: any = name === "whoami" ? { token: "Fixture identity" } : name === "record_action" ? { ok: true, id: body.params.arguments.eventId, status: body.params.arguments.status } : name === "remember" ? { ok: true, slug: "project-decisions" } : { results: [{ slug: "notes/project", title: "Project decisions", snippet: "Keep request IDs stable across retries." }], full: null };
    if (name === "whoami" && context?.verification === "begin") {
      check = { probeId: `emp_${"n".repeat(32)}`, status: "pending", startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString(), checkedAt: null, recallVerified: false, saveVerified: false, automaticWorkflowVerified: null };
      checks.set(context.runId, check);
      data.verification = { ...check };
    } else if (check && context?.probeId === check.probeId) {
      if (Date.parse(check.expiresAt) <= now) check.status = "expired";
      else {
        if (name === "recall") check.recallVerified = true;
        if (name === "remember") check.saveVerified = true;
        if (check.recallVerified && check.saveVerified) { check.status = "passed"; check.checkedAt = new Date(now).toISOString(); }
      }
      if (name === "whoami" && context.verification === "status") data.verification = { ...check };
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
  } });
  servers.push(service);
  const project = path.join(root, "project"); mkdirSync(project, { recursive: true });
  const host = service.url.origin, token = "fixture-native-never-real";
  const binding = { project, host, endpoint: `${host}/mcp`, token, topic: "Project architecture", budget: 4096, scope: createHash("sha256").update(`${host}/mcp\n${token}\n${project}`).digest("hex") };
  return { calls, project, host, token, binding, expire(runId: string) { const now = clock(); Object.assign(checks.get(runId), { startedAt: new Date(now - 960000).toISOString(), expiresAt: new Date(now - 60000).toISOString() }); }, reports: () => calls.filter(call => call.params?.name === "record_action").map(call => call.params.arguments) };
}

describe("native runtime contracts", () => {
  test("registry records supported injection events and runtime-specific limitations without universal claims", () => {
    for (const id of ["claude", "codex", "cursor", "gemini", "copilot", "opencode", "openclaw", "windsurf"]) {
      const row = registry.runtimeCapabilities(id); expect(row.installable).toBe(true); expect(row.platforms).toContain(process.platform); expect(row.docs.length).toBeGreaterThan(0);
    }
    expect(registry.runtimeCapabilities("vscode").id).toBe("copilot");
    expect(registry.runtimeCapabilities("gemini-cli").id).toBe("gemini");
    expect(registry.runtimeCapabilities("windsurf")).toMatchObject({ reportingOnly: true, injectionEvents: [] });
    expect(registry.runtimeCapabilities("cursor").injectionEvents).not.toContain("beforeSubmitPrompt");
    expect(registry.runtimeCapabilities("copilot").injectionEvents).not.toContain("userPromptSubmitted");
    expect(registry.runtimeCapabilities("grokbot").kind).toBe("guidance");
    expect(registry.runtimeCapabilities("goose").installable).toBe(false);
  });

  test("exact runtime payloads normalize and Stop/idle/turn-end never become task completion", () => {
    const fixtures = [
      ["codex", { session_id: "s", cwd: "/p", hook_event_name: "Stop" }],
      ["cursor", { conversation_id: "s", workspace_roots: ["/p"], hook_event_name: "stop" }],
      ["gemini", { session_id: "s", cwd: "/p", hook_event_name: "AfterAgent" }],
      ["copilot", { sessionId: "s", cwd: "/p" }, "agentStop"],
      ["opencode", { sessionID: "s", cwd: "/p", hook_event_name: "session.idle" }],
      ["openclaw", { sessionKey: "s", cwd: "/p", hook_event_name: "agent_end" }],
      ["windsurf", { trajectory_id: "s", cwd: "/p", agent_action_name: "post_cascade_response" }],
    ];
    for (const [id, input, event] of fixtures) expect(registry.normalizeRuntimeEvent(id, input, event)).toMatchObject({ event: "stop", canInject: false, sessionId: "s" });
    expect(registry.normalizeRuntimeEvent("gemini", { hook_event_name: "BeforeAgent", session_id: "s", cwd: "/p", prompt: "work" })).toMatchObject({ event: "prompt", canInject: true, outputShape: "hookSpecificOutput" });
    expect(registry.normalizeRuntimeEvent("codex", { hook_event_name: "UserPromptSubmit", cwd: "/p" })).toBeNull();
    const pascal = registry.normalizeRuntimeEvent("copilot", { hook_event_name: "PostToolUse", session_id: "s", cwd: "/p" });
    expect(pascal).toMatchObject({ canInject: true, outputShape: "additionalContext" });
    expect(adapters.outputFor(pascal, "reference")).toEqual({ additionalContext: "reference" });
  });
});

describe("native hook behavior", () => {
  test("read-only credentials still retrieve bounded context and do not repeat denied writes", async () => {
    const fixture = gateway({ readOnly: true });
    const start = await memory.lifecycle("task-start", { runtime: "codex", sessionId: "read-only", taskId: "retry-policy", query: "retry policy" }, { binding: fixture.binding });
    expect(start.status).toBe("retrieved");
    expect(start.context).toContain("Keep request IDs stable");
    expect(Buffer.byteLength(start.context)).toBeLessThanOrEqual(4096);
    expect((await memory.lifecycle("decision", { runId: start.runId, kind: "decision", text: "Preserve stable retry identifiers." }, { binding: fixture.binding })).status).toBe("write_denied");
    expect((await memory.lifecycle("task-progress", { runId: start.runId, progressId: "actual-step", currentStep: "Validating retry handling" }, { binding: fixture.binding })).status).toBe("write_denied");
    expect((await memory.lifecycle("stop", { runId: start.runId }, { binding: fixture.binding })).status).toBe("continue");
    expect((await memory.lifecycle("status", { runId: start.runId }, { binding: fixture.binding })).saved).toEqual([]);
    expect(fixture.calls.filter(call => call.params?.name === "record_action")).toHaveLength(1);
    expect(fixture.calls.filter(call => call.params?.name === "remember")).toHaveLength(0);
  });

  test("actual gateway HTTP200 MCP policy denials stop writes while preserving read-only recall", async () => {
    const fixture = gateway({ mcpWriteDenied: true });
    const start = await memory.lifecycle("task-start", { runtime: "codex", sessionId: "mcp-read-only", taskId: "retry-policy", query: "retry policy" }, { binding: fixture.binding });
    expect(start.status).toBe("retrieved"); expect(start.context).toContain("Keep request IDs stable");
    for (const [id, currentStep] of [["implementation", "Implementing retry checks"], ["validation", "Validating retries"]]) expect((await memory.lifecycle("task-progress", { runId: start.runId, progressId: id, currentStep }, { binding: fixture.binding })).status).toBe("write_denied");
    expect((await memory.lifecycle("decision", { runId: start.runId, kind: "decision", text: "Keep retry identifiers stable." }, { binding: fixture.binding })).status).toBe("write_denied");
    const status = await memory.lifecycle("status", { runId: start.runId }, { binding: fixture.binding });
    expect(status.ok).toBe(true); expect(status.saved).toEqual([]); expect(status.reports.running.status).toBe("write_denied");
    expect(fixture.calls.filter(call => call.params?.name === "record_action")).toHaveLength(1);
    expect(fixture.calls.filter(call => call.params?.name === "remember")).toHaveLength(0);
  });
  test("Codex and Gemini inject bounded context on their actual prompt event and never fabricate a final result", async () => {
    const fixture = gateway();
    for (const [runtime, promptEvent, stopEvent] of [["codex", "UserPromptSubmit", "Stop"], ["gemini", "BeforeAgent", "AfterAgent"]]) {
      const base = { session_id: `${runtime}-session`, cwd: fixture.project };
      const output = await adapters.nativeHook(runtime, { ...base, hook_event_name: promptEvent, prompt: "Please implement idempotent retries in the background queue." }, undefined, { binding: fixture.binding });
      expect(output.hookSpecificOutput.hookEventName).toBe(promptEvent);
      expect(output.hookSpecificOutput.additionalContext).toContain("Keep request IDs stable");
      expect(Buffer.byteLength(output.hookSpecificOutput.additionalContext)).toBeLessThanOrEqual(4096);
      const before = fixture.calls.length;
      expect(await adapters.nativeHook(runtime, { ...base, hook_event_name: stopEvent }, undefined, { binding: fixture.binding })).toEqual({});
      expect(fixture.calls.length).toBe(before);
    }
    expect(fixture.reports().every(report => report.status === "running")).toBe(true);
    for (const call of fixture.calls) if (call.params?.name === "recall" || call.params?.name === "record_action") expect(call.params._meta["com.engram/context"].integration.id).toBe("engram-mcp-memory");
  });

  test("Cursor and Copilot startup recall does not invent work and carries its budget into the first actual prompt", async () => {
    const fixture = gateway();
    for (const runtime of ["cursor", "copilot"]) {
      const base = runtime === "cursor" ? { session_id: `${runtime}-s`, workspace_roots: [fixture.project] } : { sessionId: `${runtime}-s`, cwd: fixture.project };
      const startup = await adapters.nativeHook(runtime, base, "sessionStart", { binding: fixture.binding });
      expect(startup[runtime === "cursor" ? "additional_context" : "additionalContext"]).toContain("Keep request IDs stable");
      expect(fixture.reports().filter(report => report.harness === runtime)).toHaveLength(0);
      const recallsBefore = fixture.calls.filter(call => call.params?.name === "recall").length;
      const prompt = await adapters.nativeHook(runtime, { ...base, prompt: "Please implement the project retry policy and validate repeated delivery." }, runtime === "cursor" ? "beforeSubmitPrompt" : "userPromptSubmitted", { binding: fixture.binding });
      expect(prompt).toEqual({});
      expect(fixture.calls.filter(call => call.params?.name === "recall")).toHaveLength(recallsBefore);
      const report = fixture.reports().find(report => report.harness === runtime);
      const recall = fixture.calls.find(call => call.params?.name === "recall" && call.params._meta["com.engram/context"].integration.runtime === runtime);
      expect(report.runId).toBe(recall.params._meta["com.engram/context"].runId);
    }
  });

  test("Cursor/Copilot delay recall until documented postToolUse and persist only a run marker", async () => {
    const fixture = gateway();
    for (const runtime of ["cursor", "copilot"]) {
      const base = { session_id: `${runtime}-queued`, cwd: fixture.project };
      const previousRecalls = fixture.calls.filter(call => call.params?.name === "recall").length;
      expect(await adapters.nativeHook(runtime, { ...base, prompt: "Please investigate the retry behavior and implement the fix." }, runtime === "cursor" ? "beforeSubmitPrompt" : "userPromptSubmitted", { binding: fixture.binding })).toEqual({});
      expect(fixture.calls.filter(call => call.params?.name === "recall")).toHaveLength(previousRecalls);
      const dir = path.join(memory.stateRoot(), fixture.binding.scope);
      const markers = readdirSync(dir).filter(name => name.startsWith("pending-"));
      expect(markers).toHaveLength(1);
      expect(Object.keys(JSON.parse(readFileSync(path.join(dir, markers[0]), "utf8"))).sort()).toEqual(["expiresAt", "runId"]);
      const delivered = await adapters.nativeHook(runtime, base, "postToolUse", { binding: fixture.binding });
      expect(delivered[runtime === "cursor" ? "additional_context" : "additionalContext"]).toContain("untrusted reference data");
      expect(await adapters.nativeHook(runtime, base, "postToolUse", { binding: fixture.binding })).toEqual({});
    }
    expect(await adapters.nativeHook("cursor", { session_id: "cloud", cwd: fixture.project, is_background_agent: true }, "sessionStart", { binding: fixture.binding })).toEqual({});
  });

  test("Windsurf reports actual starts but never retrieves or uploads response/transcript content", async () => {
    const fixture = gateway();
    const input = { trajectory_id: "cascade-session", cwd: fixture.project, agent_action_name: "pre_user_prompt", tool_info: { user_prompt: "Please implement the project retry policy with meaningful checks." } };
    expect(await adapters.nativeHook("windsurf", input, undefined, { binding: fixture.binding })).toEqual({});
    expect(fixture.reports()).toHaveLength(1);
    expect(fixture.calls.some(call => call.params?.name === "recall")).toBe(false);
    expect(await adapters.nativeHook("windsurf", { ...input, agent_action_name: "post_cascade_response", tool_info: { response: "DO_NOT_SEND_PRIVATE_RESPONSE", transcript_path: "/must-not-read" } }, undefined, { binding: fixture.binding })).toEqual({});
    expect(fixture.reports()).toHaveLength(1);
    expect(JSON.stringify(fixture.calls)).not.toContain("DO_NOT_SEND");
    expect(registry.normalizeRuntimeEvent("windsurf", { agent_action_name: "pre_user_prompt", trajectory_id: "documented-without-cwd", execution_id: "turn-id", tool_info: { user_prompt: "work" } })).toMatchObject({ cwd: process.cwd(), admissionId: "turn-id" });
  });

  test("native admission retries cannot create another task after a known end", async () => {
    const fixture = gateway();
    const input = { session_id: "codex-admission", cwd: fixture.project, hook_event_name: "UserPromptSubmit", turn_id: "native-turn-one", prompt: "Engram task: Validate retry policy" };
    const first = await adapters.nativeHook("codex", input, undefined, { binding: fixture.binding });
    const runId = /Lifecycle run: (em_[a-f0-9]{64})/.exec(first.hookSpecificOutput.additionalContext)![1];
    await memory.lifecycle("task-end", { runId, status: "completed", outcome: "Verified the first requested retry change." }, { binding: fixture.binding });
    const count = fixture.reports().length;
    expect(await adapters.nativeHook("codex", input, undefined, { binding: fixture.binding })).toEqual({});
    expect(fixture.reports()).toHaveLength(count);
    const fresh = await adapters.nativeHook("codex", { ...input, turn_id: "native-turn-two" }, undefined, { binding: fixture.binding });
    expect(fresh.hookSpecificOutput.additionalContext).not.toContain(`Lifecycle run: ${runId}`);
    expect(fixture.reports()).toHaveLength(count + 1);
  });
});

describe("private native installation", () => {
  test("existing runtime parent modes and explicit Claude hook-disable policy are preserved", async () => {
    const fixture = gateway();
    const hooks = path.join(fixture.project, ".github", "hooks"); mkdirSync(hooks, { recursive: true }); chmodSync(hooks, 0o755);
    await memory.install("copilot", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token });
    expect(statSync(hooks).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(hooks, "engram-memory.json")).mode & 0o777).toBe(0o600);
    const configBefore = readFileSync(memory.configFile(), "utf8");
    const settings = path.join(root, ".claude", "settings.json"); mkdirSync(path.dirname(settings));
    const original = JSON.stringify({ disableAllHooks: true, model: "preserved" }); writeFileSync(settings, original);
    await expect(memory.install("claude", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: "different-token" })).rejects.toThrow("explicitly disabled");
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(readFileSync(memory.configFile(), "utf8")).toBe(configBefore);
  });

  test("two runtimes on the same project keep separate credentials and run/stdio scopes", async () => {
    const fixture = gateway();
    const options = { project: fixture.project, topic: fixture.binding.topic, host: fixture.host };
    await memory.install("claude", { ...options, token: "fixture-claude-key" });
    await memory.install("codex", { ...options, token: "fixture-codex-key" });
    expect(JSON.parse(readFileSync(memory.configFile(), "utf8")).bindings).toHaveLength(2);
    expect(() => memory.bindingFor(fixture.project)).toThrow("unambiguous");
    await memory.claudeHook({ session_id: "claude", cwd: fixture.project, hook_event_name: "UserPromptSubmit", prompt: "Please implement the project retry policy and validate repeated requests." });
    await adapters.nativeHook("codex", { session_id: "codex", cwd: fixture.project, hook_event_name: "UserPromptSubmit", prompt: "Please implement the project retry policy and validate repeated requests." });
    const recalls = fixture.calls.filter(call => call.params?.name === "recall");
    expect(recalls).toHaveLength(2);
    expect(recalls.find(call => call.params._meta["com.engram/context"].integration.runtime === "claude-code").fixtureAuth).toBe("Bearer fixture-claude-key");
    const codex = recalls.find(call => call.params._meta["com.engram/context"].integration.runtime === "codex");
    expect(codex.fixtureAuth).toBe("Bearer fixture-codex-key");
    const runId = codex.params._meta["com.engram/context"].runId;
    expect(adapters.proxyContext({ project: fixture.project, host: fixture.host, token: "fixture-codex-key" }).runId).toBe(runId);
    expect(adapters.proxyContext({ project: fixture.project, host: fixture.host, token: "wrong-key" })).toBeNull();
    const ended = await memory.lifecycle("task-end", { project: fixture.project, runId, status: "completed", outcome: "Validated retry handling in the requested task." });
    expect(ended.ok).toBe(true);
    expect(fixture.calls.at(-1).fixtureAuth).toBe("Bearer fixture-codex-key");
  });

  test("nested monorepo bindings choose runtime or pinned credentials before the closest project", async () => {
    const fixture = gateway();
    const nested = path.join(fixture.project, "packages", "service"); mkdirSync(nested, { recursive: true });
    await memory.install("claude", { project: fixture.project, topic: "Workspace decisions", host: fixture.host, token: "parent-claude-key" });
    await memory.install("codex", { project: nested, topic: "Service decisions", host: fixture.host, token: "nested-codex-key" });
    expect(memory.bindingFor(nested, "claude-code").project).toBe(fixture.project);
    expect(memory.bindingFor(nested, "codex").project).toBe(nested);
    const input = { session_id: "nested-work", cwd: nested, hook_event_name: "UserPromptSubmit", prompt: "Please implement and validate the shared queue retry handling." };
    await memory.claudeHook(input);
    await adapters.nativeHook("codex", input);
    const recalls = fixture.calls.filter(call => call.params?.name === "recall");
    expect(recalls).toHaveLength(2);
    const claude = recalls.find(call => call.fixtureAuth === "Bearer parent-claude-key");
    const codex = recalls.find(call => call.fixtureAuth === "Bearer nested-codex-key");
    expect(adapters.proxyContext({ project: nested, host: fixture.host, token: "parent-claude-key" }).runId).toBe(claude.params._meta["com.engram/context"].runId);
    expect(adapters.proxyContext({ project: nested, host: fixture.host, token: "nested-codex-key" }).runId).toBe(codex.params._meta["com.engram/context"].runId);
    expect((await memory.lifecycle("status", { project: nested, runId: claude.params._meta["com.engram/context"].runId })).ok).toBe(true);
  });

  test("unlabeled legacy Claude bindings cannot be claimed by another native runtime", async () => {
    const fixture = gateway();
    const nested = path.join(fixture.project, "packages", "service"); mkdirSync(nested, { recursive: true });
    memory.internals.writePrivate(memory.configFile(), { version: 1, bindings: [{ project: fixture.project, host: fixture.host, token: "legacy-claude-owner-key", topic: "Legacy Claude decisions", budget: 4096 }] });
    expect(memory.bindingFor(nested, "claude-code").token).toBe("legacy-claude-owner-key");
    expect(() => memory.bindingFor(nested, "codex")).toThrow("unambiguous");
    const input = { session_id: "legacy-native", cwd: nested, hook_event_name: "UserPromptSubmit", prompt: "Please implement and validate shared background job retry handling." };
    const before = fixture.calls.length;
    expect(await adapters.nativeHook("codex", input)).toEqual({});
    expect(await adapters.nativeHook("cursor", input, "beforeSubmitPrompt")).toEqual({});
    expect(fixture.calls).toHaveLength(before);
    await memory.install("codex", { project: nested, topic: "Service work", host: fixture.host, token: "nested-new-codex-key" });
    await adapters.nativeHook("codex", input);
    await memory.claudeHook(input);
    const recalls = fixture.calls.filter(call => call.params?.name === "recall");
    expect(recalls.find(call => call.params._meta["com.engram/context"].integration.runtime === "codex").fixtureAuth).toBe("Bearer nested-new-codex-key");
    expect(recalls.find(call => call.params._meta["com.engram/context"].integration.runtime === "claude-code").fixtureAuth).toBe("Bearer legacy-claude-owner-key");
  });

  test("an explicit generic child binding overrides a farther runtime-specific parent scope", async () => {
    const fixture = gateway();
    const nested = path.join(fixture.project, "packages", "private-org"); mkdirSync(nested, { recursive: true });
    await memory.install("claude", { project: fixture.project, topic: "Parent organization", host: fixture.host, token: "parent-organization-a-key" });
    await memory.install("generic", { project: nested, topic: "Explicit child organization", host: fixture.host, token: "child-organization-b-key" });
    expect(memory.bindingFor(nested, "claude-code")).toMatchObject({ project: nested, runtime: "generic", token: "child-organization-b-key" });
    await memory.claudeHook({ session_id: "child-org", cwd: nested, hook_event_name: "UserPromptSubmit", prompt: "Please implement and validate scoped background queue retries." });
    expect(fixture.calls.filter(call => call.params?.name === "recall").at(-1).fixtureAuth).toBe("Bearer child-organization-b-key");
    await memory.install("claude", { project: nested, topic: "Exact child Claude", host: fixture.host, token: "child-exact-claude-key" });
    expect(memory.bindingFor(nested, "claude-code").token).toBe("child-exact-claude-key");
  });
  test("all supported native installers preserve unrelated settings and write private hook/plugin files", async () => {
    const fixture = gateway();
    const expected = { codex: path.join(root, ".codex", "hooks.json"), cursor: path.join(root, ".cursor", "hooks.json"), gemini: path.join(root, ".gemini", "settings.json"), copilot: path.join(fixture.project, ".github", "hooks", "engram-memory.json"), windsurf: path.join(root, ".codeium", "windsurf", "hooks.json"), openclaw: path.join(root, ".openclaw", "openclaw.json") };
    for (const [runtime, file] of Object.entries(expected)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(runtime === "openclaw" ? { model: "keep-me", plugins: { slots: { memory: "existing-memory" }, entries: { keep: { enabled: true } } } } : { model: "keep-me", hooks: {} }));
      const options = { project: fixture.project, topic: "Project architecture", host: fixture.host, token: fixture.token };
      const result = await memory.install(runtime, options);
      await memory.install(runtime, options);
      expect(result.settings).toBe(file);
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved.model).toBe("keep-me");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(saved)).not.toContain(fixture.token);
      if (runtime === "openclaw") {
        expect(saved.plugins.slots.memory).toBe("existing-memory"); expect(saved.plugins.entries.keep.enabled).toBe(true);
        expect(saved.plugins.entries["engram-memory"].hooks).toEqual({ allowPromptInjection: true, allowConversationAccess: true });
      } else for (const event of registry.runtimeCapabilities(runtime).events) expect(saved.hooks[event]).toHaveLength(1);
    }
    const opencode = await memory.install("opencode", { project: fixture.project, topic: "Project architecture", host: fixture.host, token: fixture.token });
    expect(readFileSync(opencode.settings, "utf8")).toContain("export const EngramMemory");
    expect(readFileSync(opencode.settings, "utf8")).not.toContain(fixture.token);
    expect(fixture.calls.every(call => call.method === "tools/list" || call.params?.name === "whoami")).toBe(true);
  });

  test("symlink and malformed config preflight cannot create a binding or overwrite another user's file", async () => {
    const fixture = gateway();
    mkdirSync(path.join(root, ".codex")); const outside = path.join(root, "dotfiles.json"); writeFileSync(outside, "{}");
    symlinkSync(outside, path.join(root, ".codex", "hooks.json"));
    await expect(memory.install("codex", { project: fixture.project, topic: "topic", host: fixture.host, token: fixture.token })).rejects.toThrow("symbolic-link");
    expect(readFileSync(outside, "utf8")).toBe("{}");
    expect(() => readFileSync(memory.configFile())).toThrow();
    mkdirSync(path.join(root, ".gemini")); writeFileSync(path.join(root, ".gemini", "settings.json"), JSON.stringify({ hooks: { BeforeAgent: {} } }));
    await expect(memory.install("gemini", { project: fixture.project, topic: "topic", host: fixture.host, token: fixture.token })).rejects.toThrow("arrays");
    expect(() => readFileSync(memory.configFile())).toThrow();
  });
});

describe("native plugin wrappers and stdio task propagation", () => {
  test("explicit CLI verification correlates real read/save receipts without manufacturing work or resetting budgets", async () => {
    const fixture = gateway();
    await memory.install("codex", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token });
    await adapters.nativeHook("codex", { hook_event_name: "UserPromptSubmit", session_id: "verified-session", cwd: fixture.project, prompt: "Please implement retry handling and validate duplicate delivery behavior." });
    const options = { project: fixture.project, host: fixture.host, token: fixture.token };
    const context = adapters.proxyContext(options), runId = context.runId;
    const statusBefore = await memory.lifecycle("status", { project: fixture.project, runId });
    const before = fixture.calls.length;
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "..", "shim", "index.js"), "memory", "verify", "begin", "--run", runId], { cwd: fixture.project, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(0); expect(stderr).toBe(""); expect(stdout).not.toContain(fixture.token);
    const begun = JSON.parse(stdout); expect(begun).toMatchObject({ ok: true, status: "pending", verification: { recallVerified: false, saveVerified: false, automaticWorkflowVerified: null } });
    expect(fixture.calls.slice(before).map(call => call.params?.name)).toEqual(["whoami"]);
    expect(begun.contextBytes).toBe(statusBefore.contextBytes);
    const withProbe = adapters.proxyContext(options);
    expect(withProbe.probeId).toBe(begun.verification.probeId);
    expect(withProbe.integration).toEqual(context.integration);
    const other = adapters.augmentProxyMeta({ "com.engram/context": { runId: "another-real-task" } }, options)["com.engram/context"];
    expect(other.probeId).toBeUndefined(); expect(other.integration).toBeUndefined();
    const pending = await memory.verify("status", { project: fixture.project, runId });
    expect(pending.verification.status).toBe("pending");
    await memory.lifecycle("task-context", { project: fixture.project, runId, query: "retry failure constraints for this implementation" });
    expect((await memory.verify("status", { project: fixture.project, runId })).verification).toMatchObject({ recallVerified: true, saveVerified: false });
    await memory.lifecycle("decision", { project: fixture.project, runId, kind: "decision", text: "Reuse the request identifier when retrying a background job." });
    expect((await memory.verify("status", { project: fixture.project, runId })).verification).toMatchObject({ status: "passed", recallVerified: true, saveVerified: true, automaticWorkflowVerified: null });
    expect(fixture.calls.filter(call => call.params?.name === "record_action")).toHaveLength(1);
    const stateFile = path.join(memory.stateRoot(), memory.bindingFor(fixture.project, "codex").scope, `${runId}.json`);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.verification.expiresAt = new Date(Date.now() - 1000).toISOString();
    memory.internals.writePrivate(stateFile, state);
    expect(adapters.proxyContext(options).probeId).toBeUndefined();
    expect(adapters.proxyContext({ ...options, runId }).probeId).toBeUndefined();
    await memory.verify("begin", { project: fixture.project, runId });
    fixture.expire(runId);
    expect((await memory.verify("status", { project: fixture.project, runId })).status).toBe("expired");
    expect(adapters.proxyContext(options).probeId).toBeUndefined();
    const current = await memory.lifecycle("status", { project: fixture.project, runId });
    expect(current.ok).toBe(true); expect(current.contextBudgetBytes).toBe(4096);
  });
  for (const mode of ["frozen", "advancing"] as const) test(`verification receipts remain valid when the millisecond clock is ${mode}`, async () => {
    const epoch = Date.now(); let ticks = 0;
    const fixture = gateway({ now: () => epoch + (mode === "advancing" ? ticks++ : 0) });
    await memory.install("generic", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token });
    const start = await memory.lifecycle("task-start", { runtime: "codex", sessionId: `clock-${mode}`, taskId: "clock-receipts", query: "retry handling" }, { binding: fixture.binding });
    expect(start.status).toBe("retrieved");
    const begun = await memory.verify("begin", { project: fixture.project, runId: start.runId });
    expect(begun).toMatchObject({ ok: true, status: "pending" });
    expect(Date.parse(begun.verification.expiresAt) - Date.parse(begun.verification.startedAt)).toBe(15 * 60000);
    expect((await memory.verify("status", { project: fixture.project, runId: start.runId })).status).toBe("pending");
    fixture.expire(start.runId);
    const expired = await memory.verify("status", { project: fixture.project, runId: start.runId });
    expect(expired).toMatchObject({ ok: false, status: "expired" });
    expect(Date.parse(expired.verification.expiresAt) - Date.parse(expired.verification.startedAt)).toBe(15 * 60000);
    // Sampling expiry one millisecond later recreates the old fixture defect.
    // The real SDK must keep rejecting that oversized receipt.
    const oversized = { ...expired.verification, expiresAt: new Date(Date.parse(expired.verification.expiresAt) + 1).toISOString() };
    const rejected = await memory.verify("status", { project: fixture.project, runId: start.runId }, { fetchImpl: async (_url: string, request: any) => {
      const body = JSON.parse(request.body);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ verification: oversized }) }] } });
    } });
    expect(rejected.status).toBe("invalid_response");
  });
  test("OpenCode plugin appends context to the actual user text and ignores idle as completion", async () => {
    const fixture = gateway();
    await memory.install("generic", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token });
    const plugin = await plugins.openCodePlugin({ directory: fixture.project });
    const output = { parts: [Object.freeze({ type: "text", text: "Please implement retry safety for the background queue." })] };
    await plugin["chat.message"]({ sessionID: "opencode-session" }, output);
    expect(output.parts[0].text).toContain("Keep request IDs stable");
    const count = fixture.calls.length;
    await plugin.event({ event: { type: "session.idle", properties: {} } });
    expect(fixture.calls.length).toBe(count);
    expect(fixture.reports().every(report => report.status === "running")).toBe(true);
  });

  test("OpenClaw uses only explicit currentUserMessage, honors the hook lifetime, and never reads reconstructed history", async () => {
    const fixture = gateway();
    await memory.install("generic", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token });
    const handlers: Record<string, any> = {}; plugins.openClawPlugin.register({ on: (name: string, handler: any) => { handlers[name] = handler; } });
    let assertions = 0;
    const context = { sessionKey: "openclaw-session", workspaceDir: fixture.project, hookInvocation: { assertActive() { assertions++; } } };
    const before = fixture.calls.length;
    expect(await handlers.before_prompt_build({ prompt: "PRIVATE_HISTORY", currentUserMessage: "" }, context)).toBeUndefined();
    expect(fixture.calls.length).toBe(before);
    const event = { currentUserMessage: "Please implement and validate idempotent job retry handling.", get prompt() { throw new Error("History must not be read"); }, get messages() { throw new Error("History must not be read"); } };
    const result = await handlers.before_prompt_build(event, context);
    expect(result.prependContext).toContain("Keep request IDs stable");
    expect(assertions).toBe(2);
    expect(JSON.stringify(fixture.calls)).not.toContain("PRIVATE_HISTORY");
    expect(fixture.reports().every(report => report.status === "running")).toBe(true);
    expect(adapters.proxyContext({ project: fixture.project, host: fixture.host, token: fixture.token }).runId).toBeDefined();
    await handlers.session_end({}, { sessionKey: "openclaw-session", sessionId: "session-with-no-workspace" });
    expect(adapters.proxyContext({ project: fixture.project, host: fixture.host, token: fixture.token }).runId).toBeUndefined();
  });

  test("opt-in stdio propagation checks endpoint and credential, handles ambiguous sessions, and preserves explicit task metadata", async () => {
    const fixture = gateway();
    await memory.install("generic", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token });
    const input = { session_id: "first-session", cwd: fixture.project, hook_event_name: "UserPromptSubmit", prompt: "Please implement retry handling and verify repeated deliveries." };
    await adapters.nativeHook("codex", input);
    const options = { project: fixture.project, host: fixture.host, token: fixture.token };
    const one = adapters.proxyContext(options);
    expect(one.runId).toMatch(/^em_[a-f0-9]{64}$/);
    expect(one.integration.capabilities).toContain("task-context");
    expect(adapters.proxyContext({ ...options, token: "another-token" })).toBeNull();
    expect(adapters.proxyContext({ ...options, host: "https://elsewhere.example" })).toBeNull();
    expect(adapters.proxyContext({ ...options, project: undefined })).toBeNull();
    const explicit = { "com.engram/context": { runId: "explicit-task", maxBytes: 2048, probeId: "opaque-explicit-probe" } };
    expect(adapters.augmentProxyMeta(explicit, options)["com.engram/context"]).toMatchObject(explicit["com.engram/context"]);
    await adapters.nativeHook("codex", { ...input, session_id: "second-session" });
    expect(adapters.proxyContext(options).runId).toBeUndefined();
    expect(adapters.proxyContext({ ...options, sessionId: "first-session" }).runId).toBe(one.runId);
    expect(adapters.proxyContext({ ...options, runId: "owner-explicit-task" }).runId).toBe("owner-explicit-task");
    await adapters.nativeHook("codex", { ...input, session_id: "second-session", hook_event_name: "SessionEnd" });
    expect(adapters.proxyContext(options).runId).toBe(one.runId);
    await memory.lifecycle("task-end", { project: fixture.project, runId: one.runId, status: "completed", outcome: "Verified the requested retry fix." });
    expect(adapters.proxyContext(options).runId).toBeUndefined();
  });
});

describe("Hermes Agent, Amp and Devin CLI", () => {
  const work = "Please implement idempotent retries in the background queue and validate them.";

  test("Hermes injects the startup guide and memory once per turn and reads only the current message", async () => {
    const fixture = gateway();
    const turn = (turnId: string, first: boolean, message = work) => adapters.nativeHook("hermes", { hook_event_name: "pre_llm_call", session_id: "hermes-session", cwd: fixture.project, profile: "default", extra: { user_message: message, is_first_turn: first, turn_id: turnId, conversation_history: [{ role: "user", content: "PRIVATE_HISTORY" }] } }, "pre_llm_call", { binding: fixture.binding });
    const first = await turn("t1", true);
    expect(Object.keys(first)).toEqual(["context"]);
    expect(first.context).toContain("Engram memory lifecycle is enabled");
    expect(first.context).toContain("Keep request IDs stable");
    expect(await turn("t1", true)).toEqual({});
    const later = await turn("t2", false, "Engram task: review queue metrics");
    expect(later.context || "").not.toContain("Engram memory lifecycle is enabled");
    expect(JSON.stringify(fixture.calls)).not.toContain("PRIVATE_HISTORY");
    expect(fixture.reports().every(report => report.status === "running")).toBe(true);
    expect(registry.normalizeRuntimeEvent("hermes", { session_id: "s", cwd: "/p", extra: { user_message: "x" } }, "on_session_end")).toBeNull();
  });

  test("Devin CLI uses its documented events, project directory and output shape", async () => {
    const fixture = gateway();
    const prior = process.env.DEVIN_PROJECT_DIR;
    process.env.DEVIN_PROJECT_DIR = fixture.project;
    try {
      const start = await adapters.nativeHook("devin", { hook_event_name: "SessionStart", session_id: "devin-session", source: "startup" }, "SessionStart", { binding: fixture.binding });
      expect(start.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
      expect(start.hookSpecificOutput.additionalContext).toContain("Engram memory lifecycle is enabled");
      const prompt = await adapters.nativeHook("devin", { hook_event_name: "UserPromptSubmit", session_id: "devin-session", prompt_id: "p1", prompt: work }, "UserPromptSubmit", { binding: fixture.binding });
      expect(prompt.hookSpecificOutput.additionalContext).toContain("Keep request IDs stable");
      expect(await adapters.nativeHook("devin", { hook_event_name: "UserPromptSubmit", session_id: "devin-session", prompt_id: "p1", prompt: work }, "UserPromptSubmit", { binding: fixture.binding })).toEqual({});
      const before = fixture.calls.length;
      expect(await adapters.nativeHook("devin", { hook_event_name: "Stop", session_id: "devin-session", stop_hook_active: false }, "Stop", { binding: fixture.binding })).toEqual({});
      expect(fixture.calls.length).toBe(before);
    } finally { if (prior === undefined) delete process.env.DEVIN_PROJECT_DIR; else process.env.DEVIN_PROJECT_DIR = prior; }
  });

  test("inside Devin, the Claude Code hook stands aside only when Devin has its own connection", async () => {
    const fixture = gateway();
    const options = { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token };
    await memory.install("claude", options);
    expect(memory.devinRunsOwnHooks({ cwd: fixture.project }, { DEVIN_PROJECT_DIR: fixture.project })).toBe(false);
    await memory.install("devin", options);
    expect(memory.devinRunsOwnHooks({ cwd: fixture.project }, { DEVIN_PROJECT_DIR: fixture.project })).toBe(true);
    expect(memory.devinRunsOwnHooks({}, { DEVIN_PROJECT_DIR: fixture.project })).toBe(true);
    expect(memory.devinRunsOwnHooks({ cwd: fixture.project }, {})).toBe(false);
    const hooks = JSON.parse(readFileSync(path.join(root, ".config", "devin", "config.json"), "utf8")).hooks;
    expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
    expect(hooks.SessionStart[0].hooks[0]).toMatchObject({ type: "command", timeout: 6 });

    // The installed Claude hook command, run the way Claude Code and Devin run it.
    const claudeHook = async (devinProjectDir: string) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "..", "shim", "index.js"), "memory", "hook", "claude"], { cwd: fixture.project, env: { ...process.env, DEVIN_PROJECT_DIR: devinProjectDir }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: "shared-session", cwd: fixture.project }));
      child.stdin.end();
      const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exit).toBe(0);
      return JSON.parse(stdout);
    };
    expect((await claudeHook("")).hookSpecificOutput.additionalContext).toContain("Engram memory lifecycle is enabled");
    expect(await claudeHook(fixture.project)).toEqual({});
  });

  test("the Amp plugin sends only the current prompt through the installed bridge and returns a hidden message", async () => {
    const fixture = gateway();
    const result = await memory.install("amp", { project: fixture.project, topic: fixture.binding.topic, host: fixture.host, token: fixture.token });
    expect(result.settings).toBe(path.join(root, "config", "amp", "plugins", "engram-memory.js"));
    const source = readFileSync(result.settings, "utf8");
    expect(source).not.toContain(fixture.token);
    const module = path.join(root, "amp-plugin.mjs");
    writeFileSync(module, source);
    const handlers: Record<string, any> = {};
    let workspaceRoot: any = { toString: () => `file://${fixture.project}` };
    (await import(module)).default({ system: { get workspaceRoot() { return workspaceRoot; } }, helpers: { filePathFromURI: (uri: any) => new URL(uri.toString()).pathname }, on: (name: string, handler: any) => { handlers[name] = handler; } });
    expect(Object.keys(handlers)).toEqual(["agent.start"]);
    const first = await handlers["agent.start"]({ thread: { id: "T-amp-1" }, message: work, id: "m1" });
    expect(first.message.display).toBe(false);
    expect(first.message.content).toContain("Engram memory lifecycle is enabled");
    expect(first.message.content).toContain("Keep request IDs stable");
    const second = await handlers["agent.start"]({ thread: { id: "T-amp-1" }, message: "Engram task: review the retry metrics", id: "m2" });
    expect(second.message?.content || "").not.toContain("Engram memory lifecycle is enabled");
    workspaceRoot = null;
    expect(await handlers["agent.start"]({ thread: { id: "T-amp-2" }, message: work, id: "m3" })).toEqual({});
    expect(fixture.reports().every(report => report.status === "running")).toBe(true);
  });
});
