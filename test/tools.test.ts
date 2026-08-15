import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { isPathTokenAllowed } = await import("../gateway/src/tools/pathtoken");
const { secretIdFor } = await import("../gateway/src/tools/secrets");

describe("secret name mapping", () => {
  test("uses the engram scope/name convention", () => {
    expect(secretIdFor("shared", "OPENAI_API_KEY")).toBe("engram--shared--OPENAI_API_KEY");
    expect(secretIdFor("product:beacon", "DATABASE_URL")).toBe("engram--product-beacon--DATABASE_URL");
    expect(secretIdFor("team:ai:research", "TOKEN")).toBe("engram--team-ai-research--TOKEN");
  });
});

describe("path-token classification", () => {
  test("allows read-only non-secret tokens", () => {
    expect(isPathTokenAllowed({
      name: "reader",
      scopes: { shared: "r", "product:beacon": "r" },
      secrets: false,
    })).toBe(true);
  });

  test("rejects tokens with any write scope", () => {
    expect(isPathTokenAllowed({
      name: "writer",
      scopes: { shared: "r", private: "rw" },
      secrets: false,
    })).toBe(false);
  });

  test("rejects tokens with secrets access", () => {
    expect(isPathTokenAllowed({
      name: "secret-reader",
      scopes: { shared: "r" },
      secrets: true,
    })).toBe(false);
  });
});
