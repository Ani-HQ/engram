import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type postgres from "postgres";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { ANI_HQ_ORG, onboardingStep, slugFromName } = await import("../gateway/src/orgs");
const { onboardingState, ownsShareRule } = await import("../gateway/src/org-api");
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
    const checks = { agentConnected: false, memorySaved: false, memoryRecalled: false };
    expect(onboardingStep({ checks, hasToken: true, hasPage: true })).toBe("connect");
    expect(onboardingStep({ checks: { ...checks, agentConnected: true } })).toBe("remember");
    expect(onboardingStep({ checks: { ...checks, agentConnected: true, memorySaved: true } })).toBe("recall");
    for (const kind of ["team", "personal"] as const) {
      expect(onboardingStep({ checks: { agentConnected: true, memorySaved: true, memoryRecalled: true }, kind })).toBe("done");
    }
  });
  test("pending storage returns an explicit provisioning state with no invented proof", async () => {
    expect(await onboardingState({ ...ANI_HQ_ORG, provisioningStatus: "pending" })).toEqual({
      step: "provisioning", provisioning: true, hasToken: false, hasPage: false,
      checks: { agentConnected: false, memorySaved: false, memoryRecalled: false, taskReported: false },
    });
  });
  test("ready onboarding reads only central metadata and keeps historical pages separate from agent proof", async () => {
    const calls: string[] = [];
    const db = ((parts: TemplateStringsArray) => {
      const query = parts.join('?'); calls.push(query);
      return Promise.resolve(query.includes("SELECT 1 FROM audit_log") ? [{ present: 1 }] : []);
    }) as unknown as postgres.Sql;
    db.begin = (async (_mode: string, work: (tx: postgres.Sql) => unknown) => work(db)) as any;
    const org = { ...ANI_HQ_ORG };
    Object.defineProperty(org, 'dataDb', { get() { throw new Error('Onboarding must not open tenant storage'); } });
    expect(await onboardingState(org, db)).toEqual({
      step: "connect", provisioning: false, hasToken: false, hasPage: true,
      checks: { agentConnected: false, memorySaved: false, memoryRecalled: false, taskReported: false },
    });
    expect(calls.every(query => !query.includes('memory_entries'))).toBe(true);
  });
});

describe("org policies", () => {
  const owner = normalizeToken({ orgId: 7, name: "ada", role: "owner" });
  const member = normalizeToken({ orgId: 7, name: "grace", role: "member" });
  const writer = normalizeToken({ orgId: 7, name: "cursor", role: "agent", canWrite: true });
  const reader = normalizeToken({ orgId: 7, name: "cursor", role: "agent", canWrite: false });

  test("agents write only when the token and the org both allow it", () => {
    expect(canWrite(writer, policies)).toBe(true);
    expect(canWrite(reader, policies)).toBe(false);
    expect(canWrite(writer, parsePolicies({ agentsMayWrite: false }))).toBe(false);
    expect(canWrite(member, parsePolicies({ agentsMayWrite: false }))).toBe(true);
  });

  test("agents cannot delete while members can, and review follows the switch", () => {
    expect(canDelete(writer, policies)).toBe(false);
    expect(canDelete(member, policies)).toBe(true);
    const agentsMayDelete = parsePolicies({ membersOnlyDelete: false });
    expect(canDelete(writer, agentsMayDelete)).toBe(true);
    expect(canDelete(reader, agentsMayDelete)).toBe(false);
    expect(canApproveReview(member, policies)).toBe(true);
    expect(canApproveReview(member, parsePolicies({ reviewApprovers: "owners" }))).toBe(false);
    expect(canApproveReview(owner, parsePolicies({ reviewApprovers: "owners" }))).toBe(true);
    expect(canUseTool(reader, "put_page", policies)).toBe(false);
    expect(canUseTool(reader, "search", policies)).toBe(true);
  });

  test("share rules mutate only when a human email matches the owner", () => {
    const rule = { sourceOrg: 7, ownerEmail: "ada@example.com" };
    const owner = normalizeToken({ orgId: 7, name: "ada", role: "owner", email: "ada@example.com" });
    const other = normalizeToken({ orgId: 7, name: "grace", role: "member", email: "grace@example.com" });
    const agent = normalizeToken({ orgId: 7, name: "cursor", role: "agent", canWrite: true });
    const agentCookie = normalizeToken({ orgId: 7, name: "cursor", role: "agent", kind: "session", canWrite: true });
    expect(ownsShareRule(owner, 7, rule)).toBe(true);
    expect(ownsShareRule(other, 7, rule)).toBe(false);
    expect(ownsShareRule(agent, 7, rule)).toBe(false);
    expect(ownsShareRule(agentCookie, 7, rule)).toBe(false);
    expect(ownsShareRule(owner, 8, rule)).toBe(false);
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
