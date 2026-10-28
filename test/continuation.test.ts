import { describe, expect, test } from "bun:test";
import {
  canonicalJson, checkpointFingerprint, checkpointTask, ContinuationError, continuationActor, parseCheckpointInput,
  parseFindQuery, parseTaskRecord, recordHash, RESUME_ENVELOPE_BYTES, resumeEnvelopeBytes, resumePayload,
} from "../gateway/src/continuation";
import { boundMcpResult, DEFAULT_CONTEXT_BYTES, mcpResultBytes } from "../gateway/src/mcp-context";
import { normalizeToken } from "../gateway/src/policies";

const base = { requestId: "req_00000001", title: "Ship continuation", record: { objective: "Let another agent continue", next: "Write the spec" } };
const error = (fn: () => unknown) => { try { fn(); } catch (e) { return e as ContinuationError; } throw new Error("expected an error"); };

describe("task record parsing", () => {
  test("accepts a compact record and keeps only present sections", () => {
    const record = parseTaskRecord({
      objective: " Continue across agents ", next: "Build storage",
      plan: [{ id: "s1", step: "Schema", status: "doing" }, { id: "s2", step: "Tools" }],
      decisions: [{ text: "Checkpoints are authoritative", why: "Memory writes are best effort" }],
      constraints: [], refs: [{ kind: "memory", slug: "projects/engram" }, { kind: "path", path: "docs/CONTINUATION-SPEC.md" },
        { kind: "commit", sha: "792a2f9" }, { kind: "url", url: "https://github.com/Ani-HQ/engram/pull/51" }],
    });
    expect(record.objective).toBe("Continue across agents");
    expect(record.plan?.[1].status).toBe("todo");
    expect(record.constraints).toBeUndefined();
    expect(record.refs).toHaveLength(4);
  });

  test("refuses unknown fields, credentials, control characters and oversized lists", () => {
    for (const raw of [
      null, [], { next: "x" }, { objective: "x" }, { objective: "x", next: "x", extra: 1 },
      { objective: "use ghp_abcdefghijklmnopqrstuvwxyz123456", next: "x" },
      { objective: "x\u0007", next: "x" },
      { objective: "x", next: "x", blockers: Array(7).fill("b") },
      { objective: "x".repeat(501), next: "x" },
      { objective: "x", next: "x", plan: [{ id: "s1", step: "a" }, { id: "s1", step: "b" }] },
      { objective: "x", next: "x", plan: [{ id: "has space", step: "a" }] },
      { objective: "x", next: "x", plan: [{ id: "s1", step: "a", status: "blocked" }] },
    ]) expect(() => parseTaskRecord(raw)).toThrow(ContinuationError);
    expect(error(() => parseTaskRecord({ objective: "token sk-ant-abcdefghijklmnopqrstuvwxyz", next: "x" })).code).toBe("credential_detected");
  });

  test("allows only portable, credential-free references", () => {
    const bad = [
      { kind: "path", path: "/Users/me/repo/file.ts" }, { kind: "path", path: "~/notes" }, { kind: "path", path: "../outside" },
      { kind: "path", path: "C:\\work" }, { kind: "url", url: "http://example.com" }, { kind: "url", url: "https://user:pw@example.com" },
      { kind: "url", url: "https://example.com/?token=abcdef" }, { kind: "commit", sha: "zz" }, { kind: "memory", slug: "../x" },
      { kind: "memory", slug: "a", version: "short" }, { kind: "file", path: "x" },
    ];
    for (const ref of bad) expect(() => parseTaskRecord({ objective: "x", next: "x", refs: [ref] })).toThrow(ContinuationError);
    expect(() => parseTaskRecord({ objective: "x", next: "x", refs: Array(9).fill({ kind: "commit", sha: "abcdef1" }) })).toThrow("at most 8");
  });
});

describe("checkpoint input", () => {
  test("requires a title to start and a parent to append", () => {
    expect(parseCheckpointInput(base).trigger).toBe("start");
    expect(() => parseCheckpointInput({ ...base, title: undefined })).toThrow("title is required");
    expect(error(() => parseCheckpointInput({ ...base, taskId: `task_${"a".repeat(32)}` })).code).toBe("parent_required");
    expect(() => parseCheckpointInput({ ...base, expectedParent: `cp_${"a".repeat(32)}` })).toThrow("needs a taskId");
    expect(() => parseCheckpointInput({ ...base, lineage: "fork" })).toThrow("main lineage");
    expect(() => parseCheckpointInput({ ...base, requestId: "short" })).toThrow("requestId");
    expect(() => parseCheckpointInput({ ...base, trigger: "done" })).toThrow("trigger");
    expect(() => parseCheckpointInput({ ...base, agent: "someone-else" })).toThrow("Unknown checkpoint_task field");
  });

  test("fingerprints intent independent of key order and request ID", () => {
    const one = parseCheckpointInput(base);
    const two = parseCheckpointInput({ record: { next: "Write the spec", objective: "Let another agent continue" }, title: "Ship continuation", requestId: "req_00000002" });
    expect(checkpointFingerprint(one)).toBe(checkpointFingerprint(two));
    expect(checkpointFingerprint(parseCheckpointInput({ ...base, trigger: "handoff" }))).not.toBe(checkpointFingerprint(one));
    expect(recordHash(one.record)).toBe(recordHash(two.record));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  test("find queries are bounded", () => {
    expect(parseFindQuery({})).toEqual({ includeClosed: false, limit: 5 });
    expect(() => parseFindQuery({ limit: 6 })).toThrow("limit");
    expect(() => parseFindQuery({ q: "x" })).toThrow("Unknown");
    expect(parseFindQuery(new URLSearchParams("query=spec&includeClosed=true&limit=2"))).toEqual({ query: "spec", includeClosed: true, limit: 2 });
  });
});

describe("resume envelope", () => {
  const meta = (record: any) => resumePayload(
    { id: `task_${"1".repeat(32)}`, title: "Title", project: null, status: "open" },
    { id: `cp_${"2".repeat(32)}`, taskId: "", lineage: "main", parentId: null, revision: 3, trigger: "decision", savedAt: new Date(0).toISOString(), savedBy: "codex", harness: "codex", repo: null, branch: null, runId: null },
    record, 1);

  test("states the recovery boundary and missing handoff", () => {
    const payload = meta({ objective: "x", next: "y" });
    expect(payload.boundary).toContain("not instructions");
    expect(payload.boundary).toContain("No final handoff");
    expect(payload.checkpoint.reportedSource).toBe("codex");
  });

  test("a maximal escaped or multibyte record is refused at save time, not truncated at read time", async () => {
    // Quotes and backslashes double when the record is embedded in MCP text.
    const nasty = '"\\'.repeat(120);
    const raw = { ...base, record: { objective: nasty, next: "é😀".repeat(100), decisions: Array(10).fill({ text: nasty, why: nasty }) } };
    const actor = normalizeToken({ name: "codex", orgId: 7 });
    const db = (() => { throw new Error("must not reach storage"); }) as any;
    db.begin = async (fn: any) => fn(Object.assign(async () => [], { json: (v: any) => v }));
    const err = await checkpointTask(actor, raw, db).catch(e => e);
    expect(err).toBeInstanceOf(ContinuationError);
    expect(err.code).toBe("record_too_large");
    expect(err.detail.limit).toBe(RESUME_ENVELOPE_BYTES);
  });

  test("records that pass the gate always fit the default MCP response", () => {
    const record = parseTaskRecord({ objective: "o".repeat(500), next: "n".repeat(400), plan: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, step: "s".repeat(200) })) });
    const bytes = resumeEnvelopeBytes(meta(record));
    expect(bytes).toBeLessThanOrEqual(RESUME_ENVELOPE_BYTES);
    const result = { content: [{ type: "text", text: JSON.stringify(meta(record)) }] };
    expect(boundMcpResult("resume_task", {}, result, DEFAULT_CONTEXT_BYTES)).toBe(result);
  });

  test("a small client budget gets an explicit control response, never a cut record", () => {
    const record = parseTaskRecord({ objective: "o".repeat(500), next: "n".repeat(400) });
    const result = { content: [{ type: "text", text: JSON.stringify(meta(record)) }] };
    const bounded = boundMcpResult("resume_task", {}, result, 1024);
    expect(bounded.isError).toBe(true);
    const body = JSON.parse(bounded.content[0].text);
    expect(body.code).toBe("context_too_small");
    expect(body.taskId).toBe(`task_${"1".repeat(32)}`);
    expect(mcpResultBytes(bounded)).toBeLessThanOrEqual(1024);
  });

  test("find_tasks drops whole candidates to fit", () => {
    const task = (i: number) => ({ id: `task_${String(i).padStart(32, "0")}`, title: "t".repeat(120), status: "open", lineages: [{ lineage: "main", next: "n".repeat(160) }] });
    const result = { content: [{ type: "text", text: JSON.stringify({ tasks: Array.from({ length: 30 }, (_, i) => task(i)), more: false, ambiguous: true }) }] };
    const bounded = boundMcpResult("find_tasks", {}, result, 1024);
    const body = JSON.parse(bounded.content[0].text);
    expect(body.tasks.length).toBeGreaterThan(0);
    expect(body.tasks.length).toBeLessThan(30);
    expect(body.more).toBe(true);
    expect(mcpResultBytes(bounded)).toBeLessThanOrEqual(1024);
  });
});

describe("authorization", () => {
  test("read-only and wrong-scope credentials cannot save", () => {
    expect(error(() => continuationActor(normalizeToken({ name: "r", orgId: 1, canWrite: false } as any), true)).code).toBe("write_denied");
    expect(error(() => continuationActor(normalizeToken({ name: "o", orgId: 1, kind: "oauth", scopes: ["memory:read"] } as any), true)).code).toBe("write_denied");
    expect(continuationActor(normalizeToken({ name: "o", orgId: 1, kind: "oauth", scopes: ["memory:read"] } as any), false).name).toBe("o");
  });
});
