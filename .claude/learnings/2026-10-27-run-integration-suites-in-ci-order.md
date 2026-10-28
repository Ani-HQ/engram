# Run engram's PostgreSQL integration scripts in CI order on one fresh database

**Problem shape:** `bun test/integration-tenant-security.ts` or
`integration-managed-provisioner.ts` fails immediately with
`relation "_engram_integration_sandbox" does not exist`, or
`integration-postgres.ts` fails on a second run with a workspace-name
assertion like "Ready metadata fixtures have no tenant databases".

**The procedure:**
1. Start a fresh `pgvector/pgvector:pg16` container on port 15432 with user and
   password `engram_test` and database `engram_gateway`.
2. Set `ENGRAM_TEST_DB_URL_TEMPLATE=postgresql://engram_test:engram_test@127.0.0.1:15432/__DB__`.
3. Run, in this order, on that same container: `integration-postgres.ts`,
   `integration-tenant-security.ts`, `integration-managed-provisioner.ts`.
4. To rerun, delete and recreate the container first.

**Why this works / the trap it avoids:** the later scripts depend on the sandbox
marker that `integration-postgres.ts` creates. Some suites leave tenant
databases behind, so a reused database fails on its own leftovers. Neither
failure means your change is wrong; compare against a clean run before debugging.

**Evidence:** `.github/workflows/test.yml` step order; verified 27 Oct 2026 (PR #51).
