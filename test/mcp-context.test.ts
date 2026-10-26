import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { actionSummary, boundMcpResult, contextMaxBytes, contextReadArguments, mcpResultBytes, MAX_CONTEXT_BYTES, projectRecallPassage } from "../gateway/src/mcp-context";

const result = (value: unknown, meta?: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(meta ? { _meta: meta } : {}) });
const payload = (value: any) => JSON.parse(value.content[0].text);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const page = (body: string) => ({ slug: "projects/continuity", title: "Decisions", compiled_truth: body, content_hash: "e".repeat(64), frontmatter: { title: "Decisions" } });
const action = (index: number, detail = "private detail ".repeat(1400)) => ({ id: `28c680a9-2338-452b-b275-${String(index).padStart(12, "0")}`, agent: "codex", tool: "files.edit", summary: "Updated the import", taskTitle: "Fix imports", status: "completed", evidence: "reported", occurredAt: "2026-10-26T01:00:00.000Z", detail, resource: "file:///somewhere", approach: "Adjusted the imports", outcome: "Checks passed" });

describe("MCP context wire budget", () => {
  test("configuration clamps user ceilings while internal remaining bytes can be smaller", () => {
    expect(contextMaxBytes(undefined)).toBe(4096);
    expect(contextMaxBytes(1)).toBe(1024);
    expect(contextMaxBytes(Infinity)).toBe(4096);
    expect(contextMaxBytes(1e9)).toBe(MAX_CONTEXT_BYTES);
    for (const cap of [128, 256, 512, 1024, 4096, 16384]) expect(mcpResultBytes(boundMcpResult("unknown", {}, result({ huge: "x".repeat(50000) }), cap))).toBeLessThanOrEqual(cap);
  });
  test("small legacy JSON reads stay unchanged and inputs are not mutated", () => {
    for (const [name, value] of [["whoami", { token: "agent" }], ["get_page", page("short")], ["search", [{ slug: "notes/a", chunk_text: "short" }]]] as const) {
      const input = result(value), before = structuredClone(input);
      expect(boundMcpResult(name, {}, input)).toEqual(input);
      expect(input).toEqual(before);
    }
    expect(contextReadArguments({ slug: "a", offset: 0, length: 1, cursor: "cursor", detail: true })).toEqual({ slug: "a" });
  });
  test("caps Unicode and escaped metadata with valid JSON including the entire envelope", () => {
    const input = result({ results: Array.from({ length: 5 }, (_, i) => ({ slug: `notes/${i}`, title: "💚\n\"\\".repeat(20000), snippet: "🧠 decisions\n".repeat(100) })), full: { slug: "notes/0", body: "OLDEST\n" + "💚\n\"\\".repeat(20000) + "NEWEST" } }, { engramContext: { responseBytes: 4096, usedBytes: 1234, estimatedTokens: 1024 } });
    const original = JSON.stringify(input);
    for (const cap of [1024, 4096, 16384]) {
      const output = boundMcpResult("recall", {}, input, cap);
      expect(mcpResultBytes(output)).toBeLessThanOrEqual(cap);
      const decoded = payload(output);
      expect(decoded._context?.truncated || output.isError).toBeTruthy();
      expect(output._meta).toEqual(input._meta);
      expect(JSON.stringify(output)).not.toContain("�");
    }
    expect(JSON.stringify(input)).toBe(original);
  });
  test("head and latest recall context survive shortening", () => {
    const output = boundMcpResult("recall", {}, result({ results: [{ slug: "notes/a", title: "A", snippet: "summary" }], full: { slug: "notes/a", body: "OLDEST\n" + "filler\n".repeat(900) + "NEWEST" } }));
    expect(payload(output).full.body).toContain("OLDEST");
    expect(payload(output).full.body).toContain("NEWEST");
    expect(payload(output).full.partial).toBe(true);
    expect(mcpResultBytes(output)).toBeLessThanOrEqual(4096);
  });
  test("paged bodies reassemble without splitting Unicode and keep both full hashes", () => {
    const body = "a💚\n\"\\z".repeat(1400), input = result(page(body));
    let cursor: string | undefined, restored = "", iterations = 0;
    do {
      const output = boundMcpResult("get_page", cursor ? { cursor } : {}, input, 1024);
      const value = payload(output);
      expect(output.isError).toBeUndefined();
      expect(mcpResultBytes(output)).toBeLessThanOrEqual(1024);
      expect(value.content_hash).toBe("e".repeat(64));
      expect(value.body_hash).toBe(hash(body));
      expect(value._page.offset).toBe(restored.length);
      expect(value._page.total).toBe(body.length);
      expect(value._page.length).toBe(value.compiled_truth.length);
      expect(value._page.unit).toBe("utf16_code_units");
      expect(value.compiled_truth).not.toContain("�");
      restored += value.compiled_truth;
      cursor = value._page.next_cursor ?? undefined;
      if (cursor) { expect(value._page.partial).toBe(true); expect(value._page.warning).toContain("never replace"); }
      expect(++iterations).toBeLessThan(1000);
    } while (cursor);
    expect(restored).toBe(body);
  });
  test("explicit small pages report real offsets and reject changed cursors and split surrogates", () => {
    const input = result(page("abc💚def"));
    const value = payload(boundMcpResult("get_page", { offset: 3, length: 2 }, input));
    expect(value.compiled_truth).toBe("💚");
    expect(value._page).toMatchObject({ offset: 3, length: 2, total: 8, next_offset: 5, partial: true });
    expect(boundMcpResult("get_page", { offset: 4 }, input).isError).toBe(true);
    expect(boundMcpResult("get_page", { cursor: value._page.next_cursor }, result(page("changed"))).isError).toBe(true);
    expect(boundMcpResult("get_page", { cursor: "invented" }, input).isError).toBe(true);
    expect(boundMcpResult("get_page", { length: 0 }, input).isError).toBe(true);
  });
  test("adding usage metadata can recut a fragment without corrupting its cursor or total", () => {
    const body = "💚decisions\n".repeat(2000);
    const initial = boundMcpResult("get_page", { offset: 100 }, result(page(body)), 4096);
    const first = payload(initial);
    const output = boundMcpResult("get_page", { offset: 100 }, { ...initial, _meta: { engramContext: { responseBytes: 4096, repeated: "x".repeat(200) } } }, 2048);
    const cut = payload(output);
    expect(mcpResultBytes(output)).toBeLessThanOrEqual(2048);
    expect(cut._page.offset).toBe(100);
    expect(cut._page.total).toBe(body.length);
    expect(cut.body_hash).toBe(hash(body));
    expect(cut.content_hash).toBe(first.content_hash);
    expect(cut._page.next_cursor).toBe(`v1.${hash(body)}.${100 + cut.compiled_truth.length}`);
  });
  test("huge page and search identifiers cannot escape caps or become misleading truncated slugs", () => {
    const hugeSlug = "x".repeat(20000);
    const output = boundMcpResult("get_page", {}, result({ ...page("body"), slug: hugeSlug, title: "x".repeat(20000) }));
    expect(output.isError).toBe(true);
    expect(mcpResultBytes(output)).toBeLessThanOrEqual(4096);
    const search = boundMcpResult("search", {}, result([{ slug: hugeSlug, title: "x" }]));
    expect(search.isError).toBe(true);
    expect(search.content[0].text).not.toContain(hugeSlug.slice(0, 100));
  });
  test("action summaries always omit detail and keep evidence even when the input fits", () => {
    const output = boundMcpResult("list_actions", {}, result({ actions: [action(1, "tiny secret detail")], more: false, agents: ["other"], tools: ["large facets"] }));
    const value = payload(output);
    expect(value.actions[0]).toEqual(actionSummary(action(1)));
    expect(value.actions[0].detail).toBeUndefined();
    expect(value.actions[0].resource).toBeUndefined();
    expect(value.actions[0].evidence).toBe("reported");
    expect(value.agents).toBeUndefined();
    expect(value._context.summaries).toBe(true);
  });
  test("action detail pages preserve full length and continuing offsets across caps", () => {
    const detail = "💚long detail\n\"\\".repeat(900), input = result({ actions: [action(1, detail)], more: false });
    let offset = 0, restored = "", iterations = 0;
    do {
      const output = boundMcpResult("list_actions", { detail: true, detail_offset: offset }, input, 2048);
      const row = payload(output).actions[0];
      expect(mcpResultBytes(output)).toBeLessThanOrEqual(2048);
      expect(row._detail.total).toBe(detail.length);
      expect(row._detail.offset).toBe(offset);
      expect(row._detail.length).toBe(row.detail.length);
      restored += row.detail;
      offset = row._detail.next_offset;
      expect(++iterations).toBeLessThan(1000);
    } while (offset !== null);
    expect(restored).toBe(detail);
  });
  test("action detail rejects offsets inside surrogate pairs with a bounded validation error", () => {
    for (const cap of [256, 512, 1024, 4096]) {
      const input = result({ actions: [action(1, "🙂x")], more: false }, { engramContext: { remainingBytes: 500 } });
      const output = boundMcpResult("list_actions", { detail: true, detail_offset: 1 }, input, cap);
      expect(output.isError).toBe(true);
      expect(output.content[0].text).toContain("complete Unicode character boundary");
      expect(mcpResultBytes(output)).toBeLessThanOrEqual(cap);
    }
    const valid = payload(boundMcpResult("list_actions", { detail: true, detail_offset: 2 }, result({ actions: [action(1, "🙂x")], more: false })));
    expect(valid.actions[0].detail).toBe("x");
    expect(valid.actions[0]._detail.offset).toBe(2);
  });
  test("extractive citations keep only bounded numeric coordinates and an exact excerpt length", () => {
    const snippet = "🧠".repeat(90), citation = { offset: 1000, length: snippet.length, total: 5000, source_hash: "a".repeat(64) };
    expect(projectRecallPassage({ ...citation, prompt: "untrusted extra" }, snippet)).toEqual(citation);
    for (const changed of [{ offset: -1 }, { offset: 0.1 }, { length: 179 }, { length: 181 }, { total: 1001 }, { total: Number.MAX_SAFE_INTEGER }, { source_hash: "not-a-hash" }, { source_hash: "A".repeat(64) }]) expect(projectRecallPassage({ ...citation, ...changed }, snippet)).toBeNull();
    expect(projectRecallPassage(citation, undefined)).toBeNull();
    const input = result({ results: [{ slug: "projects/cited", title: "long title ".repeat(1000), snippet, recall_passage: { ...citation, untrusted: "x".repeat(20000) } }], full: null });
    const output = boundMcpResult("recall", {}, input, 2048), row = payload(output).results[0];
    expect(mcpResultBytes(output)).toBeLessThanOrEqual(2048);
    expect(row.recall_passage).toEqual(citation);
    expect(row.snippet).toBe(snippet);
    expect(row.recall_passage.length).toBe(row.snippet.length);
    const invalid = boundMcpResult("recall", {}, result({ results: [{ slug: "projects/cited", title: "x".repeat(10000), snippet, recall_passage: { ...citation, source_hash: "injected" } }], full: null }), 2048);
    expect(payload(invalid).results[0].recall_passage).toBeUndefined();
  });
  test("row limits include metadata and expose truthful pagination", () => {
    const output = boundMcpResult("list_actions", { offset: 20 }, result({ actions: Array.from({ length: 100 }, (_, i) => ({ ...action(i), summary: "💚".repeat(300) })), more: false }), 2048);
    const value = payload(output);
    expect(value.actions.length).toBeGreaterThan(0);
    expect(value.actions.length).toBeLessThan(100);
    expect(value.more).toBe(true);
    expect(value.next_offset).toBe(20 + value.actions.length);
    expect(mcpResultBytes(output)).toBeLessThanOrEqual(2048);
  });
  test("confirmed writes return tiny receipts and failed writes never become successes", () => {
    const report = payload(boundMcpResult("record_action", {}, result({ action: action(1) })));
    expect(report).toEqual({ ok: true, id: action(1).id, status: "completed", evidence: "reported" });
    for (const name of ["put_page", "add_tag", "add_link", "add_timeline_entry"]) {
      const output = boundMcpResult(name, {}, result({ slug: "notes/a", content_hash: "a".repeat(64), compiled_truth: "x".repeat(20000) }));
      expect(payload(output)).toEqual({ ok: true, slug: "notes/a", content_hash: "a".repeat(64) });
      expect(mcpResultBytes(output)).toBeLessThan(300);
      const error = { content: [{ type: "text", text: "stale CAS hash" }], isError: true };
      expect(boundMcpResult(name, {}, error)).toEqual(error);
    }
  });
  test("nontext content and adversarial metadata still cannot exceed the ceiling", () => {
    for (const input of [{ content: [{ type: "image", data: "x".repeat(50000) }] }, { content: [{ type: "text", text: "x".repeat(50000) }], _meta: { hostile: "x".repeat(50000) } }]) {
      const output = boundMcpResult("get_page", {}, input, 1024);
      expect(mcpResultBytes(output)).toBeLessThanOrEqual(1024);
      expect(output.isError).toBe(true);
    }
  });
});
