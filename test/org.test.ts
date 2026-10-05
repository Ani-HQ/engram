import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { onboardingStep, slugFromName } = await import("../gateway/src/orgs");
const {
  canApproveReview,
  canDelete,
  canUseTool,
  canWrite,
  capShareLevel,
  normalizeToken,
  parsePolicies,
} = await import("../gateway/src/policies");
const { verifyJwt } = await import("../gateway/src/oauth");

const policies = parsePolicies({});

describe("org helpers", () => {
  test("slugs a name and keeps the onboarding order", () => {
    expect(slugFromName("Ani HQ")).toBe("ani-hq");
    expect(onboardingStep({ hasToken: false, hasPage: false })).toBe("connect");
    expect(onboardingStep({ hasToken: true, hasPage: false })).toBe("remember");
    expect(onboardingStep({ hasToken: true, hasPage: true })).toBe("invite");
    expect(onboardingStep({ hasToken: true, hasPage: true, kind: "personal" })).toBe("done");
  });
});

describe("org policies", () => {
  const owner = normalizeToken({ name: "ada", role: "owner" });
  const member = normalizeToken({ name: "grace", role: "member" });
  const writer = normalizeToken({ name: "cursor", role: "agent", canWrite: true });
  const reader = normalizeToken({ name: "cursor", role: "agent", canWrite: false });

  test("agents write only when the token and the org both allow it", () => {
    expect(canWrite(writer, policies)).toBe(true);
    expect(canWrite(reader, policies)).toBe(false);
    expect(canWrite(writer, parsePolicies({ agentsMayWrite: false }))).toBe(false);
    expect(canWrite(member, parsePolicies({ agentsMayWrite: false }))).toBe(true);
  });

  test("agents cannot delete while members can, and review follows the switch", () => {
    expect(canDelete(writer, policies)).toBe(false);
    expect(canDelete(member, policies)).toBe(true);
    expect(canApproveReview(member, policies)).toBe(true);
    expect(canApproveReview(member, parsePolicies({ reviewApprovers: "owners" }))).toBe(false);
    expect(canApproveReview(owner, parsePolicies({ reviewApprovers: "owners" }))).toBe(true);
    expect(canUseTool(reader, "put_page", policies)).toBe(false);
    expect(canUseTool(reader, "search", policies)).toBe(true);
  });

  test("share level is capped by the team, never raised", () => {
    expect(parsePolicies({}).acceptShares).toBe(true);
    expect(parsePolicies({}).maxShareLevel).toBe("digest");
    expect(parsePolicies({ acceptShares: false, maxShareLevel: "transcript" }).maxShareLevel).toBe("transcript");
    expect(capShareLevel("transcript", "digest")).toBe("digest");
    expect(capShareLevel("digest", "transcript")).toBe("digest");
    expect(capShareLevel("digest_transcript", "transcript")).toBe("digest_transcript");
  });
});

describe("oauth resource token", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const keys = [{ kid: "test", n: jwk.n, e: jwk.e }];

  function sign(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const input = `${header}.${body}`;
    const signature = createSign("RSA-SHA256").update(input).end().sign(privateKey).toString("base64url");
    return `${input}.${signature}`;
  }

  test("accepts an audience-bound token and rejects the wrong audience", async () => {
    const now = 1_800_000_000;
    const good = sign({
      iss: "https://as.example",
      aud: "https://engram.example/mcp",
      exp: now + 60,
      sub: "user-1",
    });
    const claims = await verifyJwt(good, {
      issuer: "https://as.example",
      audience: "https://engram.example/mcp",
      jwks: keys,
      now,
    });
    expect(claims?.sub).toBe("user-1");

    const wrong = sign({
      iss: "https://as.example",
      aud: "https://other.example/mcp",
      exp: now + 60,
      sub: "user-1",
    });
    expect(await verifyJwt(wrong, {
      issuer: "https://as.example",
      audience: "https://engram.example/mcp",
      jwks: keys,
      now,
    })).toBeNull();
  });
});
