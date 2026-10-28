import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { KINDS, applyToPage, readChangelog, renderChangelog } from "../scripts/changelog";

const page = () => readFileSync(new URL("../web/changelog.html", import.meta.url), "utf8");

test("changelog entries are complete, unique and dated in UTC", () => {
  const { entries } = readChangelog();
  expect(entries.length).toBeGreaterThan(0);
  expect(new Set(entries.map(entry => entry.sha)).size).toBe(entries.length);
  for (const entry of entries) {
    expect(entry.sha).toMatch(/^[0-9a-f]{7,12}$/);
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    expect(Object.keys(KINDS)).toContain(entry.kind);
    expect(entry.title.trim().length).toBeGreaterThan(0);
    expect(entry.summary.trim().length).toBeGreaterThan(0);
    if (entry.pr !== undefined) expect(Number.isInteger(entry.pr)).toBe(true);
  }
});

test("the published page matches the changelog data", () => {
  const html = page();
  expect(applyToPage(html, renderChangelog(readChangelog()))).toBe(html);
  expect((html.match(/class="ds-release-entry"/g) ?? []).length).toBe(readChangelog().entries.length);
});

test("entries render newest first and escape their text", () => {
  const { body } = renderChangelog({ repository: "https://example.com/r", entries: [
    { sha: "aaaaaaa", at: "2026-09-01T10:00:00Z", kind: "fixed", title: "Old <b>", summary: "Uses `tool`" },
    { sha: "bbbbbbb", at: "2026-10-02T03:04:00Z", kind: "new", title: "New", summary: "Later", pr: 9 },
  ] });
  expect(body.indexOf("bbbbbbb")).toBeLessThan(body.indexOf("aaaaaaa"));
  expect(body).toContain("Old &lt;b&gt;");
  expect(body).toContain("<code>tool</code>");
  expect(body).toContain('datetime="2026-10-02T03:04:00Z">2 Oct 2026<span>03:04 UTC</span>');
  expect(body).toContain('href="https://example.com/r/pull/9"');
  expect(body).toContain('href="https://example.com/r/commit/bbbbbbb">Commit bbbbbbb</a>');
});

test("entry kinds are plain text, never tags", () => {
  const { body } = renderChangelog({ repository: "https://example.com/r", entries: [
    { sha: "ccccccc", at: "2026-10-03T00:00:00Z", kind: "fixed", title: "A fix", summary: "Fixed it" },
  ] });
  expect(body).toContain('<p class="ds-release-kind">Fixed</p>');
  expect(body).not.toMatch(/ds-badge|data-tone/);
  expect(page()).not.toMatch(/ds-badge|data-tone/);
});
