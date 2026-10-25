import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { createSignupVerification, listSignupInvites, signupInviteLink } from "../gateway/src/signup-invites";
import { normalizeToken } from "../gateway/src/policies";
import { sha256 } from "../gateway/src/hash";

const actor = normalizeToken({ name: "operator@example.test", email: "operator@example.test", orgId: 1, role: "owner", kind: "session" });
const id = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const originalCode = `eg_inv_${"A".repeat(32)}`;
function database(email: string | null = null) {
  const row: any = { id, code_hash: sha256(originalCode), email, created_by_member_id: 11, created_at: new Date(Date.now() - 86_400_000), expires_at: new Date(Date.now() + 86_400_000), revoked_at: null, redeemed_at: null, redeemed_org_id: null, access_duration_days: 60 };
  const state = { operatorActive: true, creatorActive: true };
  const calls: { query: string; values: any[] }[] = [], proofs: any[] = [];
  const active = () => state.creatorActive && !row.revoked_at && !row.redeemed_at && row.expires_at.getTime() > Date.now();
  const expanded = () => ({ ...row, link_expiry: String(row.expires_at.getTime() / 1000), link_available: Boolean(active()) });
  const db = ((parts: TemplateStringsArray, ...values: any[]) => {
    const query = parts.join("?"); calls.push({ query, values });
    if (query.includes("FROM hosted_signup_operators o JOIN org_members")) return Promise.resolve(state.operatorActive ? [{ id: 11 }] : []);
    if (query.includes("AS link_available")) return Promise.resolve(values[0] === id ? [expanded()] : []);
    if (query.includes("SELECT * FROM hosted_signup_invites ORDER")) return Promise.resolve([expanded()]);
    if (query.includes("SELECT i.*, extract(epoch")) return Promise.resolve(active() && (values[0] === row.code_hash || values[1] === row.id) && (row.email === null || row.email === values[2]) ? [expanded()] : []);
    if (query.includes("max(created_at) FILTER")) return Promise.resolve([{ n: proofs.length, cooling_down: proofs.some(proof => proof.email === values[0] && proof.createdAt > Date.now() - 60_000) }]);
    if (query.includes("INSERT INTO hosted_signup_verifications")) { proofs.push({ signupInviteId: values[1], email: values[2], tokenHash: values[3], createdAt: Date.now() }); return Promise.resolve([]); }
    throw new Error("Unexpected invitation-link query");
  }) as unknown as postgres.Sql;
  (db as any).begin = (first: any, second?: any) => (typeof first === "function" ? first : second)(db);
  return { db, row, state, calls, proofs };
}
const aliasFrom = (url: string) => new URL(url).hash.slice("#invite=".length);

describe("recoverable invitation links", () => {
  test("returns a stable signed alias without changing the original hash, terms or inventory", async () => {
    const store = database(), before = JSON.stringify(store.row);
    const result = await signupInviteLink(actor, id, "https://signup.example/", store.db);
    const alias = aliasFrom(result.inviteUrl);
    expect(Object.keys(result)).toEqual(["inviteUrl"]);
    expect(alias).toMatch(/^eg_link_v1_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/);
    expect(new URL(result.inviteUrl).search).toBe("");
    expect(result.inviteUrl).not.toContain(originalCode);
    expect(result.inviteUrl).not.toContain(store.row.code_hash);
    expect(result.inviteUrl).not.toContain("operator@example.test");
    expect((await signupInviteLink(actor, id, "https://signup.example", store.db)).inviteUrl).toBe(result.inviteUrl);
    expect(JSON.stringify(store.row)).toBe(before);
    expect(store.calls.every(call => call.query.trim().startsWith("SELECT"))).toBe(true);
    const inventory = JSON.stringify(await listSignupInvites(actor, store.db));
    for (const value of [alias, result.inviteUrl, originalCode, store.row.code_hash, "link_expiry", "link_available"]) expect(inventory).not.toContain(value);
  });

  test("original and alias address the same unbound invitation and share verification limits and final state", async () => {
    const store = database();
    const alias = aliasFrom((await signupInviteLink(actor, id, "https://signup.example", store.db)).inviteUrl);
    await createSignupVerification("first@example.test", "", alias, "https://signup.example", store.db);
    await createSignupVerification("second@example.test", "", originalCode, "https://signup.example", store.db);
    expect(store.proofs.map(proof => proof.signupInviteId)).toEqual([id, id]);
    expect(store.row.email).toBeNull();
    expect(store.row.redeemed_at).toBeNull();
    await expect(createSignupVerification("first@example.test", "", originalCode, "https://signup.example", store.db)).rejects.toMatchObject({ status: 429, code: "signup_rate_limited" });
    store.row.redeemed_at = new Date(); store.row.email = "first@example.test";
    for (const code of [alias, originalCode]) await expect(createSignupVerification("first@example.test", "", code, "https://signup.example", store.db)).rejects.toMatchObject({ code: "invite_invalid" });
    await expect(signupInviteLink(actor, id, "https://signup.example", store.db)).rejects.toMatchObject({ status: 409, code: "invite_unavailable" });
  });

  test("keeps exact mailbox binding and rejects altered signatures or changed invitation bindings before creating proofs", async () => {
    const store = database("bound@example.test");
    const alias = aliasFrom((await signupInviteLink(actor, id, "https://signup.example", store.db)).inviteUrl);
    await expect(createSignupVerification("wrong@example.test", "", alias, "https://signup.example", store.db)).rejects.toMatchObject({ code: "invite_invalid" });
    const macAt = alias.length - 43;
    const tampered = alias.slice(0, macAt) + (alias[macAt] === "A" ? "B" : "A") + alias.slice(macAt + 1);
    for (const code of [tampered, `${alias}=`, alias.replace("eg_link_v1_", "eg_link_v2_")]) await expect(createSignupVerification("bound@example.test", "", code, "https://signup.example", store.db)).rejects.toMatchObject({ code: "invite_invalid" });
    const original = { ...store.row };
    for (const patch of [{ code_hash: sha256("replaced") }, { email: "changed@example.test" }, { expires_at: new Date(original.expires_at.getTime() + 1000) }, { created_by_member_id: 12 }]) {
      Object.assign(store.row, original, patch);
      await expect(createSignupVerification(store.row.email, "", alias, "https://signup.example", store.db)).rejects.toMatchObject({ code: "invite_invalid" });
    }
    expect(store.proofs).toHaveLength(0);
    Object.assign(store.row, original);
    await createSignupVerification("bound@example.test", "", alias, "https://signup.example", store.db);
    expect(store.proofs[0].email).toBe("bound@example.test");
  });

  test("fails closed for nonoperators, unavailable issuers and expired or revoked invitations", async () => {
    const store = database();
    for (const token of [normalizeToken({ ...actor, kind: "token" }), normalizeToken({ ...actor, role: "member" }), normalizeToken({ ...actor, orgId: 2 })]) await expect(signupInviteLink(token, id, "https://signup.example", store.db)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    store.state.operatorActive = false;
    await expect(signupInviteLink(actor, id, "https://signup.example", store.db)).rejects.toMatchObject({ status: 403 });
    store.state.operatorActive = true;
    await expect(signupInviteLink(actor, "invalid", "https://signup.example", store.db)).rejects.toMatchObject({ status: 404 });
    await expect(signupInviteLink(actor, "aaaa1111-bbbb-4ccc-8ddd-ffffffffffff", "https://signup.example", store.db)).rejects.toMatchObject({ status: 404 });
    const alias = aliasFrom((await signupInviteLink(actor, id, "https://signup.example", store.db)).inviteUrl);
    for (const failure of ["issuer", "expired", "revoked"]) {
      store.state.creatorActive = failure !== "issuer";
      store.row.expires_at = new Date(Date.now() + (failure === "expired" ? -1 : 86_400_000));
      store.row.revoked_at = failure === "revoked" ? new Date() : null;
      await expect(signupInviteLink(actor, id, "https://signup.example", store.db)).rejects.toMatchObject({ status: 409, code: "invite_unavailable" });
      for (const code of [alias, originalCode]) await expect(createSignupVerification("friend@example.test", "", code, "https://signup.example", store.db)).rejects.toMatchObject({ code: "invite_invalid" });
    }
    expect(store.proofs).toHaveLength(0);
  });
});
