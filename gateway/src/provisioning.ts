import { databaseSecurity } from "./config";
import { randomUUID } from "node:crypto";
import { sql, ensureDatabase, migrateTenantDataTables } from "./db";
import { getOrg } from "./orgs";

// A durable row is the queue. A runtime may enqueue deterministic bindings, but
// only a separately credentialed provisioner can create their storage. Leases
// recover interrupted jobs; per-database advisory locks serialize actual DDL.
export async function provisionPendingWorkspaces(limit = 100): Promise<{ ready: number; failed: number; pending: number }> {
  if (databaseSecurity.authority === "runtime") throw new Error("This identity cannot provision workspaces");
  let ready = 0, failed = 0;
  for (let count = 0; count < Math.max(1, Math.min(1000, limit)); count++) {
    const lease = randomUUID();
    const claim = await sql`
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
      await sql`
        UPDATE orgs SET provisioning_status = 'ready', provisioned_at = now(), provisioning_lease_until = NULL,
          provisioning_lease_token = NULL, provisioning_retry_at = NULL, provisioning_error_code = NULL
        WHERE id = ${id} AND provisioning_lease_token = ${lease}`;
      ready++;
    } catch {
      // No SQL, credential, database URL, or private engine text in job status.
      await sql`
        UPDATE orgs SET provisioning_status = 'failed', provisioning_lease_until = NULL,
          provisioning_lease_token = NULL,
          provisioning_retry_at = now() + interval '5 minutes', provisioning_error_code = 'storage_setup_failed'
        WHERE id = ${id} AND provisioning_lease_token = ${lease}`;
      failed++;
    }
  }
  const pending = Number((await sql`SELECT count(*) AS n FROM orgs WHERE provisioning_status <> 'ready'`)[0].n);
  return { ready, failed, pending };
}
