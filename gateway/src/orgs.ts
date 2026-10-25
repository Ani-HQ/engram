import { failureCode } from "./diagnostics";
import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import type { ContextOrg } from "./context";
import { runWithContext } from "./context";
import { config, databaseSecurity } from "./config";
import { ensureDatabase, poolFor, sql, migrateTenantDataTables, usingOrgPool } from "./db";
import { sha256 } from "./hash";
import { triggerProvisioning } from "./provisioning-trigger";
import {
  DEFAULT_POLICIES,
  parsePolicies,
  type ActorRole,
  type OrgKind,
  type OrgPolicies,
  type TokenRecord,
} from "./policies";

export interface Org extends ContextOrg {
  createdAt: string;
  provisioningStatus: "pending" | "provisioning" | "ready" | "failed";
  provisioningError: string | null;
}

export const ANI_HQ_ORG: Org = {
  id: 1,
  name: "Ani HQ",
  slug: "ani-hq",
  kind: "team",
  brainDb: config.brainDb,
  homeDir: "brain",
  dataDb: "engram_gateway",
  policies: DEFAULT_POLICIES,
  createdAt: "1970-01-01T00:00:00.000Z",
  provisioningStatus: "ready",
  provisioningError: null,
};

export interface OrgMember {
  id: number;
  orgId: number;
  email: string;
  role: ActorRole;
}

function rowToOrg(row: any): Org {
  const org: Org = {
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    kind: row.kind === "personal" ? "personal" : "team",
    brainDb: String(row.brain_db),
    homeDir: String(row.home_dir),
    dataDb: String(row.data_db),
    policies: parsePolicies(row.policies),
    createdAt: new Date(row.created_at).toISOString(),
    provisioningStatus: row.provisioning_status === undefined || row.provisioning_status === "ready"
      ? "ready" : row.provisioning_status === "pending" || row.provisioning_status === "provisioning" ? row.provisioning_status : "failed",
    provisioningError: row.provisioning_error_code ? String(row.provisioning_error_code) : null,
  };
  assertOrgStorage(org);
  return org;
}

// Storage bindings are assigned by provisioning, never by a request. Reject a
// partial provision or corrupt binding before it can point a tenant at another
// tenant's database/home. Org 1 retains the installation's legacy databases.
export function assertOrgStorage(org: Pick<ContextOrg, "id" | "brainDb" | "dataDb" | "homeDir">): void {
  if (!Number.isSafeInteger(org.id) || org.id < 1) throw new Error("invalid org identity");
  const expected = org.id === 1
    ? { brainDb: config.brainDb, dataDb: "engram_gateway", homeDir: "brain" }
    : { brainDb: `brain_org_${org.id}`, dataDb: `brain_org_${org.id}`, homeDir: `org-${org.id}` };
  if (org.brainDb !== expected.brainDb || org.dataDb !== expected.dataDb || org.homeDir !== expected.homeDir) {
    throw new Error(`invalid storage binding for org ${org.id}`);
  }
}

export async function getOrg(id: number, db: postgres.Sql = sql): Promise<Org | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const rows = await db`SELECT * FROM orgs WHERE id = ${id}`;
  return rows[0] ? rowToOrg(rows[0]) : null;
}

export async function listOrgs(db: postgres.Sql = sql): Promise<Org[]> {
  const rows = await db`
    SELECT * FROM orgs
    WHERE brain_db != 'pending' AND data_db != 'pending' AND home_dir != 'pending'
      AND provisioning_status = 'ready'
    ORDER BY id`;
  return rows.map(rowToOrg);
}

export async function resolveOrg(token: TokenRecord): Promise<Org> {
  const found = await getOrg(token.orgId);
  if (found) return found;
  throw new Error(`unknown org ${token.orgId}`);
}

export async function withOrg<T>(org: ContextOrg, token: TokenRecord, fn: () => Promise<T>): Promise<T> {
  assertOrgStorage(org);
  if (token.orgId !== org.id) throw new Error("Actor and workspace context must match");
  if ("provisioningStatus" in org && org.provisioningStatus !== "ready") throw new WorkspaceProvisioningError();
  return usingOrgPool(org.dataDb, dataSql => runWithContext({ org, token, dataSql }, fn));
}

export class WorkspaceProvisioningError extends Error {
  readonly status = 503;
  readonly code = "workspace_provisioning";
  constructor() { super("Your workspace is being prepared. Please retry shortly."); }
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

export async function createOrg(
  name: string,
  ownerEmail: string,
  kind: OrgKind = "team",
): Promise<Org> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("org name required");
  const email = normalizeEmail(ownerEmail);
  if (!email) throw new Error("owner email required");
  if (kind !== "team" && kind !== "personal") throw new Error("invalid org kind");

  const slug = await uniqueSlug(kind === "personal" ? personalSlugBase(email) : trimmed);
  // Assign deterministic bindings before queueing; ordinary requests cannot
  // activate the store until the separate provisioner marks it ready.
  const rows = await sql.begin(async tx => {
    const inserted = await tx`
      INSERT INTO orgs (name, slug, kind, brain_db, home_dir, data_db, policies)
      VALUES (${trimmed}, ${slug}, ${kind}, 'pending', 'pending', 'pending', ${sql.json(DEFAULT_POLICIES)})
      RETURNING id`;
    const id = Number(inserted[0].id);
    const brainDb = `brain_org_${id}`;
    const homeDir = `org-${id}`;
    const bound = await tx`
      UPDATE orgs SET brain_db = ${brainDb}, home_dir = ${homeDir}, data_db = ${brainDb}, provisioning_status = 'pending'
      WHERE id = ${id} RETURNING *`;
    await tx`INSERT INTO org_members (org_id, email, role) VALUES (${id}, ${email}, 'owner')`;
    return bound;
  });
  const id = Number(rows[0].id);
  const brainDb = String(rows[0].brain_db);
  if (databaseSecurity.authority !== "runtime") {
    await ensureDatabase(brainDb);
    await migrateTenantDataTables(brainDb);
    await sql`UPDATE orgs SET provisioning_status = 'ready', provisioned_at = now(), provisioning_error_code = NULL WHERE id = ${id}`;
    rows[0].provisioning_status = "ready";
  }
  const org = rowToOrg(rows[0]);
  if (kind === "team") {
    await ensurePersonalOrg(email).catch(e => {
      console.error("[org] personal org failed:", failureCode(e));
    });
  }
  if (databaseSecurity.authority === "runtime") await triggerProvisioning();
  return org;
}

// Signup verification owns the outer transaction. This helper creates only
// central records; it never starts an engine, provisions storage, or creates a
// second workspace outside that transaction.
export async function createPersonalOrgRecords(name: string, ownerEmail: string, db: postgres.Sql): Promise<{ org: Org; member: OrgMember }> {
  const email = normalizeEmail(ownerEmail), trimmed = name.trim();
  if (!email || !trimmed || trimmed.length > 100) throw new Error("valid personal workspace identity required");
  const inserted = await db`INSERT INTO orgs (name, slug, kind, brain_db, home_dir, data_db, policies)
    VALUES (${trimmed}, ${`pending-${randomBytes(16).toString("hex")}`}, 'personal', 'pending', 'pending', 'pending', ${db.json(DEFAULT_POLICIES)}) RETURNING id`;
  const id = Number(inserted[0].id), binding = `brain_org_${id}`;
  const rows = await db`UPDATE orgs SET slug = ${`${personalSlugBase(email).slice(0, 40)}-${id}`},
      brain_db = ${binding}, data_db = ${binding}, home_dir = ${`org-${id}`}, provisioning_status = 'pending'
    WHERE id = ${id} RETURNING *`;
  const members = await db`INSERT INTO org_members (org_id, email, role) VALUES (${id}, ${email}, 'owner') RETURNING *`;
  return { org: rowToOrg(rows[0]), member: rowToMember(members[0]) };
}

export function personalSlugBase(email: string): string {
  const local = email.split("@")[0] || "me";
  return `me-${slugFromName(local)}`;
}

export async function personalOrgForEmail(email: string): Promise<Org | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await sql`
    SELECT o.* FROM orgs o
    JOIN org_members m ON m.org_id = o.id
    WHERE m.email = ${normalized} AND o.kind = 'personal'
    ORDER BY o.id
    LIMIT 1`;
  return rows[0] ? rowToOrg(rows[0]) : null;
}

export async function ensurePersonalOrg(email: string): Promise<Org> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("owner email required");
  const existing = await personalOrgForEmail(normalized);
  if (existing) return existing;
  const local = normalized.split("@")[0] || "me";
  return createOrg(`${local}'s memory`, normalized, "personal");
}

export async function listMemberships(email: string): Promise<Array<Org & { role: ActorRole }>> {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  const rows = await sql`
    SELECT o.*, m.role AS member_role
    FROM org_members m
    JOIN orgs o ON o.id = m.org_id
    WHERE m.email = ${normalized}
    ORDER BY CASE o.kind WHEN 'personal' THEN 0 ELSE 1 END, o.id`;
  return rows.map(row => ({
    ...rowToOrg(row),
    role: row.member_role === "owner" ? "owner" : "member",
  }));
}

export async function updatePolicies(orgId: number, policies: OrgPolicies): Promise<Org | null> {
  // Jev consent and spend acceptance belong to /api/jev. Preserve the current
  // committed value in SQL, not a potentially stale request's org snapshot.
  const rows = await sql`
    UPDATE orgs SET policies = jsonb_set(${sql.json(policies)}::jsonb, '{jevProcessing}', coalesce(orgs.policies->'jevProcessing','false'::jsonb))
    WHERE id = ${orgId} RETURNING *`;
  return rows[0] ? rowToOrg(rows[0]) : null;
}

export function parseWorkspaceName(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 100 ? name : null;
}

export async function renameWorkspace(orgId: number, email: string, name: string, db: postgres.Sql = sql): Promise<Org | null> {
  const normalizedEmail = normalizeEmail(email), parsedName = parseWorkspaceName(name);
  if (!Number.isSafeInteger(orgId) || orgId < 1 || !normalizedEmail || !parsedName) return null;
  return db.begin(async transaction => {
    // Keep ownership valid through the update, including a concurrent removal
    // or demotion after the session was authenticated.
    const owner = await transaction`
      SELECT id FROM org_members
      WHERE org_id = ${orgId} AND email = ${normalizedEmail} AND role = 'owner'
      FOR SHARE`;
    if (owner.length !== 1) return null;
    const rows = await transaction`
      UPDATE orgs SET name = ${parsedName}
      WHERE id = ${orgId} AND provisioning_status = 'ready' RETURNING *`;
    return rows[0] ? rowToOrg(rows[0]) : null;
  });
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

export async function removeMember(
  orgId: number,
  email: string,
  db: postgres.Sql = sql,
): Promise<"removed" | "owner" | "not-found"> {
  const normalized = normalizeEmail(email);
  if (!Number.isSafeInteger(orgId) || orgId < 1 || !normalized) return "not-found";
  return db.begin(async transaction => {
    const member = await transaction`
      SELECT role FROM org_members
      WHERE org_id = ${orgId} AND email = ${normalized}
      FOR UPDATE`;
    if (!member.length) return "not-found" as const;
    // An owner needs an explicit ownership-transfer flow, not a destructive
    // member control that could leave the tenant without an administrator.
    if (member[0].role === "owner") return "owner" as const;
    await transaction`DELETE FROM org_members WHERE org_id = ${orgId} AND email = ${normalized} AND role = 'member'`;
    await transaction`
      UPDATE sessions SET revoked_at = now()
      WHERE org_id = ${orgId} AND email = ${normalized} AND revoked_at IS NULL`;
    await transaction`
      UPDATE tokens SET revoked_at = now()
      WHERE org_id = ${orgId} AND issued_by_email = ${normalized} AND revoked_at IS NULL`;
    await transaction`
      UPDATE oauth_refresh_tokens SET revoked_at = now()
      WHERE org_id = ${orgId} AND email = ${normalized} AND revoked_at IS NULL`;
    // A previously mailed invite must not restore access just removed here.
    await transaction`
      DELETE FROM invites
      WHERE org_id = ${orgId} AND email = ${normalized} AND accepted_at IS NULL`;
    return "removed" as const;
  }) as Promise<"removed" | "owner" | "not-found">;
}

export async function cancelInvites(orgId: number, email: string, db: postgres.Sql = sql): Promise<number> {
  const normalized = normalizeEmail(email);
  if (!Number.isSafeInteger(orgId) || orgId < 1 || !normalized) return 0;
  const rows = await db`
    DELETE FROM invites
    WHERE org_id = ${orgId} AND email = ${normalized} AND accepted_at IS NULL
    RETURNING id`;
  return rows.length;
}

export async function findMemberByEmail(email: string): Promise<OrgMember | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await sql`
    SELECT m.* FROM org_members m
    JOIN orgs o ON o.id = m.org_id
    WHERE m.email = ${normalized}
    ORDER BY
      CASE o.kind WHEN 'team' THEN 0 ELSE 1 END,
      CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,
      m.created_at DESC
    LIMIT 1`;
  return rows[0] ? rowToMember(rows[0]) : null;
}

export async function memberInOrg(orgId: number, email: string, db: postgres.Sql = sql): Promise<OrgMember | null> {
  const normalized = normalizeEmail(email);
  if (!Number.isSafeInteger(orgId) || orgId < 1 || !normalized) return null;
  const rows = await db`
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
  if (config.signupMode === "invite-only" && !await findMemberByEmail(normalized)) throw new Error("A signup invitation and email verification are required first");
  const org = await getOrg(orgId);
  if (org?.kind === "personal") throw new Error("a personal brain has one owner");
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

export async function acceptInvite(raw: string, db: postgres.Sql = sql, options: { purpose?: "login"; oauthRequestId?: string; email?: string } = {}): Promise<{ org: Org; member: OrgMember } | null> {
  if (raw.startsWith("svf_")) return options.purpose || options.oauthRequestId ? null : acceptSignupVerification(raw, db);
  // Claim a one-use link atomically. Two requests must never both provision a
  // workspace or revive a membership from the same login link.
  const rows = await db`
    UPDATE invites SET accepted_at = now()
    WHERE sha256_hash = ${sha256(raw)}
      AND accepted_at IS NULL
      AND expires_at > now()
      AND signup_invite_id IS NULL
      AND (${options.purpose ?? null}::text IS NULL OR created_by = ${options.purpose ?? null})
      AND (${options.email ?? null}::text IS NULL OR email = ${options.email ?? null})
      AND (oauth_request_id IS NULL AND ${options.oauthRequestId ?? null}::text IS NULL OR oauth_request_id = ${options.oauthRequestId ?? null})
      AND (${config.signupMode === "open"} OR created_by = 'login'
        OR (org_id IS NOT NULL AND EXISTS (SELECT 1 FROM org_members m WHERE m.email = invites.email AND m.role IN ('owner', 'member'))))
    RETURNING *`;
  if (!rows.length) return null;
  const invite = rows[0];
  const pendingName = invite.pending_name ? String(invite.pending_name) : "";
  if (!invite.org_id && pendingName) {
    const org = await createOrg(pendingName, String(invite.email));
    const member = await memberInOrg(org.id, String(invite.email));
    if (!member) return null;
    await db`UPDATE invites SET org_id = ${org.id} WHERE id = ${invite.id}`;
    return { org, member };
  }
  const org = await getOrg(Number(invite.org_id), db);
  if (!org) return null;
  if (invite.created_by === "login") {
    // A login link proves email ownership, not a grant of the role that was
    // current when it was mailed. Removal/demotion must take effect immediately.
    const member = await memberInOrg(org.id, String(invite.email), db);
    return member ? { org, member } : null;
  }
  if (org.kind === "personal") return null;
  const member = await addMember(org.id, String(invite.email), invite.role === "owner" ? "owner" : "member");
  await ensurePersonalOrg(member.email).catch(e => {
    console.error("[org] personal org failed:", failureCode(e));
  });
  return { org, member };
}

async function acceptSignupVerification(raw: string, db: postgres.Sql): Promise<{ org: Org; member: OrgMember } | null> {
  const { eligiblePersonalWorkspace } = await import("./signup-invites");
  const result = await db.begin(async tx => {
    const rows = await tx`
      SELECT i.id AS signup_id, v.email, v.id AS verification_id, v.pending_name
      FROM hosted_signup_invites i JOIN hosted_signup_verifications v ON v.signup_invite_id = i.id
      JOIN hosted_signup_operators op ON op.member_id = i.created_by_member_id AND op.revoked_at IS NULL
      JOIN org_members creator ON creator.id = op.member_id AND creator.org_id = 1 AND creator.role = 'owner'
      WHERE v.token_hash = ${sha256(raw)}
        AND v.accepted_at IS NULL AND v.expires_at > now() AND (v.email = i.email OR i.email IS NULL)
        AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      FOR UPDATE OF i, v FOR SHARE OF creator`;
    if (rows.length !== 1) return null;
    const row = rows[0], email = String(row.email);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`engram/signup/${email}`}, 0))`;
    const knownPerson = (await tx`SELECT EXISTS (SELECT 1 FROM org_members WHERE email = ${email}) AS known`)[0].known === true;
    const prior = await eligiblePersonalWorkspace(tx as unknown as postgres.Sql, email);
    const target = prior ? { org: (await getOrg(prior.orgId, tx as unknown as postgres.Sql))!, member: prior.member }
      : await createPersonalOrgRecords(String(row.pending_name), email, tx as unknown as postgres.Sql);
    if (!target.org) return null;
    await tx`UPDATE hosted_signup_invites SET email = ${email}, redeemed_at = now(),
      access_expires_at = CASE WHEN access_duration_days = 60 THEN now() + interval '1440 hours' ELSE NULL END,
      redeemed_org_id = ${target.org.id}, redeemed_owner_member_id = ${target.member.id}
      WHERE id = ${row.signup_id}`;
    await tx`UPDATE hosted_signup_verifications SET accepted_at = now() WHERE id = ${row.verification_id}`;
    if (!prior && !knownPerson) {
      const { enrollMailSeries } = await import("./mail-series");
      await enrollMailSeries(tx as unknown as postgres.Sql, { orgId: target.org.id, memberId: target.member.id, email, signupInviteId: String(row.signup_id) });
    }
    return target;
  });
  // Existing ready workspaces have no provisioning poll to retry a coalesced
  // nudge. Their one-use verified admission must schedule its reconciliation.
  if (result) await triggerProvisioning({ force: result.org.provisioningStatus === "ready" });
  return result;
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

// Historical successful page evidence for metadata-only onboarding. This is
// not a current inventory guarantee: a page may later be deleted, and imported
// content predating audit receipts cannot be inferred without tenant access.
export async function orgHasRecordedPage(orgId: number, db: postgres.Sql = sql): Promise<boolean> {
  const rows = await db`
    SELECT 1 FROM audit_log WHERE org_id = ${orgId} AND outcome = 'ok'
      AND tool IN ('remember', 'put_page', 'get_page') LIMIT 1`;
  return rows.length > 0;
}

export async function orgHasAgentToken(orgId: number, db: postgres.Sql = sql): Promise<boolean> {
  try {
    const rows = await db`
      SELECT 1 FROM tokens
      WHERE org_id = ${orgId} AND role = 'agent' AND revoked_at IS NULL
      LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export function onboardingStep(input: {
  checks: { agentConnected: boolean; memorySaved: boolean; memoryRecalled: boolean };
  hasToken?: boolean;
  hasPage?: boolean;
  kind?: OrgKind;
}): "connect" | "remember" | "recall" | "done" {
  if (!input.checks.agentConnected) return "connect";
  if (!input.checks.memorySaved) return "remember";
  if (!input.checks.memoryRecalled) return "recall";
  return "done";
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
