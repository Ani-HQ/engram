import type postgres from "postgres";
import { sql } from "./db";
import { config } from "./config";
import { getOrg } from "./orgs";
import { requireHostedWriteAccess } from "./billing";

// One durable per-workspace budget covers memory, recall, Attention and briefs,
// across app instances. Reserve immediately before transmission; a server key
// alone never grants consent. Failed calls consume budget too.
export async function reserveWorkspaceInference(orgId: number, db: postgres.Sql = sql, provider: "legacy" | "jev" = "legacy"): Promise<boolean> {
  const org = await getOrg(orgId, db);
  if (!org || (provider === "jev" ? !org.policies.jevProcessing : !org.policies.externalAiProcessing)) return false;
  try {
    await requireHostedWriteAccess({ name: "engram-inference", orgId, kind: "token", role: "agent", canWrite: true, email: null, scopes: [] }, { db });
  } catch { return false; }
  const rows = await db`INSERT INTO insight_provider_budgets(org_id,day,calls) VALUES (${orgId},(now() AT TIME ZONE 'UTC')::date,1)
    ON CONFLICT(org_id,day) DO UPDATE SET calls=insight_provider_budgets.calls+1
    WHERE insight_provider_budgets.calls < ${config.insights.dailyProviderCalls} RETURNING calls`;
  return rows.length > 0;
}
