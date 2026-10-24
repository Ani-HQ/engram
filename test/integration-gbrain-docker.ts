/** Actual pinned GBrain engine behind restricted database roles and Docker.
 * Creates only disposable Docker resources prefixed engram-isolation-test-.
 * Requires local engram:hardening and pgvector/pgvector:pg16 images.
 * Does not read a production database URL or contact an AI provider.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const suffix = `${process.pid}-${Date.now()}`;
const network = `engram-isolation-test-${suffix}`;
const database = `engram-isolation-test-db-${suffix}`;
const root = await mkdtemp(join(tmpdir(), "engram-isolation-test-"));
const image = process.env.ENGRAM_TEST_WORKER_IMAGE ?? "engram:hardening";
if (!/^engram:hardening(?:-arm)?$/.test(image)) throw new Error("Use a locally built Engram hardening test image");
const run = async (args: string[], options: { env?: Record<string, string>; fail?: boolean; timeoutMs?: number } = {}) => {
  const child = Bun.spawn(["docker", ...args], { env: options.env ?? process.env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code && !options.fail) throw new Error(`Disposable Docker command failed: ${stderr.replace(/postgres(?:ql)?:\/\/\S+/g, "[test database URL]").slice(-2000)}`);
  return { stdout, stderr, code };
};
let checks = 0;
function check(value: unknown, message: string): asserts value { assert.ok(value, message); checks++; }
function equal(value: unknown, expected: unknown, message: string) { assert.deepEqual(value, expected, message); checks++; }
let close: (() => Promise<void>) | undefined;
let stop: (() => Promise<void>) | undefined;
let closeLocks: (() => Promise<void>) | undefined;
const observers: postgres.Sql[] = [];
try {
  await run(["network", "create", "--internal", network]);
  console.error("[gbrain-docker] Disposable internal network created");
  equal((await run(["network", "inspect", "--format", "{{.Internal}}", network])).stdout.trim(), "true", "Engine network has no external egress route");
  // Only the database also joins the Docker bridge for a loopback host port;
  // engines have the internal network exclusively and cannot inherit that route.
  await run(["run", "-d", "--name", database, "--network", "bridge", "-p", "127.0.0.1:15433:5432", "--env", "POSTGRES_USER=engram_test", "--env", "POSTGRES_PASSWORD=disposable-engram-password", "--env", "POSTGRES_DB=engram_gateway", "pgvector/pgvector:pg16"]);
  await run(["network", "connect", "--alias", "engram-test-db", network, database]);
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await run(["exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "engram_test", "-d", "engram_gateway"], { fail: true });
    if (!ready.code) break;
    if (attempt === 59) throw new Error("Disposable PostgreSQL container did not become ready");
    await Bun.sleep(250);
  }
  process.env.ENGRAM_DB_URL_TEMPLATE = "postgresql://engram_gateway:disposable-runtime-password@127.0.0.1:15433/__DB__";
  console.error("[gbrain-docker] Disposable PostgreSQL TCP server ready");
  process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE = "postgresql://engram_test:disposable-engram-password@127.0.0.1:15433/__DB__";
  process.env.ENGRAM_TENANT_CREDENTIAL_KEY = "disposable-docker-worker-key-32-bytes-minimum";
  process.env.ENGRAM_WORKER_DB_URL_TEMPLATE = "postgresql://ignored:ignored@engram-test-db:5432/__DB__";
  process.env.ENGRAM_DEPLOYMENT_MODE = "hosted";
  process.env.ENGRAM_DATABASE_AUTHORITY = "provisioner";
  process.env.ENGRAM_WORKER_ISOLATION = "docker";
  process.env.ENGRAM_WORKER_IMAGE = image;
  process.env.ENGRAM_WORKER_NETWORK = network;
  process.env.GBRAIN_HOMES_DIR = root;
  process.env.VOYAGE_API_KEY = "";
  process.env.REFLEX_API_KEY = "";
  delete process.env.ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS;
  // Sentinels prove these parent-only values are not inherited by a worker.
  process.env.RESEND_API_KEY = "parent-only-mail-sentinel";
  await writeFile(join(root, "parent-secret"), "parent-only-file-sentinel");
  const { migrate, closeDatabasePools } = await import("../gateway/src/db"); close = closeDatabasePools;
  const { createOrg, withOrg } = await import("../gateway/src/orgs");
  const { ensureBrain, stopBrains } = await import("../gateway/src/brain"); stop = stopBrains;
  const { closeWriteCoordinator } = await import("../gateway/src/write-coordination"); closeLocks = closeWriteCoordinator;
  const { workerCommand } = await import("../gateway/src/worker-command");
  const { verifyWorkerIsolation } = await import("../gateway/src/worker-preflight");
  const { brainEnvironment } = await import("../gateway/src/privacy");
  const { tenantDbUrl } = await import("../gateway/src/tenant-db");
  const { normalizeToken } = await import("../gateway/src/policies");
  await verifyWorkerIsolation();
  checks++;
  console.error("[gbrain-docker] Full worker namespace, metadata and cleanup preflight passed");
  await migrate();
  console.error("[gbrain-docker] Strict database provisioning complete");
  const a = await createOrg("Disposable engine A", "a@example.test", "personal");
  const b = await createOrg("Disposable engine B", "b@example.test", "personal");
  await writeFile(join(root, b.homeDir, "other-tenant-secret"), "other-tenant-file-sentinel").catch(async () => {
    const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, b.homeDir), { mode: 0o700 });
    await writeFile(join(root, b.homeDir, "other-tenant-secret"), "other-tenant-file-sentinel");
  });
  const actorA = normalizeToken({ name: "engine-a", orgId: a.id });
  const actorB = normalizeToken({ name: "engine-b", orgId: b.id });
  const initialized = new Set<number>();
  const call = async (org: typeof a, actor: typeof actorA, name: string, args: Record<string, unknown>) => withOrg(org, actor, async () => {
    if (!initialized.has(org.id)) {
      console.error(`[gbrain-docker] Initializing isolated engine ${org.id} with embeddings disabled`);
      const init = workerCommand(org.homeDir, ["init", "--non-interactive", "--force", "--json", "--no-embedding"], brainEnvironment(org));
      await run(init.args, { env: init.env, timeoutMs: 120_000 });
      initialized.add(org.id);
      console.error(`[gbrain-docker] Engine ${org.id} initialized`);
    }
    const client = await ensureBrain(org);
    const result = await client.callTool({ name, arguments: args });
    check(!result.isError, `Actual engine ${name} succeeds for the authenticated workspace`);
    return JSON.stringify(result);
  });
  await call(a, actorA, "put_page", { slug: "security/same-page", expected_hash: null, content: "---\ntitle: amberalbatross\ntype: note\n---\n\nOnly tenant A remembers amberalbatross.\n" });
  const pageA = await call(a, actorA, "get_page", { slug: "security/same-page" });
  check(pageA.includes("amberalbatross") && !pageA.includes("violetbadger"), "Actual GBrain A reads only A's same-slug page");
  const pageHash = (response: string) => JSON.parse(JSON.parse(response).content[0].text).content_hash as string;
  const originalHash = pageHash(pageA);
  check(/^[a-f0-9]{64}$/.test(originalHash), "MCP get_page exposes the current atomic-write version");
  await call(a, actorA, "put_page", { slug: "security/same-page", expected_hash: originalHash, content: "---\ntitle: amberalbatross\ntype: note\n---\n\nOnly tenant A remembers amberalbatross with a guarded update.\n" });
  const updated = await call(a, actorA, "get_page", { slug: "security/same-page" });
  const updatedHash = pageHash(updated);
  check(updatedHash !== originalHash && updated.includes("guarded update"), "Full importer accepts the current expected_hash and advances its version");
  const observer = postgres(tenantDbUrl(a.brainDb), { max: 1, onnotice() {} }); observers.push(observer);
  const snapshot = async () => Promise.all([
    observer`SELECT content_hash, title, compiled_truth, timeline FROM pages WHERE slug = 'security/same-page' ORDER BY source_id`,
    observer`SELECT to_jsonb(c) AS chunk FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'security/same-page' ORDER BY c.id`,
  ]);
  const beforeConflict = await snapshot();
  const rejectedWrite = async (slug: string, expectedHash: string | null) => withOrg(a, actorA, async () => {
    const client = await ensureBrain(a);
    const result = await client.callTool({ name: "put_page", arguments: { slug, expected_hash: expectedHash, content: "---\ntitle: forbidden replacement\ntype: note\n---\n\nNever save this stale imported body or its chunks.\n" } });
    check(result.isError && JSON.stringify(result).includes("ENGRAM_CAS_CONFLICT"), "Full MCP importer rejects stale/create-only/missing versions with an explicit conflict");
  });
  await rejectedWrite("security/same-page", originalHash);
  equal(await snapshot(), beforeConflict, "Rejected stale import preserves the stored page and every content chunk");
  await rejectedWrite("security/same-page", null);
  equal(await snapshot(), beforeConflict, "Create-only guard cannot replace an existing page or chunks");
  await rejectedWrite("security/missing-page", updatedHash);
  equal((await observer`SELECT count(*)::int AS n FROM pages WHERE slug = 'security/missing-page'`)[0].n, 0, "A non-null expected version cannot create a missing page through the importer");
  console.error("[gbrain-docker] Full MCP importer version and chunk-preservation checks passed");
  await call(b, actorB, "put_page", { slug: "security/same-page", expected_hash: null, content: "---\ntitle: violetbadger\ntype: note\n---\n\nOnly tenant B remembers violetbadger.\n" });
  const pageB = await call(b, actorB, "get_page", { slug: "security/same-page" });
  check(pageB.includes("violetbadger") && !pageB.includes("amberalbatross"), "Actual GBrain B reads only B's same-slug page");
  const searchA = await call(a, actorA, "search", { query: "amberalbatross", limit: 10 });
  const foreignSearch = await call(b, actorB, "search", { query: "amberalbatross", limit: 10 });
  check(searchA.includes("amberalbatross"), "Actual engine search finds the tenant's content without an AI provider");
  check(!foreignSearch.includes("Only tenant A"), "Actual engine search does not expose another tenant's content");
  const env = brainEnvironment(a);
  const spec = workerCommand(a.homeDir, [], env);
  const probe = `
    import { existsSync } from "node:fs";
    if (process.env.RESEND_API_KEY || process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE || process.env.ENGRAM_TENANT_CREDENTIAL_KEY) throw new Error("Parent credentials leaked");
    if (existsSync(${JSON.stringify(join(root, "parent-secret"))}) || existsSync(${JSON.stringify(join(root, b.homeDir, "other-tenant-secret"))}) || existsSync("/var/run/docker.sock")) throw new Error("Host or sibling tenant mount leaked");
    const pids = (await import("node:fs/promises")).readdir("/proc");
    if ((await pids).filter(x => /^\\d+$/.test(x)).length > 12) throw new Error("Host PID namespace leaked");
    console.log("isolated");
  `;
  const args = [...spec.args];
  const entry = args.indexOf("--entrypoint"); args.splice(entry, 3, "--entrypoint", "/usr/local/bin/bun", image, "-e", probe);
  const security = await run(args, { env: spec.env });
  equal(security.stdout.trim(), "isolated", "Docker worker excludes parent secrets, sibling homes, host Docker socket and host PIDs");
  const attackUrl = new URL(tenantDbUrl(a.brainDb)); attackUrl.pathname = `/${b.brainDb}`;
  const attacker = postgres(attackUrl.toString(), { max: 1, onnotice() {} });
  try { await assert.rejects(async () => await attacker`SELECT * FROM pages`, (error: any) => error.code === "42501"); checks++; }
  finally { await attacker.end({ timeout: 1 }); }
  // Engine homes remain separate durable configurations, never a shared cwd.
  check((await readFile(join(root, "parent-secret"), "utf8")) === "parent-only-file-sentinel", "Worker initialization leaves parent files untouched");
  console.log(`Actual Docker GBrain isolation passed (${checks} checks).`);
} finally {
  await stop?.().catch(() => {}); await close?.().catch(() => {}); await closeLocks?.().catch(() => {});
  await Promise.all(observers.map(client => client.end({ timeout: 1 }).catch(() => {})));
  const workers = await run(["ps", "-aq", "--filter", `network=${network}`], { fail: true });
  const ids = workers.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids], { fail: true });
  await run(["rm", "-f", database], { fail: true });
  await run(["network", "rm", network], { fail: true });
  await rm(root, { recursive: true, force: true });
}
