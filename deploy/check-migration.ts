#!/usr/bin/env bun
// Bounded metadata-only cutover checks. Never import gateway startup/migrations.
import type postgres from "postgres";
import { OwnerCheckError, withOperatorDatabase } from "./check-owners";
import { recoverySettings } from "./recover-owner";
import { BILLING_SCHEMA_VERSION } from "../gateway/src/billing-schema";
import { PROFILE_PHOTO_SCHEMA_VERSION, PROFILE_PRESENTATION_SCHEMA_VERSION, SHOWCASE_SCHEMA_VERSION } from "../gateway/src/showcase-schema";
import { CONTEXT_SHARING_SCHEMA_VERSION } from "../gateway/src/context-sharing-schema";
import { CONNECTIONS_SCHEMA_VERSION } from "../gateway/src/connections-schema";
import { MEMORY_USAGE_SCHEMA_VERSION } from "../gateway/src/memory-usage-schema";

export function migrationSettings(args: string[]) {
  const mapped = args.map(arg => arg === "--owner-email" ? "--email" : arg);
  const settings = recoverySettings([...mapped, "--org", "1"]);
  return { project: settings.project, ownerEmail: settings.email, run: settings.run };
}

export async function inspectMigration(db: postgres.Sql, ownerEmail: string) {
  recoverySettings(["--project", "ani-hq", "--org", "1", "--email", ownerEmail]);
  return db.begin("isolation level repeatable read read only", async tx => {
    const mode = await tx`SHOW transaction_read_only`;
    if (mode[0]?.transaction_read_only !== "on") throw new OwnerCheckError("readonly_not_enforced");
    const schema = await tx`SELECT version, activity_version, billing_version, showcase_version, profile_presentation_version, profile_photo_version, context_sharing_version, connections_version, memory_usage_version FROM public.engram_schema_state WHERE id = true`;
    const owner = await tx`
      SELECT count(*) FILTER (WHERE role = 'owner')::integer AS owners,
        count(*) FILTER (WHERE role = 'owner' AND email = ${ownerEmail})::integer AS selected_owner
      FROM public.org_members WHERE org_id = 1`;
    const orgs = await tx`
      SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE provisioning_status = 'ready' AND provisioned_at IS NOT NULL AND provisioning_error_code IS NULL)::integer AS ready,
        count(*) FILTER (WHERE id = 1 AND brain_db = 'brain_shared' AND data_db = 'engram_gateway' AND home_dir = 'brain')::integer AS legacy_binding,
        count(*) FILTER (WHERE id > 1 AND (brain_db <> 'brain_org_' || id::text OR data_db <> 'brain_org_' || id::text OR home_dir <> 'org-' || id::text))::integer AS invalid_bindings
      FROM public.orgs`;
    const legacy = await tx`SELECT count(*)::integer AS active FROM public.tokens WHERE issuer_kind = 'legacy' AND revoked_at IS NULL`;
    const roles = await tx`
      SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit,
        (SELECT count(*)::integer FROM pg_auth_members WHERE member = r.oid) AS memberships
      FROM pg_roles r WHERE rolname IN ('engram_gateway_runtime', 'engram_tenant_1')`;
    const restricted = (name: string) => {
      const role = roles.find(row => row.rolname === name);
      return !!role && role.rolcanlogin === true && Number(role.memberships) === 0
        && [role.rolsuper, role.rolcreatedb, role.rolcreaterole, role.rolreplication, role.rolbypassrls, role.rolinherit].every(flag => flag === false);
    };
    // Run privilege predicates only after confirming both exact roles exist.
    let privileges: Record<string, unknown> | undefined;
    if (roles.length === 2) {
      privileges = (await tx`
        SELECT has_database_privilege('engram_gateway_runtime', 'engram_gateway', 'CONNECT') AS runtime_gateway,
          has_database_privilege('engram_gateway_runtime', 'engram_gateway', 'CREATE') AS runtime_database_create,
          has_database_privilege('engram_tenant_1', 'engram_gateway', 'CONNECT') AS engine_gateway,
          has_database_privilege('engram_gateway_runtime', 'brain_shared', 'CONNECT') AS runtime_memory,
          has_database_privilege('engram_tenant_1', 'brain_shared', 'CONNECT') AS engine_own,
          has_database_privilege('engram_tenant_1', 'brain_shared', 'CREATE') AS engine_database_create,
          has_schema_privilege('engram_gateway_runtime', 'public', 'USAGE') AS runtime_schema_usage,
          has_schema_privilege('engram_gateway_runtime', 'public', 'CREATE') AS runtime_schema_create,
          has_table_privilege('engram_gateway_runtime', 'public.engram_schema_state', 'UPDATE') AS runtime_version_update,
          has_table_privilege('engram_gateway_runtime', 'public.workspace_complimentary_access', 'SELECT') AS runtime_grant_read,
          has_table_privilege('engram_gateway_runtime', 'public.workspace_complimentary_access', 'INSERT,UPDATE,DELETE') AS runtime_grant_write,
          has_table_privilege('engram_gateway_runtime', 'public.complimentary_access_events', 'INSERT,UPDATE,DELETE') AS runtime_grant_audit_write`)[0];
    }
    const rls = await tx`
      SELECT count(*)::integer AS tables,
        count(*) FILTER (WHERE NOT c.relrowsecurity OR NOT c.relforcerowsecurity)::integer AS unprotected,
        count(*) FILTER (WHERE pg_get_userbyid(c.relowner) = 'engram_gateway_runtime')::integer AS runtime_owned
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND left(c.relname, 8) <> '_engram_'`;
    const checks = {
      schema: schema.length === 1 && Number(schema[0].version) === 2026102202 && Number(schema[0].activity_version) === 2026102301 && Number(schema[0].billing_version) === BILLING_SCHEMA_VERSION && Number(schema[0].showcase_version) === SHOWCASE_SCHEMA_VERSION && Number(schema[0].profile_presentation_version) === PROFILE_PRESENTATION_SCHEMA_VERSION && Number(schema[0].profile_photo_version) === PROFILE_PHOTO_SCHEMA_VERSION && Number(schema[0].context_sharing_version) === CONTEXT_SHARING_SCHEMA_VERSION && Number(schema[0].connections_version) === CONNECTIONS_SCHEMA_VERSION && Number(schema[0].memory_usage_version) === MEMORY_USAGE_SCHEMA_VERSION,
      owner: Number(owner[0]?.owners) >= 1 && Number(owner[0]?.selected_owner) === 1,
      workspacesReady: Number(orgs[0]?.total) > 0 && Number(orgs[0]?.total) === Number(orgs[0]?.ready),
      storageBindings: Number(orgs[0]?.legacy_binding) === 1 && Number(orgs[0]?.invalid_bindings) === 0,
      legacyRevoked: Number(legacy[0]?.active) === 0,
      runtimeRestricted: restricted("engram_gateway_runtime"),
      engineRestricted: restricted("engram_tenant_1") && Number(roles.find(row => row.rolname === "engram_tenant_1")?.rolconnlimit) === 12,
      connectIsolation: privileges?.runtime_gateway === true && privileges?.engine_own === true && privileges?.engine_gateway === false && privileges?.runtime_memory === false,
      noDdlAuthority: privileges?.runtime_database_create === false && privileges?.engine_database_create === false && privileges?.runtime_schema_usage === true && privileges?.runtime_schema_create === false && privileges?.runtime_version_update === false,
      centralRls: Number(rls[0]?.tables) > 0 && Number(rls[0]?.unprotected) === 0 && Number(rls[0]?.runtime_owned) === 0,
      operatorEntitlements: privileges?.runtime_grant_read === true && privileges?.runtime_grant_write === false && privileges?.runtime_grant_audit_write === false,
    };
    return { ok: Object.values(checks).every(Boolean), gate: "migration_metadata", checks, counts: { workspaces: Number(orgs[0]?.total), ready: Number(orgs[0]?.ready), ownerRows: Number(owner[0]?.owners), selectedOwner: Number(owner[0]?.selected_owner), activeLegacyCredentials: Number(legacy[0]?.active), centralTables: Number(rls[0]?.tables) } };
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const options = migrationSettings(process.argv.slice(2));
    if (!options.run) console.log(JSON.stringify({ mode: "plan", project: options.project, database: "engram_gateway", transaction: "READ ONLY", gate: "migration_metadata", privateContent: false, execute: false }));
    else {
      const result = await withOperatorDatabase({ project: options.project, region: "us-central1", instance: "engram-pg", run: true }, "read-only", db => inspectMigration(db, options.ownerEmail), controller.signal);
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 2;
    }
  } catch (error) {
    console.log(JSON.stringify({ ok: false, gate: "migration_metadata", reason: error instanceof OwnerCheckError ? error.code : "check_unavailable", ...(error instanceof OwnerCheckError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
    process.exitCode = 1;
  }
}
