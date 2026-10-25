import { describe, expect, test } from "bun:test";
import { callSharedContextTool, contextSnapshotPages, isSharedContextSlug, searchContextSnapshots } from "../gateway/src/shared-context-read";
import { redactSecrets } from "../gateway/src/redact";
import { createRequire } from "node:module";
const capture = createRequire(import.meta.url)("../shim/capture.js");

const shareId = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const slug = `shared-context/${shareId}/${id}`;
const pages = contextSnapshotPages([{ id, shareId, title: "Release decision", text: "Approve the October release.\nKeep this exact approved text.", sourceSlug: "personal/payroll", ownerEmail: "owner@example.com" } as any]);
const payload = (result: any) => JSON.parse(result.content[0].text);

describe("approved snapshot read boundary", () => {
  test("projects approved text only, with synthetic identity and no source metadata", () => {
    expect(pages).toEqual([{ slug, title: "Release decision", type: "shared-context", compiled_truth: "Approve the October release.\nKeep this exact approved text." }]);
    expect(contextSnapshotPages([{ id: "../../secret", shareId, title: "Bad", text: "Bad" }])).toEqual([]);
  });
  test("get_page never interprets arbitrary, neighboring, malformed or source slugs", () => {
    expect(payload(callSharedContextTool(pages, "get_page", { slug }))).toEqual(pages[0]);
    for (const attempted of ["personal/payroll", `shared-context/${id}/${id}`, `${slug}/../private`, "shared-context/%2e%2e/private"]) {
      expect(callSharedContextTool(pages, "get_page", { slug: attempted, orgId: 1 }).isError).toBe(true);
    }
    expect(isSharedContextSlug("shared-context/../../private")).toBe(true);
  });
  test("search and recall see only supplied snapshots and respect bounds and query matching", () => {
    expect(searchContextSnapshots(pages, "October release")).toHaveLength(1);
    expect(searchContextSnapshots(pages, "payroll")).toEqual([]);
    expect(payload(callSharedContextTool(pages, "recall", { query: "release", full: true })).full).toEqual({ slug, body: pages[0].compiled_truth });
    expect(payload(callSharedContextTool([], "recall", { query: "release", full: true }))).toEqual({ results: [], full: null });
    expect(callSharedContextTool(pages, "search", { query: " " }).isError).toBe(true);
    expect(payload(callSharedContextTool(pages, "list_pages", { offset: 1 }))).toEqual([]);
    expect(payload(callSharedContextTool(pages, "list_pages", { tag: "private" }))).toEqual([]);
    const longPages = contextSnapshotPages([{ id, shareId, title: "Long", text: `${"before ".repeat(100)}release ${"after ".repeat(100)}` }]);
    expect(searchContextSnapshots(longPages, "release")[0].chunk_text.length).toBeLessThanOrEqual(280);
    expect(searchContextSnapshots(longPages, "release")[0].chunk_text).toContain("release");
  });
  test("writes, history, export and unrelated tools are denied", () => {
    for (const name of ["remember", "put_page", "delete_page", "record_action", "list_actions", "export", "list_resources", "add_link"]) {
      expect(callSharedContextTool(pages, name, { slug, text: "overwrite" }).isError).toBe(true);
    }
    expect(payload(callSharedContextTool(pages, "whoami"))).toEqual({ access: "approved-context", readOnly: true });
  });
  test("gateway and capture redaction remove snapshot credentials wherever mentioned", () => {
    for (const end of ["A", "-", "_"]) {
      const token = `egs_${"a".repeat(31)}${end}`;
      for (const redact of [redactSecrets, capture.redactSecrets]) {
        expect(redact(`Credential: ${token}.`)).toBe("Credential: REDACTED_TOKEN.");
        expect(redact(`https://example.test/?key=${token}`)).not.toContain(token);
        expect(redact(JSON.stringify({ note: token }))).not.toContain(token);
      }
    }
  });
});
