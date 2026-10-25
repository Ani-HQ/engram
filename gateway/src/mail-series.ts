import { createHmac, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "./db";
import { sha256 } from "./hash";
import { oauthActorName } from "./oauth";
import { renderEmail, type OnboardingEmailId } from "./mail-templates";
import { mailPreferencePage, type MailPreferenceState } from "./mail-preference-view";
import { sendMail } from "./mail";

const DAY = 86_400_000;
const RETRY_HORIZON = 23 * 60 * 60_000; // Resend retains idempotency keys for 24 hours.
const LEASE_MS = 2 * 60_000;
const PLACEHOLDER = "ENGRAM_MAIL_UNSUBSCRIBE_PROOF_PLACEHOLDER";
const STEPS: readonly OnboardingEmailId[] = ["welcome", "connect-agent", "first-memory", "second-agent"];
const OFFSETS = [0, DAY, 3 * DAY, 7 * DAY];
const SAFE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };

export function preflightMailSeries(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.ENGRAM_ONBOARDING_EMAILS === "1";
  const missing: string[] = [];
  if (enabled) {
    if (Buffer.byteLength((env.ENGRAM_MAIL_UNSUBSCRIBE_KEY ?? "").trim()) < 32) missing.push("ENGRAM_MAIL_UNSUBSCRIBE_KEY");
    if (!(env.RESEND_API_KEY ?? "").trim() || env.RESEND_API_KEY?.trim() === "unset") missing.push("RESEND_API_KEY");
    try {
      const url = new URL(env.ENGRAM_PUBLIC_URL ?? "");
      if (url.username || url.password || !["http:", "https:"].includes(url.protocol) || (env.ENGRAM_DEPLOYMENT_MODE === "hosted" && url.protocol !== "https:")) throw new Error();
    } catch { missing.push("ENGRAM_PUBLIC_URL"); }
  }
  return { enabled, ready: !enabled || missing.length === 0, missing };
}

// Called only inside the successful, fresh personal signup claim transaction.
// There is deliberately no migration backfill, login or team-invitation hook.
export async function enrollMailSeries(db: postgres.Sql, input: { orgId: number; memberId: number; email: string; signupInviteId: string }, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.ENGRAM_ONBOARDING_EMAILS !== "1") return;
  const id = randomUUID();
  const rows = await db`INSERT INTO mail_series_enrollments (id, org_id, member_id, email, signup_invite_id, enrolled_at)
    VALUES (${id}, ${input.orgId}, ${input.memberId}, ${input.email}, ${input.signupInviteId}, ${now})
    ON CONFLICT (org_id) DO NOTHING RETURNING id`;
  if (!rows.length) return;
  for (let ordinal = 0; ordinal < STEPS.length; ordinal++) {
    await db`INSERT INTO mail_series_jobs (id, enrollment_id, step, ordinal, due_at)
      VALUES (${randomUUID()}, ${id}, ${STEPS[ordinal]}, ${ordinal}, ${new Date(now.getTime() + OFFSETS[ordinal])})`;
  }
}

export function mailSeriesProof(id: string, key: string): string {
  return `${id}.${createHmac("sha256", key).update(`engram/mail-series/unsubscribe/v1/${id}`).digest("base64url")}`;
}

function proofParts(raw: string): { id: string; hash: string } | null {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  return { id: raw.slice(0, 36), hash: sha256(raw) };
}

// Public capability endpoint: GET never changes state, including link scanners.
// POST accepts the RFC8058 one-click body as well as the confirmation form.
export async function handleMailUnsubscribe(req: Request, db: postgres.Sql = sql): Promise<Response> {
  const url = new URL(req.url), token = url.searchParams.get("token") ?? "", proof = proofParts(token);
  const page = (state: MailPreferenceState, status = 200) => new Response(req.method === "HEAD" ? null : mailPreferencePage(state), { status, headers: { ...SAFE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
  if (!["GET", "HEAD", "POST"].includes(req.method)) return new Response("Method Not Allowed", { status: 405, headers: { ...SAFE_HEADERS, Allow: "GET, HEAD, POST" } });
  if (!proof) return page("unavailable", 400);
  if (req.method === "POST") {
    const changed = await db.begin(async tx => {
      const [row] = await tx`SELECT id FROM mail_series_enrollments WHERE id = ${proof.id} AND unsubscribe_hash = ${proof.hash} FOR UPDATE`;
      if (!row) return false;
      await tx`UPDATE mail_series_enrollments SET status = 'unsubscribed', stopped_at = coalesce(stopped_at, now()), stop_reason = 'unsubscribed' WHERE id = ${proof.id}`;
      await tx`UPDATE mail_series_jobs SET status = 'canceled', lease_token = NULL, lease_until = NULL
        WHERE enrollment_id = ${proof.id} AND status IN ('pending', 'leased')`;
      return true;
    });
    if (req.headers.get("accept")?.includes("text/html")) return page(changed ? "unsubscribed" : "unavailable", changed ? 200 : 400);
    return new Response(changed ? "You have unsubscribed from Engram onboarding emails. Sign-in and essential account emails are unchanged." : "This unsubscribe link is unavailable.", { status: changed ? 200 : 400, headers: SAFE_HEADERS });
  }
  const [row] = await db`SELECT id FROM mail_series_enrollments WHERE id = ${proof.id} AND unsubscribe_hash = ${proof.hash}`;
  if (!row) return page("unavailable", 400);
  // A relative, fixed action keeps the opaque proof in the current URL. It is
  // not embedded in scripts, third-party assets, response metadata or logs.
  return page("confirm");
}

type Progress = { agents: number; saved: boolean; recalled: boolean };
export function mailStepComplete(step: OnboardingEmailId, progress: Progress): boolean {
  return step === "connect-agent" ? progress.agents > 0 : step === "first-memory" ? progress.saved && progress.recalled : step === "second-agent" ? progress.agents > 1 : false;
}

async function progressFor(db: postgres.Sql, orgId: number, now: Date): Promise<Progress> {
  const credentials = await db`
    SELECT t.name AS agent, t.created_at AS since FROM tokens t
      LEFT JOIN org_members m ON m.id = t.issued_by_member_id AND m.org_id = t.org_id AND m.email = t.issued_by_email
    WHERE t.org_id = ${orgId} AND t.role = 'agent' AND t.revoked_at IS NULL AND left(t.name, 25) <> 'operator-candidate-smoke-'
      AND (t.issuer_kind IN ('operator', 'legacy') OR (t.issuer_kind = 'member' AND m.id IS NOT NULL AND m.role IN ('owner', 'member')))`;
  const oauth = await db`SELECT r.email, r.client_id, m.created_at AS since
    FROM oauth_refresh_tokens r JOIN org_members m ON m.id = r.membership_id AND m.org_id = r.org_id AND m.email = r.email
    WHERE r.org_id = ${orgId} AND r.revoked_at IS NULL AND r.expires_at > ${now} AND m.role IN ('owner','member')
    GROUP BY r.email, r.client_id, m.created_at`;
  const identities = [...credentials, ...oauth.map(row => ({ agent: oauthActorName({ sub: String(row.email), client_id: String(row.client_id) }), since: row.since }))];
  if (!identities.length) return { agents: 0, saved: false, recalled: false };
  const [row] = await db`SELECT count(DISTINCT a.token_name)::int AS agents,
      coalesce(bool_or(a.tool IN ('remember','put_page')), false) AS saved,
      coalesce(bool_or(a.tool IN ('recall','search','get_page')), false) AS recalled
    FROM audit_log a JOIN unnest(${identities.map(item => String(item.agent))}::text[], ${identities.map(item => new Date(item.since).toISOString())}::timestamptz[]) AS eligible(agent,since)
      ON a.token_name = eligible.agent AND a.ts >= eligible.since
    WHERE a.org_id = ${orgId} AND a.outcome = 'ok' AND a.ts <= ${now}
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.org_id = a.org_id AND s.name = a.token_name
        AND a.ts >= s.created_at AND a.ts <= least(s.expires_at, coalesce(s.revoked_at,s.expires_at)))`;
  return { agents: Number(row.agents), saved: row.saved === true, recalled: row.recalled === true };
}

type Frozen = { to: string; subject: string; text: string; html: string; unsubscribeUrl: string };
function hydrate(payload: Frozen, token: string) {
  return { to: payload.to, subject: payload.subject, text: payload.text.replaceAll(PLACEHOLDER, token), html: payload.html.replaceAll(PLACEHOLDER, token),
    headers: { "List-Unsubscribe": `<${payload.unsubscribeUrl.replace(PLACEHOLDER, token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
}

export async function drainMailSeries(options: { db?: postgres.Sql; dryRun?: boolean; now?: Date; limit?: number; send?: typeof sendMail; env?: NodeJS.ProcessEnv } = {}) {
  const db = options.db ?? sql, env = options.env ?? process.env, now = options.now ?? new Date(), preflight = preflightMailSeries(env);
  const counts = { enabled: preflight.enabled, dryRun: options.dryRun === true, blocked: !preflight.ready, due: 0, sent: 0, skipped: 0, retried: 0, failed: 0, canceled: 0, pending: 0 };
  if (!preflight.enabled) return counts;
  const count = async () => {
    const [row] = await db`SELECT count(*) FILTER (WHERE j.due_at <= ${now})::int AS due, count(*)::int AS pending
      FROM mail_series_jobs j JOIN mail_series_enrollments e ON e.id = j.enrollment_id WHERE e.status = 'active' AND j.status IN ('pending','leased')`;
    counts.due = Number(row.due); counts.pending = Number(row.pending);
  };
  await count();
  if (options.dryRun || !preflight.ready) return counts;
  const key = env.ENGRAM_MAIL_UNSUBSCRIBE_KEY!.trim(), origin = new URL(env.ENGRAM_PUBLIC_URL!).origin;
  const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 25)));
  for (let index = 0; index < limit; index++) {
    // Claim and prepare before the provider call. A crash after acceptance can
    // retry only this frozen payload, with its deterministic idempotency key.
    const claim = await db.begin(async tx => {
      // Every mutation locks the enrollment before its jobs, matching optout.
      const [enrollment] = await tx`SELECT e.* FROM mail_series_enrollments e WHERE e.status = 'active'
        AND EXISTS (SELECT 1 FROM mail_series_jobs j WHERE j.enrollment_id = e.id AND j.due_at <= ${now}
          AND (j.status = 'pending' OR (j.status = 'leased' AND j.lease_until <= ${now}))
          AND NOT EXISTS (SELECT 1 FROM mail_series_jobs prior WHERE prior.enrollment_id = j.enrollment_id AND prior.ordinal < j.ordinal AND prior.status NOT IN ('sent','skipped','failed')))
        ORDER BY e.enrolled_at, e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`;
      if (!enrollment) return null;
      const [selected] = await tx`SELECT j.* FROM mail_series_jobs j WHERE j.enrollment_id = ${enrollment.id} AND j.due_at <= ${now}
        AND (j.status = 'pending' OR (j.status = 'leased' AND j.lease_until <= ${now}))
        AND NOT EXISTS (SELECT 1 FROM mail_series_jobs prior WHERE prior.enrollment_id = j.enrollment_id AND prior.ordinal < j.ordinal AND prior.status NOT IN ('sent','skipped','failed'))
        ORDER BY j.ordinal FOR UPDATE LIMIT 1`;
      const job = selected ? { ...selected, org_id: enrollment.org_id, member_id: enrollment.member_id, email: enrollment.email, unsubscribe_hash: enrollment.unsubscribe_hash } : null;
      if (!job) return null;
      if (Number(job.attempts) >= 5 || (job.first_attempt_at && now.getTime() - new Date(job.first_attempt_at).getTime() >= RETRY_HORIZON)) {
        await tx`UPDATE mail_series_jobs SET status = 'failed', error_code = 'retry_exhausted', completed_at = ${now}, lease_until = NULL, lease_token = NULL WHERE id = ${job.id}`;
        await tx`UPDATE mail_series_jobs SET due_at = greatest(due_at, ${new Date(now.getTime() + (OFFSETS[Number(job.ordinal) + 1] - OFFSETS[Number(job.ordinal)] || DAY))}) WHERE enrollment_id = ${job.enrollment_id} AND ordinal = ${Number(job.ordinal) + 1} AND status = 'pending'`;
        return { exhausted: true };
      }
      const token = mailSeriesProof(String(job.enrollment_id), key), hash = sha256(token);
      if (job.unsubscribe_hash && job.unsubscribe_hash !== hash) {
        await tx`UPDATE mail_series_jobs SET status = 'failed', error_code = 'key_changed', completed_at = ${now}, lease_until = NULL, lease_token = NULL WHERE id = ${job.id}`;
        return { exhausted: true };
      }
      let payload = job.prepared_payload as Frozen | null;
      if (!payload) {
        const [org] = await tx`SELECT name FROM orgs WHERE id = ${job.org_id}`;
        const unsubscribeUrl = `${origin}/email/unsubscribe?token=${PLACEHOLDER}`;
        const target = job.step === 'first-memory' ? 'memory' : job.step === 'welcome' ? 'activity' : 'connect';
        const rendered = renderEmail({ template: job.step as OnboardingEmailId, appUrl: `${origin}/app#${target}`, unsubscribeUrl, orgName: String(org.name) });
        payload = { to: String(job.email), subject: rendered.subject, text: rendered.text, html: rendered.html, unsubscribeUrl };
      }
      const lease = randomUUID();
      await tx`UPDATE mail_series_enrollments SET unsubscribe_hash = ${hash} WHERE id = ${job.enrollment_id}`;
      await tx`UPDATE mail_series_jobs SET status = 'leased', lease_token = ${lease}, lease_until = ${new Date(now.getTime() + LEASE_MS)},
        first_attempt_at = coalesce(first_attempt_at, ${now}), prepared_payload = ${tx.json(payload)}, attempts = attempts + 1 WHERE id = ${job.id}`;
      return { ...job, payload, token, lease, exhausted: false };
    });
    if (!claim) break;
    if (claim.exhausted) { counts.failed++; continue; }
    await db.begin(async tx => {
      // Serialize optout with sending. Once unsubscribe returns successfully,
      // no previously leased message can pass this guard and send later.
      const [enrollment] = await tx`SELECT * FROM mail_series_enrollments WHERE id = ${claim.enrollment_id} FOR UPDATE`;
      const [job] = await tx`SELECT * FROM mail_series_jobs WHERE id = ${claim.id} FOR UPDATE`;
      if (!enrollment || enrollment.status !== 'active' || job?.status !== 'leased' || job.lease_token !== claim.lease) return;
      const [member] = await tx`SELECT id FROM org_members WHERE id = ${enrollment.member_id} AND org_id = ${enrollment.org_id} AND email = ${enrollment.email} AND role = 'owner' FOR SHARE`;
      const [admission] = await tx`SELECT i.*, op.revoked_at AS operator_revoked, creator.role AS operator_role
        FROM hosted_signup_invites i JOIN hosted_signup_operators op ON op.member_id = i.created_by_member_id
        JOIN org_members creator ON creator.id = op.member_id AND creator.org_id = 1
        WHERE i.id = ${enrollment.signup_invite_id} FOR SHARE OF i, op, creator`;
      const [org] = await tx`SELECT * FROM orgs WHERE id = ${enrollment.org_id} FOR SHARE`;
      const canceled = !member || !org || !admission || !admission.redeemed_at || admission.redeemed_org_id !== enrollment.org_id || admission.redeemed_owner_member_id !== enrollment.member_id || admission.email !== enrollment.email
        || admission.revoked_at || admission.complimentary_revoked_at || admission.operator_revoked || admission.operator_role !== 'owner';
      if (canceled) {
        await tx`UPDATE mail_series_enrollments SET status = 'canceled', stopped_at = ${now}, stop_reason = ${!member ? 'membership_removed' : 'access_revoked'} WHERE id = ${enrollment.id}`;
        await tx`UPDATE mail_series_jobs SET status = 'canceled', lease_token = NULL, lease_until = NULL WHERE enrollment_id = ${enrollment.id} AND status IN ('pending','leased')`;
        counts.canceled++; return;
      }
      const [grant] = await tx`SELECT id FROM workspace_complimentary_access WHERE org_id = ${org.id} AND owner_member_id = ${enrollment.member_id} AND revoked_at IS NULL AND granted_at <= ${now} AND (expires_at IS NULL OR expires_at > ${now}) FOR SHARE`;
      if (admission.complimentary_applied_at && !grant) {
        await tx`UPDATE mail_series_enrollments SET status = 'canceled', stopped_at = ${now}, stop_reason = 'access_revoked' WHERE id = ${enrollment.id}`;
        await tx`UPDATE mail_series_jobs SET status = 'canceled', lease_token = NULL, lease_until = NULL WHERE enrollment_id = ${enrollment.id} AND status IN ('pending','leased')`;
        counts.canceled++; return;
      }
      if (org.provisioning_status !== 'ready' || !grant) {
        // Provisioning delays do not consume delivery attempts or the provider
        // retry horizon. No welcome precedes ready + applied free access.
        await tx`UPDATE mail_series_jobs SET status = 'pending', due_at = ${new Date(now.getTime() + 15 * 60_000)}, attempts = attempts - 1,
          first_attempt_at = CASE WHEN attempts = 1 THEN NULL ELSE first_attempt_at END, lease_token = NULL, lease_until = NULL WHERE id = ${job.id}`;
        return;
      }
      const complete = mailStepComplete(job.step, await progressFor(tx as unknown as postgres.Sql, Number(org.id), now));
      let status = 'skipped';
      if (!complete) {
        const delivery = await (options.send ?? sendMail)({ ...hydrate(claim.payload, claim.token), idempotencyKey: `engram-onboarding-v1-${job.id}` });
        if (delivery !== 'sent') {
          const exhausted = Number(job.attempts) >= 5;
          await tx`UPDATE mail_series_jobs SET status = ${exhausted ? 'failed' : 'pending'}, error_code = ${exhausted ? 'retry_exhausted' : 'delivery_failed'},
            due_at = ${new Date(now.getTime() + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** (Number(job.attempts) - 1)))},
            completed_at = ${exhausted ? now : null}, lease_token = NULL, lease_until = NULL WHERE id = ${job.id}`;
          if (exhausted) {
            counts.failed++;
            await tx`UPDATE mail_series_jobs SET due_at = greatest(due_at, ${new Date(now.getTime() + (OFFSETS[Number(job.ordinal) + 1] - OFFSETS[Number(job.ordinal)] || DAY))}) WHERE enrollment_id = ${enrollment.id} AND ordinal = ${Number(job.ordinal) + 1} AND status = 'pending'`;
          } else counts.retried++;
          return;
        }
        status = 'sent'; counts.sent++;
      } else counts.skipped++;
      await tx`UPDATE mail_series_jobs SET status = ${status}, completed_at = ${now}, lease_token = NULL, lease_until = NULL, error_code = NULL WHERE id = ${job.id}`;
      await tx`UPDATE mail_series_enrollments SET last_step_at = ${now} WHERE id = ${enrollment.id}`;
      const gap = OFFSETS[Number(job.ordinal) + 1] - OFFSETS[Number(job.ordinal)];
      if (Number(job.ordinal) < 3) {
        await tx`UPDATE mail_series_jobs SET due_at = greatest(due_at, ${new Date(now.getTime() + gap)}) WHERE enrollment_id = ${enrollment.id} AND ordinal = ${Number(job.ordinal) + 1} AND status = 'pending'`;
      } else await tx`UPDATE mail_series_enrollments SET status = 'completed', stopped_at = ${now}, stop_reason = 'finished' WHERE id = ${enrollment.id}`;
    });
  }
  await count();
  return counts;
}
