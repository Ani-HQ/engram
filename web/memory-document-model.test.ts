import { describe, expect, test } from "bun:test";
import { memoryDocument, sourceExcerpt } from "./memory-document-model.js";

const page = (body: string, title = "Launch plan", slug = "project/launch-plan") => ({ title, slug, body });
const reconstruct = (model: ReturnType<typeof memoryDocument>) => model.sections.map(section => section.source).join("");

describe("conservative memory documents", () => {
  test("recognizes screenshot-like journal entries without removing dates from their actual content", () => {
    const entries = Array.from({ length: 8 }, (_, index) => `- 2026-10-21T05:07:${String(index).padStart(2, "0")}.417Z — 2026-10-21: public /venues pages should render item ${index}.`);
    const body = `# Launch plan\n\nSaved decisions.\n\n${entries.join("\n")}\n\nKeep these notes for the next release.\n`;
    const model = memoryDocument(page(body));
    expect(model.isJournal).toBe(true);
    expect(model.entries).toHaveLength(8);
    expect(model.entries.map(entry => entry.order)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(model.entries.every(entry => entry.text.startsWith("2026-10-21: public /venues"))).toBe(true);
    expect(model.intro).toContain("Saved decisions.");
    expect(model.outro).toContain("Keep these notes for the next release.");
    expect(model.source).toBe(body);
    expect(model.body).toBe(body);
    expect(reconstruct(model)).toBe(model.document);
    expect(model.removedHeading?.source + model.document).toBe(body);
  });

  test("removes only a complete duplicate leading heading and preserves a meaningful remainder", () => {
    expect(memoryDocument(page("# Launch plan\n\nContent.")).document).toBe("\nContent.");
    expect(memoryDocument(page("## launch-plan ##\nContent.", "Different title")).duplicateHeadingRemoved).toBe(true);
    expect(memoryDocument(page("Launch plan\n===========\nContent.")).document).toBe("Content.");
    for (const body of ["# Launch plan — decisions\nBody", "# Launch plan and more\nBody", "Intro\n# Launch plan\nBody", "# **Launch plan**\nBody", "```md\n# Launch plan\n```", "# Other document\nBody"]) {
      const model = memoryDocument(page(body)); expect(model.document).toBe(body); expect(model.duplicateHeadingRemoved).toBe(false);
    }
    const blank = memoryDocument(page("\r\n# Launch plan\r\n\r\nContent.\r\n"));
    expect(blank.document).toBe("\r\n\r\nContent.\r\n");
    expect(blank.source).toBe("\r\n# Launch plan\r\n\r\nContent.\r\n");
  });

  test("preserves multiline, lazy and nested fenced continuations without reading code as journal entries", () => {
    const body = "Intro\n\n- 2026-10-22: First line\n  Indented continuation.\nLazy continuation.\n\n  Another paragraph.\n  ```md\n- 2026-10-30 — code example only\n  ```\n- 2026-10-23 — Second entry.\n\nOutro paragraph.\n\n```md\n- 2026-10-29 — outside code only\n```\n";
    const model = memoryDocument(page(body));
    expect(model.isJournal).toBe(true);
    expect(model.entries).toHaveLength(2);
    expect(model.entries[1].text).toBe("First line\n  Indented continuation.\nLazy continuation.\n\n  Another paragraph.\n  ```md\n- 2026-10-30 — code example only\n  ```\n");
    expect(model.outro).toContain("Outro paragraph.");
    expect(model.outro).toContain("- 2026-10-29");
    expect(reconstruct(model)).toBe(body);
  });

  test("fenced code, nested bullets, frontmatter and date mentions remain ordinary documents", () => {
    for (const body of [
      "```md\n- 2026-10-21 — code\n```", "~~~~text\n- 2026-10-21 — code\n~~~\n~~~~", "    ```\n- 2026-10-21 — code\n    ```",
      "  - 2026-10-21 — nested bullet", "Paragraph 2026-10-21 — context", "## 2026-10-21\nA heading date.",
      "---\ntitle: Launch plan\n- 2026-10-21 — YAML data\n---\nNormal content.", "---\n- 2026-10-21 — unclosed frontmatter",
    ]) { const model = memoryDocument(page(body)); expect(model.isJournal).toBe(false); expect(model.document).toBe(body); expect(model.source).toBe(body); }
  });

  test("rejects impossible or ambiguous timestamps instead of accepting Date normalization", () => {
    for (const timestamp of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-01-00", "2026-04-31", "1900-02-29", "2026-10-21T24:00:00Z", "2026-10-21T09:60:00Z", "2026-10-21T09:00:60Z", "2026-10-21T09:00:00", "2026-10-21T09:00:00+24:00", "2026-10-21T09:00:00+05:60", "2026-10-21oops", "2026-10-21Tnope"]) {
      const body = `- ${timestamp} — Keep this as source.`;
      const model = memoryDocument(page(body)); expect(model.isJournal).toBe(false); expect(model.document).toBe(body);
    }
    for (const timestamp of ["2024-02-29", "2000-02-29", "2026-10-21T09:42:20.417Z", "2026-10-21T09:42:20+05:30"]) expect(memoryDocument(page(`- ${timestamp}: Valid note.`)).isJournal).toBe(true);
  });

  test("keeps mixed lists and separate journal blocks in ordinary document mode without content loss", () => {
    for (const body of [
      "- Ordinary item\n- 2026-10-21 — Date item\n", "- 2026-10-21 — Date item\n- Ordinary item\n",
      "- 2026-10-21 — First\n- 2026-02-30 — Invalid date\n- 2026-10-22 — Last\n",
      "- 2026-10-21 — First\n\nAn unrelated section.\n\n- 2026-10-22 — Second\n",
      "1. Ordered item\n\n- 2026-10-21 — Date item\n", "- 2026-10-21 — Date item\n\n* Ordinary list\n",
    ]) { const model = memoryDocument(page(body)); expect(model.isJournal).toBe(false); expect(model.entries).toEqual([]); expect(reconstruct(model)).toBe(body); }
  });

  test("sorts canonical instants latest first with original ordering for ties", () => {
    const body = "- 2026-10-21T09:00:00Z — A\n- 2026-10-21T14:30:00+05:30 — B\n- 2026-10-22: C\n- 2026-10-20 - D\n";
    const model = memoryDocument(page(body));
    expect(model.entries.map(entry => entry.order)).toEqual([2, 0, 1, 3]);
    expect(model.entries[1].at).toBe(model.entries[2].at);
    expect(model.sections.filter(section => section.kind === "entry").map(section => section.order)).toEqual([0, 1, 2, 3]);
    expect(reconstruct(model)).toBe(body);
    const precise = memoryDocument(page("- 2026-10-21T09:00:00.123000001Z — Earlier\n- 2026-10-21T09:00:00.123000002Z — Later\n- 2026-10-21T09:00:00.123000002Z — Same instant\n"));
    expect(precise.entries.map(entry => entry.order)).toEqual([1, 2, 0]);
  });

  test("preserves CRLF, whitespace, Markdown, URLs and raw text exactly without HTML construction", () => {
    const body = "  Intro with [link](https://example.com).\r\n\r\n- 2026-10-21 — <img src=x onerror=alert(1)> **exact**  \r\n  `code` &amp; [[memory]]\r\n\r\nOutro | table |\r\n";
    const model = memoryDocument(page(body));
    expect(model.entries[0].text).toBe("<img src=x onerror=alert(1)> **exact**  \r\n  `code` &amp; [[memory]]\r\n");
    expect(model.source).toBe(body); expect(reconstruct(model)).toBe(body);
    const input = page(body); memoryDocument(input); expect(input.body).toBe(body);
    expect(memoryDocument(null).source).toBe(""); expect(memoryDocument({ body: 123 }).source).toBe("");
  });

  test("returns only bounded exact source excerpts, never guessed summaries or decoded markup", () => {
    const text = "<script>alert(1)</script>\n**Recorded** 🔒 details";
    expect(sourceExcerpt(text, 8)).toBe("<script>");
    expect(sourceExcerpt("🔒".repeat(200))).toBe("🔒".repeat(180));
    expect(sourceExcerpt(text, 0)).toBe(""); expect(sourceExcerpt(text, -1)).toBe("");
    expect(sourceExcerpt(text, Number.NaN)).toBe(text); expect(sourceExcerpt(null)).toBe("");
    expect(sourceExcerpt("x".repeat(5000), 9000)).toHaveLength(2000);
  });
});
