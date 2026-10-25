import { databaseSecurity } from "../config";
import { closeDatabasePools, migrate } from "../db";
import { provisionerPool } from "../tenant-db";
import { provisionPendingWorkspaces } from "../provisioning";
import { failureCode } from "../diagnostics";

export async function main(): Promise<void> {
  if (databaseSecurity.authority !== "provisioner") throw new Error("Separate provisioner authority is required for this job");
  try {
    const jevOwnerEmail = process.env.ENGRAM_JEV_OPERATOR_EMAIL?.trim();
    const rawWorkspaceId = process.env.ENGRAM_JEV_OPERATOR_WORKSPACE_ID?.trim();
    if (rawWorkspaceId && (!jevOwnerEmail || !/^[1-9]\d{0,9}$/.test(rawWorkspaceId) || Number(rawWorkspaceId) > 2147483647)) throw new Error('Invalid Jev operator workspace selector');
    await migrate();
    const reprovisionAll = process.argv.includes("--reprovision-all");
    // Maintenance-only command: the public job invoker cannot override job
    // arguments. Stop traffic/workers before credential rotation and restart
    // them only after this finishes and old database sessions are terminated.
    if (jevOwnerEmail || reprovisionAll) {
      // The request pool intentionally cannot write operator grants. Keep this
      // provisioner client local to bootstrap/maintenance and close it before
      // the ordinary workspace provisioning loop creates its own clients.
      const admin = provisionerPool("engram_gateway");
      try {
        if (jevOwnerEmail) {
          const { configureJevOperatorDefault } = await import("../jev");
          const configured = await configureJevOperatorDefault(admin, { email: jevOwnerEmail, ...(rawWorkspaceId ? { workspaceId: Number(rawWorkspaceId) } : {}) });
          if (configured.reason === 'owner-not-found' || configured.reason === 'ambiguous-owner' || configured.reason === 'configuration-conflict') throw new Error('Jev operator owner is unavailable');
        }
        if (reprovisionAll) await admin`UPDATE orgs SET provisioning_status = 'pending', provisioning_retry_at = NULL WHERE provisioning_status IN ('ready', 'failed')`;
      } finally { await admin.end({ timeout: 2 }); }
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
