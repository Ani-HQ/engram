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
