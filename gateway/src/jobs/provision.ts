import { databaseSecurity } from "../config";
import { closeDatabasePools, migrate, sql } from "../db";
import { provisionPendingWorkspaces } from "../provisioning";
import { failureCode } from "../diagnostics";

export async function main(): Promise<void> {
  if (databaseSecurity.authority !== "provisioner") throw new Error("Separate provisioner authority is required for this job");
  try {
    const jevOwnerEmail = process.env.ENGRAM_JEV_OPERATOR_EMAIL?.trim();
    const rawWorkspaceId = process.env.ENGRAM_JEV_OPERATOR_WORKSPACE_ID?.trim();
    if (rawWorkspaceId && (!jevOwnerEmail || !/^[1-9]\d{0,9}$/.test(rawWorkspaceId) || Number(rawWorkspaceId) > 2147483647)) throw new Error('Invalid Jev operator workspace selector');
    await migrate();
    if (jevOwnerEmail) {
      const { configureJevOperatorDefault } = await import("../jev");
      const configured = await configureJevOperatorDefault(sql, { email: jevOwnerEmail, ...(rawWorkspaceId ? { workspaceId: Number(rawWorkspaceId) } : {}) });
      if (configured.reason === 'owner-not-found' || configured.reason === 'ambiguous-owner' || configured.reason === 'configuration-conflict') throw new Error('Jev operator owner is unavailable');
    }
    // Maintenance-only command: the public job invoker cannot override job
    // arguments. Stop traffic/workers before credential rotation and restart
    // them only after this finishes and old database sessions are terminated.
    if (process.argv.includes("--reprovision-all")) {
      await sql`UPDATE orgs SET provisioning_status = 'pending', provisioning_retry_at = NULL WHERE provisioning_status IN ('ready', 'failed')`;
    }
    const result = await provisionPendingWorkspaces();
    console.log(JSON.stringify({ provisioning: result }));
    // A retry may find failed storage waiting for its backoff. That is still
    // incomplete setup, even when this particular attempt claims no rows.
    if (result.failed || result.pending) process.exitCode = 1;
  } finally { await closeDatabasePools(); }
}
if (import.meta.main) {
  try { await main(); }
  catch (error) {
    // PostgreSQL errors can include private values in message/detail/context.
    console.error("[provision] setup failed:", failureCode(error));
    process.exitCode = 1;
  }
}
