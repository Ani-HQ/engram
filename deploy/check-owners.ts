#!/usr/bin/env bun
// Read-only cutover gate. No gateway imports, migrations, repair, or IAM writes.
// Cloud SQL proxy supports CSQL_PROXY_TOKEN: credentials stay out of argv/files.
// https://github.com/GoogleCloudPlatform/cloud-sql-proxy#configuring-environment-variables
import postgres from "postgres";
import { existsSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

export class OwnerCheckError extends Error {
  constructor(readonly code: string, readonly diagnostic?: { errorName?: string; sqlState?: string; httpStatus?: number }) { super("Owner check did not establish the cutover prerequisite"); }
}
function diagnostic(error: unknown): { errorName?: string; sqlState?: string } {
  const item = error as { name?: string; code?: string } | null;
  const errorName = item?.name && ["AbortError", "TimeoutError", "TypeError", "PostgresError", "Error", "SystemError"].includes(item.name) ? item.name : "Error";
  return { errorName, ...(errorName === "PostgresError" && /^[A-Z0-9]{5}$/.test(item?.code ?? "") ? { sqlState: item!.code } : {}) };
}
export interface OwnerCheckSettings { project: string; region: string; instance: string; run: boolean }
export function settings(args: string[]): OwnerCheckSettings {
  const values: Record<string, string> = {};
  let run = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--run" && !run) { run = true; continue; }
    if (!["--project", "--region", "--instance"].includes(key) || values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new OwnerCheckError("invalid_arguments");
    values[key] = args[++i];
  }
  const result = { project: values["--project"] ?? "", region: values["--region"] ?? "us-central1", instance: values["--instance"] ?? "engram-pg", run };
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(result.project) || !/^[a-z]+-[a-z]+[0-9]+$/.test(result.region) || !/^[a-z][a-z0-9-]{0,62}$/.test(result.instance)) throw new OwnerCheckError("invalid_arguments");
  return result;
}

export function databaseCredentials(template: string): { username: string; password: string } {
  try {
    const url = new URL(template.trim());
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/__DB__" || !url.username || !url.password || url.hash || ["user", "username", "password", "database", "dbname"].some(key => url.searchParams.has(key))) throw new Error();
    return { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  } catch { throw new OwnerCheckError("invalid_database_secret"); }
}

export interface OwnerCounts { orgId: number; ownerRows: number; loginOwners: number }
export async function inspectOwners(db: postgres.Sql) {
  return db.begin("isolation level repeatable read read only", async tx => {
    const mode = await tx`SHOW transaction_read_only`;
    if (mode[0]?.transaction_read_only !== "on") throw new OwnerCheckError("readonly_not_enforced");
    const tables = await tx`SELECT to_regclass('public.orgs') IS NOT NULL AS orgs, to_regclass('public.org_members') IS NOT NULL AS members`;
    if (!tables[0]?.orgs || !tables[0]?.members) return { ok: false, gate: "owner_membership", reason: "schema_missing", orgs: [] as OwnerCounts[] };
    const rows = await tx`
      SELECT o.id AS org_id,
        count(m.id) FILTER (WHERE m.role = 'owner')::integer AS owner_rows,
        count(m.id) FILTER (WHERE m.role = 'owner' AND m.email = lower(m.email)
          AND m.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')::integer AS login_owners
      FROM public.orgs o LEFT JOIN public.org_members m ON m.org_id = o.id
      GROUP BY o.id ORDER BY o.id`;
    const orgs = rows.map(row => {
      const orgId = Number(row.org_id), ownerRows = Number(row.owner_rows), loginOwners = Number(row.login_owners);
      if (![orgId, ownerRows, loginOwners].every(Number.isSafeInteger) || orgId < 1 || loginOwners < 0 || ownerRows < loginOwners) throw new OwnerCheckError("invalid_owner_counts");
      return { orgId, ownerRows, loginOwners };
    });
    const reason = !orgs.some(org => org.orgId === 1) ? "org1_missing" : orgs.some(org => org.loginOwners === 0) ? "owners_missing" : "owners_present";
    // Membership presence does not establish identity, mailbox delivery, or
    // overall release readiness. It is only this explicitly named prerequisite.
    return { ok: reason === "owners_present", gate: "owner_membership", reason, orgs };
  });
}

async function cloudRead(project: string, args: string[], signal: AbortSignal, failure: string, maxBytes: number): Promise<string> {
  const child = Bun.spawn(["gcloud", ...args, "--project", project, "--quiet", "--verbosity=error", "--no-log-http"], {
    env: { ...process.env, CLOUDSDK_CORE_LOG_HTTP: "false", CLOUDSDK_CORE_VERBOSITY: "error", CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true" }, stdout: "pipe", stderr: "ignore", stdin: "ignore",
  });
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 15_000);
  try {
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (signal.aborted || code !== 0 || !output.trim() || output.length > maxBytes) throw new OwnerCheckError(failure);
    return output.trim();
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}
// Only operator scripts may choose write mode. The owner-count command below
// always selects read-only and additionally verifies its READ ONLY transaction.
export async function withOperatorDatabase<T>(options: OwnerCheckSettings, mode: "read-only" | "write", work: (db: postgres.Sql) => Promise<T>, signal = new AbortController().signal): Promise<T> {
  settings(["--project", options.project, "--region", options.region, "--instance", options.instance, ...(options.run ? ["--run"] : [])]);
  if (!options.run) throw new OwnerCheckError("explicit_execution_required");
  if (mode !== "read-only" && mode !== "write") throw new OwnerCheckError("invalid_connection_mode");
  let access: string;
  try { access = await cloudRead(options.project, ["auth", "print-access-token"], signal, "authentication_unavailable", 16_384); }
  catch (error) { throw error instanceof OwnerCheckError ? error : new OwnerCheckError("authentication_unavailable", diagnostic(error)); }
  let template: string;
  try {
    template = await cloudRead(options.project, ["secrets", "versions", "access", "latest", "--secret", "engram-provisioner-db-url-template"], signal, "database_secret_unavailable", 65_536);
  } catch (error) { throw error instanceof OwnerCheckError ? error : new OwnerCheckError("database_secret_unavailable", diagnostic(error)); }
  const credentials = databaseCredentials(template);
  const directory = mkdtempSync("/tmp/engram-owner-check-");
  chmodSync(directory, 0o700);
  const connection = `${options.project}:${options.region}:${options.instance}`;
  const socketDirectory = join(directory, connection), socket = join(socketDirectory, ".s.PGSQL.5432");
  if (socket.length > 100) { rmSync(directory, { recursive: true, force: true }); throw new OwnerCheckError("socket_path_too_long"); }
  let proxy: ReturnType<typeof Bun.spawn> | undefined, db: postgres.Sql | undefined;
  const stop = () => proxy?.kill("SIGTERM");
  signal.addEventListener("abort", stop, { once: true });
  try {
    try {
      proxy = Bun.spawn(["cloud-sql-proxy", "--unix-socket", directory, "--max-connections", "1", "--quiet", "--max-sigterm-delay", "1s", connection], {
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CSQL_PROXY_TOKEN: access }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
    } catch (error) { throw new OwnerCheckError("sql_proxy_unavailable", diagnostic(error)); }
    const deadline = Date.now() + 20_000;
    while (!existsSync(socket)) {
      if (signal.aborted || proxy.exitCode !== null || Date.now() >= deadline) throw new OwnerCheckError("sql_proxy_unavailable");
      await Bun.sleep(100);
    }
    db = postgres({ ...credentials, host: socketDirectory, port: 5432, database: "engram_gateway", ssl: false, max: 1, prepare: false, connect_timeout: 5, idle_timeout: 2, onnotice() {}, connection: { default_transaction_read_only: mode === "read-only" ? "on" : "off", statement_timeout: 5000, application_name: mode === "read-only" ? "engram-owner-count-readonly" : "engram-operator-recovery" } });
    if (signal.aborted) throw new OwnerCheckError("interrupted");
    try { return await work(db); }
    catch (error) { throw error instanceof OwnerCheckError ? error : new OwnerCheckError("database_unavailable", diagnostic(error)); }
  } finally {
    await db?.end({ timeout: 1 }).catch(() => {});
    if (proxy) {
      proxy.kill("SIGTERM");
      await Promise.race([proxy.exited, Bun.sleep(1000)]);
      if (proxy.exitCode === null) { proxy.kill("SIGKILL"); await proxy.exited; }
    }
    signal.removeEventListener("abort", stop);
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function checkOwners(options: OwnerCheckSettings, signal = new AbortController().signal) {
  return withOperatorDatabase(options, "read-only", inspectOwners, signal);
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const options = settings(process.argv.slice(2));
    if (!options.run) console.log(JSON.stringify({ mode: "plan", project: options.project, instance: `${options.project}:${options.region}:${options.instance}`, secret: "engram-provisioner-db-url-template", database: "engram_gateway", transaction: "READ ONLY", output: "workspace IDs and owner counts only", mutations: false }));
    else { const result = await checkOwners(options, controller.signal); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 2; }
  } catch (error) {
    console.log(JSON.stringify({ ok: false, gate: "owner_membership", reason: error instanceof OwnerCheckError ? error.code : "check_unavailable", ...(error instanceof OwnerCheckError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
    process.exitCode = 1;
  }
}
