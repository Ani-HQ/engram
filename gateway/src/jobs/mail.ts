import { databaseSecurity, config } from "../config";
import { migrate, closeDatabasePools } from "../db";
import { drainMailSeries, preflightMailSeries } from "../mail-series";

export async function main() {
  try {
    if (config.deploymentMode === "hosted" && databaseSecurity.authority !== "runtime") {
      throw new Error("mail_runtime_required");
    }
    const preflight = preflightMailSeries();
    if (preflight.enabled && !preflight.ready) throw new Error("mail_configuration_missing");
    if (!preflight.enabled) {
      console.log(JSON.stringify({ mail: { enabled: false, sent: 0 } }));
      return;
    }
    // Runtime migrate() checks the provisioner-owned version; no DDL, tenant
    // engine, optional AI, or administrator credential is needed for this job.
    await migrate();
    const result = await drainMailSeries({ dryRun: process.argv.includes("--dry-run"), limit: 25 });
    console.log(JSON.stringify({ mail: result }));
    if (result.blocked || result.failed || result.retried) process.exitCode = 1;
  } finally {
    await closeDatabasePools();
  }
}

if (import.meta.main) {
  main().catch(() => {
    // Database/provider errors may contain recipients, links or message bodies.
    console.error("[mail] delivery job failed; inspect aggregate delivery state");
    process.exitCode = 1;
  });
}
