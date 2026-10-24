/** Exercise the exact patched upstream putPage SQL against disposable PostgreSQL.
 * Source: docker cp <pinned-image-container>:/opt/gbrain/src /tmp/engram-gbrain-cas-source
 * Run: ENGRAM_GBRAIN_CAS_SOURCE=/tmp/engram-gbrain-cas-source \
 * ENGRAM_TEST_DB_URL_TEMPLATE=postgresql://engram_test@127.0.0.1:15432/__DB__ \
 * bun test/integration-gbrain-cas.ts
 * This isolates SQL semantics; full upstream importer smoke belongs to the
 * Docker integration suite. No gateway configuration or production DB is used.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const template = process.env.ENGRAM_TEST_DB_URL_TEMPLATE;
if (!template) throw new Error("Set the disposable integration database template");
const target = new URL(template);
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost"].includes(target.hostname) ||
    target.port !== "15432" || decodeURIComponent(target.username) !== "engram_test" || target.pathname !== "/__DB__" || target.search || target.hash) {
  throw new Error("CAS tests require engram_test on the disposable loopback 15432 sandbox");
}
const source = process.env.ENGRAM_GBRAIN_CAS_SOURCE;
if (!source) throw new Error("Set ENGRAM_GBRAIN_CAS_SOURCE to the unmodified pinned gbrain source copy");
const files = ["core/operations.ts", "core/import-file.ts", "core/engine.ts", "core/postgres-engine.ts", "core/pglite-engine.ts", "mcp/validate-params.ts", "mcp/tool-defs.ts"];
const scratch = await mkdtemp(join(tmpdir(), "engram-cas-"));
const patched = join(scratch, "src");
const dbName = `engram_cas_${randomBytes(8).toString("hex")}`;
function databaseUrl(name: string) { const u = new URL(template!); u.pathname = `/${name}`; return u.toString(); }
const admin = postgres(databaseUrl("engram_gateway"), { max: 1, onnotice: () => {} });
let db: postgres.Sql | undefined;
let created = false;
let checks = 0;
function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
async function conflict(fn: () => Promise<unknown>, message: string) { await assert.rejects(fn, /ENGRAM_CAS_CONFLICT/, message); checks++; }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const page = (text: string) => ({ type: "note", title: text, compiled_truth: text, content_hash: hash(text) });

try {
  equal((await admin`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose,
    "engram-disposable-integration-v1", "Refuse an unmarked cluster");
  for (const name of [...files, "core/levenshtein.ts"]) {
    await mkdir(dirname(join(patched, name)), { recursive: true });
    await copyFile(join(source, name), join(patched, name));
  }
  const patchPath = resolve("deploy/patch-gbrain-cas.py");
  const result = spawnSync("python3", [patchPath, patched], { encoding: "utf8" });
  equal(result.status, 0, `Pinned patch applies: ${result.stderr}`);

  const pgSource = await readFile(join(patched, "core/postgres-engine.ts"), "utf8");
  const start = pgSource.indexOf("  async putPage(");
  const end = pgSource.indexOf("\n  async deletePage(", start);
  assert.ok(start > 0 && end > start);
  // Execute the literal patched method, with unrelated row decoding/slug
  // helpers stubbed. SQL, parameter interpolation, guards and throws are real.
  const harness = join(scratch, "engine.ts");
  await writeFile(harness, `type PageInput = any; type Page = any;
const MARKDOWN_CHUNKER_VERSION = 2;
const validateSlug = (slug: string) => slug;
const contentHash = () => { throw new Error('Tests always supply a content hash'); };
const rowToPage = (row: unknown) => row;
export class SqlEngine {
  constructor(public sql: any) {}
${pgSource.slice(start, end)}
}
`);
  const { SqlEngine } = await import(pathToFileURL(harness).href);
  const { normalizeOptionalParams, validateParams } = await import(pathToFileURL(join(patched, "mcp/validate-params.ts")).href);
  const { paramDefToSchema } = await import(pathToFileURL(join(patched, "mcp/tool-defs.ts")).href);
  const op = { params: { expected_hash: { type: "string", nullable: true }, optional: { type: "string" } } };
  equal(normalizeOptionalParams(op, { expected_hash: null, optional: null }), { expected_hash: null }, "Explicit create-only null survives MCP normalization");
  equal(normalizeOptionalParams(op, { expected_hash: "" }), { expected_hash: "" }, "Malformed empty hash reaches the rejecting handler");
  equal(validateParams(op, { expected_hash: null }), null, "Nullable CAS parameter is accepted by MCP validation");
  equal(paramDefToSchema(op.params.expected_hash), { type: ["string", "null"] }, "All MCP schemas advertise the create-only null");
  const importer = await readFile(join(patched, "core/import-file.ts"), "utf8");
  assert.ok(importer.includes("if (!casWrite && existing?.content_hash === hash") && importer.includes("if (!casWrite && !opts.forceRechunk && engine.findDuplicatePage)")); checks++;
  assert.ok(importer.includes("}, { ...txOpts, ...(casWrite ? { expectedHash: opts.expectedHash } : {}) });")); checks++;
  const operations = await readFile(join(patched, "core/operations.ts"), "utf8");
  assert.ok(operations.includes("...(hasExpectedHash ? { expectedHash: p.expected_hash as string | null } : {})")); checks++;

  // A second patch or source drift must fail before writing any target file.
  const before = await Promise.all(files.map(name => readFile(join(patched, name), "utf8")));
  equal(spawnSync("python3", [patchPath, patched], { encoding: "utf8" }).status, 1, "Already patched/drifted source fails closed");
  equal(await Promise.all(files.map(name => readFile(join(patched, name), "utf8"))), before, "Failed validation leaves every source unchanged");

  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  created = true;
  db = postgres(databaseUrl(dbName), { max: 6, onnotice: () => {} });
  await db`CREATE TABLE pages (
    id bigserial PRIMARY KEY, source_id text NOT NULL, slug text NOT NULL,
    type text, page_kind text, title text, compiled_truth text, timeline text,
    frontmatter jsonb, content_hash text NOT NULL, created_at timestamptz DEFAULT now(),
    updated_at timestamptz, deleted_at timestamptz, effective_date date,
    effective_date_source text, import_filename text, chunker_version smallint,
    source_path text, source_kind text, source_uri text, ingested_via text, ingested_at timestamptz,
    UNIQUE(source_id, slug)
  )`;
  await db`CREATE TABLE side_effects (name text)`;
  const engine = new SqlEngine(db);
  const createdPage = await engine.putPage("cas/existing", page("v1"), { expectedHash: null });
  equal(createdPage.content_hash, hash("v1"), "Create-only inserts an absent page");
  await conflict(() => engine.putPage("cas/existing", page("v2"), { expectedHash: null }), "Create-only cannot replace an existing page");
  equal((await engine.putPage("cas/existing", page("v2"), { expectedHash: hash("v1") })).content_hash, hash("v2"), "Matching version updates");
  await conflict(() => engine.putPage("cas/existing", page("stale"), { expectedHash: hash("v1") }), "Stale version cannot overwrite");
  await conflict(() => engine.putPage("cas/missing", page("wrong-create"), { expectedHash: hash("v1") }), "A non-null expected version cannot create a missing page");
  equal((await db`SELECT count(*)::int AS n FROM pages WHERE slug = 'cas/missing'`)[0].n, 0, "Rejected missing version leaves no row");
  await conflict(() => engine.putPage("cas/existing", page("v2"), { expectedHash: hash("v1") }), "Same-content retry still checks stale version");
  await assert.rejects(() => engine.putPage("cas/existing", page("invalid"), { expectedHash: "" }), /ENGRAM_CAS_INVALID_HASH/); checks++;

  const creators = await Promise.allSettled([
    engine.putPage("cas/raced-create", page("creator-a"), { expectedHash: null }),
    engine.putPage("cas/raced-create", page("creator-b"), { expectedHash: null }),
  ]);
  equal(creators.map(x => x.status).sort(), ["fulfilled", "rejected"], "Exactly one competing absent-page writer wins");
  equal((creators.find(x => x.status === "rejected") as PromiseRejectedResult).reason.message, "ENGRAM_CAS_CONFLICT", "Losing create has explicit conflict result");

  const writers = await Promise.allSettled([
    engine.putPage("cas/existing", page("writer-a"), { expectedHash: hash("v2") }),
    engine.putPage("cas/existing", page("writer-b"), { expectedHash: hash("v2") }),
  ]);
  equal(writers.map(x => x.status).sort(), ["fulfilled", "rejected"], "Exactly one competing same-version writer wins");
  equal((writers.find(x => x.status === "rejected") as PromiseRejectedResult).reason.message, "ENGRAM_CAS_CONFLICT", "Losing update has explicit conflict result");

  await engine.putPage("cas/existing", page("other-source"), { sourceId: "second", expectedHash: null });
  await conflict(() => engine.putPage("cas/existing", page("cross-source"), { sourceId: "second", expectedHash: hash("v2") }), "Version checks stay within the selected source");
  equal((await db`SELECT compiled_truth FROM pages WHERE source_id = 'second'`)[0].compiled_truth, "other-source", "Conflicting source cannot alter another source's content");

  await conflict(async () => {
    await db!.begin(async tx => {
      await tx`INSERT INTO side_effects VALUES ('version-before-put')`;
      await new SqlEngine(tx).putPage("cas/existing", page("bad-transaction"), { expectedHash: hash("v1") });
      await tx`INSERT INTO side_effects VALUES ('chunks-after-put')`;
    });
  }, "Conflict aborts the importer-style transaction before tag/chunk work");
  equal((await db`SELECT count(*)::int AS n FROM side_effects`)[0].n, 0, "Earlier version side effects roll back with the failed guarded write");

  equal((await engine.putPage("cas/existing", page("legacy"))).content_hash, hash("legacy"), "Omitted expected_hash preserves legacy unconditional writes");
  console.log(`gbrain CAS: ${checks} checks passed against disposable PostgreSQL`);
} finally {
  await db?.end({ timeout: 2 });
  if (created) await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end({ timeout: 2 });
  await rm(scratch, { recursive: true, force: true });
}
