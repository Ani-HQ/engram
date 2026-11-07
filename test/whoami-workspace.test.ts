import { describe, expect, test } from "bun:test";
import { whoamiBody } from "../gateway/src/proxy";
import { normalizeToken } from "../gateway/src/policies";

describe("whoami", () => {
  test("names the connection's workspace so agents can tell connections apart", () => {
    const token = normalizeToken({ name: "oauth:abc:claude", orgId: 1, role: "member" });
    expect(whoamiBody(token, { name: "Ani HQ", slug: "ani-hq", kind: "team" }))
      .toEqual({ token: "oauth:abc:claude", workspace: { name: "Ani HQ", slug: "ani-hq", kind: "team" }, role: "member" });
  });
  test("omits the workspace when no request context is present", () => {
    const token = normalizeToken({ name: "agent", orgId: 2, role: "agent" });
    expect(whoamiBody(token)).toEqual({ token: "agent", role: "agent" });
  });
});
