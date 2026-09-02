import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { authenticate, sha256 } = await import("../gateway/src/auth");

describe("auth token identity", () => {
  test("hashes bearer tokens with sha256", () => {
    expect(sha256("engram")).toBe("450dcf23e621ff10542114dd8f622660cc8b96bdb2abb02af641e69f94c7b2da");
  });

  test("missing bearer auth returns null without a lookup", async () => {
    expect(await authenticate(null)).toBeNull();
    expect(await authenticate("Basic abc")).toBeNull();
  });
});
