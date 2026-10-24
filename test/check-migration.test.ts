import { describe, expect, test } from "bun:test";
import { inspectMigration, migrationSettings } from "../deploy/check-migration";

function fixture() {
  const state = {
    mode: "on", schema: [{ version: 2026102202, activity_version: 2026102301, billing_version: 2026102401 }], owner: [{ owners: 1, selected_owner: 1 }],
    orgs: [{ total: 1, ready: 1, legacy_binding: 1, invalid_bindings: 0 }], legacy: [{ active: 0 }],
    roles: ["engram_gateway_runtime", "engram_tenant_1"].map(rolname => ({ rolname, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false, rolconnlimit: rolname === "engram_tenant_1" ? 12 : -1, memberships: 0 })),
    privileges: [{ runtime_gateway: true, runtime_database_create: false, engine_gateway: false, runtime_memory: false, engine_own: true, engine_database_create: false, runtime_schema_usage: true, runtime_schema_create: false, runtime_version_update: false, runtime_grant_read: true, runtime_grant_write: false, runtime_grant_audit_write: false }],
    rls: [{ tables: 24, unprotected: 0, runtime_owned: 0 }],
  };
  const queries: string[] = [], parameters: unknown[][] = [];
  const tx = async (parts: TemplateStringsArray, ...args: unknown[]) => {
    const sql = parts.join("?"); queries.push(sql); parameters.push(args);
    if (sql.startsWith("SHOW")) return [{ transaction_read_only: state.mode }];
    if (sql.includes("FROM public.engram_schema_state")) return state.schema;
    if (sql.includes("FROM public.org_members")) return state.owner;
    if (sql.includes("FROM public.orgs")) return state.orgs;
    if (sql.includes("FROM public.tokens")) return state.legacy;
    if (sql.includes("FROM pg_roles")) return state.roles;
    if (sql.includes("has_database_privilege")) return state.privileges;
    if (sql.includes("FROM pg_class")) return state.rls;
    throw new Error("Unexpected query");
  };
  return { state, queries, parameters, db: { begin: (mode: string, work: (tx: any) => unknown) => { expect(mode).toBe("isolation level repeatable read read only"); return work(tx); } } as any };
}

describe("read-only migration cutover checks", () => {
  test("defaults to a plan and permits only the reviewed target and normalized email", () => {
    expect(migrationSettings(["--project", "ani-hq", "--owner-email", "verified@example.com"])).toEqual({ project: "ani-hq", ownerEmail: "verified@example.com", run: false });
    expect(() => migrationSettings(["--project", "other-project", "--owner-email", "verified@example.com"])).toThrow();
    expect(() => migrationSettings(["--project", "ani-hq", "--owner-email", "Verified@example.com"])).toThrow();
  });

  test("verifies every boundary using only metadata SELECTs in a read-only transaction", async () => {
    const f = fixture(), email = "verified@example.com";
    const result = await inspectMigration(f.db, email);
    expect(result.ok).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.counts).toEqual({ workspaces: 1, ready: 1, ownerRows: 1, selectedOwner: 1, activeLegacyCredentials: 0, centralTables: 24 });
    expect(JSON.stringify(result)).not.toContain(email);
    expect(f.queries.every(sql => /^(SELECT|SHOW)/.test(sql.trim()))).toBe(true);
    expect(f.queries.some(sql => sql.includes(email))).toBe(false);
    expect(f.parameters.flat()).toEqual([email]);
  });

  test("blocks changed schema, missing owners, pending stores, legacy keys and broad role grants", async () => {
    const f = fixture();
    f.state.schema[0].version--;
    f.state.owner[0].selected_owner = 0;
    f.state.orgs[0].ready = 0;
    f.state.legacy[0].active = 1;
    f.state.roles[0].memberships = 1;
    f.state.roles[1].rolcreatedb = true;
    const result = await inspectMigration(f.db, "verified@example.com");
    expect(result.ok).toBe(false);
    for (const key of ["schema", "owner", "workspacesReady", "legacyRevoked", "runtimeRestricted", "engineRestricted"] as const) expect(result.checks[key]).toBe(false);
  });

  test("requires the additive feature marker while preserving the reviewed base authority version", async () => {
    const f = fixture();
    f.state.schema[0].activity_version--;
    expect((await inspectMigration(f.db, "verified@example.com")).checks.schema).toBe(false);
    f.state.schema[0].activity_version = 2026102301;
    expect(f.state.schema[0].version).toBe(2026102202);
    expect((await inspectMigration(f.db, "verified@example.com")).checks.schema).toBe(true);
    f.state.schema[0].billing_version--;
    expect((await inspectMigration(f.db, "verified@example.com")).checks.schema).toBe(false);
  });

  test("blocks cross-database access, schema version writes, runtime ownership and missing RLS", async () => {
    const f = fixture();
    f.state.privileges[0].engine_gateway = true;
    f.state.privileges[0].runtime_version_update = true;
    f.state.privileges[0].runtime_grant_write = true;
    f.state.rls[0].runtime_owned = 1;
    f.state.rls[0].unprotected = 1;
    const result = await inspectMigration(f.db, "verified@example.com");
    expect(result.ok).toBe(false);
    expect(result.checks.connectIsolation).toBe(false);
    expect(result.checks.noDdlAuthority).toBe(false);
    expect(result.checks.centralRls).toBe(false);
    expect(result.checks.operatorEntitlements).toBe(false);
  });

  test("fails before metadata access when read-only mode is absent", async () => {
    const f = fixture(); f.state.mode = "off";
    await expect(inspectMigration(f.db, "verified@example.com")).rejects.toMatchObject({ code: "readonly_not_enforced" });
    expect(f.queries).toHaveLength(1);
  });
});
