import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { capShareLevel, parseShareLevel } = await import("../gateway/src/policies");
const { slugForRemember } = await import("../gateway/src/proxy");
const {
  itemFromEntry,
  itemFromTrail,
  parseShareMatch,
  ruleMatches,
} = await import("../gateway/src/sharing");

const trail = itemFromTrail({
  id: "t1",
  harness: "cursor",
  sessionId: "s1",
  repo: "github.com/ani-hq/engram",
  cwd: "/tmp/engram",
  branch: "growth/memory-slices",
  authorEmail: "ada@example.com",
  startedAt: "2026-10-01T00:00:00.000Z",
  endedAt: "2026-10-05T00:00:00.000Z",
  transcript: "secret",
  digest: "worked on engram",
  digestSlug: "trails/ani-hq/engram/2026-10-05-cursor-aaaa",
});

const entry = itemFromEntry({
  id: "e1",
  fingerprint: "f",
  slug: "projects/engram",
  archiveSlug: null,
  recordedAt: "2026-10-04T00:00:00.000Z",
  tokenName: "cursor",
  rawText: "Ship slices from a personal brain.",
  topicHint: "engram",
  status: "active",
  repo: "github.com/ani-hq/engram",
  harness: "cursor",
  sessionId: "s1",
});

describe("share rule matching", () => {
  test("an empty match copies everything", () => {
    const match = parseShareMatch({});
    expect(ruleMatches(match, trail)).toBe(true);
    expect(ruleMatches(match, entry)).toBe(true);
  });

  test("matches by repo, topic, harness, and date", () => {
    expect(ruleMatches(parseShareMatch({ repos: ["ani-hq/engram"] }), trail)).toBe(true);
    expect(ruleMatches(parseShareMatch({ repos: ["other/repo"] }), trail)).toBe(false);
    expect(ruleMatches(parseShareMatch({ harnesses: ["cursor"] }), trail)).toBe(true);
    expect(ruleMatches(parseShareMatch({ harnesses: ["claude"] }), trail)).toBe(false);
    expect(ruleMatches(parseShareMatch({ topics: ["engram"] }), entry)).toBe(true);
    expect(ruleMatches(parseShareMatch({ topics: ["billing"] }), entry)).toBe(false);
    expect(ruleMatches(parseShareMatch({ since: "2026-10-03T00:00:00.000Z" }), trail)).toBe(true);
    expect(ruleMatches(parseShareMatch({ until: "2026-10-02T00:00:00.000Z" }), trail)).toBe(false);
  });

  test("a one-off trail id does not leak other conversations", () => {
    const match = parseShareMatch({ trailIds: ["t1"] });
    expect(ruleMatches(match, trail)).toBe(true);
    expect(ruleMatches(match, { ...trail, id: "t2" })).toBe(false);
    expect(ruleMatches(match, entry)).toBe(false);
  });

  test("an excluded trail stays out of a standing rule", () => {
    const match = parseShareMatch({ repos: ["ani-hq/engram"], excludeTrailIds: ["t1"] });
    expect(ruleMatches(match, trail)).toBe(false);
    expect(ruleMatches(match, { ...trail, id: "t2" })).toBe(true);
  });
});

describe("shared entry pages", () => {
  test("a shared entry lands on its own page so unshare cannot delete a team topic", () => {
    expect(slugForRemember("Ship slices from a personal brain.", `shared/${entry.id}`))
      .toBe(`shared/${entry.id}`);
    expect(slugForRemember("Ship slices from a personal brain.", "engram"))
      .toBe("projects/engram");
  });
});

describe("share level cap", () => {
  test("the team cap wins", () => {
    expect(parseShareLevel("digest_transcript")).toBe("digest_transcript");
    expect(parseShareLevel("nope")).toBe("digest");
    expect(capShareLevel("transcript", "digest")).toBe("digest");
    expect(capShareLevel("digest", "transcript")).toBe("digest");
  });
});
