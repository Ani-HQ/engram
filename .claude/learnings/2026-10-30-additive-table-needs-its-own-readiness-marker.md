# A new table needs its own readiness marker, wired in five places

**Problem shape:** adding a gateway table (here `agent_identities`) and the
runtime either refuses to start ("run the separate provisioner job first") or
the migration check passes on a database that lacks the table.

**The procedure:**
1. Put the DDL in `gateway/src/<feature>-schema.ts` with an exported
   `<FEATURE>_SCHEMA_VERSION` (date-based int) and `ensure<Feature>Schema()`.
2. Call it from `gateway/src/db.ts` migrate, before `protectGatewayMetadata`
   (which grants runtime DML and FORCE RLS to every public table automatically).
3. `gateway/src/provisioning-schema.ts`: ADD COLUMN `<feature>_version`, add it
   to the `markSchemaReady` INSERT/ON CONFLICT, the `assertRuntimeSchema` SELECT
   and the mismatch check.
4. `deploy/check-migration.ts`: SELECT and compare the marker.
5. Tests: `test/activity-schema.test.ts` (ready row, values array, reject loop),
   `test/check-migration.test.ts` (fixture row, reject loop),
   `test/integration-tenant-security.ts` (runtime cannot forge the marker).
6. Run the three PostgreSQL suites in CI order on a fresh container (see
   2026-10-27-run-integration-suites-in-ci-order.md). If Docker is down,
   `open -a Docker` and poll `docker info`.

**Traps:** a hand-built PNG fixture needs a valid filter byte (0-4) at the start
of every row or strict validators reject it. Demo fixture additions in
`web/dev-server.ts` change counts asserted in `web/dev-server.test.ts`.

**Evidence:** PR #75 (feat/agent-self-identity), 30 Oct 2026.
