import { createHash } from "node:crypto";
import type postgres from "postgres";

export function oauthConnectionId(orgId: number, email: string, clientId: string): string {
  return `oauth:${createHash("sha256").update(JSON.stringify([orgId, email, clientId])).digest("hex")}`;
}

// Credential issuance and lifecycle mutations acquire the same transaction
// lock, including when the lifecycle row does not exist yet.
export async function lockConnection(db: postgres.Sql, orgId: number, id: string): Promise<void> {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`engram/connection/${orgId}/${id}`}, 0))`;
}
