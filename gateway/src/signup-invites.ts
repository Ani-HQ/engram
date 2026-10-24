import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { config } from "./config";
import { sql } from "./db";
import { sha256 } from "./hash";
import { normalizeEmail, type OrgMember } from "./orgs";
import { normalizeToken, type TokenRecord } from "./policies";

export class SignupInviteError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invite_invalid") { super(message); }
}

export function signupPolicy(mode = config.signupMode) {
  return { mode, complimentary: true, verificationRequired: true, inviteCodeRequired: mode === "invite-only" };
}

export async function canManageSignupInvites(token: TokenRecord, db: postgres.Sql = sql): Promise<boolean> {
  const actor = normalizeToken(token);
  if (actor.kind !== "session" || actor.role !== "owner" || actor.orgId !== 1 || !actor.email) return false;
  const rows = await db`
    SELECT m.id FROM hosted_signup_operators o JOIN org_members m ON m.id = o.member_id
    WHERE o.revoked_at IS NULL AND m.org_id = 1 AND m.role = 'owner' AND m.email = ${actor.email}`;
  return rows.length === 1;
}

async function requireOperator(token: TokenRecord, db: postgres.Sql) {
  const actor = normalizeToken(token);
  if (actor.kind !== "session" || actor.role !== "owner" || actor.orgId !== 1 || !actor.email) {
    throw new SignupInviteError("Only the signup operator can manage invitation codes.", 403, "forbidden");
  }
  const rows = await db`
    SELECT m.id FROM hosted_signup_operators o JOIN org_members m ON m.id = o.member_id
    WHERE o.revoked_at IS NULL AND m.org_id = 1 AND m.role = 'owner' AND m.email = ${actor.email}
    FOR SHARE OF m`;
  if (rows.length !== 1) throw new SignupInviteError("Only the signup operator can manage invitation codes.", 403, "forbidden");
  return Number(rows[0].id);
}

function iso(value: unknown): string | null { return value == null ? null : new Date(String(value)).toISOString(); }
export function publicSignupInvite(row: any) {
  return {
    id: String(row.id), email: String(row.email), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at), redeemedAt: iso(row.redeemed_at),
    redeemedOrgId: row.redeemed_org_id == null ? null : Number(row.redeemed_org_id), accessExpiresAt: null,
    complimentaryAppliedAt: iso(row.complimentary_applied_at), complimentaryRevokedAt: iso(row.complimentary_revoked_at),
    complimentaryErrorCode: row.complimentary_error_code === "signup_access_unavailable" ? "signup_access_unavailable" : null,
    complimentaryRetryAt: iso(row.complimentary_retry_at),
  };
}

export async function issueSignupInvite(token: TokenRecord, email: string, expiresAt: unknown = undefined, db: postgres.Sql = sql, now = new Date()) {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 254) throw new SignupInviteError("Enter a valid email.");
  const expiry = expiresAt === undefined ? new Date(now.getTime() + 7 * 86_400_000) : new Date(typeof expiresAt === "string" ? expiresAt : "");
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime() || expiry.getTime() > now.getTime() + 30 * 86_400_000) {
    throw new SignupInviteError("Invitation expiry must be within the next 30 days.");
  }
  const inviteCode = `eg_inv_${randomBytes(24).toString("base64url")}`;
  const invite = await db.begin(async tx => {
    const operator = await requireOperator(token, tx as unknown as postgres.Sql);
    const rows = await tx`
      INSERT INTO hosted_signup_invites (id, code_hash, email, created_by_member_id, expires_at)
      VALUES (${randomUUID()}, ${sha256(inviteCode)}, ${normalized}, ${operator}, ${expiry}) RETURNING *`;
    return publicSignupInvite(rows[0]);
  });
  return { invite, inviteCode };
}

export async function listSignupInvites(token: TokenRecord, db: postgres.Sql = sql) {
  return db.begin("isolation level repeatable read read only", async tx => {
    if (!await canManageSignupInvites(token, tx as unknown as postgres.Sql)) throw new SignupInviteError("Only the signup operator can manage invitation codes.", 403, "forbidden");
    const rows = await tx`SELECT * FROM hosted_signup_invites ORDER BY created_at DESC, id DESC LIMIT 101`;
    return { invites: rows.slice(0, 100).map(publicSignupInvite), more: rows.length > 100 };
  });
}

export async function revokeSignupInvite(token: TokenRecord, id: string, db: postgres.Sql = sql) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new SignupInviteError("Invitation not found.", 404);
  return db.begin(async tx => {
    await requireOperator(token, tx as unknown as postgres.Sql);
    const rows = await tx`UPDATE hosted_signup_invites SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${id} RETURNING *`;
    if (!rows.length) throw new SignupInviteError("Invitation not found.", 404);
    const row = rows[0];
    return { invite: publicSignupInvite(row), revocationPending: row.redeemed_at !== null && row.complimentary_revoked_at === null };
  });
}

function invalidInvite(): never { throw new SignupInviteError("That invitation code is invalid, expired, or unavailable for this email."); }

// This function sends no mail and creates no account. A valid code authorizes
// only a verification link to its exact mailbox; final consumption happens in
// the same transaction that creates/binds the verified personal workspace.
export async function createSignupVerification(email: string, name: string, inviteCode: string, publicUrl: string, db: postgres.Sql = sql) {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 254 || !/^eg_inv_[A-Za-z0-9_-]{32}$/.test(inviteCode)) invalidInvite();
  const pendingName = name.trim() || `${normalized.split("@")[0]}'s memory`;
  if (pendingName.length > 100) throw new SignupInviteError("Workspace names can contain up to 100 characters.");
  // Separate namespace/table: an older runtime cannot accept this as an
  // ungated pending-name signup while a candidate is being staged/rolled back.
  const raw = `svf_${randomBytes(24).toString("base64url")}`;
  await db.begin(async tx => {
    const rows = await tx`
      SELECT i.* FROM hosted_signup_invites i
      JOIN hosted_signup_operators op ON op.member_id = i.created_by_member_id AND op.revoked_at IS NULL
      JOIN org_members creator ON creator.id = op.member_id AND creator.org_id = 1 AND creator.role = 'owner'
      WHERE i.code_hash = ${sha256(inviteCode)} AND i.email = ${normalized}
        AND i.revoked_at IS NULL AND i.redeemed_at IS NULL AND i.expires_at > now()
      FOR UPDATE OF i`;
    if (rows.length !== 1) invalidInvite();
    await eligiblePersonalWorkspace(tx as unknown as postgres.Sql, normalized);
    const sent = (await tx`SELECT count(*)::integer AS n, max(created_at) > now() - interval '60 seconds' AS cooling_down
      FROM hosted_signup_verifications WHERE signup_invite_id = ${rows[0].id} AND created_at > now() - interval '1 day'`)[0];
    if (Number(sent.n) >= 10 || sent.cooling_down === true) throw new SignupInviteError("Please wait before requesting another verification email.", 429, "signup_rate_limited");
    await tx`UPDATE hosted_signup_verifications SET accepted_at = now() WHERE signup_invite_id = ${rows[0].id} AND accepted_at IS NULL`;
    await tx`INSERT INTO hosted_signup_verifications (id, signup_invite_id, email, token_hash, expires_at, pending_name)
      VALUES (${randomUUID()}, ${rows[0].id}, ${normalized}, ${sha256(raw)}, least(${rows[0].expires_at}::timestamptz, now() + interval '1 day'), ${pendingName})`;
  });
  return { raw, url: `${publicUrl.replace(/\/$/, "")}/app#join=${raw}` };
}

// A complimentary code must never mask a current/pending payment relationship.
// Only an owned personal workspace can be upgraded; team entitlements stay put.
export async function eligiblePersonalWorkspace(db: postgres.Sql, email: string): Promise<{ orgId: number; member: OrgMember } | null> {
  const rows = await db`
    SELECT o.id AS org_id, m.id AS member_id, m.email
    FROM orgs o JOIN org_members m ON m.org_id = o.id AND m.email = ${email} AND m.role = 'owner'
    WHERE o.kind = 'personal' ORDER BY o.id LIMIT 1`;
  if (!rows.length) return null;
  const row = rows[0];
  // Checkout holds this same row while binding a provider customer/session.
  // Read the payment relationship after that lock, using a fresh snapshot.
  const billing = (await db`SELECT stripe_customer_id, stripe_subscription_id, checkout_session_id FROM workspace_billing WHERE org_id = ${row.org_id} FOR UPDATE`)[0];
  const access = (await db`SELECT id, expires_at, revoked_at FROM workspace_complimentary_access WHERE org_id = ${row.org_id}`)[0];
  const admitted = await db`SELECT id FROM hosted_signup_invites WHERE redeemed_org_id = ${row.org_id} AND revoked_at IS NULL LIMIT 1`;
  if (billing?.stripe_customer_id || billing?.stripe_subscription_id || billing?.checkout_session_id ||
      admitted.length ||
      (access && !access.revoked_at && (!access.expires_at || new Date(access.expires_at).getTime() > Date.now()))) {
    throw new SignupInviteError("This personal workspace already has billing or complimentary access. Sign in to manage it.", 409, "signup_account_ineligible");
  }
  return { orgId: Number(row.org_id), member: { id: Number(row.member_id), orgId: Number(row.org_id), email: String(row.email), role: "owner" } };
}
