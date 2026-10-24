#!/usr/bin/env python3
"""Add atomic put_page compare-and-swap to pinned gbrain 4922905fb970.

expected_hash omitted preserves upstream writes; null creates only if absent;
a SHA-256 string updates only the same existing version. The PostgreSQL write
is the authority: importer prechecks never substitute for the guarded write.
All pinned files and all replacement anchors are checked before any writes.
Usage: python3 deploy/patch-gbrain-cas.py [/opt/gbrain/src]
"""
from hashlib import sha256
from pathlib import Path
import sys

PINNED = {
    "core/operations.ts": "eb6474d852f73327829531eec4a539ed0e88d642db0861b60b9e74c89ee2abe7",
    "core/import-file.ts": "39bf9bd026343a0916e3b57cc15fe8b0010d220a21a3b54804c663e9da66038e",
    "core/engine.ts": "d9957ba4fa60e4ec62eac0a6260ef227fe710f76ac0b424cafd8159badd1f109",
    "core/postgres-engine.ts": "f6e317786c93f0ee47b6dcf7395fbad8724f039b5e8100759b3921433447fae7",
    "core/pglite-engine.ts": "c8e49da33169e6b222f4c8669d4a2eb2aae29f7630a53596de67a5b0be73cb06",
    "mcp/validate-params.ts": "d0a1f95906c5c1948d24f99b835b741ba904b3999fded886e8826a53b37dca33",
    "mcp/tool-defs.ts": "b994a4de97cbf5e77810fd400d8fa9fe98644a3ee66c63f810e3aaffce2712cc",
}


def patch(root: Path) -> None:
    sources = {}
    for name, digest in PINNED.items():
        raw = (root / name).read_bytes()
        if sha256(raw).hexdigest() != digest:
            raise ValueError(f"pinned source changed: {name}")
        sources[name] = raw.decode("utf-8")

    def replace(name: str, before: str, after: str) -> None:
        if sources[name].count(before) != 1:
            raise ValueError(f"expected one exact anchor: {name}: {before[:80]!r}")
        sources[name] = sources[name].replace(before, after, 1)

    replace("core/operations.ts", "  required?: boolean;\n  description?: string;",
            "  required?: boolean;\n  nullable?: boolean;\n  description?: string;")
    replace("core/operations.ts",
            "    content: { type: 'string', required: true, description: 'Full markdown content with YAML frontmatter' },",
            "    content: { type: 'string', required: true, description: 'Full markdown content with YAML frontmatter' },\n"
            "    expected_hash: { type: 'string', nullable: true, required: false, description: 'Atomic version guard: omit for an unconditional write; null to create only if absent; otherwise the current content_hash from get_page. A stale or missing version fails without changing the page.' },")
    replace("core/operations.ts", "    const slug = p.slug as string;\n\n    // v0.39.3.0 CV6 trust gate",
            "    const slug = p.slug as string;\n"
            "    const hasExpectedHash = Object.prototype.hasOwnProperty.call(p, 'expected_hash');\n"
            "    if (hasExpectedHash && p.expected_hash !== null &&\n"
            "        (typeof p.expected_hash !== 'string' || !/^[a-f0-9]{64}$/.test(p.expected_hash))) {\n"
            "      throw new OperationError('invalid_params', 'expected_hash must be null or a lowercase SHA-256 content hash');\n"
            "    }\n\n    // v0.39.3.0 CV6 trust gate")
    replace("core/operations.ts",
            "    const result = await importFromContent(ctx.engine, slug, p.content as string, {\n      noEmbed,",
            "    const result = await importFromContent(ctx.engine, slug, p.content as string, {\n"
            "      noEmbed,\n      ...(hasExpectedHash ? { expectedHash: p.expected_hash as string | null } : {}),")
    # Null is meaningful for CAS. It must survive the common MCP normalization.
    replace("mcp/validate-params.ts", "    if (def.required) continue;",
            "    if (def.required || def.nullable) continue;")
    replace("mcp/tool-defs.ts", "    type: p.type === 'array' ? 'array' : p.type,",
            "    type: p.nullable ? [p.type, 'null'] : p.type === 'array' ? 'array' : p.type,")

    replace("core/import-file.ts", "    noEmbed?: boolean;\n    sourceId?: string;",
            "    noEmbed?: boolean;\n    sourceId?: string;\n    expectedHash?: string | null;")
    replace("core/import-file.ts", "  const sourceId = opts.sourceId;\n  // Reject oversized payloads",
            "  const sourceId = opts.sourceId;\n"
            "  const casWrite = opts.expectedHash !== undefined;\n"
            "  if (casWrite && opts.expectedHash !== null &&\n"
            "      (typeof opts.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(opts.expectedHash))) {\n"
            "    throw new Error('ENGRAM_CAS_INVALID_HASH');\n"
            "  }\n  // Reject oversized payloads")
    replace("core/import-file.ts", "  if (existing?.content_hash === hash && !opts.forceRechunk) {",
            "  if (!casWrite && existing?.content_hash === hash && !opts.forceRechunk) {")
    replace("core/import-file.ts", "  if (!opts.forceRechunk && engine.findDuplicatePage) {",
            "  if (!casWrite && !opts.forceRechunk && engine.findDuplicatePage) {")
    replace("core/import-file.ts",
            "      // provenance write fires; never client-controlled.\n    }, txOpts);",
            "      // provenance write fires; never client-controlled.\n"
            "    }, { ...txOpts, ...(casWrite ? { expectedHash: opts.expectedHash } : {}) });")

    old_opts = "putPage(slug: string, page: PageInput, opts?: { sourceId?: string })"
    new_opts = "putPage(slug: string, page: PageInput, opts?: { sourceId?: string; expectedHash?: string | null })"
    for name in ("core/engine.ts", "core/postgres-engine.ts", "core/pglite-engine.ts"):
        replace(name, old_opts, new_opts)
    replace("core/pglite-engine.ts", f"  async {new_opts}: Promise<Page> {{\n    slug = validateSlug(slug);",
            f"  async {new_opts}: Promise<Page> {{\n"
            "    if (opts?.expectedHash !== undefined) throw new Error('ENGRAM_CAS_REQUIRES_POSTGRES');\n"
            "    slug = validateSlug(slug);")

    replace("core/postgres-engine.ts", f"  async {new_opts}: Promise<Page> {{\n    slug = validateSlug(slug);",
            f"  async {new_opts}: Promise<Page> {{\n"
            "    const casWrite = opts?.expectedHash !== undefined;\n"
            "    const expectedHash = opts?.expectedHash ?? null;\n"
            "    if (casWrite && expectedHash !== null &&\n"
            "        (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) {\n"
            "      throw new Error('ENGRAM_CAS_INVALID_HASH');\n"
            "    }\n    slug = validateSlug(slug);")
    # Lock an existing matching version before admitting the INSERT. This also
    # prevents a non-null expected_hash from creating a missing/deleted row.
    replace("core/postgres-engine.ts",
            "    const rows = await sql`\n      INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at, effective_date, effective_date_source, import_filename, chunker_version, source_path, source_kind, source_uri, ingested_via, ingested_at)",
            "    const rows = await sql`\n"
            "      WITH cas_target AS MATERIALIZED (\n"
            "        SELECT id FROM pages\n"
            "        WHERE ${casWrite}::boolean AND ${expectedHash}::text IS NOT NULL\n"
            "          AND source_id = ${sourceId} AND slug = ${slug}\n"
            "          AND content_hash = ${expectedHash}::text\n"
            "        FOR UPDATE\n"
            "      )\n"
            "      INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at, effective_date, effective_date_source, import_filename, chunker_version, source_path, source_kind, source_uri, ingested_via, ingested_at)")
    before_values = "      VALUES (${sourceId}, ${slug}, ${page.type}, ${pageKind}, ${page.title}, ${page.compiled_truth}, ${page.timeline || ''}, ${sql.json(frontmatter as Parameters<typeof sql.json>[0])}, ${hash}, now(), ${effectiveDate}, ${effectiveDateSource}, ${importFilename}, COALESCE(${chunkerVersion}::smallint, ${MARKDOWN_CHUNKER_VERSION}), ${sourcePath}, ${sourceKind}, ${sourceUri}, ${ingestedVia}, ${ingestedAt})"
    replace("core/postgres-engine.ts", before_values,
            before_values.replace("VALUES (", "SELECT ")[:-1] + "\n"
            "      WHERE NOT ${casWrite}::boolean OR ${expectedHash}::text IS NULL\n"
            "        OR EXISTS (SELECT 1 FROM cas_target)")
    replace("core/postgres-engine.ts",
            "        ingested_at           = COALESCE(EXCLUDED.ingested_at,           pages.ingested_at)\n      RETURNING",
            "        ingested_at           = COALESCE(EXCLUDED.ingested_at,           pages.ingested_at)\n"
            "      WHERE NOT ${casWrite}::boolean OR\n"
            "        (${expectedHash}::text IS NOT NULL AND pages.content_hash = ${expectedHash}::text)\n      RETURNING")
    replace("core/postgres-engine.ts",
            "    return rowToPage(rows[0]);\n  }\n\n  async deletePage(slug:",
            "    if (rows.length === 0) throw new Error('ENGRAM_CAS_CONFLICT');\n"
            "    return rowToPage(rows[0]);\n  }\n\n  async deletePage(slug:")

    for name, source in sources.items():
        (root / name).write_text(source, encoding="utf-8")


if __name__ == "__main__":
    try:
        patch(Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/gbrain/src"))
    except (OSError, ValueError) as error:
        sys.exit(f"patch-gbrain-cas: refusing to patch: {error}")
    print("patch-gbrain-cas: applied pinned atomic put_page version guards")
