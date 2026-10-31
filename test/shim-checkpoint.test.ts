import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const memory = require("../shim/memory.js");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let root: string;
let previous: Record<string, string | undefined>;
const servers: any[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engram-checkpoint-test-")));
  previous = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"].map(key => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_STATE_HOME = path.join(root, "state");
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

// A small model of the gateway contract: writer-scoped idempotent request IDs,
// expected-parent checks and structured error codes.
function fakeGateway() {
  const receipts = new Map<string, { fingerprint: string; receipt: any }>();
  const heads = new Map<string, { id: string; revision: number }>();
  const calls: any[] = [];
  const mode = { down: false, timeoutAfterCommit: 0, denied: false };
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${String(++counter).padStart(32, "0")}`;
  const error = (code: string, extra: any = {}) => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, code, error: "x", ...extra }) }], isError: true });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const message = await request.json() as any;
      const args = message.params?.arguments || {};
      if (message.params?.name !== "checkpoint_task") return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, id: "action", status: "running", evidence: "reported" }) }] } });
      calls.push(args);
      if (mode.down) return new Response("unavailable", { status: 503 });
      if (mode.denied) return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "denied: checkpoint_task is not allowed for this token" }], isError: true } });
      const fingerprint = JSON.stringify({ ...args, requestId: undefined });
      let result: any;
      const prior = receipts.get(args.requestId);
      if (prior) result = prior.fingerprint === fingerprint ? { content: [{ type: "text", text: JSON.stringify({ ...prior.receipt, duplicate: true }) }] } : error("request_conflict");
      else if (JSON.stringify(args.record).length > 2000) result = error("record_too_large", { bytes: 5000 });
      else if (!args.taskId) {
        const taskId = id("task"), checkpointId = id("cp");
        heads.set(taskId, { id: checkpointId, revision: 1 });
        const receipt = { ok: true, taskId, checkpointId, lineage: "main", revision: 1, savedAt: new Date().toISOString(), created: true, unchanged: false };
        receipts.set(args.requestId, { fingerprint, receipt });
        result = { content: [{ type: "text", text: JSON.stringify(receipt) }] };
      } else {
        const head = heads.get(args.taskId);
        if (!head) result = error("task_not_found");
        else if (head.id !== args.expectedParent) result = error("revision_conflict", { currentCheckpointId: head.id });
        else {
          const checkpointId = id("cp");
          heads.set(args.taskId, { id: checkpointId, revision: head.revision + 1 });
          const receipt = { ok: true, taskId: args.taskId, checkpointId, lineage: "main", revision: head.revision + 1, savedAt: new Date().toISOString(), created: false, unchanged: false };
          receipts.set(args.requestId, { fingerprint, receipt });
          result = { content: [{ type: "text", text: JSON.stringify(receipt) }] };
        }
      }
      // Commit happened, but the client never sees the answer.
      if (mode.timeoutAfterCommit > 0) { mode.timeoutAfterCommit--; return new Response("lost", { status: 504 }); }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  servers.push(server);
  const host = `http://127.0.0.1:${server.port}`;
  const project = path.join(root, "project");
  mkdirSync(project, { recursive: true });
  const binding = { project, host, endpoint: `${host}/mcp`, token: "fixture-token", topic: "continuation", budget: 4096, scope: hash(`${host}/mcp\nfixture-token\n${project}`), memoryWriteAvailable: true };
  return { calls, heads, mode, binding, moveHead(taskId: string) { const head = heads.get(taskId)!; heads.set(taskId, { id: id("cp"), revision: head.revision + 1 }); } };
}

const run = { runtime: "codex", sessionId: "session-1", taskId: "work-1" };
const record = (next: string) => ({ objective: "Ship continuation", next });

describe("checkpoint bridge queue", () => {
  test("starts a task, then chains later saves from the confirmed parent", async () => {
    const gateway = fakeGateway();
    const first = await memory.lifecycle("checkpoint", { ...run, title: "Continuation", record: record("Write storage") }, { binding: gateway.binding });
    expect(first.ok).toBe(true);
    expect(first.continuation.task.revision).toBe(1);
    const second = await memory.lifecycle("checkpoint", { runId: first.runId, trigger: "decision", record: record("Write tests") }, { binding: gateway.binding });
    expect([second.ok, second.receipt.revision]).toEqual([true, 2]);
    expect(gateway.calls[1].expectedParent).toBe(first.continuation.task.checkpointId);
    expect(gateway.calls[1].harness).toBe("codex");
    expect(gateway.calls[1].runId).toBe(first.runId);
  });

  test("a timeout after commit retries the identical request and gets the original receipt", async () => {
    const gateway = fakeGateway();
    gateway.mode.timeoutAfterCommit = 1;
    const first = await memory.lifecycle("checkpoint", { ...run, title: "Continuation", record: record("Write storage") }, { binding: gateway.binding });
    expect(first.status).toBe("unconfirmed");
    expect(first.ok).toBe(false);
    expect(first.continuation.unconfirmed).toBe(1);
    // The next real lifecycle event flushes the queue; no timers.
    const status = await memory.lifecycle("no-change", { runId: first.runId }, { binding: gateway.binding });
    expect(status.ok).toBe(true);
    const after = await memory.lifecycle("status", { runId: first.runId }, { binding: gateway.binding });
    expect(after.continuation.unconfirmed).toBe(0);
    expect(after.continuation.task.revision).toBe(1);
    expect(gateway.calls[0]).toEqual(gateway.calls[1]);
    expect(gateway.heads.size).toBe(1);
  });

  test("an outage keeps saves local, collapses unsent ones and never reorders sent ones", async () => {
    const gateway = fakeGateway();
    const first = await memory.lifecycle("checkpoint", { ...run, title: "Continuation", record: record("one") }, { binding: gateway.binding });
    gateway.mode.down = true;
    const sent = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("two") }, { binding: gateway.binding });
    expect(sent.status).toBe("unconfirmed");
    const queued = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("three") }, { binding: gateway.binding });
    const latest = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("four") }, { binding: gateway.binding });
    // "two" stays queued exactly as sent; "four" replaces the never-sent "three".
    expect(latest.continuation.unconfirmed).toBe(1);
    expect(latest.continuation.unsent).toBe(1);
    expect(queued.ok).toBe(false);
    gateway.mode.down = false;
    const recovered = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("five") }, { binding: gateway.binding });
    expect(recovered.ok).toBe(true);
    // "two" was sent, so it is delivered as sent; "three" and "four" never left and were superseded.
    const nexts = gateway.calls.filter(call => !gateway.mode.down).map(call => call.record.next);
    expect(nexts.filter(next => next === "three" || next === "four")).toEqual([]);
    // Only two (already sent) and five reach the server after one.
    expect(recovered.receipt.revision).toBe(3);
    const state = JSON.parse(readFileSync(path.join(root, "state", "engram-mcp", "memory", gateway.binding.scope, `${first.runId}.json`), "utf8"));
    expect(state.checkpoints.pending).toEqual([]);
  });

  test("another agent's newer save stops the queue instead of overwriting it", async () => {
    const gateway = fakeGateway();
    const first = await memory.lifecycle("checkpoint", { ...run, title: "Continuation", record: record("one") }, { binding: gateway.binding });
    gateway.moveHead(first.continuation.task.taskId);
    const stale = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("two") }, { binding: gateway.binding });
    expect(stale.status).toBe("revision_conflict");
    expect(stale.continuation.conflict.currentCheckpointId).toBe(gateway.heads.get(first.continuation.task.taskId)!.id);
    const again = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("three") }, { binding: gateway.binding });
    expect(again.status).toBe("revision_conflict");
    // Reconcile explicitly after resume_task.
    const head = gateway.heads.get(first.continuation.task.taskId)!;
    const reconciled = await memory.lifecycle("checkpoint", { runId: first.runId, continueFrom: { taskId: first.continuation.task.taskId, checkpointId: head.id }, record: record("merged") }, { binding: gateway.binding });
    expect(reconciled.ok).toBe(true);
  });

  test("a resumed task is continued by passing its taskId and checkpoint", async () => {
    const gateway = fakeGateway();
    const outgoing = await memory.lifecycle("checkpoint", { ...run, title: "Continuation", record: record("one") }, { binding: gateway.binding });
    // A fresh run without a title or resumed task cannot invent a task.
    const untitled = await memory.lifecycle("checkpoint", { runtime: "cursor", sessionId: "other-2", taskId: "work-3", record: record("orphan") }, { binding: gateway.binding });
    expect(untitled.status).toBe("title_required");
    const attach = await memory.lifecycle("task-start", { runtime: "cursor", sessionId: "other-3", taskId: "work-4", recall: false }, { binding: gateway.binding });
    const saved = await memory.lifecycle("checkpoint", { runId: attach.runId, continueFrom: { taskId: outgoing.continuation.task.taskId, checkpointId: outgoing.continuation.task.checkpointId }, trigger: "handoff", record: record("done by cursor") }, { binding: gateway.binding });
    expect([saved.ok, saved.receipt.taskId, saved.receipt.revision]).toEqual([true, outgoing.continuation.task.taskId, 2]);
    // A confirmed handoff hands the user something to paste into the next agent.
    expect(saved.pickUp.prompt).toContain(outgoing.continuation.task.taskId);
    expect(saved.pickUp.prompt).toContain("resume_task");
    expect(saved.pickUp.say).toContain("Keep building");
    expect(outgoing.pickUp).toBeUndefined();
    expect(gateway.calls.at(-1).harness).toBe("cursor");
  });

  test("invalid records fail without blocking later saves; read-only connections save nothing", async () => {
    const gateway = fakeGateway();
    const first = await memory.lifecycle("checkpoint", { ...run, title: "Continuation", record: record("one") }, { binding: gateway.binding });
    const huge = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("x".repeat(3000)) }, { binding: gateway.binding });
    expect(huge.status).toBe("record_too_large");
    const fine = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("two") }, { binding: gateway.binding });
    expect(fine.ok).toBe(true);
    await expect(memory.lifecycle("checkpoint", { runId: first.runId, trigger: "finished", record: record("x") }, { binding: gateway.binding })).rejects.toThrow("trigger");
    gateway.mode.denied = true;
    const denied = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("three") }, { binding: gateway.binding });
    expect(denied.ok).toBe(false);
    const after = await memory.lifecycle("checkpoint", { runId: first.runId, record: record("four") }, { binding: gateway.binding });
    expect(after.status).toBe("write_denied");
  });

  test("hook guidance teaches the checkpoint flow and names the current task after a reset", async () => {
    const gateway = fakeGateway();
    const first = await memory.lifecycle("checkpoint", { ...run, title: "Continuation", record: record("one") }, { binding: gateway.binding });
    const state = JSON.parse(readFileSync(path.join(root, "state", "engram-mcp", "memory", gateway.binding.scope, `${first.runId}.json`), "utf8"));
    const text = memory.continuationGuidance(state);
    expect(text).toContain("checkpoint --run <run-id>");
    expect(text).toContain("find_tasks");
    expect(text).toContain(first.continuation.task.taskId);
    expect(text).toContain("pickUp.prompt");
  });

  test("Cursor session-start context is delivered once more on the first tool result, never twice", async () => {
    const gateway = fakeGateway();
    const adapters = require("../shim/runtime-adapters.js");
    const base = { session_id: "cursor-session", workspace_roots: [gateway.binding.project] };
    const startup = await adapters.nativeHook("cursor", base, "sessionStart", { binding: gateway.binding });
    expect(startup.additional_context).toContain("Continuation:");
    const first = await adapters.nativeHook("cursor", { ...base, tool_name: "Read" }, "postToolUse", { binding: gateway.binding });
    expect(first.additional_context).toContain("repeated once");
    expect(first.additional_context).toContain("find_tasks");
    // A duplicate post-tool event cannot repeat it.
    expect(await adapters.nativeHook("cursor", { ...base, tool_name: "Read" }, "postToolUse", { binding: gateway.binding })).toEqual({});
  });
});
