// Called only by the marked disposable PostgreSQL integration runner. No mail,
// Stripe, cloud metadata, or external provider is called by these checks.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { config } from "../gateway/src/config";
import { createLoginInvite, createSession } from "../gateway/src/auth";
import { acceptInvite, createInvite } from "../gateway/src/orgs";
import { closeOrgPool as closePool } from "../gateway/src/db";
import { sha256 } from "../gateway/src/hash";
import { normalizeToken } from "../gateway/src/policies";
import { canManageSignupInvites, createSignupVerification, issueSignupInvite, listSignupInvites, revokeSignupInvite, signupPolicy } from "../gateway/src/signup-invites";
import { applySignupInviteAccess, provisionPendingWorkspaces } from "../gateway/src/provisioning";
import { handleWeb } from "../gateway/src/web";
import { handleBillingApi } from "../gateway/src/billing";
import { triggerProvisioning } from "../gateway/src/provisioning-trigger";

export async function checkSignupInvites(db: postgres.Sql): Promise<number> {
  assert.equal((await db`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose, "engram-disposable-integration-v1");
  let checks = 1;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  const reject = async (work: () => Promise<unknown>, code: string) => { await assert.rejects(work, (error: any) => error.code === code); checks++; };
  const prefix = `signup-api-${randomUUID()}`;
  const operatorEmail = `${prefix}-operator@example.test`, otherOwnerEmail = `${prefix}-owner@example.test`;
  const personalId = 830001, orgIds: number[] = [], inviteIds: string[] = [];
  const priorMode = config.signupMode;
  const priorJob = process.env.ENGRAM_PROVISION_JOB, originalFetch = globalThis.fetch;
  config.signupMode = "invite-only";
  let operatorId: number | undefined;
  const actor = (email = operatorEmail, role: "owner" | "member" = "owner", kind: "session" | "token" | "oauth" = "session", orgId = 1) => normalizeToken({ name: email, email, orgId, role, kind });
  const issue = async (suffix: string) => {
    const result = await issueSignupInvite(actor(), `${prefix}-${suffix}@example.test`, undefined, db);
    inviteIds.push(result.invite.id); return result;
  };
  const request = (path: string, session: string | null, body?: unknown, extra: Record<string, string> = {}) => new Request(`https://signup.example${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...(session ? { Cookie: `engram_session=${session}` } : {}), "X-Engram-Console": "1", "X-Engram-Workspace": "1", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    equal(Number((await db`SELECT count(*) AS n FROM orgs WHERE id = ${personalId}`)[0].n), 0, "Personal trial fixture cannot replace an existing workspace");
    operatorId = Number((await db`INSERT INTO org_members (org_id, email, role) VALUES (1, ${operatorEmail}, 'owner') RETURNING id`)[0].id);
    await db`INSERT INTO hosted_signup_operators (member_id) VALUES (${operatorId})`;
    await db`INSERT INTO org_members (org_id, email, role) VALUES (1, ${otherOwnerEmail}, 'owner')`;
    equal(await canManageSignupInvites(actor(), db), true, "Only the live allowlisted operator session is capable");
    for (const denied of [actor(otherOwnerEmail), actor(operatorEmail, "member"), actor(operatorEmail, "owner", "token"), actor(operatorEmail, "owner", "oauth"), actor(operatorEmail, "owner", "session", 2)]) {
      equal(await canManageSignupInvites(denied, db), false, "Other owners, agents, OAuth and workspaces cannot issue codes");
      await reject(() => issueSignupInvite(denied, "friend@example.test", undefined, db), "forbidden");
    }
    equal(signupPolicy().mode, "invite-only", "Signup policy reports the hosted admission gate");
    const operatorSession = await createSession({ orgId: 1, name: operatorEmail, email: operatorEmail, role: "owner" });
    const deniedOwnerSession = await createSession({ orgId: 1, name: otherOwnerEmail, email: otherOwnerEmail, role: "owner" });
    equal((await handleWeb(request("/api/admin/signup-invites", deniedOwnerSession))).status, 403, "A non-allowlisted owner's HTTP request fails closed");
    equal((await handleWeb(request("/api/admin/signup-invites", operatorSession, { email: "friend@example.test" }, { "X-Engram-Console": "0" }))).status, 403, "The operator endpoint preserves the CSRF header boundary");
    equal((await handleWeb(request("/api/admin/signup-invites", operatorSession, { email: "friend@example.test" }, { "X-Engram-Workspace": "2" }))).status, 409, "The operator endpoint preserves workspace pinning");
    const publicPolicy = await handleWeb(new Request("https://signup.example/api/signup-policy"));
    equal([publicPolicy.status, (await publicPolicy.json()).inviteCodeRequired], [200, true], "Signup policy is public without issuing credentials");
    const beforePublicSignup = Number((await db`SELECT count(*) AS n FROM orgs`)[0].n);
    for (const body of [{}, { email: "invalid" }, { email: null }]) equal((await handleWeb(request("/api/orgs", null, body))).status, 400, "Malformed or absent signup email returns a controlled 400");
    equal((await handleWeb(request("/api/orgs", null, { email: `${prefix}-closed@example.test` }))).status, 403, "A public signup without a code is denied before email/storage provisioning");
    equal(Number((await db`SELECT count(*) AS n FROM orgs`)[0].n), beforePublicSignup, "Denied public signup creates no workspace");

    const first = await issue("new");
    const stored = (await db`SELECT code_hash, expires_at, created_at FROM hosted_signup_invites WHERE id = ${first.invite.id}`)[0];
    equal(stored.code_hash, sha256(first.inviteCode), "Only the code hash is persisted");
    equal(Math.round((new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime()) / 86_400_000), 7, "Codes default to seven days");
    equal(JSON.stringify(await listSignupInvites(actor(), db)).includes(first.inviteCode), false, "Operator inventory never repeats raw codes");
    await reject(() => createSignupVerification("wrong@example.test", "Wrong", first.inviteCode, "https://signup.example", db), "invite_invalid");
    const verification = await createSignupVerification(first.invite.email, "A friend's memory", first.inviteCode, "https://signup.example", db);
    equal(Number((await db`SELECT count(*) AS n FROM invites WHERE sha256_hash = ${sha256(verification.raw)}`)[0].n), 0, "An old runtime's invite lookup cannot redeem the new verification token");
    equal(Number((await db`SELECT count(*) AS n FROM org_members WHERE email = ${first.invite.email}`)[0].n), 0, "Code redemption does not create membership before email proof");
    equal((await db`SELECT redeemed_at FROM hosted_signup_invites WHERE id = ${first.invite.id}`)[0].redeemed_at, null, "Email delivery failure or delay cannot consume the code");
    await reject(() => createSignupVerification(first.invite.email, "Retry", first.inviteCode, "https://signup.example", db), "signup_rate_limited");
    const claims = await Promise.all([acceptInvite(verification.raw, db), acceptInvite(verification.raw, db)]);
    equal(claims.filter(Boolean).length, 1, "Concurrent verification accepts the one-use code once");
    const accepted = claims.find(Boolean)!; orgIds.push(accepted.org.id);
    equal([accepted.org.kind, accepted.org.provisioningStatus, accepted.member.email], ["personal", "pending", first.invite.email], "Verified signup creates one exact pending personal workspace");
    equal(Number((await db`SELECT count(*) AS n FROM org_members WHERE email = ${first.invite.email}`)[0].n), 1, "Signup creates no second automatic team/personal workspace");
    equal(Number((await db`SELECT count(*) AS n FROM workspace_complimentary_access WHERE org_id = ${accepted.org.id}`)[0].n), 0, "The request runtime does not write the free grant");
    await provisionPendingWorkspaces(10);
    const ready = (await db`SELECT o.provisioning_status, c.expires_at, c.revoked_at FROM orgs o JOIN workspace_complimentary_access c ON c.org_id = o.id WHERE o.id = ${accepted.org.id}`)[0];
    equal(ready, { provisioning_status: "ready", expires_at: null, revoked_at: null }, "Provisioning exposes readiness with its audited non-expiring grant");

    // Two separately authorized codes for one email cannot create duplicate
    // personal stores or independently queue competing complimentary grants.
    const concurrentA = await issue("concurrent"), concurrentB = await issueSignupInvite(actor(), concurrentA.invite.email, undefined, db);
    inviteIds.push(concurrentB.invite.id);
    const links = await Promise.all([concurrentA, concurrentB].map(item => createSignupVerification(item.invite.email, "Concurrent", item.inviteCode, "https://signup.example", db)));
    const race = await Promise.allSettled(links.map(item => acceptInvite(item.raw, db)));
    const winners = race.filter((item): item is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof acceptInvite>>>> => item.status === "fulfilled" && !!item.value);
    equal(winners.length, 1, "Different codes for the same email still produce one admission"); orgIds.push(winners[0].value.org.id);
    equal(Number((await db`SELECT count(*) AS n FROM org_members WHERE email = ${concurrentA.invite.email}`)[0].n), 1, "Email-scoped locking prevents duplicate stores");

    const revoked = await issue("revoked"), expired = await issue("expired");
    const revokedLink = await createSignupVerification(revoked.invite.email, "Revoked", revoked.inviteCode, "https://signup.example", db);
    const expiredLink = await createSignupVerification(expired.invite.email, "Expired", expired.inviteCode, "https://signup.example", db);
    await revokeSignupInvite(actor(), revoked.invite.id, db);
    await db`UPDATE hosted_signup_invites SET created_at = now()-interval '2 days', expires_at = now()-interval '1 second' WHERE id = ${expired.invite.id}`;
    equal(await acceptInvite(revokedLink.raw, db), null, "Revocation is rechecked after email delivery");
    equal(await acceptInvite(expiredLink.raw, db), null, "Code expiry is rechecked after email delivery");
    const limited = await issue("resend-limit");
    for (let attempt = 0; attempt < 10; attempt++) {
      await createSignupVerification(limited.invite.email, "Resend limit", limited.inviteCode, "https://signup.example", db);
      await db`UPDATE hosted_signup_verifications SET created_at = now()-interval '61 seconds' WHERE signup_invite_id = ${limited.invite.id}`;
    }
    await reject(() => createSignupVerification(limited.invite.email, "Resend limit", limited.inviteCode, "https://signup.example", db), "signup_rate_limited");
    const oldRaw = `inv_${randomBytes(24).toString("base64url")}`;
    await db`INSERT INTO invites (email, role, sha256_hash, created_by, expires_at, pending_name) VALUES (${`${prefix}-old@example.test`}, 'owner', ${sha256(oldRaw)}, 'signup', now()+interval '1 day', 'Old public signup')`;
    equal(await acceptInvite(oldRaw, db), null, "Old ungated pending signup links cannot bypass private admission");
    await assert.rejects(() => createInvite(1, `${prefix}-team-new@example.test`, "member", operatorEmail, "https://signup.example"), /verification are required/); checks++;
    const teamRaw = `inv_${randomBytes(24).toString("base64url")}`;
    await db`INSERT INTO invites (org_id, email, role, sha256_hash, created_by, expires_at) VALUES (1, ${`${prefix}-team-new@example.test`}, 'member', ${sha256(teamRaw)}, 'legacy-owner', now()+interval '1 day')`;
    equal(await acceptInvite(teamRaw, db), null, "Old team invitations cannot create a first-time account");

    // Existing people retain login. OAuth proofs cannot be swapped into the
    // console or another request and cannot consume a signup proof.
    const normalLogin = await createLoginInvite(first.invite.email, "https://signup.example");
    equal((await acceptInvite(normalLogin!.raw, db))?.org.id, accepted.org.id, "Existing members can still sign in without a new code");
    const boundLogin = await createLoginInvite(first.invite.email, "https://signup.example", "oar_signup_fixture");
    equal(await acceptInvite(boundLogin!.raw, db), null, "An OAuth-bound login proof is not a console/signup proof");
    equal(await acceptInvite(boundLogin!.raw, db, { purpose: "login", oauthRequestId: "oar_wrong", email: first.invite.email }), null, "Another OAuth request cannot consume the login proof");
    equal((await acceptInvite(boundLogin!.raw, db, { purpose: "login", oauthRequestId: "oar_signup_fixture", email: first.invite.email }))?.org.id, accepted.org.id, "The exact OAuth request can consume its own email proof");
    equal(await acceptInvite(links[0].raw, db, { purpose: "login", oauthRequestId: "oar_signup_fixture" }), null, "OAuth continuation cannot redeem signup verification");

    const existing = await issue("trial");
    await db`INSERT INTO orgs (id,name,slug,kind,brain_db,data_db,home_dir,provisioning_status) VALUES (${personalId}, 'Existing trial', ${prefix}, 'personal', ${`brain_org_${personalId}`}, ${`brain_org_${personalId}`}, ${`org-${personalId}`}, 'ready')`; orgIds.push(personalId);
    await db`INSERT INTO org_members (org_id,email,role) VALUES (${personalId},${existing.invite.email},'owner')`;
    await db`INSERT INTO workspace_billing (org_id,trial_ends_at) VALUES (${personalId},now()+interval '3 days')`;
    const originalBilling = (await db`SELECT row_to_json(b) AS value FROM workspace_billing b WHERE org_id = ${personalId}`)[0].value;
    const existingLink = await createSignupVerification(existing.invite.email, "Unused name", existing.inviteCode, "https://signup.example", db);
    // Simulate only the two local protocol responses: no request is allowed to
    // leave this process. A normal nudge just ran, so the ready-workspace
    // redemption and its operator revocation must bypass coalescing.
    let scheduledJobs = 0;
    process.env.ENGRAM_PROVISION_JOB = "projects/engram-test/locations/us-central1/jobs/engram-provision";
    globalThis.fetch = (async input => {
      const url = String(input);
      if (url === "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token") return Response.json({ access_token: "disposable-integration-token-never-real" });
      if (url === "https://run.googleapis.com/v2/projects/engram-test/locations/us-central1/jobs/engram-provision:run") { scheduledJobs++; return Response.json({}); }
      throw new Error("External calls are forbidden in signup integration");
    }) as typeof fetch;
    await triggerProvisioning();
    const beforeReadyAdmission = scheduledJobs;
    equal((await acceptInvite(existingLink.raw, db))?.org.id, personalId, "An existing verified personal trial is upgraded without a duplicate workspace");
    equal(scheduledJobs, beforeReadyAdmission + 1, "A ready personal admission schedules its job even inside the normal 15-second cooldown");
    let providerCalls = 0;
    const checkout = await handleBillingApi(new Request("https://signup.example/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "cloud" }) }), actor(existing.invite.email, "owner", "session", personalId), {
      db, settings: { mode: "hosted", publicUrl: "https://signup.example", secretKey: "sk_test_fixture", webhookSecret: "whsec_fixture", cloudMonthlyPriceId: "price_fixture" },
      fetch: (async () => { providerCalls++; throw new Error("No provider operation is permitted"); }) as typeof fetch,
    });
    equal([checkout.status, (await checkout.json()).code, providerCalls], [409, "complimentary_pending", 0], "Queued free admission cannot race a new paid Checkout");
    equal((await applySignupInviteAccess(db)).applied, 1, "The ready-workspace sweep applies its queued free grant");
    equal((await db`SELECT row_to_json(b) AS value FROM workspace_billing b WHERE org_id = ${personalId}`)[0].value, originalBilling, "The original trial and Stripe fields remain unchanged");
    const revokedResponse = await handleWeb(request(`/api/admin/signup-invites/${existing.invite.id}/revoke`, operatorSession, {}));
    equal([revokedResponse.status, (await revokedResponse.json()).revocationPending], [200, true], "A used code reports its asynchronous grant revocation");
    equal(scheduledJobs, beforeReadyAdmission + 2, "Immediate operator revocation schedules another job without being silently coalesced");
    globalThis.fetch = originalFetch; process.env.ENGRAM_PROVISION_JOB = "";
    equal((await applySignupInviteAccess(db)).revoked, 1, "Revocation is processed for ready workspaces without reprovisioning");
    equal((await db`SELECT revoked_at IS NOT NULL AS revoked FROM workspace_complimentary_access WHERE org_id = ${personalId}`)[0].revoked, true, "The exact code's free grant is revoked");
    equal((await db`SELECT row_to_json(b) AS value FROM workspace_billing b WHERE org_id = ${personalId}`)[0].value, originalBilling, "Revocation restores the independent original trial unchanged");

    const overlapId = personalId + 1, overlapEmail = `${prefix}-overlap@example.test`;
    equal(Number((await db`SELECT count(*) AS n FROM orgs WHERE id = ${overlapId}`)[0].n), 0, "Concurrent billing fixture cannot replace a workspace");
    await db`INSERT INTO orgs (id,name,slug,kind,brain_db,data_db,home_dir,provisioning_status) VALUES (${overlapId}, 'Concurrent grant', ${`${prefix}-overlap`}, 'personal', ${`brain_org_${overlapId}`}, ${`brain_org_${overlapId}`}, ${`org-${overlapId}`}, 'ready')`; orgIds.push(overlapId);
    const overlapOwner = Number((await db`INSERT INTO org_members (org_id,email,role) VALUES (${overlapId},${overlapEmail},'owner') RETURNING id`)[0].id);
    await db`INSERT INTO workspace_billing (org_id,trial_ends_at) VALUES (${overlapId},now()+interval '3 days')`;
    let waitingCheckout: Promise<Response> | undefined, overlapProviderCalls = 0;
    await db.begin(async tx => {
      await tx`SELECT org_id FROM workspace_billing WHERE org_id = ${overlapId} FOR UPDATE`;
      waitingCheckout = handleBillingApi(new Request("https://signup.example/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "cloud" }) }), actor(overlapEmail, "owner", "session", overlapId), {
        db, settings: { mode: "hosted", publicUrl: "https://signup.example", secretKey: "sk_test_fixture", webhookSecret: "whsec_fixture", cloudMonthlyPriceId: "price_fixture" },
        fetch: (async () => { overlapProviderCalls++; throw new Error("No provider operation is permitted"); }) as typeof fetch,
      });
      let overlapObserved = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await db`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF b%'`;
        if (waiting.length) { overlapObserved = true; break; }
        await Bun.sleep(5);
      }
      equal(overlapObserved, true, "Checkout is actually waiting with an old joined-read snapshot before the grant commits");
      await tx`INSERT INTO workspace_complimentary_access (id,org_id,owner_member_id) VALUES (${randomUUID()},${overlapId},${overlapOwner})`;
    });
    const afterGrantCheckout = await waitingCheckout!;
    equal([afterGrantCheckout.status, (await afterGrantCheckout.json()).code, overlapProviderCalls], [409, "complimentary_access", 0], "Checkout refreshes its snapshot after the grant's billing lock and makes no provider call");
    return checks;
  } finally {
    config.signupMode = priorMode;
    globalThis.fetch = originalFetch;
    if (priorJob === undefined) delete process.env.ENGRAM_PROVISION_JOB; else process.env.ENGRAM_PROVISION_JOB = priorJob;
    if (inviteIds.length) {
      await db`DELETE FROM hosted_signup_verifications WHERE signup_invite_id IN ${db(inviteIds)}`;
      await db`DELETE FROM hosted_signup_invites WHERE id IN ${db(inviteIds)}`;
    }
    if (orgIds.length) {
      await db`DELETE FROM complimentary_access_events WHERE org_id IN ${db(orgIds)}`;
      await db`DELETE FROM workspace_complimentary_access WHERE org_id IN ${db(orgIds)}`;
      await db`DELETE FROM sessions WHERE org_id IN ${db(orgIds)}`;
      await db`DELETE FROM invites WHERE org_id IN ${db(orgIds)}`;
      await db`DELETE FROM workspace_billing WHERE org_id IN ${db(orgIds)}`;
      await db`DELETE FROM org_members WHERE org_id IN ${db(orgIds)}`;
      await db`DELETE FROM orgs WHERE id IN ${db(orgIds)}`;
    }
    await db`DELETE FROM invites WHERE email LIKE ${`${prefix}%`}`;
    await db`DELETE FROM sessions WHERE email IN (${operatorEmail},${otherOwnerEmail})`;
    if (operatorId !== undefined) await db`DELETE FROM hosted_signup_operators WHERE member_id = ${operatorId}`;
    await db`DELETE FROM org_members WHERE email IN (${operatorEmail},${otherOwnerEmail})`;
    for (const id of orgIds.filter(id => id !== personalId)) {
      await closePool(`brain_org_${id}`);
      await db.unsafe(`DROP DATABASE IF EXISTS brain_org_${id} WITH (FORCE)`);
    }
  }
}
