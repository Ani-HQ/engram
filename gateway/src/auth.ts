import { createHash } from "node:crypto";
import { sql } from "./db";

export interface TokenRecord {
  name: string;
  // scope -> "r" | "rw"
  scopes: Record<string, string>;
  secrets: boolean;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function authenticate(authHeader: string | null): Promise<TokenRecord | null> {
  const m = authHeader?.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = sha256(m[1].trim());
  const rows = await sql`
    SELECT name, scopes, secrets_acl FROM tokens
    WHERE sha256_hash = ${hash} AND revoked_at IS NULL`;
  if (rows.length === 0) return null;
  // fire-and-forget usage stamp
  sql`UPDATE tokens SET last_used_at = now() WHERE name = ${rows[0].name}`.catch(() => {});
  return {
    name: rows[0].name,
    scopes: rows[0].scopes as Record<string, string>,
    secrets: rows[0].secrets_acl === true,
  };
}

export function canRead(t: TokenRecord, scope: string): boolean {
  const p = t.scopes[scope];
  return p === "r" || p === "rw";
}

export function canWrite(t: TokenRecord, scope: string): boolean {
  return t.scopes[scope] === "rw";
}

export function readableScopes(t: TokenRecord): string[] {
  return Object.keys(t.scopes).filter(s => canRead(t, s));
}
