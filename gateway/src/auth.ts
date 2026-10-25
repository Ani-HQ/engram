import { failureCode } from "./diagnostics";
import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { sql } from "./db";
import { sha256 } from "./hash";
import { parseReportedSource } from "./agent-source";
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
  // Snapshot credentials are deliberately unusable as workspace credentials,
  // even if a hash were accidentally inserted into the ordinary token table.
  if (!raw || raw.startsWith("egs_")) return null;
  if (isJwt(raw)) {
    try {
      return await authenticateJwt(raw, audience ?? "");
    } catch (e) {
      console.error("[auth] jwt failed:", failureCode(e));
      return null;
    }
  }
  return authenticateStoredSecret(raw);
}

// Opaque credentials never choose a tenant from request parameters. Sessions
// also re-check live membership so a revoked owner cannot keep managing billing
// or other workspace settings until their old cookie expires.
export async function authenticateStoredSecret(raw: string, db: postgres.Sql = sql): Promise<TokenRecord | null> {
  if (!raw || raw.startsWith("egs_")) return null;
  const hash = sha256(raw);
  const token = await lookupToken(hash, db);
  if (token) return token;
  return lookupSession(hash, db);
}

function validOrgId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function lookupToken(hash: string, db: postgres.Sql): Promise<TokenRecord | null> {
  try {
    const rows = await db`
      SELECT t.name, t.org_id, t.role, t.can_write, t.harness, t.source_label
      FROM tokens t
      LEFT JOIN org_members m ON m.id = t.issued_by_member_id
        AND m.org_id = t.org_id AND m.email = t.issued_by_email
      WHERE t.sha256_hash = ${hash} AND t.revoked_at IS NULL
        AND (t.issuer_kind IN ('operator', 'legacy') OR
          (t.issuer_kind = 'member' AND m.id IS NOT NULL AND m.role IN ('owner', 'member')))`;
    if (rows.length !== 1) return null;
    const orgId = Number(rows[0].org_id);
    if (!validOrgId(orgId)) return null;
    db`UPDATE tokens SET last_used_at = now() WHERE sha256_hash = ${hash} AND org_id = ${orgId} AND revoked_at IS NULL`.catch(() => {});
    return normalizeToken({
      name: String(rows[0].name),
      orgId,
      role: rows[0].role,
      canWrite: rows[0].can_write !== false,
      kind: "token",
      ...(rows[0].harness ? { source: { harness: String(rows[0].harness), label: rows[0].source_label ? String(rows[0].source_label) : null, kind: "registered" as const } } : {}),
    });
  } catch {
    return null;
  }
}

async function lookupSession(hash: string, db: postgres.Sql): Promise<TokenRecord | null> {
  try {
    const rows = await db`
      SELECT s.name, s.org_id, m.role, s.email
      FROM sessions s
      JOIN org_members m ON m.org_id = s.org_id AND m.email = s.email
      WHERE s.sha256_hash = ${hash}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`;
    if (!rows.length) return null;
    const orgId = Number(rows[0].org_id);
    if (!validOrgId(orgId) || !rows[0].email || !["owner", "member"].includes(rows[0].role)) return null;
    return normalizeToken({
      name: String(rows[0].name),
      orgId,
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
  issuerEmail: string | null = null,
  db: postgres.Sql = sql,
  source?: { harness: string; label?: string | null },
): Promise<string> {
  if (!validOrgId(orgId)) throw new Error("valid workspace required");
  const parsedSource = parseReportedSource(source?.harness, source?.label);
  if (parsedSource.sourceLabel && !parsedSource.harness) throw new Error("harness is required for a source label");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("token name required");
  const raw = `eng_${randomBytes(32).toString("base64url")}`;
  const email = issuerEmail === null ? null : normalizeEmail(issuerEmail);
  if (issuerEmail !== null && !email) throw new Error("issuer email required");
  await db.begin(async tx => {
    // Lock the membership against removal while issuing. Rejoining creates a
    // different member ID and cannot restore credentials from an earlier stay.
    const members = email ? await tx`
      SELECT id FROM org_members WHERE org_id = ${orgId} AND email = ${email} FOR UPDATE` : [];
    if (email && !members.length) throw new Error("issuer is not a current workspace member");
    await tx`
    INSERT INTO tokens (name, sha256_hash, scopes, secrets_acl, org_id, role, can_write, issuer_kind, issued_by_email, issued_by_member_id, harness, source_label)
    VALUES (
      ${trimmed},
      ${sha256(raw)},
      ${db.json({})},
      ${db.json(false)},
      ${orgId},
      'agent',
      ${canWrite},
      ${email ? "member" : "operator"},
      ${email},
      ${email ? members[0].id : null},
      ${parsedSource.harness},
      ${parsedSource.sourceLabel}
    )`;
  });
  return raw;
}

export async function listTokens(orgId: number) {
  const rows = await sql`
    SELECT name, can_write, created_at, revoked_at, last_used_at, issuer_kind, issued_by_email, harness, source_label
    FROM tokens WHERE org_id = ${orgId} ORDER BY created_at`;
  return rows.map(row => ({
    name: String(row.name),
    issuedBy: row.issued_by_email ? String(row.issued_by_email) : null,
    issuerKind: String(row.issuer_kind),
    canWrite: row.can_write !== false,
    harness: row.harness ? String(row.harness) : null,
    sourceLabel: row.source_label ? String(row.source_label) : null,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }));
}

export async function setTokenSource(orgId: number, name: string, source: { harness?: unknown; sourceLabel?: unknown }, db: postgres.Sql = sql) {
  if (!validOrgId(orgId) || typeof name !== "string" || !name.trim()) throw new Error("A workspace and connection name are required");
  const parsed = parseReportedSource(source.harness, source.sourceLabel);
  if (parsed.sourceLabel && !parsed.harness) throw new Error("harness is required for a source label");
  const rows = await db`
    UPDATE tokens SET harness = ${parsed.harness}, source_label = ${parsed.sourceLabel}
    WHERE org_id = ${orgId} AND name = ${name.trim()} AND revoked_at IS NULL
    RETURNING name, harness, source_label`;
  return rows[0] ? { name: String(rows[0].name), harness: rows[0].harness ? String(rows[0].harness) : null, sourceLabel: rows[0].source_label ? String(rows[0].source_label) : null } : null;
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

export async function createLoginInvite(email: string, publicUrl: string, oauthRequestId: string | null = null): Promise<{ raw: string; url: string } | null> {
  const member = await findMemberByEmail(email);
  if (!member) return null;
  const raw = `inv_${randomBytes(24).toString("base64url")}`;
  await sql`
    INSERT INTO invites (org_id, email, role, sha256_hash, created_by, expires_at, oauth_request_id)
    VALUES (
      ${member.orgId},
      ${member.email},
      ${member.role},
      ${sha256(raw)},
      'login',
      now() + interval '1 day',
      ${oauthRequestId}
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
  const { config } = await import("./config");
  if (config.signupMode === "invite-only") return null;
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
