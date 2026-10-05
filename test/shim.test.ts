import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const shim = require("../shim/index.js");

const cacheRoot = mkdtempSync(path.join(tmpdir(), "engram-shim-test-"));
afterAll(() => rmSync(cacheRoot, { recursive: true, force: true }));

beforeEach(() => {
  process.env.XDG_CACHE_HOME = cacheRoot;
});

const HOST = "https://engram-test.us-central1.run.app";

describe("retry classification", () => {
  // Retrying a write that the gateway already applied would duplicate a remember
  // entry, so only the two safe cases retry: an idempotent call, and a status the
  // Cloud Run frontend produces when it never routed the request at all.
  test("a lost response retries only for idempotent calls", () => {
    const err = new Error("fetch failed");
    expect(shim.shouldRetry(null, err, true)).toBe(true);
    expect(shim.shouldRetry(null, err, false)).toBe(false);
    expect(shim.shouldRetry(null, err, undefined)).toBe(false);
  });

  test("frontend statuses retry even for writes", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(shim.shouldRetry(status, null, false)).toBe(true);
    }
  });

  test("statuses the gateway itself produces never retry", () => {
    // 401 and 400 come from engram, and a 500 means the request was handled.
    for (const status of [400, 401, 403, 404, 500]) {
      expect(shim.shouldRetry(status, null, true)).toBe(false);
    }
  });
});

describe("tool cache", () => {
  const tools = [
    { name: "recall", description: "Search shared memory.", inputSchema: { type: "object" } },
  ];

  test("round trips through a path derived from the host", () => {
    expect(shim.writeToolCache(HOST, tools)).toBe(true);
    expect(shim.toolCachePath(HOST)).toContain("engram-test.us-central1.run.app");
    expect(shim.readToolCache(HOST)).toEqual(tools);
  });

  test("keys separate hosts apart", () => {
    expect(shim.toolCachePath("https://a.example.com"))
      .not.toBe(shim.toolCachePath("https://b.example.com"));
    // A host must never produce a path that escapes the cache directory.
    expect(shim.cacheKeyForHost("https://evil/../../etc")).not.toContain("/");
  });

  test("a missing, corrupt or empty cache reads as a miss rather than throwing", () => {
    expect(shim.readToolCache("https://never-written.example.com")).toBeNull();

    const corrupt = shim.toolCachePath("https://corrupt.example.com");
    mkdirSync(path.dirname(corrupt), { recursive: true });
    writeFileSync(corrupt, "{not json");
    expect(shim.readToolCache("https://corrupt.example.com")).toBeNull();

    shim.writeToolCache("https://empty.example.com", []);
    // An empty list is a miss too: serving it would advertise a server with no
    // tools, which is worse than taking the slow path.
    expect(shim.readToolCache("https://empty.example.com")).toBeNull();
  });

  test("an unwritable cache directory fails soft", () => {
    process.env.XDG_CACHE_HOME = "/proc/nonexistent-engram";
    expect(shim.writeToolCache(HOST, tools)).toBe(false);
    expect(shim.readToolCache(HOST)).toBeNull();
  });
});

describe("tool normalization", () => {
  test("fills the fields a cached entry must always carry", () => {
    expect(shim.normalizeTools({ tools: [{ name: "whoami" }] })).toEqual([
      { name: "whoami", description: "", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(shim.normalizeTools({})).toEqual([]);
    expect(shim.normalizeTools(null)).toEqual([]);
  });
});

describe("connect-time cache seeding", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const target = { host: "https://seed.example.com", token: "eng_x" };

  test("writes the cache from a live tools/list", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { tools: [{ name: "recall" }, { name: "remember" }] } }),
    })) as any;

    expect(await shim.seedToolCache(target)).toBe(true);
    expect(shim.readToolCache(target.host).map((t: any) => t.name)).toEqual(["recall", "remember"]);
  });

  test("a server that cannot be reached is reported, not thrown", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as any;

    // connect has already written the harness config by this point, so a failure
    // here must not look like a failed connect.
    expect(await shim.seedToolCache({ host: "https://unreachable.example.com", token: "t" }))
      .toBe(false);
    expect(shim.readToolCache("https://unreachable.example.com")).toBeNull();
  });

  test("an empty tool list is refused rather than cached", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { tools: [] } }),
    })) as any;

    expect(await shim.seedToolCache({ host: "https://empty-seed.example.com", token: "t" }))
      .toBe(false);
  });

  test("nothing to seed without a resolved target", async () => {
    expect(await shim.seedToolCache(null)).toBe(false);
    expect(await shim.seedToolCache({ host: "https://x.example.com" })).toBe(false);
  });
});

const capture = require("../shim/capture.js");

describe("capture hooks and sweep", () => {
  const root = mkdtempSync(path.join(tmpdir(), "engram-capture-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("hook installers write valid config and back up the old file", () => {
    const home = path.join(root, "home");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "settings.json"), `${JSON.stringify({ model: "keep-me" }, null, 2)}\n`);
    const file = capture.installHooks("claude", { host: "https://engram.example", token: "eng_test" });
    const written = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    expect(written.model).toBe("keep-me");
    expect(JSON.stringify(written.hooks)).toContain("capture --hook claude");
    expect(require("node:fs").existsSync(`${file}.engram-backup`)).toBe(true);
    process.env.HOME = prevHome;
  });

  test("redaction and never-capture run before upload", () => {
    expect(capture.redactSecrets("Bearer eng_supersecrettokenvalue123")).toContain("REDACTED");
    expect(capture.shouldCapture(
      { repo: "github.com/ani-hq/secrets", cwd: "/tmp/secrets" },
      { neverRepos: ["ani-hq/secrets"], neverPaths: [] },
    )).toBe(false);
    expect(capture.shouldCapture(
      { repo: "github.com/ani-hq/engram", cwd: "/tmp/engram" },
      { neverRepos: ["ani-hq/secrets"], neverPaths: [] },
    )).toBe(true);
  });

  test("parsers flatten harness transcripts into turns", () => {
    const claude = capture.parseClaudeTranscript([
      JSON.stringify({ type: "user", sessionId: "s1", cwd: "/tmp", message: { role: "user", content: "hello" }, timestamp: "2026-10-05T00:00:00.000Z" }),
      JSON.stringify({ type: "assistant", sessionId: "s1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    ].join("\n"));
    expect(claude.sessionId).toBe("s1");
    expect(claude.turns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
    const cursor = capture.parseCursorTranscript(JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>share this</user_query>" }] },
    }), "c1");
    expect(cursor.sessionId).toBe("c1");
    expect(cursor.turns[0].text).toBe("share this");
  });

  test("sweep is idempotent when the file has not changed", async () => {
    const prevHome = process.env.HOME;
    const prevCache = process.env.XDG_CACHE_HOME;
    process.env.HOME = path.join(root, "empty-home");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    mkdirSync(process.env.HOME, { recursive: true });
    const first = await capture.sweep();
    const second = await capture.sweep();
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    process.env.HOME = prevHome;
    process.env.XDG_CACHE_HOME = prevCache;
  });
});
