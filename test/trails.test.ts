import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const {
  capTranscript,
  normalizeRepo,
  redactSecrets,
  repoPageSlug,
  TRANSCRIPT_CHAR_CAP,
} = await import("../gateway/src/redact");
const {
  digestSlug,
  extractFiles,
  extractTurns,
  heuristicDigest,
  parseHarness,
  parseTrailIngest,
  trailId,
} = await import("../gateway/src/trails");

describe("redaction and caps", () => {
  test("redacts keys, tokens, connection strings, and env lines", () => {
    const raw = [
      "Authorization: Bearer eng_supersecrettokenvalue123",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
      "postgres://user:pass@localhost:5432/db",
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain("eng_supersecrettokenvalue123");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("postgres://user:pass");
    expect(redacted).toContain("REDACTED");
  });

  test("caps an oversized transcript at both ends", () => {
    const text = "a".repeat(TRANSCRIPT_CHAR_CAP + 400);
    const capped = capTranscript(text);
    expect(capped.length).toBeLessThan(text.length);
    expect(capped).toContain("omitted");
    expect(capped.startsWith("aaa")).toBe(true);
    expect(capped.endsWith("aaa")).toBe(true);
  });

  test("normalizes git remotes", () => {
    expect(normalizeRepo("git@github.com:Ani-HQ/engram.git")).toBe("github.com/ani-hq/engram");
    expect(normalizeRepo("https://github.com/Ani-HQ/engram.git")).toBe("github.com/ani-hq/engram");
    expect(repoPageSlug("git@github.com:Ani-HQ/engram.git")).toBe("ani-hq/engram");
    expect(repoPageSlug(null)).toBe("local");
  });
});

describe("trail ingest helpers", () => {
  test("upsert identity is stable for the same harness and session", () => {
    expect(trailId("cursor", "abc")).toBe(trailId("cursor", "abc"));
    expect(trailId("cursor", "abc")).not.toBe(trailId("claude", "abc"));
  });

  test("parses labeled turns and files from a transcript", () => {
    const turns = extractTurns("User: open gateway/src/trails.ts\nAssistant: I will add ingest.");
    expect(turns).toEqual([
      { role: "user", text: "open gateway/src/trails.ts" },
      { role: "assistant", text: "I will add ingest." },
    ]);
    expect(extractFiles("touched gateway/src/trails.ts and shim/capture.js")).toEqual([
      "gateway/src/trails.ts",
      "shim/capture.js",
    ]);
  });

  test("heuristic digest still writes when Jev is down", () => {
    const digest = heuristicDigest({
      repo: "github.com/ani-hq/engram",
      harness: "cursor",
      turns: [
        { role: "user", text: "Share a slice of my memory with the team." },
        { role: "assistant", text: "Use a personal brain and copy by rule." },
      ],
    });
    expect(digest).toContain("github.com/ani-hq/engram");
    expect(digest).toContain("cursor");
    expect(digest).toContain("Share a slice");
  });

  test("rejects a bad ingest body and accepts a complete one", () => {
    expect(parseTrailIngest({})).toBe("harness must be claude, cursor, or codex");
    expect(parseHarness("windsurf")).toBeNull();
    const parsed = parseTrailIngest({
      harness: "cursor",
      session_id: "s1",
      transcript: "User: hello",
      repo: "github.com/ani-hq/engram",
    });
    expect(parsed).toMatchObject({ harness: "cursor", sessionId: "s1" });
    expect(digestSlug({ repo: "github.com/ani-hq/engram", harness: "cursor", sessionId: "s1", at: "2026-10-05T00:00:00Z" }))
      .toMatch(/^trails\/ani-hq\/engram\/2026-10-05-cursor-/);
  });
});
