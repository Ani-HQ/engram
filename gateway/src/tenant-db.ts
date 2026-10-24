import { createHmac } from "node:crypto";
import postgres from "postgres";
import { config, databaseSecurity, dbUrl, provisionerDbUrl } from "./config";
import { OPERATOR_ONLY_BILLING_TABLES } from "./billing-schema";

function identifier(value: string): string { return `"${value.replace(/"/g, '""')}"`; }

export function tenantIdentity(dbName: string): { orgId: number; role: string } {
  const match = /^brain_org_([1-9]\d*)$/.exec(dbName);
  const orgId = dbName === config.brainDb && dbName === "brain_shared" ? 1 : Number(match?.[1]);
  if (!Number.isSafeInteger(orgId) || orgId < 1 || (orgId === 1 && dbName !== "brain_shared")) {
    throw new Error("Invalid tenant database binding");
  }
  return { orgId, role: `engram_tenant_${orgId}` };
}

// A child sees only its own derived password; it cannot derive another tenant's
// password without the parent-only key. No secret is stored in org metadata.
export function tenantDbUrl(dbName: string, templateOverride?: string): string {
  const baseUrl = templateOverride ? templateOverride.replace("__DB__", dbName) : dbUrl(dbName);
  if (databaseSecurity.legacy) return baseUrl;
  const { role } = tenantIdentity(dbName);
  const url = new URL(baseUrl);
  url.username = role;
  url.password = createHmac("sha256", databaseSecurity.tenantCredentialKey)
    .update(`engram/tenant-db/v1/${role}`).digest("base64url");
  return url.toString();
}

export function provisionerPool(dbName: string): postgres.Sql {
  return postgres(provisionerDbUrl(dbName), { max: 1, connect_timeout: 5, onnotice: () => {} });
}

async function assertRestrictedRole(db: postgres.Sql, role: string): Promise<boolean> {
  const rows = await db`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = ${role}`;
  if (!rows.length) return false;
  if (Object.values(rows[0]).some(value => value === true)) throw new Error("Configured runtime database role has administrative privileges");
  const memberships = await db`
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ${role}`;
  if (memberships.length) throw new Error("Runtime database roles must not inherit other roles");
  return true;
}

async function ensureRole(db: postgres.Sql, role: string, password: string): Promise<void> {
  const exists = await assertRestrictedRole(db, role);
  // Password is an escaped SQL literal because PostgreSQL utility statements do
  // not accept bind parameters here. Never log this statement or its parameters.
  const passwordLiteral = String((await db`SELECT pg_catalog.quote_literal(${password}::text) AS value`)[0].value);
  const connectionLimit = role.startsWith("engram_tenant_") ? `CONNECTION LIMIT ${databaseSecurity.tenantConnectionLimit} ` : "";
  await db.unsafe(`${exists ? "ALTER" : "CREATE"} ROLE ${identifier(role)} WITH LOGIN ${exists ? "" : "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS "}NOINHERIT ${connectionLimit}PASSWORD ${passwordLiteral}`);
  // PostgreSQL 16+ role creators can have ADMIN without SET. The migration
  // identity must explicitly be able to assign application-object ownership.
  // This grant goes toward the provisioner; engines inherit no other role.
  const owner = String((await db`SELECT current_user AS name`)[0].name);
  const version = Number((await db`SHOW server_version_num`)[0].server_version_num);
  // A non-superuser creator already has bootstrap-granted ADMIN on PG16+.
  // Granting ADMIN back to itself can be rejected as a circular grant. Only SET
  // is required here; do not inherit tenant authority into the current role.
  await db.unsafe(`GRANT ${identifier(role)} TO ${identifier(owner)} ${version >= 160000 ? "WITH INHERIT FALSE, SET TRUE" : ""}`);
}

export async function prepareGatewayDatabase(): Promise<void> {
  if (databaseSecurity.legacy) return;
  const admin = provisionerPool("postgres");
  try {
    await admin`SELECT pg_advisory_lock(hashtextextended('engram/gateway-provision/v1', 0))`;
    try {
    const identity = await admin`SELECT current_user AS name`;
    if (identity[0]?.name === databaseSecurity.runtimeRole) throw new Error("Provisioner and runtime database roles must be different");
    const runtime = new URL(dbUrl("engram_gateway"));
    if (!databaseSecurity.runtimeRole || databaseSecurity.runtimeRole.startsWith("engram_tenant_")) throw new Error("Invalid gateway runtime database role");
    await ensureRole(admin, databaseSecurity.runtimeRole, decodeURIComponent(runtime.password));
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = 'engram_gateway'`;
    if (!exists.length) await admin.unsafe(`CREATE DATABASE engram_gateway`);
    await admin.unsafe(`ALTER DATABASE engram_gateway OWNER TO ${identifier(String(identity[0].name))}`);
    await admin.unsafe(`REVOKE ALL ON DATABASE engram_gateway FROM PUBLIC`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE engram_gateway TO ${identifier(databaseSecurity.runtimeRole)}`);
    } finally { await admin`SELECT pg_advisory_unlock(hashtextextended('engram/gateway-provision/v1', 0))`; }
  } finally { await admin.end({ timeout: 2 }); }
}

// Migrations run as the provisioner. The runtime gets DML and sequence access,
// never table/schema ownership, role creation, database creation, or BYPASSRLS.
// Global authentication/bootstrap/publication require a trusted gateway policy.
// This is not per-request RLS: central queries must still bind their org filters.
export async function protectGatewayMetadata(db: postgres.Sql): Promise<void> {
  if (databaseSecurity.legacy) return;
  // Provisioning runs alongside live requests. Ownership, grants and FORCE RLS
  // policy replacement must commit together: autocommit REVOKE/GRANT or
  // DROP/CREATE pairs expose a temporary denied/empty view to the runtime.
  // A failed refresh rolls back the entire authority change.
  await db.begin(async db => {
    const runtime = identifier(databaseSecurity.runtimeRole);
    const owner = String((await db`SELECT current_user AS name`)[0].name);
    await db.unsafe(`ALTER SCHEMA public OWNER TO ${identifier(owner)}`);
    await db.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await db.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
    const tables = await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND left(tablename, 8) <> '_engram_'`;
    for (const row of tables) {
      const table = identifier(String(row.tablename));
      await db.unsafe(`ALTER TABLE public.${table} OWNER TO ${identifier(owner)}`);
      await db.unsafe(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
      await db.unsafe(`REVOKE ALL ON TABLE public.${table} FROM ${runtime}`);
      const privileges = row.tablename === "engram_schema_state" || OPERATOR_ONLY_BILLING_TABLES.has(String(row.tablename)) ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE";
      await db.unsafe(`GRANT ${privileges} ON TABLE public.${table} TO ${runtime}`);
      await db.unsafe(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      await db.unsafe(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      await db.unsafe(`DROP POLICY IF EXISTS engram_gateway_runtime ON public.${table}`);
      await db.unsafe(`CREATE POLICY engram_gateway_runtime ON public.${table} TO ${runtime} USING (true) WITH CHECK (true)`);
      // The non-superuser migration owner also needs access when FORCE RLS is on.
      await db.unsafe(`DROP POLICY IF EXISTS engram_gateway_migration ON public.${table}`);
      await db.unsafe(`CREATE POLICY engram_gateway_migration ON public.${table} TO ${identifier(owner)} USING (true) WITH CHECK (true)`);
    }
    await db.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC`);
    await db.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
    await db.unsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`);
    await db.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC`);
    await db.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  });
}

export async function provisionTenantDatabase(dbName: string): Promise<void> {
  const { role } = tenantIdentity(dbName);
  const admin = provisionerPool("postgres");
  try {
    // Serialize both initial creation and credential rotation across replicas.
    await admin`SELECT pg_advisory_lock(hashtextextended(${`engram/provision/${dbName}`}, 0))`;
    try {
      const url = new URL(tenantDbUrl(dbName));
      await ensureRole(admin, role, decodeURIComponent(url.password));
      const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
      if (!exists.length) await admin.unsafe(`CREATE DATABASE ${identifier(dbName)}`);
      const owner = String((await admin`SELECT current_user AS name`)[0].name);
      await admin.unsafe(`ALTER DATABASE ${identifier(dbName)} OWNER TO ${identifier(owner)}`);
      await admin.unsafe(`REVOKE ALL ON DATABASE ${identifier(dbName)} FROM PUBLIC`);
      await admin.unsafe(`REVOKE ALL ON DATABASE ${identifier(dbName)} FROM ${identifier(databaseSecurity.runtimeRole)}`);
      await admin.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE ${identifier(dbName)} TO ${identifier(role)}`);
      await prepareTenantSchema(dbName, role);
    } finally { await admin`SELECT pg_advisory_unlock(hashtextextended(${`engram/provision/${dbName}`}, 0))`; }
  } finally { await admin.end({ timeout: 2 }); }
}

async function protectOwnedPublicObjects(db: postgres.TransactionSql, engineRole: string): Promise<void> {
  const relations = await db`
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
  for (const row of relations) {
    const kind = row.relkind === "S" ? "SEQUENCE" : "TABLE";
    await db.unsafe(`REVOKE ALL ON ${kind} public.${identifier(String(row.relname))} FROM PUBLIC`);
  }
  const functions = await db`
    SELECT p.oid::regprocedure::text AS signature, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
  for (const row of functions) {
    const kind = row.prokind === "p" ? "PROCEDURE" : "FUNCTION";
    await db.unsafe(`REVOKE ALL ON ${kind} ${row.signature} FROM PUBLIC`);
    await db.unsafe(`GRANT EXECUTE ON ${kind} ${row.signature} TO ${identifier(engineRole)}`);
  }
}

async function prepareTenantSchema(dbName: string, role: string): Promise<void> {
  const db = provisionerPool(dbName);
  try {
    await db.begin(async db => {
      // Extensions need database-admin authority. The engine only creates and
      // migrates its own schema after these exist.
      await db.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
      await db.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await db.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      const owner = String((await db`SELECT current_user AS name`)[0].name);
      const publicOwner = String((await db`SELECT pg_get_userbyid(nspowner) AS name FROM pg_namespace WHERE nspname = 'public'`)[0].name);
      if (publicOwner === role) {
        // Compatibility for a store provisioned by the older superuser path.
        // SET-only membership is not inherited ownership; act as its real owner.
        await db.unsafe(`SET LOCAL ROLE ${identifier(role)}`);
        await db.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
        await db.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(owner)}`);
        await db.unsafe(`RESET ROLE`);
      } else {
        // Owning a schema would require granting the engine CREATE on the whole
        // database. It only needs to create/migrate objects inside public.
        await db.unsafe(`ALTER SCHEMA public OWNER TO ${identifier(owner)}`);
        await db.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
        await db.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(role)}`);
      }
      // Transfer existing application relations, excluding extension-owned ones.
      const relations = await db`
        SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = ${role})
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
          AND NOT (c.relkind = 'S' AND EXISTS (
            SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')))`;
      for (const row of relations) {
        const kind = row.relkind === "S" ? "SEQUENCE" : row.relkind === "v" ? "VIEW" : row.relkind === "m" ? "MATERIALIZED VIEW" : row.relkind === "f" ? "FOREIGN TABLE" : "TABLE";
        await db.unsafe(`ALTER ${kind} public.${identifier(String(row.relname))} OWNER TO ${identifier(role)}`);
      }
      const functions = await db`
        SELECT p.oid::regprocedure::text AS signature, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
          AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = ${role})
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;
      for (const row of functions) {
        const kind = row.prokind === "p" ? "PROCEDURE" : "FUNCTION";
        await db.unsafe(`ALTER ${kind} ${row.signature} OWNER TO ${identifier(role)}`);
      }
      const types = await db`
        SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r')
          AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = ${role})
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')`;
      for (const row of types) await db.unsafe(`ALTER ${row.typtype === "d" ? "DOMAIN" : "TYPE"} public.${identifier(String(row.typname))} OWNER TO ${identifier(role)}`);
      // SET-only membership confers no inherited object authority. Restrict ACL
      // changes to the actual owner's objects, including extensions when this
      // provisioner installed them. Provider-owned extensions keep their existing
      // ACLs; the database itself admits only this tenant and the provisioner.
      await protectOwnedPublicObjects(db, role);
      await db.unsafe(`SET LOCAL ROLE ${identifier(role)}`);
      await protectOwnedPublicObjects(db, role);
      // A per-schema REVOKE cannot remove PostgreSQL's global default EXECUTE.
      await db.unsafe(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
      await db.unsafe(`RESET ROLE`);
      await db`CREATE SCHEMA IF NOT EXISTS engram_control`;
      await db.unsafe(`ALTER SCHEMA engram_control OWNER TO ${identifier(owner)}`);
      await db.unsafe(`REVOKE ALL ON SCHEMA engram_control FROM PUBLIC`);
      await db.unsafe(`GRANT USAGE ON SCHEMA engram_control TO ${identifier(role)}`);
      await db`CREATE TABLE IF NOT EXISTS engram_control.workspace (id boolean PRIMARY KEY CHECK (id), org_id integer NOT NULL, version integer NOT NULL)`;
      await db.unsafe(`REVOKE ALL ON engram_control.workspace FROM PUBLIC`);
      await db.unsafe(`GRANT SELECT ON engram_control.workspace TO ${identifier(role)}`);
      await db`INSERT INTO engram_control.workspace (id, org_id, version) VALUES (true, ${tenantIdentity(dbName).orgId}, 1) ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, version = EXCLUDED.version`;
    });
  } finally { await db.end({ timeout: 2 }); }
}

export async function assertTenantDatabaseReady(dbName: string): Promise<void> {
  const { orgId, role } = tenantIdentity(dbName);
  const db = postgres(tenantDbUrl(dbName), { max: 1, connect_timeout: 3, onnotice() {} });
  try {
    const rows = await db`SELECT org_id, version, current_user AS role, current_database() AS db FROM engram_control.workspace WHERE id = true`;
    if (rows[0]?.org_id !== orgId || rows[0]?.version !== 1 || rows[0]?.role !== role || rows[0]?.db !== dbName) throw new Error("Tenant database is not provisioned");
  } finally { await db.end({ timeout: 1 }); }
}
