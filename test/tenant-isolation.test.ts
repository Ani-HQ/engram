import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import type postgres from "postgres";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { authenticateStoredSecret, issueToken } = await import("../gateway/src/auth");
const { currentContext, runWithContext } = await import("../gateway/src/context");
const { dataSql } = await import("../gateway/src/db");
const { acceptInvite, assertOrgStorage, cancelInvites, getOrg, listOrgs, removeMember, withOrg } = await import("../gateway/src/orgs");
const { audit, provenanceFor, recentActivity } = await import("../gateway/src/audit");
const { handleOrgApi } = await import("../gateway/src/org-api");
const { oauthMemberForClaims, verifyJwt } = await import("../gateway/src/oauth");
const { connectorSession } = await import("../gateway/src/oauth-as");
const { normalizeToken, parsePolicies } = await import("../gateway/src/policies");
const { parseShareMatch, resolveShareAuthority } = await import("../gateway/src/sharing");

type Query = { statement: string; values: unknown[] };
function database(reply: (query: Query) => unknown[] | Promise<unknown[]>) {
  const calls: Query[] = [];
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = { statement: parts.join("?"), values };
    calls.push(query);
    return Promise.resolve().then(() => reply(query));
  }) as unknown as postgres.Sql;
  db.begin = (async (fn: (transaction: postgres.Sql) => unknown) => fn(db)) as any;
  db.json = ((value: unknown) => value) as any;
  return { db, calls };
}

function orgRow(id: number) {
  return {
    id, name: `Workspace ${id}`, slug: `workspace-${id}`, kind: "team",
    brain_db: `brain_org_${id}`, data_db: `brain_org_${id}`, home_dir: `org-${id}`,
    policies: {}, created_at: "2026-10-01T00:00:00Z",
  };
}

function org(id: number) {
  return {
    id, name: `Workspace ${id}`, slug: `workspace-${id}`, kind: "team" as const,
    brainDb: `brain_org_${id}`, dataDb: `brain_org_${id}`, homeDir: `org-${id}`,
    policies: parsePolicies({}), createdAt: "2026-10-01T00:00:00Z",
  };
}

describe("tenant storage boundaries", () => {
  test("context entry rejects an actor from a different workspace before acquiring a pool", async () => {
    const workspace = org(7);
    const token = normalizeToken({ name: "wrong-workspace", orgId: 8 });
    const { db, calls } = database(() => []);
    expect(() => runWithContext({ org: workspace, token, dataSql: db }, () => "leaked")).toThrow("must match");
    await expect(withOrg(workspace, token, async () => "leaked")).rejects.toThrow("must match");
    expect(calls).toHaveLength(0);
    expect(currentContext()).toBeUndefined();
  });

  test("audit and provenance never fall back to the installation workspace", async () => {
    await expect(audit("agent", "search", "{}", "ok")).rejects.toThrow("workspace context");
    await expect(provenanceFor(["private-page"])).rejects.toThrow("workspace context");
    await expect(recentActivity()).rejects.toThrow("workspace context");
  });

  test("tenant data access requires a request or job context", () => {
    expect(currentContext()).toBeUndefined();
    expect(() => dataSql()).toThrow("workspace context");
    const workspace = org(7);
    const { db } = database(() => []);
    runWithContext({ org: workspace, token: normalizeToken({ name: "cursor", orgId: 7 }), dataSql: db }, () => {
      expect(dataSql()).toBe(db);
    });
  });

  test("invalid IDs never query storage and missing workspace 1 does not fall back", async () => {
    const { db, calls } = database(() => []);
    for (const id of [0, -1, 1.5, NaN, Infinity]) expect(await getOrg(id, db)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await getOrg(1, db)).toBeNull();
    expect(calls[0].values).toEqual([1]);
  });

  test("database failure does not silently select the installation owner's workspace", async () => {
    const { db } = database(() => { throw new Error("database unavailable"); });
    await expect(getOrg(1, db)).rejects.toThrow("database unavailable");
    await expect(listOrgs(db)).rejects.toThrow("database unavailable");
  });

  test("provisioned storage cannot alias another tenant or escape its home", async () => {
    expect(() => assertOrgStorage(org(7))).not.toThrow();
    for (const change of [
      { brainDb: "brain_org_8" }, { dataDb: "engram_gateway" },
      { homeDir: "../org-8" }, { brainDb: "pending" }, { id: 7.5 },
    ]) expect(() => assertOrgStorage({ ...org(7), ...change })).toThrow();
    const { db } = database(() => [{ ...orgRow(7), data_db: "brain_org_8" }]);
    await expect(getOrg(7, db)).rejects.toThrow("invalid storage binding");
  });

  test("parallel requests and nested operations restore their own context", async () => {
    const a = org(7), b = org(8);
    const { db } = database(() => []);
    const tokenA = normalizeToken({ name: "agent-a", orgId: 7 });
    const tokenB = normalizeToken({ name: "agent-b", orgId: 8 });
    await Promise.all([a, b].map(workspace => runWithContext({
      org: workspace, token: workspace.id === 7 ? tokenA : tokenB, dataSql: db,
    }, async () => {
      await Promise.resolve();
      expect(currentContext()?.org.id).toBe(workspace.id);
      await runWithContext({ org: b, token: tokenB, dataSql: db }, async () => {
        await Promise.resolve();
        expect(currentContext()?.org.id).toBe(8);
      });
      expect(currentContext()?.org.id).toBe(workspace.id);
    })));
    expect(currentContext()).toBeUndefined();
  });
});

describe("live membership and credential boundaries", () => {
  test("resource credentials require a valid expiration, subject, and expected audience", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const jwks = [{ kid: "tenant-test", n: jwk.n, e: jwk.e }];
    const now = 1_800_000_000;
    const valid = { iss: "https://engram.example", aud: "https://engram.example/mcp", sub: "ada", exp: now + 60 };
    const signed = (payload: unknown) => {
      const packed = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "tenant-test" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
      return `${packed}.${createSign("RSA-SHA256").update(packed).end().sign(privateKey).toString("base64url")}`;
    };
    const options = { issuer: valid.iss, audience: valid.aud, jwks, now };
    expect(await verifyJwt(signed(valid), options)).toMatchObject({ sub: "ada" });
    for (const payload of [null, [], { ...valid, exp: undefined }, { ...valid, exp: String(now + 60) }, { ...valid, exp: now }, { ...valid, sub: {} }]) {
      expect(await verifyJwt(signed(payload), options)).toBeNull();
    }
    expect(await verifyJwt(signed(valid), { ...options, audience: "" })).toBeNull();
  });

  test("session role comes from the current membership and the session's exact org", async () => {
    const { db, calls } = database(({ statement }) => statement.includes("FROM sessions")
      ? [{ name: "ada", org_id: 7, role: "member", email: "ada@example.com" }] : []);
    const actor = await authenticateStoredSecret("ens_demoted-owner", db);
    expect(actor).toMatchObject({ orgId: 7, role: "member", kind: "session" });
    const query = calls.find(call => call.statement.includes("FROM sessions"))!;
    expect(query.statement).toContain("JOIN org_members m ON m.org_id = s.org_id AND m.email = s.email");
    expect(query.statement).toContain("m.role");
    expect(query.statement).toContain("s.revoked_at IS NULL");
  });

  test("member credentials link the exact live membership while operator credentials are explicit", async () => {
    const { db, calls } = database(({ statement }) => statement.includes("SELECT id FROM org_members") ? [{ id: 41 }] : []);
    expect(await issueToken(7, "cursor", true, " Ada@Example.com ", db)).toStartWith("eng_");
    expect(calls[0].values).toEqual([7, "ada@example.com"]);
    expect(calls[0].statement).toContain("FOR UPDATE");
    expect(calls[1].values.slice(6, 9)).toEqual(["member", "ada@example.com", 41]);
    const removed = database(() => []);
    await expect(issueToken(7, "cursor", true, "removed@example.com", removed.db)).rejects.toThrow("not a current");
    expect(removed.calls).toHaveLength(1);
    const invalid = database(() => []);
    await expect(issueToken(0, "cursor", true, null, invalid.db)).rejects.toThrow("valid workspace");
    expect(invalid.calls).toHaveLength(0);
    const lookup = database(({ statement }) => statement.includes("FROM tokens") ? [{ name: "cursor", org_id: 7, role: "agent" }] : []);
    expect(await authenticateStoredSecret("eng_valid", lookup.db)).toMatchObject({ orgId: 7 });
    expect(lookup.calls[0].statement).toContain("m.id = t.issued_by_member_id");
    expect(lookup.calls[0].statement).toContain("m.org_id = t.org_id AND m.email = t.issued_by_email");
  });

  test("removed memberships and credentials without an org do not become workspace 1", async () => {
    const missing = database(() => []);
    expect(await authenticateStoredSecret("ens_removed-owner", missing.db)).toBeNull();
    const malformed = database(({ statement }) => statement.includes("FROM tokens")
      ? [{ name: "broken", org_id: null, role: "owner" }] : []);
    expect(await authenticateStoredSecret("eng_unbound", malformed.db)).toBeNull();
  });

  test("OAuth selects the signed tenant even when the same person belongs elsewhere", async () => {
    const { db, calls } = database(({ statement, values }) => {
      if (statement.includes("FROM org_members")) {
        expect(values).toEqual([8, "ada@example.com"]);
        return [{ id: 3, org_id: 8, email: "ada@example.com", role: "member" }];
      }
      if (statement.includes("FROM orgs")) return [orgRow(8)];
      throw new Error("unexpected query");
    });
    expect(await oauthMemberForClaims({ sub: "ada", email: "ada@example.com", org_id: 8, membership_id: 3 }, db))
      .toMatchObject({ orgId: 8, role: "member" });
    expect(calls).toHaveLength(2);
  });

  test("OAuth without a signed tenant or matching live membership fails closed", async () => {
    const { db, calls } = database(() => []);
    for (const org_id of [undefined, 0, -1, 1.1, "7"]) {
      expect(await oauthMemberForClaims({ sub: "ada", email: "ada@example.com", org_id, membership_id: 3 } as any, db)).toBeNull();
    }
    expect(calls).toHaveLength(0);
    for (const membership_id of [undefined, null, 0, -1, 1.1, "3"]) {
      expect(await oauthMemberForClaims({ sub: "ada", email: "ada@example.com", org_id: 7, membership_id } as any, db)).toBeNull();
    }
    expect(calls).toHaveLength(0);
    expect(await oauthMemberForClaims({ sub: "ada", email: "ada@example.com", org_id: 7, membership_id: 3 }, db)).toBeNull();
    expect(calls[0].values).toEqual([7, "ada@example.com"]);
  });

  test("OAuth from a previous membership cannot reactivate after removal and rejoining", async () => {
    let membershipId: number | null = 41;
    const { db } = database(({ statement }) => {
      if (statement.includes("FROM org_members")) return membershipId === null ? [] : [{ id: membershipId, org_id: 7, email: "ada@example.com", role: "member" }];
      if (statement.includes("FROM orgs")) return [orgRow(7)];
      return [];
    });
    const claims = { sub: "ada", email: "ada@example.com", org_id: 7, membership_id: 41 };
    expect(await oauthMemberForClaims(claims, db)).toMatchObject({ id: 41 });
    membershipId = null;
    expect(await oauthMemberForClaims(claims, db)).toBeNull();
    membershipId = 42;
    expect(await oauthMemberForClaims(claims, db)).toBeNull();
    expect(await oauthMemberForClaims({ ...claims, membership_id: 42 }, db)).toMatchObject({ id: 42 });
  });

  test("an old login link does not restore a removed or demoted owner", async () => {
    let claimed = false;
    const { db, calls } = database(({ statement }) => {
      if (statement.includes("UPDATE invites SET accepted_at")) {
        if (claimed) return [];
        claimed = true;
        return [{ id: 1, org_id: 7, email: "ada@example.com", role: "owner", created_by: "login" }];
      }
      if (statement.includes("FROM orgs")) return [orgRow(7)];
      if (statement.includes("FROM org_members")) return [{ id: 1, org_id: 7, email: "ada@example.com", role: "member" }];
      throw new Error("login may not mutate membership");
    });
    expect((await acceptInvite("inv_old-owner", db))?.member.role).toBe("member");
    expect(await acceptInvite("inv_old-owner", db)).toBeNull();
    expect(calls.some(call => call.statement.includes("INSERT INTO org_members"))).toBe(false);
    const removed = database(({ statement }) => statement.includes("UPDATE invites")
      ? [{ id: 2, org_id: 7, email: "removed@example.com", role: "owner", created_by: "login" }]
      : statement.includes("FROM orgs") ? [orgRow(7)] : []);
    expect(await acceptInvite("inv_removed", removed.db)).toBeNull();
  });

  test("an actor cannot administer another tenant or widen a delegated OAuth credential", async () => {
    const workspace = org(7);
    const owner = normalizeToken({ name: "ada", orgId: 8, role: "owner", kind: "session", email: "ada@example.com" });
    const request = (path: string, method = "GET", body?: unknown) => new Request(`https://engram.example${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    const mismatched = request("/api/members");
    expect((await handleOrgApi(mismatched, new URL(mismatched.url), owner, workspace))?.status).toBe(403);
    const oauth = normalizeToken({ ...owner, orgId: 7, kind: "oauth", scopes: ["memory:read"] });
    for (const [path, method] of [
      ["/api/tokens", "POST"], ["/api/invites", "POST"], ["/api/policies", "PUT"],
      ["/api/session/switch", "POST"], ["/api/tokens", "GET"], ["/api/members", "GET"],
      ["/api/members", "DELETE"], ["/api/invites", "DELETE"],
    ]) {
      const req = request(path, method, method === "GET" ? undefined : { name: "broad-token", orgId: 8 });
      expect((await handleOrgApi(req, new URL(req.url), oauth, workspace))?.status).toBe(403);
    }
    const req = request("/api/orgs");
    expect(await (await handleOrgApi(req, new URL(req.url), oauth, workspace))?.json()).toEqual({ orgs: [] });
  });

  test("delegated credentials cannot silently authorize a broader connector", async () => {
    const request = new Request("https://engram.example/oauth/authorize", { headers: { Cookie: "engram_session=credential" } });
    const human = normalizeToken({ name: "ada", orgId: 7, role: "owner", email: "ada@example.com", kind: "session" });
    expect(await connectorSession(request, async () => human)).toEqual(human);
    for (const actor of [normalizeToken({ ...human, kind: "oauth", scopes: ["memory:read"] }), normalizeToken({ ...human, kind: "token" })]) {
      expect(await connectorSession(request, async () => actor)).toBeNull();
    }
  });

  test("removing a member revokes that tenant's sessions, linked tokens, refresh credentials and invites", async () => {
    const { db, calls } = database(({ statement }) => statement.includes("SELECT role") ? [{ role: "member" }] : []);
    expect(await removeMember(7, " Member@Example.com ", db)).toBe("removed");
    expect(calls).toHaveLength(6);
    expect(calls[0].statement).toContain("FOR UPDATE");
    expect(calls[1].statement).toContain("DELETE FROM org_members");
    expect(calls[1].statement).toContain("role = 'member'");
    expect(calls[2].statement).toContain("UPDATE sessions SET revoked_at");
    expect(calls[3].statement).toContain("UPDATE tokens SET revoked_at");
    expect(calls[4].statement).toContain("UPDATE oauth_refresh_tokens SET revoked_at");
    expect(calls[5].statement).toContain("DELETE FROM invites");
    for (const query of calls) {
      expect(query.statement).toContain("org_id = ? AND");
      expect(query.values).toEqual([7, "member@example.com"]);
    }
  });

  test("owners cannot be removed and a cancellation does not alter membership", async () => {
    const protectedOwner = database(() => [{ role: "owner" }]);
    expect(await removeMember(7, "owner@example.com", protectedOwner.db)).toBe("owner");
    expect(protectedOwner.calls).toHaveLength(1);
    const invites = database(() => [{ id: 1 }, { id: 2 }]);
    expect(await cancelInvites(8, "member@example.com", invites.db)).toBe(2);
    expect(invites.calls[0].values).toEqual([8, "member@example.com"]);
    expect(invites.calls[0].statement).toContain("accepted_at IS NULL");
    expect(invites.calls[0].statement).not.toContain("org_members");
    const workspace = org(7);
    const owner = normalizeToken({ name: "owner", orgId: 7, role: "owner", kind: "session", email: "owner@example.com" });
    const req = new Request("https://engram.example/api/members", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "OWNER@example.com" }) });
    expect((await handleOrgApi(req, new URL(req.url), owner, workspace))?.status).toBe(403);
    const member = normalizeToken({ ...owner, role: "member" });
    const denied = new Request(req.url, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "other@example.com" }) });
    expect((await handleOrgApi(denied, new URL(denied.url), member, workspace))?.status).toBe(403);
  });
});

describe("explicit cross-workspace sharing authority", () => {
  const rule = {
    id: 9, ownerEmail: "ada@example.com", sourceOrg: 7, targetOrg: 8,
    match: parseShareMatch({matchAll:true}), level: "digest" as const,
    createdAt: "2026-10-01T00:00:00Z", pausedAt: null, revokedAt: null,
  };

  test("mirrors use the current target membership and a target-bound actor", async () => {
    const { db, calls } = database(({ statement, values }) => {
      if (statement.includes("FROM orgs")) return [{ ...orgRow(7), kind: "personal" }];
      if (statement.includes("FROM org_members")) return [{ id: 1, org_id: values[0], email: "ada@example.com", role: values[0] === 7 ? "owner" : "member" }];
      throw new Error("unexpected query");
    });
    const authority = await resolveShareAuthority(rule, org(8), db);
    expect(authority?.sourceToken).toMatchObject({ orgId: 7, role: "owner", email: "ada@example.com" });
    expect(authority?.targetToken).toMatchObject({ orgId: 8, role: "member", email: "ada@example.com", name: "share:9" });
    expect(calls.filter(call => call.statement.includes("FROM org_members")).map(call => call.values))
      .toEqual([[7, "ada@example.com"], [8, "ada@example.com"]]);
  });

  test("removal at either end or disabled consent stops a standing rule", async () => {
    for (const removedOrg of [7, 8]) {
      const { db } = database(({ statement, values }) => {
        if (statement.includes("FROM orgs")) return [{ ...orgRow(7), kind: "personal" }];
        return values[0] === removedOrg ? [] : [{ id: 1, org_id: values[0], email: "ada@example.com", role: "owner" }];
      });
      expect(await resolveShareAuthority(rule, org(8), db)).toBeNull();
    }
    const { db, calls } = database(() => { throw new Error("revoked sharing must not read source data"); });
    expect(await resolveShareAuthority({ ...rule, revokedAt: "2026-10-22T00:00:00Z" }, org(8), db)).toBeNull();
    expect(await resolveShareAuthority({ ...rule, pausedAt: "2026-10-22T00:00:00Z" }, org(8), db)).toBeNull();
    expect(await resolveShareAuthority(rule, org(99), db)).toBeNull();
    expect(await resolveShareAuthority(rule, { ...org(8), policies: parsePolicies({ acceptShares: false }) }, db)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
