import { describe, expect, test } from "bun:test";
import {
  canonicalTopicSlug,
  entryFingerprint,
  idFromFingerprint,
  parsePageEntries,
  parseRememberBullet,
} from "../gateway/src/memory-entries";
import { deriveClusters } from "../gateway/src/dream/cluster";
import { nightKey } from "../gateway/src/dream/lock";
import { splitForRoll, splitTopicEntries } from "../gateway/src/topic-page";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

describe("memory entry identity", () => {
  test("fingerprints ignore archive suffix and extra whitespace", () => {
    const a = entryFingerprint("projects/engram", "2026-09-21T00:00:00.000Z", "Chose Voyage embeddings.");
    const b = entryFingerprint("projects/engram-archive", "2026-09-21T00:00:00.000Z", "Chose   Voyage embeddings.");
    expect(a).toBe(b);
    expect(canonicalTopicSlug("projects/engram-archive")).toBe("projects/engram");
    expect(idFromFingerprint(a)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("parses remember bullets and standalone pages", () => {
    const bullet = parseRememberBullet("- 2026-09-21T10:00:00.000Z — Use Jev for rerank.");
    expect(bullet.recordedAt).toBe("2026-09-21T10:00:00.000Z");
    expect(bullet.text).toBe("Use Jev for rerank.");
    const page = parsePageEntries("notes/hello", "# Hello\n\nA captured note without bullets.");
    expect(page).toEqual([{
      recordedAt: null,
      text: "A captured note without bullets.",
      raw: "A captured note without bullets.",
    }]);
  });

  test("rollover keeps newest entries and leaves identity in the moved text", () => {
    const body = [
      "# engram",
      "",
      "- 2026-09-01T00:00:00.000Z — " + "old ".repeat(1200),
      "",
      "- 2026-09-21T00:00:00.000Z — newest decision",
    ].join("\n");
    const { entries } = splitTopicEntries(body);
    const { keep, move } = splitForRoll(entries);
    expect(move.length).toBeGreaterThan(0);
    expect(keep.at(-1)?.join("\n")).toContain("newest decision");
    const moved = parseRememberBullet(move[0].join("\n"));
    expect(entryFingerprint("projects/engram", moved.recordedAt, moved.text))
      .toBe(entryFingerprint("projects/engram-archive", moved.recordedAt, moved.text));
  });
});

describe("dream helpers", () => {
  test("nightKey is a calendar date in Asia/Kolkata", () => {
    expect(nightKey(new Date("2026-09-21T20:00:00.000Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("clusters use existing page slugs as labels", () => {
    const clusters = deriveClusters([
      { id: "1", fingerprint: "a", slug: "projects/engram", archiveSlug: null, recordedAt: null, tokenName: null, rawText: "one", topicHint: null, status: "active" },
      { id: "2", fingerprint: "b", slug: "projects/engram", archiveSlug: null, recordedAt: null, tokenName: null, rawText: "two", topicHint: null, status: "active" },
    ]);
    expect(clusters[0]?.title).toBe("engram");
    expect(clusters[0]?.members).toEqual(["projects/engram"]);
  });
});
