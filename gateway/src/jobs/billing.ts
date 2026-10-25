import { config, databaseSecurity } from '../config';
import { closeDatabasePools, migrate } from '../db';
import { drainJevBilling } from '../billing';

export async function main() {
  try {
    if (config.deploymentMode !== 'hosted' || databaseSecurity.authority !== 'runtime') throw new Error('billing_runtime_required');
    const dryRun = process.argv.includes('--dry-run');
    if (process.env.ENGRAM_JEV_BILLING_WORKER_ENABLED !== '1' && !dryRun) {
      console.log(JSON.stringify({ billing: { enabled: false, pending: 0, exported: 0, review: 0 } }));
      return;
    }
    if (!config.billing.secretKey || !config.publicUrl) throw new Error('billing_configuration_missing');
    await migrate(); // Restricted readiness check only; no DDL or engines.
    const result = await drainJevBilling({}, { dryRun, limit: 25 });
    console.log(JSON.stringify({ billing: result }));
    if (!dryRun && (!result.enabled || result.review || result.pending)) process.exitCode = 1;
  } finally { await closeDatabasePools(); }
}
if (import.meta.main) main().catch(() => {
  console.error('[billing] usage reconciliation failed; inspect aggregate billing state');
  process.exitCode = 1;
});
