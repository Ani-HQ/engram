import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql, poolFor } from "./db";
import { getOrg } from "./orgs";
import { config } from "./config";
import { requireHostedWriteAccess } from "./billing";

let lastOrgId = 0;
// Reconcile the independently committed memory entry and central queue after a
// crash between those writes. Durable per-tenant cursors avoid re-reading the
// same first page forever. At most50 eligible workspaces/50 entries each pass.
export async function reconcileMemoryInsights(input: { db?: postgres.Sql; configured?: boolean } = {}): Promise<number> {
  if (!(input.configured ?? (!!config.reflex.apiKey && /^jev-\d+\.\d+\.\d+$/.test(config.reflex.model)))) return 0;
  const db = input.db ?? sql;
  let rows = await db`SELECT id FROM orgs WHERE id > ${lastOrgId} AND policies->>'externalAiProcessing'='true'
    AND coalesce(policies->>'jevMayPropose','true')='true' ORDER BY id LIMIT 50`;
  if (!rows.length && lastOrgId) { lastOrgId = 0; rows = await db`SELECT id FROM orgs WHERE policies->>'externalAiProcessing'='true'
    AND coalesce(policies->>'jevMayPropose','true')='true' ORDER BY id LIMIT 50`; }
  let inserted = 0;
  for (const row of rows) {
    lastOrgId = Number(row.id);
    try {
      const org = await getOrg(lastOrgId, db);
      if (!org?.policies.externalAiProcessing || !org.policies.jevMayPropose) continue;
      await requireHostedWriteAccess({ name: "engram-memory-reconciler", orgId: org.id, role: "agent", kind: "token", canWrite: true, email: null, scopes: [] }, { db });
      inserted += await db.begin(async tx => {
        const lock = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${`memory-insights:${org.id}`},0)) AS acquired`;
        if (!lock[0]?.acquired) return 0;
        const pending = await tx`SELECT count(*) AS count FROM insight_jobs WHERE org_id=${org.id} AND kind='memory' AND status IN ('queued','running')`;
        let capacity = Math.max(0, 32 - Number(pending[0]?.count));
        if (!capacity) return 0;
        await tx`INSERT INTO insight_memory_cursors(org_id,scanned_at,scanned_id) VALUES (${org.id},now()-interval '24 hours','') ON CONFLICT(org_id) DO NOTHING`;
        const cursors = await tx`SELECT scanned_at::text,scanned_id FROM insight_memory_cursors WHERE org_id=${org.id} FOR UPDATE`;
        // Preserve PostgreSQL microsecond precision in the cursor, rather than
        // losing it through a JavaScript Date round trip.
        const cursor = cursors[0];
        const entries = await poolFor(org.dataDb)`SELECT id,created_at::text FROM memory_entries WHERE status='active' AND created_at >= now()-interval '24 hours'
          AND (created_at,id) > (${cursor.scanned_at}::timestamptz,${cursor.scanned_id}::text) ORDER BY created_at,id LIMIT 50`;
        let count = 0;
        for (const entry of entries) {
          if (!capacity) break;
          const added = await tx`INSERT INTO insight_jobs(id,org_id,actor_name,kind,dedup_key,request)
            VALUES (${randomUUID()},${org.id},'engram-memory-reconciler','memory',${entry.id},${tx.json({ entryId: entry.id })})
            ON CONFLICT(org_id,kind,dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING RETURNING id`;
          if (added.length) { count++; capacity--; }
          await tx`UPDATE insight_memory_cursors SET scanned_at=${entry.created_at}::timestamptz,scanned_id=${entry.id} WHERE org_id=${org.id}`;
        }
        return count;
      });
    } catch { console.warn("[insights] memory reconciliation deferred"); }
  }
  return inserted;
}
