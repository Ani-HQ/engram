import { ensureBrain, stopBrains } from "../brain";
import { migrate, closeDatabasePools } from "../db";
import { closeWriteCoordinator } from "../write-coordination";
import { verifyWorkerIsolation } from "../worker-preflight";
import { runDreamCycle } from "../dream/reconcile";
import { requireHostedWriteAccess } from "../billing";
import { listOrgs, withOrg } from "../orgs";
import { normalizeToken } from "../policies";
import { reflexClient } from "../reflex/client";

export async function main() {
  console.error("[dream] migrating gateway db...");
  await migrate();
  const orgs = await listOrgs();
  const results = [];
  for (const org of orgs) {
    const token = normalizeToken({ name: "dream", orgId: org.id, role: "owner" });
    const result = await withOrg(org, token, async () => {
      if (!org.policies.jevProcessing || !org.policies.jevMayPropose || !reflexClient().available()) return { ok: true, stats: { skipped: 1 } };
      try { await requireHostedWriteAccess(token); }
      catch { return { ok: true, stats: { skipped: 1 } }; }
      console.error(`[dream] org ${org.id} ${org.slug}`);
      await ensureBrain(org);
      return runDreamCycle();
    });
    results.push({ orgId: org.id, ...result });
    if (!result.ok) process.exitCode = 1;
  }
  console.log(JSON.stringify(results));
}

if (import.meta.main) {
  try { await verifyWorkerIsolation(); await main(); }
  finally { await stopBrains(); await closeWriteCoordinator(); await closeDatabasePools(); }
}
