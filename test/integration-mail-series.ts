// Runs only from the marked disposable real-PostgreSQL integration harness.
// Every provider delivery is injected; no mail or external call is permitted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { config } from "../gateway/src/config";
import { createLoginInvite, issueToken } from "../gateway/src/auth";
import { acceptInvite } from "../gateway/src/orgs";
import { createSignupVerification, issueSignupInvite } from "../gateway/src/signup-invites";
import { normalizeToken } from "../gateway/src/policies";
import { drainMailSeries, handleMailUnsubscribe, mailSeriesProof } from "../gateway/src/mail-series";
import { sha256 } from "../gateway/src/hash";
import { handleWeb } from "../gateway/src/web";

export async function checkMailSeries(db: postgres.Sql): Promise<number> {
  assert.equal((await db`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose, "engram-disposable-integration-v1");
  let checks = 1;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
  const prefix = `mail-${randomUUID()}`, operatorEmail = `${prefix}@example.test`;
  const orgIds: number[] = [], inviteIds: string[] = [];
  const oldFlag = process.env.ENGRAM_ONBOARDING_EMAILS, oldMode = config.signupMode, originalFetch = globalThis.fetch;
  const now = new Date(), day = 86_400_000;
  const env = { ENGRAM_ONBOARDING_EMAILS: "1", ENGRAM_MAIL_UNSUBSCRIBE_KEY: "disposable-mail-series-key-32-bytes-only", RESEND_API_KEY: "not-a-provider-key", ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_PUBLIC_URL: "https://mail.example.test" };
  const deliveries: any[] = [];
  let providerCalls = 0, operatorId = 0;
  const send = async (mail: any): Promise<"sent"> => { deliveries.push(mail); return "sent"; };
  const drain = (at: Date, extra: Record<string, unknown> = {}) => drainMailSeries({ db, env, now: at, send, ...extra });
  const fresh = async (suffix: string, ready = true, known = false) => {
    const actor = normalizeToken({ kind: "session", email: operatorEmail, name: operatorEmail, orgId: 1, role: "owner" });
    const issued = await issueSignupInvite(actor, `${prefix}-${suffix}@example.test`, undefined, db); inviteIds.push(issued.invite.id);
    if (known) await db`INSERT INTO org_members (org_id,email,role) VALUES (1,${issued.invite.email},'member')`;
    const proof = await createSignupVerification(issued.invite.email, `${suffix} workspace`, issued.inviteCode, env.ENGRAM_PUBLIC_URL, db);
    const [first, replay] = await Promise.all([acceptInvite(proof.raw, db), acceptInvite(proof.raw, db)]);
    const accepted = first ?? replay; assert.ok(accepted); orgIds.push(accepted.org.id);
    equal([first, replay].filter(Boolean).length, 1, "Concurrent verification produces one claim");
    const [enrollment] = await db`SELECT * FROM mail_series_enrollments WHERE org_id = ${accepted.org.id}`;
    if (ready) {
      await db`UPDATE orgs SET provisioning_status = 'ready' WHERE id = ${accepted.org.id}`;
      await db`INSERT INTO workspace_complimentary_access (id,org_id,owner_member_id) VALUES (${randomUUID()},${accepted.org.id},${accepted.member.id})`;
      await db`UPDATE hosted_signup_invites SET complimentary_applied_at = now() WHERE id = ${issued.invite.id}`;
    }
    return { ...accepted, enrollment, inviteId: issued.invite.id };
  };
  const cancel = async (id: string) => { await db`UPDATE mail_series_enrollments SET status = 'unsubscribed' WHERE id = ${id}`; };
  try {
    process.env.ENGRAM_ONBOARDING_EMAILS = "1"; config.signupMode = "invite-only";
    globalThis.fetch = (async () => { providerCalls++; throw new Error("External provider calls forbidden in mail-series integration"); }) as typeof fetch;
    operatorId = Number((await db`INSERT INTO org_members (org_id,email,role) VALUES (1,${operatorEmail},'owner') RETURNING id`)[0].id);
    await db`INSERT INTO hosted_signup_operators (member_id) VALUES (${operatorId})`;

    process.env.ENGRAM_ONBOARDING_EMAILS = "0";
    const disabled = await fresh("disabled"); equal(disabled.enrollment, undefined, "Feature-off signup does not enroll or backfill");
    process.env.ENGRAM_ONBOARDING_EMAILS = "1";
    const known = await fresh("existing-person", true, true);
    equal(known.enrollment, undefined, "Existing team members acquiring their personal workspace are not fresh-account enrollment");
    const delayed = await fresh("delayed", false);
    equal(Number((await db`SELECT count(*) AS n FROM mail_series_jobs WHERE enrollment_id = ${delayed.enrollment.id}`)[0].n), 4, "One verified signup atomically records four unique steps");
    const snapshot = JSON.stringify((await db`SELECT row_to_json(j) AS value FROM mail_series_jobs j WHERE enrollment_id = ${delayed.enrollment.id} ORDER BY ordinal`).map(row => row.value));
    const dry = await drain(new Date(now.getTime() + day), { dryRun: true });
    check(dry.due > 0 && dry.sent === 0, "Dry run reports due metadata without delivery");
    equal(JSON.stringify((await db`SELECT row_to_json(j) AS value FROM mail_series_jobs j WHERE enrollment_id = ${delayed.enrollment.id} ORDER BY ordinal`).map(row => row.value)), snapshot, "Dry run does not claim, prepare or mutate jobs");
    await drain(new Date(now.getTime() + day)); equal(deliveries.length, 0, "No welcome precedes workspace readiness and access grant");
    equal((await db`SELECT attempts FROM mail_series_jobs WHERE enrollment_id = ${delayed.enrollment.id} AND ordinal = 0`)[0].attempts, 0, "Readiness delays consume no provider attempt");
    await db`UPDATE orgs SET provisioning_status = 'ready' WHERE id = ${delayed.org.id}`;
    await db`INSERT INTO workspace_complimentary_access (id,org_id,owner_member_id) VALUES (${randomUUID()},${delayed.org.id},${delayed.member.id})`;
    const delayedAt = new Date(now.getTime() + 10 * day);
    const concurrent = await Promise.all([drain(delayedAt), drain(delayedAt)]);
    equal(concurrent.reduce((sum, row) => sum + row.sent, 0), 1, "Concurrent drainers send one leased welcome");
    equal(deliveries.length, 1, "Delayed readiness does not cascade overdue reminders");
    const [next] = await db`SELECT due_at FROM mail_series_jobs WHERE enrollment_id = ${delayed.enrollment.id} AND ordinal = 1`;
    equal(new Date(next.due_at).getTime(), delayedAt.getTime() + day, "Next reminder is spaced after actual welcome delivery");
    const login = await createLoginInvite(delayed.member.email, env.ENGRAM_PUBLIC_URL);
    assert.ok(login); await acceptInvite(login.raw, db);
    equal(Number((await db`SELECT count(*) AS n FROM mail_series_enrollments WHERE email = ${delayed.member.email}`)[0].n), 1, "Email login never re-enrolls an existing account");

    const raw = mailSeriesProof(delayed.enrollment.id, env.ENGRAM_MAIL_UNSUBSCRIBE_KEY);
    const optoutUrl = `${env.ENGRAM_PUBLIC_URL}/email/unsubscribe?token=${raw}`;
    equal((await db`SELECT unsubscribe_hash FROM mail_series_enrollments WHERE id = ${delayed.enrollment.id}`)[0].unsubscribe_hash, sha256(raw), "Only the unsubscribe proof hash is stored");
    const persisted = JSON.stringify((await db`SELECT prepared_payload FROM mail_series_jobs WHERE enrollment_id = ${delayed.enrollment.id}`).map(row => row.prepared_payload));
    equal(persisted.includes(raw), false, "Frozen retry payloads never persist raw unsubscribe proof");
    check(deliveries[0].headers["List-Unsubscribe"].includes(raw), "Actual delivery receives its one-click unsubscribe capability");
    equal(deliveries[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "One-click header is explicit");
    for (const method of ["GET", "HEAD"]) {
      const page = await handleWeb(new Request(optoutUrl, { method }));
      equal(page.status, 200, "Public HTTP scanner/HEAD confirmation succeeds without a session");
      equal(page.headers.get("set-cookie"), null, "Preference capability never mints an authentication cookie");
      equal(page.headers.get("referrer-policy"), "no-referrer", "Preference capability is not passed in outgoing referrers");
      const body = await page.text();
      equal(body.includes(raw), false, "Browser confirmation does not reflect the opaque proof into HTML");
      if (method === "HEAD") equal(body, "", "Preference HEAD has no response body");
    }
    equal((await db`SELECT status FROM mail_series_enrollments WHERE id = ${delayed.enrollment.id}`)[0].status, "active", "Link scanning never unsubscribes");
    equal((await handleMailUnsubscribe(new Request(optoutUrl.replace(raw.slice(-8), "AAAAAAAA"), { method: "POST" }), db)).status, 400, "Incorrect capability cannot change preferences");
    equal((await handleMailUnsubscribe(new Request(optoutUrl, { method: "POST", body: "List-Unsubscribe=One-Click" }), db)).status, 200, "A genuine one-click POST opts out");
    const browserSuccess = await handleWeb(new Request(optoutUrl, { method: "POST", headers: { Accept: "text/html" } }));
    equal(browserSuccess.status, 200, "Browser optout remains idempotent");
    check((await browserSuccess.text()).includes("PREFERENCE SAVED"), "Browser POST receives the shared branded success view");
    equal((await drain(new Date(now.getTime() + 30 * day))).sent, 0, "Unsubscribed users receive no later reminders");

    const retry = await fresh("retry"); const attempts: any[] = [];
    const failureAt = new Date(now.getTime() + 60_000);
    const failed = await drain(failureAt, { send: async (mail: any) => { attempts.push(mail); return "failed"; } });
    equal(failed.retried, 1, "Ambiguous/failed delivery schedules a bounded retry");
    await db`UPDATE orgs SET name = 'Renamed between attempts' WHERE id = ${retry.org.id}`;
    const successful = await drain(new Date(failureAt.getTime() + 16 * 60_000), { send: async (mail: any) => { attempts.push(mail); return "sent"; } });
    equal(successful.sent, 1, "Pending delivery retries successfully");
    equal(attempts[0], attempts[1], "Provider key and complete frozen payload remain identical across retries and workspace rename");
    await cancel(retry.enrollment.id);

    const crashed = await fresh("crash"); const crashPayloads: any[] = [];
    await assert.rejects(() => drain(failureAt, { send: async (mail: any) => { crashPayloads.push(mail); throw new Error("Simulated process loss after provider acceptance"); } })); checks++;
    equal((await db`SELECT status FROM mail_series_jobs WHERE enrollment_id = ${crashed.enrollment.id} AND ordinal = 0`)[0].status, "leased", "Provider ambiguity retains the durable prepared lease");
    equal((await drain(new Date(failureAt.getTime() + 60_000))).sent, 0, "Unexpired lease cannot be stolen");
    await drain(new Date(failureAt.getTime() + 3 * 60_000), { send: async (mail: any) => { crashPayloads.push(mail); return "sent"; } });
    equal(crashPayloads[0], crashPayloads[1], "Recovered expired lease uses the same provider idempotency key and full payload");
    await cancel(crashed.enrollment.id);

    const inFlight = await fresh("inflight");
    let startSend!: () => void, finishSend!: () => void;
    const started = new Promise<void>(resolve => { startSend = resolve; });
    const finish = new Promise<void>(resolve => { finishSend = resolve; });
    const running = drain(failureAt, { send: async () => { startSend(); await finish; return "sent"; } });
    await started;
    const inFlightUrl = `${env.ENGRAM_PUBLIC_URL}/email/unsubscribe?token=${mailSeriesProof(inFlight.enrollment.id, env.ENGRAM_MAIL_UNSUBSCRIBE_KEY)}`;
    let optoutReturned = false;
    const stopping = handleMailUnsubscribe(new Request(inFlightUrl, { method: "POST" }), db).then(response => { optoutReturned = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 30));
    equal(optoutReturned, false, "Optout serializes with a provider call already in flight");
    finishSend(); await running;
    equal((await stopping).status, 200, "Optout completes after the in-flight call and cancels subsequent steps");
    equal((await drain(new Date(failureAt.getTime() + 8 * day))).sent, 0, "No previously leased message sends after successful optout returns");

    const horizon = await fresh("horizon"); let horizonCalls = 0;
    await drain(failureAt, { send: async () => { horizonCalls++; return "failed"; } });
    await drain(new Date(failureAt.getTime() + 23 * 60 * 60_000));
    equal(horizonCalls, 1, "No provider retry occurs after the idempotency horizon");
    equal((await db`SELECT status,error_code FROM mail_series_jobs WHERE enrollment_id = ${horizon.enrollment.id} AND ordinal = 0`)[0], { status: "failed", error_code: "retry_exhausted" }, "Expired retries retain a safe terminal reason");
    await cancel(horizon.enrollment.id);

    const bounded = await fresh("bounded"); let boundedCalls = 0;
    const overdueAt = new Date(now.getTime() + 10 * day);
    for (const minute of [0, 16, 47, 108, 229]) await drain(new Date(overdueAt.getTime() + minute * 60_000), { send: async () => { boundedCalls++; return "failed"; } });
    equal(boundedCalls, 5, "A failed delivery has at most five provider attempts");
    const [boundedNext] = await db`SELECT due_at FROM mail_series_jobs WHERE enrollment_id = ${bounded.enrollment.id} AND ordinal = 1`;
    check(new Date(boundedNext.due_at).getTime() >= overdueAt.getTime() + (229 * 60_000) + day, "Fifth failure spaces an overdue next reminder instead of a catch-up burst");
    await cancel(bounded.enrollment.id);

    const rotation = await fresh("rotation");
    await drain(failureAt, { send: async () => "failed" });
    const rotated = await drain(new Date(failureAt.getTime() + 16 * 60_000), { env: { ...env, ENGRAM_MAIL_UNSUBSCRIBE_KEY: "another-disposable-key-with-32-bytes" } });
    check(rotated.sent === 0 && rotated.failed > 0, "Signing-key rotation fails closed rather than changing an idempotent retry body");
    await cancel(rotation.enrollment.id);

    const revoked = await fresh("revoked");
    await db`UPDATE hosted_signup_invites SET revoked_at = now() WHERE id = ${revoked.inviteId}`;
    equal((await drain(failureAt)).canceled, 1, "Revoked invitation cancels the series before calling provider");
    const removed = await fresh("removed");
    await db`UPDATE org_members SET role = 'member' WHERE id = ${removed.member.id}`;
    equal((await drain(failureAt)).canceled, 1, "Owner access demotion cancels series before provider");
    const expiredGrant = await fresh("expiredgrant");
    await db`UPDATE workspace_complimentary_access SET revoked_at = now() WHERE org_id = ${expiredGrant.org.id}`;
    equal((await drain(failureAt)).canceled, 1, "Previously applied but revoked free access cancels rather than deferring forever");

    const progress = await fresh("progress");
    await drain(failureAt); // Welcome is useful even if core progress is complete.
    const agent1 = `mail-agent-${randomUUID()}`, agent2 = `mail-agent-${randomUUID()}`;
    await issueToken(progress.org.id, agent1); await issueToken(progress.org.id, agent2);
    const receiptAt = new Date(now.getTime() + 2 * 60_000);
    // Failed and foreign receipts must not make an unused key count as connected.
    await db`INSERT INTO audit_log (org_id,token_name,tool,outcome,ts) VALUES (${progress.org.id},${agent1},'remember','error',${receiptAt}), (2,${agent1},'recall','ok',${receiptAt})`;
    const connect = await drain(new Date(failureAt.getTime() + day));
    equal(connect.sent, 1, "Unused keys, failed receipts and foreign workspace successes do not suppress a useful reminder");
    await db`INSERT INTO audit_log (org_id,token_name,tool,outcome,ts) VALUES (${progress.org.id},${agent1},'remember','ok',${receiptAt}),(${progress.org.id},${agent1},'recall','ok',${receiptAt}),(${progress.org.id},${agent2},'whoami','ok',${receiptAt})`;
    equal((await drain(new Date(failureAt.getTime() + 3 * day))).skipped, 1, "Successful agent save and recall skip completed memory reminder");
    equal((await drain(new Date(failureAt.getTime() + 7 * day))).skipped, 1, "Two actually contacted agents skip second-agent reminder");
    equal((await db`SELECT status FROM mail_series_enrollments WHERE id = ${progress.enrollment.id}`)[0].status, "completed", "The finite four-step sequence terminates");
    equal(providerCalls, 0, "No external request escaped the local provider stubs");
  } finally {
    globalThis.fetch = originalFetch; config.signupMode = oldMode;
    if (oldFlag === undefined) delete process.env.ENGRAM_ONBOARDING_EMAILS; else process.env.ENGRAM_ONBOARDING_EMAILS = oldFlag;
    if (orgIds.length) {
      await db`DELETE FROM mail_series_enrollments WHERE org_id = ANY(${orgIds})`;
      await db`DELETE FROM hosted_signup_verifications WHERE signup_invite_id = ANY(${inviteIds}::uuid[])`;
      await db`DELETE FROM hosted_signup_invites WHERE id = ANY(${inviteIds}::uuid[])`;
      await db`DELETE FROM invites WHERE email LIKE ${`${prefix}%`}`;
      await db`DELETE FROM workspace_complimentary_access WHERE org_id = ANY(${orgIds})`;
      await db`DELETE FROM workspace_billing WHERE org_id = ANY(${orgIds})`;
      await db`DELETE FROM tokens WHERE org_id = ANY(${orgIds})`;
      await db`DELETE FROM sessions WHERE org_id = ANY(${orgIds})`;
      await db`DELETE FROM org_members WHERE org_id = ANY(${orgIds})`;
      await db`DELETE FROM audit_log WHERE token_name LIKE ${'mail-agent-%'}`;
      await db`DELETE FROM orgs WHERE id = ANY(${orgIds})`;
    }
    if (operatorId) { await db`DELETE FROM hosted_signup_operators WHERE member_id = ${operatorId}`; await db`DELETE FROM org_members WHERE email LIKE ${`${prefix}%`}`; }
  }
  return checks;
}
