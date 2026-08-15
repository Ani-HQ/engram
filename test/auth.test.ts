import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { canRead, canWrite, readableScopes } = await import("../gateway/src/auth");

describe("auth scope helpers", () => {
  const token = {
    name: "agent",
    scopes: {
      shared: "r",
      private: "rw",
      blocked: "none",
    },
    secrets: false,
  };

  test("canRead accepts r and rw scopes", () => {
    expect(canRead(token, "shared")).toBe(true);
    expect(canRead(token, "private")).toBe(true);
    expect(canRead(token, "blocked")).toBe(false);
    expect(canRead(token, "missing")).toBe(false);
  });

  test("canWrite accepts only rw scopes", () => {
    expect(canWrite(token, "shared")).toBe(false);
    expect(canWrite(token, "private")).toBe(true);
    expect(canWrite(token, "blocked")).toBe(false);
    expect(canWrite(token, "missing")).toBe(false);
  });

  test("readableScopes returns only readable scope names", () => {
    expect(readableScopes(token)).toEqual(["shared", "private"]);
  });
});
