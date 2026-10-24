#!/usr/bin/env bun
// Operator-only entitlement management. No HTTP grant surface, migrations,
// credential output, payment requests, or implicit production execution.
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { BILLING_SCHEMA_VERSION } from "../gateway/src/billing-schema";
import { OwnerCheckError, withOperatorDatabase } from "./check-owners";

type Operation = "inspect" | "grant" | "revoke";
export interface ComplimentarySettings {
  operation: Operation; project: "ani-hq"; orgId: 1; workspaceName: "Ani HQ";
  ownerEmail: string; requestId: string | null; reason: string | null;
  expiresAt: string | null; grantId: string | null; run: boolean;
}
export function complimentarySettings(args: string[], now = new Date()): ComplimentarySettings {
  const operation = args[0] as Operation;
  if (!["inspect", "grant", "revoke"].includes(operation)) throw new OwnerCheckError("invalid_complimentary_operation");
  const values: Record<string, string> = {};
  let run = false;
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === "--run" && !run) { run = true; continue; }
    if (!["--project", "--org", "--workspace-name", "--owner-email", "--request-id", "--reason", "--expires-at", "--grant-id"].includes(key) || values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new OwnerCheckError("invalid_complimentary_arguments");
    values[key] = args[++i];
  }
  // This launch helper is intentionally limited to the explicitly authorized
  // workspace. It never defaults a missing target or promotes membership.
  if (values["--project"] !== "ani-hq" || values["--org"] !== "1" || values["--workspace-name"] !== "Ani HQ") throw new OwnerCheckError("complimentary_target_not_authorized");
  const ownerEmail = values["--owner-email"] ?? "";
  if (ownerEmail.length > 254 || ownerEmail !== ownerEmail.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new OwnerCheckError("normalized_owner_email_required");
  const requestId = values["--request-id"] ?? null, reason = values["--reason"] ?? null;
  if (operation !== "inspect" && (!requestId || !/^[A-Za-z0-9][A-Za-z0-9:._-]{7,119}$/.test(requestId) || !reason || reason.trim() !== reason || reason.length > 300 || /[\u0000-\u001f\u007f]/.test(reason))) throw new OwnerCheckError("audited_request_required");
  if (operation === "inspect" && (requestId || reason)) throw new OwnerCheckError("invalid_complimentary_arguments");
  const expiresAt = values["--expires-at"] ?? null, grantId = values["--grant-id"] ?? null;
  if (expiresAt && (operation !== "grant" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt || Date.parse(expiresAt) <= now.getTime())) throw new OwnerCheckError("future_expiration_required");
  if (operation === "revoke" ? !grantId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(grantId) : grantId !== null) throw new OwnerCheckError("exact_grant_id_required");
  return { operation, project: "ani-hq", orgId: 1, workspaceName: "Ani HQ", ownerEmail, requestId, reason, expiresAt, grantId, run };
}

function validated(options: ComplimentarySettings, now: Date) {
  return complimentarySettings([options.operation, "--project", options.project, "--org", String(options.orgId), "--workspace-name", options.workspaceName, "--owner-email", options.ownerEmail,
    ...(options.requestId ? ["--request-id", options.requestId] : []), ...(options.reason ? ["--reason", options.reason] : []),
    ...(options.expiresAt ? ["--expires-at", options.expiresAt] : []), ...(options.grantId ? ["--grant-id", options.grantId] : []), ...(options.run ? ["--run"] : [])], now);
}
function access(row: any, now: Date) {
  if (!row) return null;
  const grantedAt = new Date(row.granted_at).toISOString(), expiresAt = row.expires_at === null ? null : new Date(row.expires_at).toISOString();
  const revokedAt = row.revoked_at === null ? null : new Date(row.revoked_at).toISOString();
  return { grantId: String(row.id), active: revokedAt === null && (expiresAt === null || Date.parse(expiresAt) > now.getTime()), grantedAt, expiresAt, revokedAt };
}

export async function manageComplimentaryAccess(db: postgres.Sql, supplied: ComplimentarySettings, now = new Date()) {
  const options = validated(supplied, now);
  if (!options.run) throw new OwnerCheckError("explicit_execution_required");
  const work = async (tx: postgres.TransactionSql) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '5s'`;
    const schema = await tx`SELECT billing_version FROM public.engram_schema_state WHERE id = true`;
    if (schema[0]?.billing_version !== BILLING_SCHEMA_VERSION) throw new OwnerCheckError("complimentary_schema_not_ready");
    const rows = options.operation === "inspect"
      ? await tx`SELECT o.id, o.name, o.brain_db, o.data_db, o.home_dir, o.provisioning_status, m.id AS member_id
          FROM public.orgs o JOIN public.org_members m ON m.org_id = o.id
          WHERE o.id = ${options.orgId} AND o.name = ${options.workspaceName} AND m.email = ${options.ownerEmail} AND m.role = 'owner'`
      : await tx`SELECT o.id, o.name, o.brain_db, o.data_db, o.home_dir, o.provisioning_status, m.id AS member_id
          FROM public.orgs o JOIN public.org_members m ON m.org_id = o.id
          WHERE o.id = ${options.orgId} AND o.name = ${options.workspaceName} AND m.email = ${options.ownerEmail} AND m.role = 'owner' FOR UPDATE OF o, m`;
    const target = rows[0];
    if (rows.length !== 1 || target.id !== 1 || target.name !== options.workspaceName || target.brain_db !== "brain_shared" || target.data_db !== "engram_gateway" || target.home_dir !== "brain" || target.provisioning_status !== "ready" || !Number.isSafeInteger(Number(target.member_id))) throw new OwnerCheckError("complimentary_owner_workspace_mismatch");
    if (options.operation !== "inspect") await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`engram/complimentary/${options.orgId}`}, 0))`;
    const current = (await tx`SELECT id, org_id, granted_at, expires_at, revoked_at FROM public.workspace_complimentary_access WHERE org_id = ${options.orgId}`)[0];
    if (options.operation === "inspect") return { ok: true, operation: "inspect", orgId: options.orgId, ownerVerified: true, workspaceVerified: true, complimentary: access(current, now) };
    const payloadHash = createHash("sha256").update(JSON.stringify([options.operation, options.orgId, options.workspaceName, options.ownerEmail, Number(target.member_id), options.expiresAt, options.grantId, options.reason])).digest("hex");
    const prior = (await tx`SELECT grant_id, payload_hash, operation FROM public.complimentary_access_events WHERE org_id = ${options.orgId} AND request_id = ${options.requestId!}`)[0];
    if (prior) {
      if (prior.payload_hash !== payloadHash || prior.operation !== options.operation) throw new OwnerCheckError("complimentary_request_conflict");
      return { ok: true, operation: options.operation, replayed: true, orgId: options.orgId, ownerVerified: true, workspaceVerified: true, grantId: String(prior.grant_id), complimentary: access(current, now), stripeBillingChanged: false };
    }
    let grantId: string;
    if (options.operation === "grant") {
      if (access(current, now)?.active) throw new OwnerCheckError("complimentary_grant_already_active");
      grantId = randomUUID();
      await tx`INSERT INTO public.workspace_complimentary_access (id, org_id, owner_member_id, expires_at)
        VALUES (${grantId}, ${options.orgId}, ${Number(target.member_id)}, ${options.expiresAt})
        ON CONFLICT (org_id) DO UPDATE SET id = EXCLUDED.id, owner_member_id = EXCLUDED.owner_member_id,
          granted_at = now(), expires_at = EXCLUDED.expires_at, revoked_at = NULL`;
    } else {
      if (!current || String(current.id) !== options.grantId) throw new OwnerCheckError("complimentary_grant_mismatch");
      if (current.revoked_at !== null) throw new OwnerCheckError("complimentary_already_revoked");
      grantId = String(current.id);
      const updated = await tx`UPDATE public.workspace_complimentary_access SET revoked_at = now() WHERE org_id = ${options.orgId} AND id = ${grantId} AND revoked_at IS NULL RETURNING id`;
      if (updated.length !== 1) throw new OwnerCheckError("complimentary_revoke_conflict");
    }
    await tx`INSERT INTO public.complimentary_access_events (id, org_id, grant_id, owner_member_id, operation, request_id, payload_hash, operator_role, reason, expires_at)
      VALUES (${randomUUID()}, ${options.orgId}, ${grantId}, ${Number(target.member_id)}, ${options.operation}, ${options.requestId!}, ${payloadHash}, current_user, ${options.reason!}, ${options.operation === "grant" ? options.expiresAt : current.expires_at})`;
    const verified = (await tx`SELECT id, org_id, granted_at, expires_at, revoked_at FROM public.workspace_complimentary_access WHERE org_id = ${options.orgId}`)[0];
    if (!verified || String(verified.id) !== grantId || (options.operation === "grant" ? verified.revoked_at !== null : verified.revoked_at === null)) throw new OwnerCheckError("complimentary_verification_failed");
    return { ok: true, operation: options.operation, replayed: false, orgId: options.orgId, ownerVerified: true, workspaceVerified: true, grantId, complimentary: access(verified, now), stripeBillingChanged: false };
  };
  return options.operation === "inspect" ? db.begin("isolation level repeatable read read only", work) : db.begin(work);
}

export function complimentaryFailure(error: unknown) {
  const sqlState = error instanceof OwnerCheckError ? error.diagnostic?.sqlState : undefined;
  return { ok: false, operation: "complimentary_access", reason: error instanceof OwnerCheckError ? error.code : "complimentary_unavailable",
    ...(typeof sqlState === "string" && /^[A-Z0-9]{5}$/.test(sqlState) ? { diagnostic: { sqlState } } : {}) };
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  try {
    const options = complimentarySettings(process.argv.slice(2));
    if (!options.run) console.log(JSON.stringify({ mode: "plan", operation: options.operation, project: options.project, orgId: options.orgId, expectedWorkspace: options.workspaceName, currentOwnerRequired: true, ownerEmailProvided: true, expiresAt: options.expiresAt, exactGrantRequired: options.operation === "revoke", audited: options.operation !== "inspect", paymentRequests: false, migrations: false, execute: false }));
    else console.log(JSON.stringify(await withOperatorDatabase({ project: options.project, region: "us-central1", instance: "engram-pg", run: true }, options.operation === "inspect" ? "read-only" : "write", db => manageComplimentaryAccess(db, options), controller.signal)));
  } catch (error) {
    console.log(JSON.stringify(complimentaryFailure(error)));
    process.exitCode = 1;
  }
}
