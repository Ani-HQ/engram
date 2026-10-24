import { randomUUID } from "node:crypto";
import { currentContext } from "./context";
import { sql } from "./db";
import { config } from "./config";
import { requireHostedWriteAccess } from "./billing";

// Commit the memory entry before enqueueing. Only its opaque identifier is kept
// in this central outbox; text stays in the tenant's database until processing.
export async function enqueueMemoryInsight(entryId: string): Promise<void> {
  const context = currentContext();
  if (!context || !context.org.policies.jevMayPropose || !context.org.policies.externalAiProcessing || !config.reflex.apiKey) return;
  await requireHostedWriteAccess(context.token);
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`memory-insights:${context.org.id}`}, 0))`;
    const counts = await tx`SELECT count(*) AS count FROM insight_jobs WHERE org_id=${context.org.id} AND kind='memory' AND status IN ('queued','running')`;
    if (Number(counts[0]?.count) >= 32) return;
    await tx`INSERT INTO insight_jobs(id,org_id,actor_name,kind,dedup_key,request)
      VALUES (${randomUUID()},${context.org.id},${context.token.name},'memory',${entryId},${tx.json({ entryId })})
      ON CONFLICT(org_id,kind,dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`;
  });
}
