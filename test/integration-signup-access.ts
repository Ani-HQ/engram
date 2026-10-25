// Helper-only checks called by the marked, disposable PostgreSQL integration.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { applySignupInviteAccess } from "../gateway/src/provisioning";
import { ensureHostedSignupInvitesSchema } from "../gateway/src/signup-invites-schema";

export async function checkSignupInviteAccess(db: postgres.Sql): Promise<number> {
  const marker = (await db`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0];
  assert.equal(marker?.purpose, "engram-disposable-integration-v1");
  let checks = 1;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  const reject = async (message: string) => { equal((await applySignupInviteAccess(db)).failed, 1, message); };
  const orgIds = Array.from({ length: 9 }, (_, index) => 820001 + index);
  equal(Number((await db`SELECT count(*) AS n FROM orgs WHERE id IN ${db(orgIds)}`)[0].n), 0, "Helper fixture never replaces an existing workspace");
  const operatorEmail = `signup-helper-${randomUUID()}@example.test`;
  let operatorId: number | undefined;
  const invites: string[] = [];
  const owners = new Map<number, { email: string; id: number }>();
  const addInvite = async (orgId: number, change: { email?: string; ownerId?: number; creatorId?: number; revoked?: boolean } = {}) => {
    const owner = owners.get(orgId)!;
    const id = randomUUID();
    invites.push(id);
    // Exercise an older runtime's exact write shape after additive migration:
    // it does not know the new term columns when issuing or verifying a code.
    await db`INSERT INTO hosted_signup_invites (id, code_hash, email, created_by_member_id, expires_at)
      VALUES (${id}, ${createHash("sha256").update(id).digest("hex")}, ${change.email ?? owner.email}, ${change.creatorId ?? operatorId!}, now() + interval '1 day')`;
    await db`UPDATE hosted_signup_invites SET redeemed_at = now(), redeemed_org_id = ${orgId},
      redeemed_owner_member_id = ${change.ownerId ?? owner.id}, revoked_at = ${change.revoked ? new Date() : null} WHERE id = ${id}`;
    return id;
  };
  try {
    operatorId = Number((await db`INSERT INTO org_members (org_id, email, role) VALUES (1, ${operatorEmail}, 'owner') RETURNING id`)[0].id);
    await db`INSERT INTO hosted_signup_operators (member_id) VALUES (${operatorId})`;
    for (const orgId of orgIds) {
      await db`INSERT INTO orgs (id, name, slug, kind, brain_db, data_db, home_dir, provisioning_status)
        VALUES (${orgId}, 'Signup helper fixture', ${`signup-helper-${orgId}`}, 'personal', ${`brain_org_${orgId}`}, ${`brain_org_${orgId}`}, ${`org-${orgId}`}, 'ready')`;
      const email = `signup-helper-${orgId}@example.test`;
      const ownerId = Number((await db`INSERT INTO org_members (org_id, email, role) VALUES (${orgId}, ${email}, 'owner') RETURNING id`)[0].id);
      owners.set(orgId, { email, id: ownerId });
      await db`INSERT INTO workspace_billing (org_id, trial_ends_at) VALUES (${orgId}, now() - interval '1 day')`;
    }
    const billingBefore = await db`SELECT org_id, row_to_json(b) AS value FROM workspace_billing b WHERE org_id IN ${db(orgIds)} ORDER BY org_id`;
    const firstInvite = await addInvite(orgIds[0]);
    equal((await db`SELECT access_duration_days, access_expires_at FROM hosted_signup_invites WHERE id = ${firstInvite}`)[0], { access_duration_days: null, access_expires_at: null }, "Old issuance and redemption SQL keep their original terms while a new runtime is staged");
    equal((await db`SELECT signup_version FROM engram_schema_state WHERE id = true`)[0].signup_version, 2026102401, "The old runtime's exact signup readiness marker stays compatible");
    const firstRuns = await Promise.all([applySignupInviteAccess(db), applySignupInviteAccess(db)]);
    equal(firstRuns.reduce((sum, result) => sum + result.applied, 0), 1, "Concurrent reconciliation applies one grant");
    const first = (await db`SELECT * FROM workspace_complimentary_access WHERE org_id = ${orgIds[0]}`)[0];
    equal([first.owner_member_id, first.expires_at, first.revoked_at], [owners.get(orgIds[0])!.id, null, null], "Grant is bound to the exact owner with no fabricated expiry");
    equal((await db`SELECT complimentary_grant_id FROM hosted_signup_invites WHERE id = ${firstInvite}`)[0].complimentary_grant_id, first.id, "Invite records its stable grant UUID");
    equal(Number((await db`SELECT count(*) AS n FROM complimentary_access_events WHERE org_id = ${orgIds[0]}`)[0].n), 1, "Exact retries produce one grant receipt");
    equal(await applySignupInviteAccess(db), { applied: 0, revoked: 0, failed: 0 }, "Applied invitations stay idempotent");
    await ensureHostedSignupInvitesSchema(db);
    equal((await db`SELECT expires_at FROM workspace_complimentary_access WHERE org_id = ${orgIds[0]}`)[0].expires_at, null, "Repeated migrations never shorten a legacy non-expiring grant");
    equal((await db`SELECT access_duration_days, access_expires_at FROM hosted_signup_invites WHERE id = ${firstInvite}`)[0], { access_duration_days: null, access_expires_at: null }, "Older invitation terms remain unchanged after the new default");
    equal(await db`SELECT org_id, row_to_json(b) AS value FROM workspace_billing b WHERE org_id IN ${db(orgIds)} ORDER BY org_id`, billingBefore, "Grant leaves every Stripe and original trial field unchanged");

    for (const [orgId, change, message] of [
      [orgIds[1], { email: "someone-else@example.test" }, "Wrong recipient email cannot grant access"],
      [orgIds[2], { ownerId: owners.get(orgIds[0])!.id }, "Another workspace's owner cannot receive the grant"],
      [orgIds[3], { creatorId: owners.get(orgIds[0])!.id }, "An owner outside the operator allowlist cannot authorize a grant"],
    ] as const) {
      const id = await addInvite(orgId, change);
      await reject(message);
      equal(Number((await db`SELECT count(*) AS n FROM workspace_complimentary_access WHERE org_id = ${orgId}`)[0].n), 0, "Rejected admission creates no grant");
      await db`DELETE FROM hosted_signup_invites WHERE id = ${id}`;
    }
    const paidId = await addInvite(orgIds[4]);
    await db`UPDATE workspace_billing SET stripe_subscription_id = 'sub_signup_helper_fixture', status = 'active' WHERE org_id = ${orgIds[4]}`;
    await reject("A subscription cannot be replaced by complimentary admission");
    await db`UPDATE workspace_billing SET stripe_subscription_id = NULL, stripe_customer_id = 'cus_signup_helper_fixture' WHERE org_id = ${orgIds[4]}`;
    await db`UPDATE hosted_signup_invites SET complimentary_retry_at = now() - interval '1 second' WHERE id = ${paidId}`;
    await reject("A provider customer created after redemption blocks complimentary admission");
    await db`UPDATE workspace_billing SET stripe_customer_id = NULL, checkout_session_id = 'cs_signup_helper_fixture' WHERE org_id = ${orgIds[4]}`;
    await db`UPDATE hosted_signup_invites SET complimentary_retry_at = now() - interval '1 second' WHERE id = ${paidId}`;
    await reject("An in-flight Checkout created after redemption blocks complimentary admission");
    await db`DELETE FROM hosted_signup_invites WHERE id = ${paidId}`;
    const teamId = await addInvite(orgIds[5]);
    await db`UPDATE orgs SET kind = 'team' WHERE id = ${orgIds[5]}`;
    await reject("A team workspace cannot receive the personal admission grant");
    await db`DELETE FROM hosted_signup_invites WHERE id = ${teamId}`;

    const revokedBeforeApply = await addInvite(orgIds[6], { revoked: true });
    equal(await applySignupInviteAccess(db), { applied: 0, revoked: 1, failed: 0 }, "Revoked admission never creates access");
    equal(Number((await db`SELECT count(*) AS n FROM workspace_complimentary_access WHERE org_id = ${orgIds[6]}`)[0].n), 0, "A pre-application revocation has no complimentary row");
    equal((await db`SELECT complimentary_applied_at FROM hosted_signup_invites WHERE id = ${revokedBeforeApply}`)[0].complimentary_applied_at, null, "Pre-application revocation does not pretend access was granted");

    await db`UPDATE hosted_signup_invites SET revoked_at = now() WHERE id = ${firstInvite}`;
    await db`UPDATE hosted_signup_operators SET revoked_at = now() WHERE member_id = ${operatorId}`;
    equal(await applySignupInviteAccess(db), { applied: 0, revoked: 1, failed: 0 }, "Revocation still works after the creator's authority is removed");
    equal((await db`SELECT revoked_at IS NOT NULL AS revoked FROM workspace_complimentary_access WHERE id = ${first.id}`)[0].revoked, true, "Revocation targets the recorded grant");
    equal(Number((await db`SELECT count(*) AS n FROM complimentary_access_events WHERE org_id = ${orgIds[0]}`)[0].n), 2, "Grant and revoke each keep one audit receipt");
    equal(await applySignupInviteAccess(db), { applied: 0, revoked: 0, failed: 0 }, "A revoked invitation cannot regrant on later jobs");
    const revokedOperatorId = await addInvite(orgIds[7]);
    await reject("A revoked allowlist entry fails closed for fresh grants");
    await db`DELETE FROM hosted_signup_invites WHERE id = ${revokedOperatorId}`;
    await db`UPDATE hosted_signup_operators SET revoked_at = NULL WHERE member_id = ${operatorId}`;
    const inactiveGrantId = randomUUID();
    await db`INSERT INTO workspace_complimentary_access (id, org_id, owner_member_id) VALUES (${inactiveGrantId}, ${orgIds[7]}, ${owners.get(orgIds[7])!.id})`;
    const inactiveInvite = await addInvite(orgIds[7]);
    await reject("A fresh invitation cannot replace an active independent grant");
    await db`UPDATE workspace_complimentary_access SET revoked_at = now() WHERE id = ${inactiveGrantId}`;
    await db`UPDATE hosted_signup_invites SET complimentary_retry_at = now() - interval '1 second' WHERE id = ${inactiveInvite}`;
    equal((await applySignupInviteAccess(db)).applied, 1, "A fresh authorized invitation can replace an inactive grant");
    const reissued = (await db`SELECT id, revoked_at, expires_at FROM workspace_complimentary_access WHERE org_id = ${orgIds[7]}`)[0];
    equal(reissued.id === inactiveGrantId, false, "Replacing inactive access creates a distinct stable grant identity");
    equal([reissued.revoked_at, reissued.expires_at], [null, null], "Fresh admission gets non-expiring active access");
    await db`UPDATE hosted_signup_invites SET revoked_at = now() WHERE id = ${inactiveInvite}`;
    equal((await applySignupInviteAccess(db)).revoked, 1, "The fresh grant remains independently revocable");
    const replacementInvite = await addInvite(orgIds[8]);
    equal((await applySignupInviteAccess(db)).applied, 1, "A separate personal redemption receives its own grant");
    const replacementId = randomUUID();
    await db`UPDATE workspace_complimentary_access SET id = ${replacementId} WHERE org_id = ${orgIds[8]}`;
    await db`UPDATE hosted_signup_invites SET revoked_at = now() WHERE id = ${replacementInvite}`;
    equal((await applySignupInviteAccess(db)).revoked, 1, "A superseded invitation completes its revocation reconciliation");
    equal((await db`SELECT id, revoked_at FROM workspace_complimentary_access WHERE org_id = ${orgIds[8]}`)[0], { id: replacementId, revoked_at: null }, "Revocation cannot touch a later independent grant");

    const bad = await addInvite(orgIds[1], { email: "quarantined@example.test" });
    const valid = await addInvite(orgIds[2]);
    equal(await applySignupInviteAccess(db), { applied: 1, revoked: 0, failed: 1 }, "A bad admission cannot block an unrelated valid grant in the same sweep");
    equal(Number((await db`SELECT count(*) AS n FROM workspace_complimentary_access WHERE org_id = ${orgIds[1]}`)[0].n), 0, "Quarantined admission has no access");
    equal((await db`SELECT complimentary_error_code, complimentary_retry_at > now() AS backoff FROM hosted_signup_invites WHERE id = ${bad}`)[0], { complimentary_error_code: "signup_access_unavailable", backoff: true }, "Quarantine stores only a safe category and a durable retry time");
    equal(await applySignupInviteAccess(db), { applied: 0, revoked: 0, failed: 1 }, "Backoff preserves failure status without retrying or rolling back valid access");
    await db`UPDATE hosted_signup_invites SET revoked_at = now() WHERE id = ${bad}`;
    equal(await applySignupInviteAccess(db), { applied: 0, revoked: 1, failed: 0 }, "Revocation bypasses failed-grant backoff and resolves quarantine");
    equal((await db`SELECT complimentary_grant_id IS NOT NULL AS granted FROM hosted_signup_invites WHERE id = ${valid}`)[0].granted, true, "The valid grant remains applied after quarantine cleanup");
    return checks;
  } finally {
    await db`DELETE FROM complimentary_access_events WHERE org_id IN ${db(orgIds)}`;
    await db`DELETE FROM workspace_complimentary_access WHERE org_id IN ${db(orgIds)}`;
    if (invites.length) await db`DELETE FROM hosted_signup_invites WHERE id IN ${db(invites)}`;
    if (operatorId !== undefined) await db`DELETE FROM hosted_signup_operators WHERE member_id = ${operatorId}`;
    await db`DELETE FROM org_members WHERE org_id IN ${db(orgIds)} OR email = ${operatorEmail}`;
    await db`DELETE FROM workspace_billing WHERE org_id IN ${db(orgIds)}`;
    await db`DELETE FROM orgs WHERE id IN ${db(orgIds)}`;
  }
}
