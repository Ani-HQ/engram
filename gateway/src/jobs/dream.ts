import { ensureBrain } from "../brain";
import { migrate } from "../db";
import { runDreamCycle } from "../dream/reconcile";
import { maybeEnableVoyage } from "../embed-setup";
import { listOrgs, withOrg } from "../orgs";
import { normalizeToken } from "../policies";

export async function main() {
  console.error("[dream] migrating gateway db...");
  await migrate();
  await maybeEnableVoyage().catch(e => {
    console.warn("[dream] voyage setup skipped:", String(e).slice(0, 200));
  });
  const orgs = await listOrgs();
  const results = [];
  for (const org of orgs) {
    const token = normalizeToken({ name: "dream", orgId: org.id, role: "owner" });
    const result = await withOrg(org, token, async () => {
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
  await main();
}
