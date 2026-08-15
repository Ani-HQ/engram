#!/usr/bin/env python3
"""Build-time patch for the pinned gbrain checkout (applied in the Dockerfile).

Why: Cloud SQL grants no role BYPASSRLS or superuser, so three gbrain
migrations hard-fail there (v24/v29 RAISE EXCEPTION without BYPASSRLS; v35
additionally needs superuser for CREATE EVENT TRIGGER). gbrain's own
schema-embedded.ts already gates the same RLS setup gracefully — this patch
extends that graceful-skip pattern to the three migrations. RLS is unused in
engram's deployment: every scope database is single-tenant and authorization
is enforced by the engram gateway.

Exact-match string replacement, loud failure: if upstream changes these
blocks (a GBRAIN_COMMIT bump), the build fails here instead of shipping an
unpatched image.
"""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/opt/gbrain/src/core/migrate.ts"
src = open(path, encoding="utf-8").read()

REPLACEMENTS = [
    # v24: skip RLS backfill instead of aborting init.
    (
        """        IF NOT has_bypass THEN
          -- Fail the migration loudly instead of WARNING + version-bump.
          -- The runner unconditionally records schema_version on success,
          -- so a silent WARNING here would permanently lock the backfill out
          -- on future runs even after switching to a bypass role. Raising
          -- aborts the transaction, leaves schema_version at the prior value,
          -- and lets the next invocation retry after the role is fixed.
          RAISE EXCEPTION 'v24 rls_backfill_missing_tables: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role). The migration will retry automatically on the next initSchema call.', current_user;
        END IF;""",
        """        IF NOT has_bypass THEN
          -- engram: skip instead of raise (Cloud SQL has no BYPASSRLS role;
          -- single-tenant per-scope databases do not use RLS).
          RAISE NOTICE 'v24: skipping RLS backfill — role % lacks BYPASSRLS', current_user;
          RETURN;
        END IF;""",
    ),
    # v29: same skip pattern.
    (
        """          IF NOT has_bypass THEN
            RAISE EXCEPTION 'v29 cathedral_ii_code_edges_rls: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role). The migration will retry automatically on the next initSchema call.', current_user;
          END IF;""",
        """          IF NOT has_bypass THEN
            -- engram: skip instead of raise (Cloud SQL has no BYPASSRLS role).
            RAISE NOTICE 'v29: skipping code_edges RLS — role % lacks BYPASSRLS', current_user;
            RETURN;
          END IF;""",
    ),
    # v31: the BYPASSRLS gate sits BEFORE the CREATE TABLEs, so a plain skip
    # would drop the tables. Create unconditionally; gate only the RLS ALTERs.
    (
        """          IF NOT has_bypass THEN
            RAISE EXCEPTION 'v31 eval_capture_tables: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role). The migration will retry automatically on the next initSchema call.', current_user;
          END IF;""",
        """          IF NOT has_bypass THEN
            -- engram: tables still created below; only RLS is skipped.
            RAISE NOTICE 'v31: skipping RLS — role % lacks BYPASSRLS', current_user;
          END IF;""",
    ),
    (
        """          CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates (created_at DESC);
          ALTER TABLE eval_candidates ENABLE ROW LEVEL SECURITY;""",
        """          CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates (created_at DESC);
          IF has_bypass THEN
            ALTER TABLE eval_candidates ENABLE ROW LEVEL SECURITY;
          END IF;""",
    ),
    (
        """          CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures (ts DESC);
          ALTER TABLE eval_capture_failures ENABLE ROW LEVEL SECURITY;

          RAISE NOTICE 'v31: eval_capture tables ready (role % has BYPASSRLS)', current_user;""",
        """          CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures (ts DESC);
          IF has_bypass THEN
            ALTER TABLE eval_capture_failures ENABLE ROW LEVEL SECURITY;
          END IF;

          RAISE NOTICE 'v31: eval_capture tables ready', current_user;""",
    ),
    # v35 backfill DO block: same skip pattern.
    (
        """          IF NOT has_bypass THEN
            -- Same posture as v24: raise to abort the migration so the runner
            -- leaves config.version unbumped and retries on the next call.
            RAISE EXCEPTION 'v35 auto_rls_event_trigger backfill: role % does not have BYPASSRLS — cannot enable RLS safely. Re-run as postgres (or another BYPASSRLS role).', current_user;
          END IF;""",
        """          IF NOT has_bypass THEN
            -- engram: skip instead of raise (Cloud SQL has no BYPASSRLS role).
            RAISE NOTICE 'v35: skipping RLS backfill — role % lacks BYPASSRLS', current_user;
            RETURN;
          END IF;""",
    ),
    # v35 event trigger: CREATE EVENT TRIGGER requires superuser, which the
    # top-level statement cannot check. Gate it inside a DO block. The plain
    # auto_enable_rls() function creation above it needs no privilege and stays.
    (
        """        DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table;
        CREATE EVENT TRIGGER auto_rls_on_create_table
          ON ddl_command_end
          WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
          EXECUTE FUNCTION auto_enable_rls();""",
        """        DO $v35tg$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND pr.rolsuper) THEN
            -- engram: event triggers need superuser; Cloud SQL has none.
            RAISE NOTICE 'v35: skipping auto-RLS event trigger — requires superuser';
          ELSE
            EXECUTE 'DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table';
            EXECUTE 'CREATE EVENT TRIGGER auto_rls_on_create_table ON ddl_command_end WHEN TAG IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'') EXECUTE FUNCTION auto_enable_rls()';
          END IF;
        END $v35tg$;""",
    ),
]

for old, new in REPLACEMENTS:
    if old not in src:
        sys.exit(f"patch-gbrain: target block not found (upstream drift?):\n{old[:160]}...")
    src = src.replace(old, new, 1)

open(path, "w", encoding="utf-8").write(src)
print(f"patch-gbrain: {len(REPLACEMENTS)} blocks patched in {path}")
