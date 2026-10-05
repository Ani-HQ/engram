import { randomBytes } from "node:crypto";
import type { ContextOrg } from "./context";
import { runWithContext } from "./context";
import { config } from "./config";
import { ensureDatabase, poolFor, sql, migrateOrgDataTables } from "./db";
import { sha256 } from "./hash";
import {
  DEFAULT_POLICIES,
  parsePolicies,
  type ActorRole,
  type OrgPolicies,
  type TokenRecord,
} from "./policies";

export interface Org extends ContextOrg {
  createdAt: string;
}

export const ANI_HQ_ORG: Org = {
  id: 1,
  name: "Ani HQ",
  slug: "ani-hq",
  brainDb: config.brainDb,
  homeDir: "brain",
  dataDb: "engram_gateway",
  policies: DEFAULT_POLICIES,
  createdAt: "1970-01-01T00:00:00.000Z",
};

export interface OrgMember {
  id: number;
  orgId: number;
  email: string;
  role: ActorRole;
}

function rowToOrg(row: any): Org {
  return {
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    brainDb: String(row.brain_db),
    homeDir: String(row.home_dir),
    dataDb: String(row.data_db),
    policies: parsePolicies(row.policies),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function getOrg(id: number): Promise<Org | null> {
  try {
    const rows = await sql`SELECT * FROM orgs WHERE id = ${id}`;
    return rows[0] ? rowToOrg(rows[0]) : null;
  } catch {
    return id === 1 ? ANI_HQ_ORG : null;
  }
}

export async function listOrgs(): Promise<Org[]> {
  try {
    const rows = await sql`SELECT * FROM orgs ORDER BY id`;
    return rows.map(rowToOrg);
  } catch {
    return [ANI_HQ_ORG];
  }
}

export async function resolveOrg(token: TokenRecord): Promise<Org> {
  const found = await getOrg(token.orgId);
  if (found) return found;
  if (token.orgId === 1) return ANI_HQ_ORG;
  throw new Error(`unknown org ${token.orgId}`);
}

export async function withOrg<T>(org: ContextOrg, token: TokenRecord, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ org, token, dataSql: poolFor(org.dataDb) }, fn);
}

export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "org";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugFromName(name);
  for (let i = 0; i < 12; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const rows = await sql`SELECT 1 FROM orgs WHERE slug = ${candidate}`;
    if (!rows.length) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export async function createOrg(name: string, ownerEmail: string): Promise<Org> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("org name required");
  const email = normalizeEmail(ownerEmail);
  if (!email) throw new Error("owner email required");

  const slug = await uniqueSlug(trimmed);
  const inserted = await sql`
    INSERT INTO orgs (name, slug, brain_db, home_dir, data_db, policies)
    VALUES (${trimmed}, ${slug}, 'pending', 'pending', 'pending', ${sql.json(DEFAULT_POLICIES)})
    RETURNING *`;
  const id = Number(inserted[0].id);
  const brainDb = `brain_org_${id}`;
  const homeDir = `org-${id}`;
  await ensureDatabase(brainDb);
  await migrateOrgDataTables(poolFor(brainDb));
  const rows = await sql`
    UPDATE orgs
    SET brain_db = ${brainDb}, home_dir = ${homeDir}, data_db = ${brainDb}
    WHERE id = ${id}
    RETURNING *`;
  const org = rowToOrg(rows[0]);
  await addMember(org.id, email, "owner");
  return org;
}

export async function updatePolicies(orgId: number, policies: OrgPolicies): Promise<Org | null> {
  const rows = await sql`
    UPDATE orgs SET policies = ${sql.json(policies)} WHERE id = ${orgId} RETURNING *`;
  return rows[0] ? rowToOrg(rows[0]) : null;
}

export async function addMember(orgId: number, email: string, role: ActorRole): Promise<OrgMember> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("email required");
  const rows = await sql`
    INSERT INTO org_members (org_id, email, role)
    VALUES (${orgId}, ${normalized}, ${role})
    ON CONFLICT (org_id, email) DO UPDATE SET role = EXCLUDED.role
    RETURNING *`;
  return rowToMember(rows[0]);
}

export async function listMembers(orgId: number): Promise<OrgMember[]> {
  const rows = await sql`
    SELECT * FROM org_members WHERE org_id = ${orgId} ORDER BY created_at`;
  return rows.map(rowToMember);
}

export async function findMemberByEmail(email: string): Promise<OrgMember | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await sql`
    SELECT * FROM org_members
    WHERE email = ${normalized}
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1`;
  return rows[0] ? rowToMember(rows[0]) : null;
}

export async function memberInOrg(orgId: number, email: string): Promise<OrgMember | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await sql`
    SELECT * FROM org_members WHERE org_id = ${orgId} AND email = ${normalized}`;
  return rows[0] ? rowToMember(rows[0]) : null;
}

export interface IssuedSecret {
  raw: string;
  url: string;
}

export async function createInvite(
  orgId: number,
  email: string,
  role: ActorRole,
  createdBy: string,
  publicUrl: string,
): Promise<IssuedSecret> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("email required");
  if (role === "agent") throw new Error("invite a person, not an agent");
  const raw = `inv_${randomBytes(24).toString("base64url")}`;
  await sql`
    INSERT INTO invites (org_id, email, role, sha256_hash, created_by, expires_at)
    VALUES (
      ${orgId},
      ${normalized},
      ${role},
      ${sha256(raw)},
      ${createdBy},
      now() + interval '7 days'
    )`;
  return { raw, url: joinUrl(publicUrl, raw) };
}

export async function acceptInvite(raw: string): Promise<{ org: Org; member: OrgMember } | null> {
  const rows = await sql`
    SELECT * FROM invites
    WHERE sha256_hash = ${sha256(raw)}
      AND accepted_at IS NULL
      AND expires_at > now()`;
  if (!rows.length) return null;
  const invite = rows[0];
  const org = await getOrg(Number(invite.org_id));
  if (!org) return null;
  const member = await addMember(org.id, String(invite.email), invite.role === "owner" ? "owner" : "member");
  await sql`UPDATE invites SET accepted_at = now() WHERE id = ${invite.id}`;
  return { org, member };
}

export async function listInvites(orgId: number) {
  const rows = await sql`
    SELECT id, email, role, created_at, expires_at, accepted_at
    FROM invites WHERE org_id = ${orgId} ORDER BY created_at DESC`;
  return rows.map(row => ({
    id: Number(row.id),
    email: String(row.email),
    role: String(row.role),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
  }));
}

export async function orgHasPage(org: ContextOrg): Promise<boolean> {
  const data = poolFor(org.dataDb);
  try {
    const rows = await data`SELECT 1 FROM memory_entries LIMIT 1`;
    if (rows.length) return true;
  } catch {
    // empty or missing table still means no page
  }
  try {
    const rows = await sql`
      SELECT 1 FROM audit_log
      WHERE org_id = ${org.id} AND outcome = 'ok'
        AND tool IN ('remember', 'put_page')
      LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function orgHasAgentToken(orgId: number): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT 1 FROM tokens
      WHERE org_id = ${orgId} AND role = 'agent' AND revoked_at IS NULL
      LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export function onboardingStep(input: { hasToken: boolean; hasPage: boolean }): "connect" | "remember" | "invite" | "done" {
  if (!input.hasToken) return "connect";
  if (!input.hasPage) return "remember";
  return "invite";
}

export function publicUrlFrom(req: Request): string {
  if (config.publicUrl) return config.publicUrl;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export function mcpUrlFrom(req: Request): string {
  return `${publicUrlFrom(req)}/mcp`;
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function joinUrl(publicUrl: string, raw: string): string {
  const base = publicUrl.replace(/\/$/, "") || "";
  return `${base}/app#join=${raw}`;
}

function rowToMember(row: any): OrgMember {
  return {
    id: Number(row.id),
    orgId: Number(row.org_id),
    email: String(row.email),
    role: row.role === "owner" ? "owner" : "member",
  };
}
