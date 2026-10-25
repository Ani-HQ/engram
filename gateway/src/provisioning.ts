import { databaseSecurity } from "./config";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql, ensureDatabase, migrateTenantDataTables } from "./db";
import { getOrg } from "./orgs";
import { provisionerPool } from "./tenant-db";

type SignupAccessResult = { applied: number; revoked: number; failed: number };

function assertProvisioner(): void {
  if (databaseSecurity.authority === "runtime") throw new Error("This identity cannot provision workspaces");
}

function accessEventHash(operation: "grant" | "revoke", invite: any, grantId: string): string {
  return createHash("sha256").update(JSON.stringify([operation, String(invite.id), Number(invite.redeemed_org_id), Number(invite.redeemed_owner_member_id), grantId,
    invite.access_duration_days ?? null, invite.access_expires_at ? new Date(invite.access_expires_at).toISOString() : null])).digest("hex");
}

async function applySignupInviteAccessInTransaction(tx: postgres.TransactionSql, orgId?: number, lease?: string, inviteId?: string): Promise<SignupAccessResult> {
  const result = { applied: 0, revoked: 0, failed: 0 };
  // Lock admission before workspace/member rows, matching redemption's order.
  // A code revoked concurrently with this job is either observed now or picked
  // up by the next job; a revoked code can never create a fresh grant.
  const invites = inviteId !== undefined
    ? await tx`SELECT i.* FROM hosted_signup_invites i
        WHERE i.id = ${inviteId} AND i.redeemed_at IS NOT NULL AND i.redeemed_org_id IS NOT NULL
          AND ((i.revoked_at IS NOT NULL AND i.complimentary_revoked_at IS NULL)
            OR (i.revoked_at IS NULL AND i.complimentary_applied_at IS NULL AND i.complimentary_revoked_at IS NULL
              AND (i.complimentary_retry_at IS NULL OR i.complimentary_retry_at <= now())))
        ORDER BY i.id FOR UPDATE OF i`
    : await tx`SELECT i.* FROM hosted_signup_invites i
        WHERE i.redeemed_at IS NOT NULL AND i.redeemed_org_id = ${orgId}
          AND ((i.revoked_at IS NOT NULL AND i.complimentary_revoked_at IS NULL)
            OR (i.revoked_at IS NULL AND i.complimentary_applied_at IS NULL AND i.complimentary_revoked_at IS NULL))
        ORDER BY i.id FOR UPDATE OF i`;
  for (const invite of invites) {
    const targetId = Number(invite.redeemed_org_id), ownerId = Number(invite.redeemed_owner_member_id);
    const org = (await tx`SELECT id, kind, brain_db, data_db, home_dir, provisioning_status, provisioning_lease_token FROM orgs WHERE id = ${targetId} FOR UPDATE`)[0];
    if (!org || org.kind !== "personal" || org.brain_db !== `brain_org_${targetId}` || org.data_db !== `brain_org_${targetId}` || org.home_dir !== `org-${targetId}` || !Number.isSafeInteger(ownerId) || ownerId < 1) {
      throw new Error("Signup complimentary workspace does not match redemption");
    }
    if (lease !== undefined && org.provisioning_lease_token !== lease) throw new Error("Signup workspace provisioning lease changed");
    if (inviteId !== undefined && invite.revoked_at === null && org.provisioning_status !== "ready") continue;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`engram/complimentary/${targetId}`}, 0))`;
    const current = (await tx`SELECT id, owner_member_id, expires_at, revoked_at,
      revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AS active
      FROM workspace_complimentary_access WHERE org_id = ${targetId} FOR UPDATE`)[0];
    if (invite.revoked_at !== null) {
      // Removing access remains possible after the creator or recipient loses
      // membership. Never revoke a later, independent operator grant.
      const grantId = invite.complimentary_grant_id ? String(invite.complimentary_grant_id) : null;
      if (grantId && current && String(current.id) === grantId) {
        if (Number(current.owner_member_id) !== ownerId) throw new Error("Signup complimentary owner does not match redemption");
        await tx`UPDATE workspace_complimentary_access SET revoked_at = COALESCE(revoked_at, now()) WHERE org_id = ${targetId} AND id = ${grantId}`;
        await tx`INSERT INTO complimentary_access_events (id, org_id, grant_id, owner_member_id, operation, request_id, payload_hash, operator_role, reason, expires_at)
          VALUES (${randomUUID()}, ${targetId}, ${grantId}, ${ownerId}, 'revoke', ${`signup-invite:${invite.id}:revoke`}, ${accessEventHash("revoke", invite, grantId)}, current_user, 'Hosted private beta invite revoked', ${current.expires_at})
          ON CONFLICT (org_id, request_id) DO NOTHING`;
      }
      await tx`UPDATE hosted_signup_invites SET complimentary_revoked_at = now(), complimentary_error_code = NULL, complimentary_retry_at = NULL WHERE id = ${invite.id}`;
      result.revoked++;
      continue;
    }
    const owner = (await tx`SELECT id FROM org_members WHERE id = ${ownerId} AND org_id = ${targetId} AND email = ${invite.email} AND role = 'owner' FOR UPDATE`)[0];
    const operator = await tx`SELECT m.id FROM org_members m JOIN hosted_signup_operators p ON p.member_id = m.id
      WHERE m.id = ${invite.created_by_member_id} AND m.org_id = 1 AND m.role = 'owner' AND p.revoked_at IS NULL FOR SHARE OF m, p`;
    if (!owner || operator.length !== 1) throw new Error("Signup complimentary admission is no longer authorized");
    const billing = (await tx`SELECT stripe_customer_id, stripe_subscription_id, checkout_session_id FROM workspace_billing WHERE org_id = ${targetId} FOR UPDATE`)[0];
    if (billing?.stripe_customer_id || billing?.stripe_subscription_id || billing?.checkout_session_id) throw new Error("Signup complimentary access cannot replace a payment relationship");
    if (current?.active) throw new Error("Signup complimentary access cannot replace an active independent grant");
    const grantId = randomUUID();
    const grantStartsAt = invite.redeemed_at, grantExpiresAt = invite.access_expires_at;
    await tx`INSERT INTO workspace_complimentary_access (id, org_id, owner_member_id, granted_at, expires_at) VALUES (${grantId}, ${targetId}, ${ownerId}, ${grantStartsAt}, ${grantExpiresAt})
      ON CONFLICT (org_id) DO UPDATE SET id = EXCLUDED.id, owner_member_id = EXCLUDED.owner_member_id,
        granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at, revoked_at = NULL`;
    await tx`INSERT INTO complimentary_access_events (id, org_id, grant_id, owner_member_id, operation, request_id, payload_hash, operator_role, reason, expires_at)
      VALUES (${randomUUID()}, ${targetId}, ${grantId}, ${ownerId}, 'grant', ${`signup-invite:${invite.id}:grant`}, ${accessEventHash("grant", invite, grantId)}, current_user, 'Hosted private beta invite redeemed', ${grantExpiresAt})`;
    await tx`UPDATE hosted_signup_invites SET complimentary_applied_at = now(), complimentary_grant_id = ${grantId}, complimentary_error_code = NULL, complimentary_retry_at = NULL WHERE id = ${invite.id}`;
    result.applied++;
  }
  return result;
}

export async function applySignupInviteAccess(supplied?: postgres.Sql): Promise<SignupAccessResult> {
  assertProvisioner();
  const db = supplied ?? (databaseSecurity.legacy ? sql : provisionerPool("engram_gateway"));
  try {
    const result = { applied: 0, revoked: 0, failed: 0 };
    const candidates = await db`SELECT i.id FROM hosted_signup_invites i
      WHERE i.redeemed_at IS NOT NULL AND i.redeemed_org_id IS NOT NULL
        AND ((i.revoked_at IS NOT NULL AND i.complimentary_revoked_at IS NULL)
          OR (i.revoked_at IS NULL AND i.complimentary_applied_at IS NULL AND i.complimentary_revoked_at IS NULL
            AND (i.complimentary_retry_at IS NULL OR i.complimentary_retry_at <= now())
            AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = i.redeemed_org_id AND o.provisioning_status = 'ready')))
      ORDER BY i.id`;
    for (const candidate of candidates) {
      try {
        // A bad ready-workspace admission must not roll back another person's
        // grant or prevent unrelated pending storage from being provisioned.
        const applied = await db.begin(tx => applySignupInviteAccessInTransaction(tx, undefined, undefined, String(candidate.id)));
        result.applied += applied.applied;
        result.revoked += applied.revoked;
      } catch {
        await db`UPDATE hosted_signup_invites SET complimentary_error_code = 'signup_access_unavailable', complimentary_retry_at = now() + interval '5 minutes'
          WHERE id = ${candidate.id} AND complimentary_revoked_at IS NULL
            AND (complimentary_applied_at IS NULL OR revoked_at IS NOT NULL)`;
      }
    }
    // Backoff is not success: retain a visible failure count until a later
    // authorized retry or revocation resolves each quarantined admission.
    result.failed = Number((await db`SELECT count(*) AS n FROM hosted_signup_invites WHERE complimentary_error_code IS NOT NULL`)[0].n);
    return result;
  }
  finally { if (!supplied && db !== sql) await db.end({ timeout: 2 }); }
}

// A durable row is the queue. A runtime may enqueue deterministic bindings, but
// only a separately credentialed provisioner can create their storage. Leases
// recover interrupted jobs; per-database advisory locks serialize actual DDL.
export async function provisionPendingWorkspaces(limit = 100): Promise<{ ready: number; failed: number; pending: number }> {
  assertProvisioner();
  const db = databaseSecurity.legacy ? sql : provisionerPool("engram_gateway");
  try {
    // Ready workspaces need revocation and delayed admission reconciliation too.
    const reconciled = await applySignupInviteAccess(db);
    let ready = 0, failed = reconciled.failed;
    for (let count = 0; count < Math.max(1, Math.min(1000, limit)); count++) {
      const lease = randomUUID();
      const claim = await db`
        WITH candidate AS (
          SELECT id FROM orgs
          WHERE brain_db != 'pending' AND data_db != 'pending' AND home_dir != 'pending'
            AND (provisioning_status = 'pending'
              OR (provisioning_status = 'failed' AND provisioning_retry_at <= now())
              OR (provisioning_status = 'provisioning' AND provisioning_lease_until < now()))
          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE orgs SET provisioning_status = 'provisioning', provisioning_attempts = provisioning_attempts + 1,
          provisioning_lease_until = now() + interval '5 minutes', provisioning_lease_token = ${lease}, provisioning_error_code = NULL
        WHERE id = (SELECT id FROM candidate) RETURNING id`;
      if (!claim.length) break;
      const id = Number(claim[0].id);
      try {
        const org = await getOrg(id);
        if (!org) throw new Error("workspace missing");
        await ensureDatabase(org.brainDb);
        if (org.dataDb !== "engram_gateway") await migrateTenantDataTables(org.dataDb);
        const finalized = await db.begin(async tx => {
          // Admission and readiness become visible at the same commit. An invalid
          // admission cannot leave a workspace reporting ready without its grant.
          await applySignupInviteAccessInTransaction(tx, id, lease);
          return tx`UPDATE orgs SET provisioning_status = 'ready', provisioned_at = now(), provisioning_lease_until = NULL,
              provisioning_lease_token = NULL, provisioning_retry_at = NULL, provisioning_error_code = NULL
            WHERE id = ${id} AND provisioning_lease_token = ${lease} RETURNING id`;
        });
        if (finalized.length) ready++;
      } catch {
        // No SQL, credential, database URL, or private engine text in job status.
        await db`
          UPDATE orgs SET provisioning_status = 'failed', provisioning_lease_until = NULL,
            provisioning_lease_token = NULL,
            provisioning_retry_at = now() + interval '5 minutes', provisioning_error_code = 'storage_setup_failed'
          WHERE id = ${id} AND provisioning_lease_token = ${lease}`;
        failed++;
      }
    }
    const pending = Number((await db`SELECT count(*) AS n FROM orgs WHERE provisioning_status <> 'ready'`)[0].n);
    return { ready, failed, pending };
  } finally { if (db !== sql) await db.end({ timeout: 2 }); }
}
