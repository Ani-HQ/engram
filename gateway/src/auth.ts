import { createHash } from "node:crypto";
import { sql } from "./db";

export interface TokenRecord {
  name: string;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function authenticate(authHeader: string | null): Promise<TokenRecord | null> {
  const m = authHeader?.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = sha256(m[1].trim());
  const rows = await sql`
    SELECT name FROM tokens
    WHERE sha256_hash = ${hash} AND revoked_at IS NULL`;
  if (rows.length === 0) return null;
  // fire-and-forget usage stamp
  sql`UPDATE tokens SET last_used_at = now() WHERE name = ${rows[0].name}`.catch(() => {});
  return { name: rows[0].name };
}
