# Spike findings (2026-08-15, gbrain 0.46.0.0, commit 4922905)

All pre-build unknowns from the plan, resolved against a local pgvector Postgres.

## Verified

1. **`gbrain serve` is a stdio MCP server exposing 114 tools — including writes.**
   `put_page`, `remember`, `add_tag`, `add_link`, `add_timeline_entry` all exist as MCP
   tools, so the gateway never shells out to the CLI. Full dump lives in the spike
   scratchpad; the curated allowlist is in `gateway/src/proxy.ts`.
2. **`GBRAIN_HOME` is honored for config** — `init` writes `$GBRAIN_HOME/.gbrain/config.json`
   (the log line prints `~/.gbrain` cosmetically). Only a harmless `last-update-check`
   file leaks to the real `~/.gbrain` (the #1226 class of bug; non-critical paths only).
3. **Two children, two databases, zero leakage.** Concurrent `serve` children with distinct
   `GBRAIN_HOME` + `GBRAIN_DATABASE_URL`: a page written in scope A is invisible to scope B
   (search and `get_page` both). DB-per-scope is a sound privacy boundary.
4. **Stdio requests multiplex.** Three concurrent `search` calls on one child completed in
   parallel (~50 ms each, not serialized).
5. **Keyless mode works.** With no embedding key, init proceeds ("keyword search + memory
   your agent writes down itself"), search still finds pages. Semantic upgrade later via
   `gbrain init --force --embedding-model ...` + re-embed, or `migrate_embeddings`.
   The embedding choice is therefore NOT a one-way door.
6. **pgvector auto-created** by `gbrain init` when missing (needs a role that can
   `CREATE EXTENSION`; the Cloud SQL `postgres` user can — pgvector is allowlisted).
7. **Driver is postgres.js** (`postgres` npm package), which supports
   `postgresql://user:pass@/db?host=/cloudsql/...` unix-socket URLs — the Cloud SQL
   socket shape. Confirm live at first deploy; fallback is bundling cloud-sql-proxy.

## Cautions carried into the design

- `gbrain init` auto-loads `.env.local` from cwd (dotenv) — Dockerfile removes any and
  `.dockerignore` excludes them.
- 114 tools would bloat every client's context and include destructive ops
  (`sources_remove`, `delete_page`, `submit_agent`, job queue, schema mutation).
  The gateway allowlists 9 + `whoami`.
- `init --force` is used on boot for idempotent config/migrations; safe because config
  lives in the per-scope `GBRAIN_HOME`, data in Postgres.
- **Slug prefixes `test/`, `attachments/`, and `.raw/` are silently hard-excluded from
  search** (`DEFAULT_HARD_EXCLUDES` in `src/core/search/source-boost.ts`). Pages under
  them store and `get_page` fine but never appear in results — this cost an hour of
  false-negative debugging because the local smoke-test page was named `test/...`.
  Agent-facing docs must warn against these prefixes; smoke tests use `notes/...`.

## Local v0 verification (all passing)

Gateway on :8091 against local pgvector Postgres: 401 without bearer; `tools/list`
returns the 10-tool curated surface; `whoami` reports token + scopes; `put_page` →
`search` round-trip hits through the gateway (slug `notes/engram-launch`).
