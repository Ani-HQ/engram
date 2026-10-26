import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { parseMcpIntegration, type McpIntegration } from "./mcp-request-context";
import type { TokenRecord } from "./policies";

export const INTEGRATION_CHECKS_PER_ACTOR = 8;
export const INTEGRATION_CHECKS_PER_ORG = 256;
export const INTEGRATION_CHECK_TTL_MS = 15 * 60 * 1000;
export type IntegrationContext = { runId?: unknown; integration?: unknown; probeId?: unknown; verification?: unknown; credentialKey?: unknown };
export type IntegrationUse = {
  declaration: McpIntegration | null; declaredAt: string | null; lastSeenAt: string | null;
  connected: boolean; recallVerified: boolean; saveVerified: boolean;
  workflowCheck: "not-checked" | "pending" | "passed" | "expired";
  checkStartedAt: string | null; checkedAt: string | null; checkExpiresAt: string | null;
  automaticWorkflowVerified: null;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const date = (value: unknown): string | null => { const at = value ? new Date(value as string).getTime() : NaN; return Number.isFinite(at) ? new Date(at).toISOString() : null; };
const runId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const probeId = (value: unknown): value is string => typeof value === "string" && /^emp_[A-Za-z0-9_-]{32}$/.test(value);
export function integrationDeclaration(value: unknown): McpIntegration | null { try { return parseMcpIntegration(value); } catch { return null; } }
function scope(options: IntegrationContext) {
  const declaration = integrationDeclaration(options.integration);
  if (!declaration || !runId(options.runId) || typeof options.credentialKey !== "string" || !/^[a-f0-9]{64}$/.test(options.credentialKey)) return null;
  return { declaration, declarationHash: hash(declaration), runHash: hash(options.runId), credentialKey: options.credentialKey };
}

/** Declarations describe the client; they never attest that an agent used memory
 * automatically. The server-derived credential digest is never returned. */
export async function recordIntegrationDeclaration(tx: postgres.Sql, actor: TokenRecord, actorKey: string, options: IntegrationContext): Promise<void> {
  const declaration = integrationDeclaration(options.integration);
  if (typeof options.credentialKey !== "string" || !/^[a-f0-9]{64}$/.test(options.credentialKey)) return;
  if (!declaration) {
    await tx`UPDATE memory_connection_usage SET integration_check = NULL, integration_check_probe_hash = NULL,
      integration_credential_key = ${options.credentialKey}
      WHERE org_id = ${actor.orgId} AND actor_key = ${actorKey} AND integration_credential_key IS DISTINCT FROM ${options.credentialKey}`;
    return;
  }
  const encoded = tx.json(declaration);
  await tx`UPDATE memory_connection_usage SET
    integration_check = CASE WHEN integration_declaration IS DISTINCT FROM ${encoded}::jsonb OR integration_credential_key IS DISTINCT FROM ${options.credentialKey} THEN NULL ELSE integration_check END,
    integration_check_probe_hash = CASE WHEN integration_declaration IS DISTINCT FROM ${encoded}::jsonb OR integration_credential_key IS DISTINCT FROM ${options.credentialKey} THEN NULL ELSE integration_check_probe_hash END,
    integration_declared_at = CASE WHEN integration_declaration IS DISTINCT FROM ${encoded}::jsonb THEN now() ELSE coalesce(integration_declared_at, now()) END,
    integration_declaration = ${encoded}::jsonb, integration_credential_key = ${options.credentialKey}
    WHERE org_id = ${actor.orgId} AND actor_key = ${actorKey}`;
}
type CheckRow = { started_at: unknown; expires_at: unknown; recall_at?: unknown; save_at?: unknown };
function checkView(row: CheckRow | undefined, now = Date.now()) {
  const startedAt = date(row?.started_at), expiresAt = date(row?.expires_at), recallAt = date(row?.recall_at), saveAt = date(row?.save_at);
  const passed = !!(startedAt && expiresAt && recallAt && saveAt && Date.parse(recallAt) >= Date.parse(startedAt) && Date.parse(saveAt) >= Date.parse(startedAt) && Date.parse(recallAt) <= Date.parse(expiresAt) && Date.parse(saveAt) <= Date.parse(expiresAt));
  return { status: !row ? "not-found" : passed ? "passed" : expiresAt && Date.parse(expiresAt) <= now ? "expired" : "pending",
    startedAt, expiresAt, checkedAt: passed ? [recallAt!, saveAt!].sort().at(-1)! : null,
    recallVerified: !!recallAt, saveVerified: !!saveAt, automaticWorkflowVerified: null };
}
async function cacheCheck(tx: postgres.Sql, actor: TokenRecord, actorKey: string, nonce: string, row: CheckRow, begin = false) {
  const probeHash = hash(nonce), view = tx.json(checkView(row));
  await tx`UPDATE memory_connection_usage SET integration_check = ${view}::jsonb, integration_check_probe_hash = ${probeHash}
    WHERE org_id = ${actor.orgId} AND actor_key = ${actorKey}
      AND (${begin} OR integration_check_probe_hash = ${probeHash})`;
}
/** Explicit, bounded compatibility probes correlate actual gateway receipts.
 * They prove a read/save sequence, never automatic model invocation. */
export async function integrationVerification(tx: postgres.Sql, actor: TokenRecord, actorKey: string, options: IntegrationContext) {
  const identity = scope(options);
  if (!identity || !["begin", "status"].includes(String(options.verification))) throw new Error("Verification needs an authenticated task and integration declaration.");
  if (options.verification === "begin") {
    if (options.probeId !== undefined) throw new Error("Begin verification without a probe ID.");
    await tx`DELETE FROM memory_integration_checks WHERE org_id = ${actor.orgId} AND expires_at <= now()`;
    const nonce = `emp_${randomBytes(24).toString("base64url")}`;
    const [row] = await tx`INSERT INTO memory_integration_checks(org_id, actor_key, probe_hash, run_hash, credential_key, declaration_hash)
      SELECT ${actor.orgId}, ${actorKey}, ${hash(nonce)}, ${identity.runHash}, ${identity.credentialKey}, ${identity.declarationHash}
      WHERE (SELECT count(*) FROM memory_integration_checks WHERE org_id = ${actor.orgId} AND actor_key = ${actorKey}) < ${INTEGRATION_CHECKS_PER_ACTOR}
        AND (SELECT count(*) FROM memory_integration_checks WHERE org_id = ${actor.orgId}) < ${INTEGRATION_CHECKS_PER_ORG}
      RETURNING started_at, expires_at, recall_at, save_at`;
    if (!row) throw new Error("Verification capacity reached. Continue without running a compatibility check.");
    return { nonce, row: row as CheckRow, begin: true, verification: { probeId: nonce, ...checkView(row as CheckRow) } };
  }
  if (!probeId(options.probeId)) throw new Error("Verification status needs the issued probe ID.");
  const [row] = await tx`SELECT started_at, expires_at, recall_at, save_at FROM memory_integration_checks
    WHERE org_id = ${actor.orgId} AND actor_key = ${actorKey} AND probe_hash = ${hash(options.probeId)}
      AND run_hash = ${identity.runHash} AND credential_key = ${identity.credentialKey} AND declaration_hash = ${identity.declarationHash}`;
  return { nonce: options.probeId, row: row as CheckRow | undefined, begin: false, verification: { probeId: options.probeId, ...checkView(row as CheckRow | undefined) } };
}
export async function cacheIntegrationVerification(tx: postgres.Sql, actor: TokenRecord, actorKey: string, check: Awaited<ReturnType<typeof integrationVerification>>) {
  if (check.row) await cacheCheck(tx, actor, actorKey, check.nonce, check.row, check.begin);
}
export async function recordIntegrationReceipt(tx: postgres.Sql, actor: TokenRecord, actorKey: string, options: IntegrationContext, recall: boolean, save: boolean) {
  const identity = scope(options);
  if (!identity || !probeId(options.probeId) || (!recall && !save)) return;
  const [row] = await tx`UPDATE memory_integration_checks SET
      recall_at = CASE WHEN ${recall} THEN coalesce(recall_at, now()) ELSE recall_at END,
      save_at = CASE WHEN ${save} THEN coalesce(save_at, now()) ELSE save_at END
    WHERE org_id = ${actor.orgId} AND actor_key = ${actorKey} AND probe_hash = ${hash(options.probeId)}
      AND run_hash = ${identity.runHash} AND credential_key = ${identity.credentialKey} AND declaration_hash = ${identity.declarationHash}
      AND expires_at > now()
    RETURNING started_at, expires_at, recall_at, save_at`;
  if (row) await cacheCheck(tx, actor, actorKey, options.probeId, row as CheckRow);
}
export function mapIntegrationUse(row?: Record<string, any>, now = Date.now()): IntegrationUse {
  const data = row?.integration_data, declaration = integrationDeclaration(data?.declaration), check = data?.check;
  const started = date(check?.startedAt), expires = date(check?.expiresAt), checked = date(check?.checkedAt);
  const status = check?.status === "passed" && started && checked && expires && Date.parse(checked) >= Date.parse(started) && Date.parse(checked) <= Date.parse(expires) ? "passed"
    : ["pending", "expired"].includes(check?.status) && started && expires ? Date.parse(expires) <= now ? "expired" : "pending" : "not-checked";
  return { declaration, declaredAt: date(data?.declaredAt), lastSeenAt: date(row?.last_seen_at), connected: !!row,
    recallVerified: date(row?.last_recall_at) !== null, saveVerified: date(row?.last_remember_at) !== null,
    workflowCheck: status, checkStartedAt: started, checkedAt: status === "passed" ? checked : null, checkExpiresAt: expires,
    automaticWorkflowVerified: null };
}
