import { randomBytes } from "node:crypto";
import { sql } from "./db";
import { sha256 } from "./hash";
import { authenticateJwt, canonicalResource, isJwt, resourceHost } from "./oauth";
import { findMemberByEmail, normalizeEmail } from "./orgs";
import { normalizeToken, type ActorRole, type TokenRecord } from "./policies";

export type { TokenRecord, ActorRole } from "./policies";
export { sha256 };

const SESSION_TTL_DAYS = 14;

export async function authenticate(
  authHeader: string | null,
  audience?: string,
): Promise<TokenRecord | null> {
  const m = authHeader?.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return authenticateSecret(m[1].trim(), audience);
}

export async function authenticateSecret(raw: string, audience?: string): Promise<TokenRecord | null> {
  if (!raw) return null;
  if (isJwt(raw)) {
    try {
      return await authenticateJwt(raw, audience ?? "");
    } catch (e) {
      console.error("[auth] jwt failed:", String(e).slice(0, 160));
      return null;
    }
  }
  const hash = sha256(raw);
  const token = await lookupToken(hash);
  if (token) return token;
  return lookupSession(hash);
}

async function lookupToken(hash: string): Promise<TokenRecord | null> {
  try {
    const rows = await sql`
      SELECT name, org_id, role, can_write
      FROM tokens
      WHERE sha256_hash = ${hash} AND revoked_at IS NULL`;
    if (!rows.length) return null;
    sql`UPDATE tokens SET last_used_at = now() WHERE sha256_hash = ${hash}`.catch(() => {});
    return normalizeToken({
      name: String(rows[0].name),
      orgId: Number(rows[0].org_id ?? 1),
      role: rows[0].role,
      canWrite: rows[0].can_write !== false,
      kind: "token",
    });
  } catch {
    return null;
  }
}

async function lookupSession(hash: string): Promise<TokenRecord | null> {
  try {
    const rows = await sql`
      SELECT name, org_id, role, email
      FROM sessions
      WHERE sha256_hash = ${hash}
        AND revoked_at IS NULL
        AND expires_at > now()`;
    if (!rows.length) return null;
    return normalizeToken({
      name: String(rows[0].name),
      orgId: Number(rows[0].org_id),
      role: rows[0].role,
      canWrite: true,
      kind: "session",
      email: rows[0].email ? String(rows[0].email) : null,
    });
  } catch {
    return null;
  }
}

export async function authenticateRequest(req: Request): Promise<TokenRecord | null> {
  const host = resourceHost(req);
  return authenticate(req.headers.get("authorization"), canonicalResource(host));
}

export async function issueToken(
  orgId: number,
  name: string,
  canWrite = true,
): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("token name required");
  const raw = `eng_${randomBytes(32).toString("base64url")}`;
  await sql`
    INSERT INTO tokens (name, sha256_hash, scopes, secrets_acl, org_id, role, can_write)
    VALUES (
      ${trimmed},
      ${sha256(raw)},
      ${sql.json({})},
      ${sql.json(false)},
      ${orgId},
      'agent',
      ${canWrite}
    )`;
  return raw;
}

export async function listTokens(orgId: number) {
  const rows = await sql`
    SELECT name, can_write, created_at, revoked_at, last_used_at
    FROM tokens WHERE org_id = ${orgId} ORDER BY created_at`;
  return rows.map(row => ({
    name: String(row.name),
    canWrite: row.can_write !== false,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }));
}

export async function revokeToken(orgId: number, name: string): Promise<boolean> {
  const result = await sql`
    UPDATE tokens
    SET revoked_at = now()
    WHERE org_id = ${orgId} AND name = ${name} AND revoked_at IS NULL`;
  return result.count > 0;
}

export async function setTokenWrite(orgId: number, name: string, canWrite: boolean): Promise<boolean> {
  const result = await sql`
    UPDATE tokens SET can_write = ${canWrite}
    WHERE org_id = ${orgId} AND name = ${name} AND revoked_at IS NULL`;
  return result.count > 0;
}

export async function createSession(input: {
  orgId: number;
  name: string;
  role: ActorRole;
  email?: string | null;
}): Promise<string> {
  const raw = `ens_${randomBytes(24).toString("base64url")}`;
  await sql`
    INSERT INTO sessions (org_id, name, role, email, sha256_hash, expires_at)
    VALUES (
      ${input.orgId},
      ${input.name},
      ${input.role},
      ${input.email ?? null},
      ${sha256(raw)},
      ${new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000)}
    )`;
  return raw;
}

export async function createLoginInvite(email: string, publicUrl: string): Promise<{ raw: string; url: string } | null> {
  const member = await findMemberByEmail(email);
  if (!member) return null;
  const raw = `inv_${randomBytes(24).toString("base64url")}`;
  await sql`
    INSERT INTO invites (org_id, email, role, sha256_hash, created_by, expires_at)
    VALUES (
      ${member.orgId},
      ${member.email},
      ${member.role},
      ${sha256(raw)},
      'login',
      now() + interval '1 day'
    )`;
  return { raw, url: `${publicUrl.replace(/\/$/, "")}/app#join=${raw}` };
}

export async function createSignupInvite(
  email: string,
  orgName: string,
  publicUrl: string,
): Promise<{ raw: string; url: string } | null> {
  const normalized = normalizeEmail(email);
  const name = orgName.trim();
  if (!normalized || !name) return null;
  const raw = `inv_${randomBytes(24).toString("base64url")}`;
  await sql`
    INSERT INTO invites (org_id, email, role, sha256_hash, created_by, expires_at, pending_name)
    VALUES (
      NULL,
      ${normalized},
      'owner',
      ${sha256(raw)},
      'signup',
      now() + interval '1 day',
      ${name}
    )`;
  return { raw, url: `${publicUrl.replace(/\/$/, "")}/app#join=${raw}` };
}
