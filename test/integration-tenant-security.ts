/** Real restricted PostgreSQL roles; only the disposable 15432 sandbox is allowed.
 * Run after integration-postgres.ts. The service needs pgvector and SCRAM host
 * authentication for restricted roles. No production configuration is imported.
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { fileURLToPath } from "node:url";

const template = process.env.ENGRAM_TEST_DB_URL_TEMPLATE;
if (!template) throw new Error("Set ENGRAM_TEST_DB_URL_TEMPLATE to the disposable 15432 sandbox");
const target = new URL(template);
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "15432" || decodeURIComponent(target.username) !== "engram_test" || target.pathname !== "/__DB__" || target.search || target.hash) {
  throw new Error("Tenant security tests require engram_test on the disposable loopback 15432 sandbox");
}
const runtime = new URL(template);
runtime.username = "engram_gateway_security_test";
runtime.password = "engram-disposable-'quoted'-\\-gateway-password";
process.env.ENGRAM_DB_URL_TEMPLATE = runtime.toString();
process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE = template;
process.env.ENGRAM_TENANT_CREDENTIAL_KEY = "engram-disposable-only-master-key-32-bytes";
process.env.ENGRAM_DEPLOYMENT_MODE = "hosted";
process.env.ENGRAM_DATABASE_AUTHORITY = "provisioner";
process.env.ENGRAM_PROVISION_JOB = "";
delete process.env.ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS;

const admin = postgres(template.replace("__DB__", "engram_gateway"), { max: 1, onnotice: () => {} });
let checks = 0;
const clients: postgres.Sql[] = [];
function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
function check(actual: unknown, message: string): asserts actual { assert.ok(actual, message); checks++; }
async function denied(fn: () => PromiseLike<unknown>, message: string, code = "42501") {
  await assert.rejects(async () => await fn(), (error: any) => error?.code === code, message); checks++;
}
function connect(url: string): postgres.Sql {
  const client = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
  clients.push(client); return client;
}
function databaseUrl(url: string, name: string): string { const result = new URL(url); result.pathname = `/${name}`; return result.toString(); }

const { migrate, sql, closeDatabasePools, ensureDatabase } = await import("../gateway/src/db");
const { createOrg, addMember, removeMember, withOrg, acceptInvite } = await import("../gateway/src/orgs");
const { issueToken, authenticateStoredSecret, createSession } = await import("../gateway/src/auth");
const { tenantDbUrl } = await import("../gateway/src/tenant-db");
const { brainEnvironment } = await import("../gateway/src/privacy");
const { normalizeToken } = await import("../gateway/src/policies");
const { oauthMemberForClaims } = await import("../gateway/src/oauth");
const { listConnections } = await import("../gateway/src/connections");
const { closeWriteCoordinator } = await import("../gateway/src/write-coordination");
const { canManageSignupInvites, issueSignupInvite, createSignupVerification } = await import("../gateway/src/signup-invites");
const { ensureHostedSignupInvitesSchema } = await import("../gateway/src/signup-invites-schema");
try {
  const marker = await admin`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`;
  equal(marker[0]?.purpose, "engram-disposable-integration-v1", "Only the marked integration sandbox may be upgraded");
  // Snapshot test-only legacy credentials before the strict migration.
  await admin`INSERT INTO tokens (name, sha256_hash, org_id, role) VALUES ('security-legacy-key', 'security-legacy-hash', 1, 'agent') ON CONFLICT DO NOTHING`;
  await migrate();
  await Promise.all([migrate(), migrate()]);
  checks++;
  await admin`ALTER ROLE engram_gateway_security_test BYPASSRLS`;
  try {
    await assert.rejects(() => migrate(), /administrative privileges/); checks++;
  } finally { await admin`ALTER ROLE engram_gateway_security_test NOBYPASSRLS`; }
  const identity = await sql`SELECT current_user AS role, current_database() AS db`;
  equal(identity[0], { role: "engram_gateway_security_test", db: "engram_gateway" }, "Gateway requests use the distinct runtime role");
  const flags = await sql`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  check(Object.values(flags[0]).every(flag => flag === false), "Gateway runtime has no database-administration or RLS-bypass privileges");
  equal((await sql`SELECT revoked_at IS NOT NULL AS revoked FROM tokens WHERE name = 'security-legacy-key'`)[0].revoked, true, "Strict upgrades revoke unattributed legacy credentials");
  const protectedTables = await sql`
    SELECT c.relrowsecurity, c.relforcerowsecurity, owner.rolname AS owner
    FROM pg_class c JOIN pg_roles owner ON owner.oid = c.relowner
    WHERE c.relname IN ('tokens', 'org_members', 'audit_log', 'action_events', 'insight_jobs') AND c.relnamespace = 'public'::regnamespace`;
  equal(protectedTables.length, 5, "Both identity and tenant metadata tables are covered");
  check(protectedTables.every(row => row.relrowsecurity && row.relforcerowsecurity && row.owner !== "engram_gateway_security_test"), "Central metadata is forced-RLS protected and not owned by request runtime");
  await denied(() => sql`CREATE ROLE security_forbidden_role`, "Gateway cannot create roles");
  await denied(() => sql`CREATE DATABASE security_forbidden_db`, "Gateway cannot create databases");
  await denied(() => sql`ALTER TABLE action_events ADD COLUMN security_forbidden text`, "Gateway cannot change metadata schema");
  await denied(() => sql`SET ROLE engram_test`, "Gateway cannot assume provisioner authority");
  await denied(() => sql`SELECT rolpassword FROM pg_authid`, "Gateway cannot read PostgreSQL password verifiers");
  await denied(() => sql`UPDATE engram_schema_state SET version = 1`, "Runtime cannot forge the provisioner's schema readiness version");
  equal((await sql`SELECT count(*)::int AS n FROM workspace_complimentary_access`)[0].n >= 0, true, "Restricted runtime can read complimentary entitlement state");
  await denied(() => sql`INSERT INTO workspace_complimentary_access (id,org_id,owner_member_id) VALUES (gen_random_uuid(),1,0)`, "Runtime cannot grant complimentary access");
  await denied(() => sql`UPDATE workspace_complimentary_access SET revoked_at=now() WHERE org_id=1`, "Runtime cannot revoke complimentary access");
  await denied(() => sql`DELETE FROM workspace_complimentary_access WHERE org_id=1`, "Runtime cannot erase complimentary entitlement state");
  await denied(() => sql`INSERT INTO complimentary_access_events (id,org_id,grant_id,owner_member_id,operation,request_id,payload_hash,operator_role,reason) VALUES (gen_random_uuid(),1,gen_random_uuid(),0,'grant','runtime-forgery',repeat('a',64),current_user,'forbidden')`, "Runtime cannot forge a complimentary audit receipt");
  await denied(() => sql`UPDATE complimentary_access_events SET reason='tampered' WHERE org_id=1`, "Runtime cannot alter complimentary audit history");
  await denied(() => sql`DELETE FROM complimentary_access_events WHERE org_id=1`, "Runtime cannot delete complimentary audit history");
  equal((await sql`SELECT count(*)::int AS n FROM hosted_signup_operators`)[0].n >= 0, true, "Runtime can read operator capability membership");
  await denied(() => sql`INSERT INTO hosted_signup_operators (member_id) VALUES (0)`, "Runtime cannot appoint a signup operator");
  await denied(() => sql`UPDATE hosted_signup_operators SET revoked_at=NULL`, "Runtime cannot reactivate a revoked signup operator");
  await denied(() => sql`DELETE FROM hosted_signup_operators`, "Runtime cannot erase the protected operator allowlist");

  const stamp = `${Date.now()}`;
  const betaOperatorEmail = `security-beta-operator-${stamp}@example.test`, betaEmail = `security-beta-friend-${stamp}@example.test`;
  const betaOperatorId = Number((await admin`INSERT INTO org_members (org_id,email,role) VALUES (1,${betaOperatorEmail},'owner') RETURNING id`)[0].id);
  await admin`INSERT INTO hosted_signup_operators (member_id) VALUES (${betaOperatorId})`;
  const betaOperator = normalizeToken({ name: betaOperatorEmail, email: betaOperatorEmail, orgId: 1, role: "owner", kind: "session" });
  equal(await canManageSignupInvites(betaOperator, sql), true, "Restricted runtime reads the live operator capability without acquiring forbidden write authority");
  const betaInvite = await issueSignupInvite(betaOperator, betaEmail, undefined, sql);
  const betaProof = await createSignupVerification(betaEmail, "Restricted signup fixture", betaInvite.inviteCode, "https://security.example", sql);
  const betaAccepted = await acceptInvite(betaProof.raw, sql);
  check(betaAccepted?.org.kind === "personal" && betaAccepted.org.provisioningStatus === "pending", "The restricted request role can atomically verify and queue one personal workspace");
  equal(await acceptInvite(betaProof.raw, sql), null, "Restricted runtime cannot replay the verified admission");
  equal(Number((await sql`SELECT count(*) AS n FROM workspace_complimentary_access WHERE org_id = ${betaAccepted!.org.id}`)[0].n), 0, "Verified runtime admission still cannot grant its own billing entitlement");
  await admin`UPDATE hosted_signup_operators SET revoked_at=now() WHERE member_id=${betaOperatorId}`;
  await ensureHostedSignupInvitesSchema(admin);
  equal(await canManageSignupInvites(betaOperator, sql), false, "Repeated schema bootstrap cannot reactivate an explicitly revoked operator");
  await admin`UPDATE hosted_signup_operators SET revoked_at=NULL WHERE member_id=${betaOperatorId}`;
  const a = await createOrg(`Security A ${stamp}`, "security-owner@example.test", "personal");
  const b = await createOrg(`Security B ${stamp}`, "security-other@example.test", "personal");
  const urlA = tenantDbUrl(a.brainDb), urlB = tenantDbUrl(b.brainDb);
  await Promise.all([ensureDatabase(a.brainDb), ensureDatabase(a.brainDb), ensureDatabase(a.brainDb)]);
  checks++;
  check(new URL(urlA).username !== new URL(urlB).username && new URL(urlA).password !== new URL(urlB).password, "Every tenant has a distinct login and password");
  const worker = brainEnvironment(a, { PATH: "/bin", ENGRAM_TENANT_CREDENTIAL_KEY: "must-not-leak", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "must-not-leak" });
  equal(worker.GBRAIN_DATABASE_URL, urlA, "Worker receives only its tenant-scoped database credential");
  check(!Object.hasOwn(worker, "ENGRAM_TENANT_CREDENTIAL_KEY") && !Object.hasOwn(worker, "ENGRAM_PROVISIONER_DB_URL_TEMPLATE"), "Credential derivation and provisioning authority never enter worker environment");
  const engineA = connect(urlA), engineB = connect(urlB);
  const engineFlags = await engineA`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  check(Object.values(engineFlags[0]).every(flag => flag === false), "Engine role has no administrative attributes");
  equal((await engineA`SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user`)[0].rolconnlimit, 12, "PostgreSQL enforces the engine connection budget independently of gateway pools");
  equal((await engineA`SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'pgcrypto')`)[0].n, 3, "Provisioner installed required extensions before restricted worker startup");
  await denied(() => engineA`UPDATE engram_control.workspace SET org_id = 1`, "Engine cannot forge provisioner-owned readiness or tenant identity");
  // Identical object names and keys in distinct DBs cannot overwrite each other.
  for (const [client, value] of [[engineA, "only-a"], [engineB, "only-b"]] as const) {
    await client`DROP TABLE IF EXISTS security_probe`;
    await client`CREATE TABLE security_probe (id text PRIMARY KEY, value text NOT NULL)`;
    await client`INSERT INTO security_probe VALUES ('same-key', ${value})`;
    await client`ALTER TABLE security_probe ADD COLUMN migrated boolean DEFAULT true`;
    await client`CREATE INDEX security_probe_value_idx ON security_probe (value)`;
  }
  equal((await engineA`SELECT value FROM security_probe WHERE id = 'same-key'`)[0].value, "only-a", "A can migrate/read its own isolated schema");
  equal((await engineB`SELECT value FROM security_probe WHERE id = 'same-key'`)[0].value, "only-b", "B has an independent object with the same logical key");
  // Verify extension functions still work after PUBLIC execute is revoked.
  equal((await engineA`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance`)[0].distance, 1, "Restricted engine can use provisioned pgvector");
  await denied(() => connect(databaseUrl(urlA, b.brainDb))`SELECT * FROM security_probe`, "A's valid credential cannot connect to B's database");
  await denied(() => connect(databaseUrl(urlA, "engram_gateway"))`SELECT * FROM tokens`, "Engine cannot connect to gateway identity or metadata database");
  await denied(() => connect(databaseUrl(runtime.toString().replace("__DB__", "engram_gateway"), a.brainDb))`SELECT 1`, "Gateway runtime cannot connect using its global identity to tenant memory");
  const wrongPassword = new URL(urlA); wrongPassword.password = "wrong-disposable-password";
  await denied(() => connect(wrongPassword.toString())`SELECT 1`, "Tenant passwords are enforced by PostgreSQL authentication", "28P01");
  await denied(() => engineA`CREATE ROLE security_engine_escape`, "Engine cannot create another database role");
  await denied(() => engineA`CREATE DATABASE security_engine_escape_db`, "Engine cannot create a database");
  await denied(() => engineA`SET ROLE engram_test`, "Engine cannot assume provisioner authority");
  await denied(() => engineA`SET ROLE engram_gateway_security_test`, "Engine cannot assume gateway authority");

  // A role accidentally granted table access still gets default-deny RLS. Do not
  // relax CONNECT or table permissions for an actual engine to test this layer.
  const probe = "engram_security_rls_probe";
  await sql`INSERT INTO action_events (id, org_id, agent, tool, summary, status, evidence, occurred_at) VALUES (${`security-rls-private-${stamp}`}, ${a.id}, 'private-agent', 'private-tool', 'private-row', 'completed', 'reported', now())`;
  const exists = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${probe}`;
  if (!exists.length) await admin.unsafe(`CREATE ROLE ${probe} LOGIN PASSWORD 'engram-disposable-probe-password'`);
  await admin.unsafe(`GRANT CONNECT ON DATABASE engram_gateway TO ${probe}`);
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${probe}`);
  await admin.unsafe(`GRANT SELECT, INSERT ON action_events TO ${probe}`);
  const probeUrl = new URL(databaseUrl(template, "engram_gateway")); probeUrl.username = probe; probeUrl.password = "engram-disposable-probe-password";
  const probeDb = connect(probeUrl.toString());
  equal((await probeDb`SELECT count(*)::int AS n FROM action_events`)[0].n, 0, "Untrusted metadata role receives no rows despite explicit table SELECT");
  await denied(() => probeDb`INSERT INTO action_events (id, org_id, agent, tool, summary, status, evidence, occurred_at) VALUES ('security-denied', 1, 'probe', 'probe', 'forbidden', 'completed', 'reported', now())`, "Forced metadata RLS also rejects untrusted writes");

  const memberEmail = "security-member@example.test";
  const memberA = await addMember(a.id, memberEmail, "member");
  await addMember(b.id, memberEmail, "member");
  const originalClaims = { sub: memberEmail, email: memberEmail, org_id: a.id, membership_id: memberA.id };
  equal((await oauthMemberForClaims(originalClaims, sql))?.id, memberA.id, "OAuth accepts the signed exact live membership before removal");
  const linkedA = await issueToken(a.id, "member-agent", true, memberEmail);
  const linkedB = await issueToken(b.id, "member-agent", true, memberEmail);
  const operatorA = await issueToken(a.id, "operator-agent");
  const memberSession = await createSession({ orgId: a.id, name: memberEmail, role: "member", email: memberEmail });
  check(await authenticateStoredSecret(linkedA), "Linked member credential authenticates while membership is current");
  equal(await removeMember(a.id, memberEmail), "removed", "Current owner removes the membership");
  equal(await authenticateStoredSecret(linkedA), null, "Removing a member revokes the issued agent credential");
  equal(await authenticateStoredSecret(memberSession), null, "Member session is revoked at the same boundary");
  equal(await oauthMemberForClaims(originalClaims, sql), null, "Signed OAuth membership loses access immediately on removal");
  check(await authenticateStoredSecret(linkedB), "Same person's credential in a different workspace remains usable");
  check(await authenticateStoredSecret(operatorA), "Explicit operator service credentials have their own revocation lifecycle");
  const rejoined = await addMember(a.id, memberEmail, "member");
  check(rejoined.id !== memberA.id, "Rejoining creates a new membership identity");
  equal(await oauthMemberForClaims(originalClaims, sql), null, "Rejoining the same email cannot resurrect a previous OAuth access grant");
  equal((await oauthMemberForClaims({ ...originalClaims, membership_id: rejoined.id }, sql))?.id, rejoined.id, "A fresh OAuth grant for the new membership can authenticate");
  await sql`UPDATE tokens SET revoked_at = NULL WHERE org_id = ${a.id} AND name = 'member-agent'`;
  equal(await authenticateStoredSecret(linkedA), null, "Even a stale revocation record cannot resurrect an earlier membership's credential");
  const actorB = normalizeToken({ name: "wrong-workspace", orgId: b.id });
  await assert.rejects(() => withOrg(a, actorB, async () => engineA`SELECT * FROM security_probe`), /must match/); checks++;

  // Use a never-before-provisioned ID even when the earlier regression resets
  // org rows but leaves physical test databases for reuse.
  const highestRole = Number((await admin`SELECT coalesce(max(substring(rolname FROM '^engram_tenant_([0-9]+)$')::bigint), 1) AS n FROM pg_roles WHERE rolname ~ '^engram_tenant_[0-9]+$'`)[0].n);
  await admin`SELECT setval('orgs_id_seq', GREATEST((SELECT max(id) FROM orgs), ${highestRole + 10}))`;
  const runGateway = async (arg: string) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./runtime-provision-process.ts", import.meta.url)), arg], {
      env: { ...process.env, ENGRAM_DATABASE_AUTHORITY: "runtime", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_PROVISION_JOB: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    equal(code, 0, `No-admin runtime process succeeds: ${stderr}`);
    return stdout.trim();
  };
  const pendingOrg = JSON.parse(await runGateway("queue"));
  equal((await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${pendingOrg.brainDb}`)[0].n, 0, "Public runtime can queue a workspace but cannot create its database");
  equal((await admin`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${`engram_tenant_${pendingOrg.id}`}`)[0].n, 0, "Public runtime cannot create its engine credential");
  const provisioner = Bun.spawn([process.execPath, fileURLToPath(new URL("../gateway/src/jobs/provision.ts", import.meta.url))], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [jobOutput, jobError, jobCode] = await Promise.all([new Response(provisioner.stdout).text(), new Response(provisioner.stderr).text(), provisioner.exited]);
  equal(jobCode, 0, `Separate provisioner job creates queued storage: ${jobError}`);
  check(JSON.parse(jobOutput).provisioning.ready >= 1, "Separate job reports durable provisioning completion");
  equal((await sql`SELECT o.provisioning_status, c.expires_at, c.revoked_at FROM orgs o JOIN workspace_complimentary_access c ON c.org_id=o.id WHERE o.id=${betaAccepted!.org.id}`)[0], { provisioning_status: "ready", expires_at: null, revoked_at: null }, "The separate privileged job commits the verified signup grant with readiness under restricted runtime ACLs");
  equal(await runGateway(String(pendingOrg.id)), "ready", "Original no-admin runtime can use the completed workspace without schema authority");

  const inventoryOwner = normalizeToken({ name: "security-owner@example.test", orgId: a.id, role: "owner", kind: "session", email: "security-owner@example.test" });
  const inventory = await listConnections(inventoryOwner, sql);
  check(inventory.connections.some(connection => connection.kind === "token" && connection.name === "operator-agent" && connection.status === "authorized"), "Restricted gateway role can read its org-bound connection inventory under forced metadata RLS");
  equal(inventory.connections.find(connection => connection.name === "member-agent")?.status, "membership_removed", "Restricted inventory preserves exact membership revocation after removal and rejoining");

  await admin`CREATE TABLE IF NOT EXISTS _engram_write_lock_probe (label text NOT NULL, group_id text NOT NULL, org_id int NOT NULL, phase text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())`;
  await admin`TRUNCATE _engram_write_lock_probe`;
  await admin`GRANT SELECT, INSERT ON _engram_write_lock_probe TO engram_gateway_security_test`;
  const lockChild = async (orgId: number, label: string, group: string, barrier = false) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./write-lock-process.ts", import.meta.url)), String(orgId), label, group, barrier ? "barrier" : "sleep"], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `Disposable child lock process failed: ${stderr || stdout}`);
  };
  await Promise.all([lockChild(a.id, "same-first", "same"), lockChild(a.id, "same-second", "same")]);
  const intervals = await admin`
    SELECT label, min(at) FILTER (WHERE phase = 'start') AS start, max(at) FILTER (WHERE phase = 'end') AS finish
    FROM _engram_write_lock_probe WHERE group_id = 'same' GROUP BY label ORDER BY start`;
  equal(intervals.length, 2, "Both separate gateway processes completed nested writes");
  check(new Date(intervals[1].start).getTime() >= new Date(intervals[0].finish).getTime(), "Same-tenant critical sections never overlap across processes");
  await Promise.all([lockChild(a.id, "different-first", "different", true), lockChild(b.id, "different-second", "different", true)]);
  const overlap = await admin`
    SELECT max(at) FILTER (WHERE phase = 'start') < min(at) FILTER (WHERE phase = 'end') AS overlapping
    FROM _engram_write_lock_probe WHERE group_id = 'different'`;
  equal(overlap[0].overlapping, true, "Different tenants enter independent write locks concurrently");
  console.log(`PostgreSQL credential and authority isolation passed (${checks} checks).`);
} finally {
  await Promise.all(clients.map(client => client.end({ timeout: 1 }).catch(() => {})));
  await admin.end({ timeout: 2 });
  await closeDatabasePools();
  await closeWriteCoordinator();
}
