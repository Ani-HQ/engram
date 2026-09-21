import { startBrain } from "../brain";
import { migrate } from "../db";
import { runDreamCycle } from "../dream/reconcile";
import { maybeEnableVoyage } from "../embed-setup";

export async function main() {
  console.error("[dream] migrating gateway db...");
  await migrate();
  console.error("[dream] starting brain child...");
  await startBrain();
  await maybeEnableVoyage().catch(e => {
    console.warn("[dream] voyage setup skipped:", String(e).slice(0, 200));
  });
  const result = await runDreamCycle();
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
