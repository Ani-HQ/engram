# Mail job failures are silent: read Cloud SQL logs, and watch imports and row locks

**Problem shape:** onboarding or reminder emails stop going out. `engram-mail`
executions show failed, but the job's own logs show nothing useful (errors are
withheld by design).

**The procedure:**
1. Find the real error in the database logs:
   `gcloud logging read 'resource.type="cloudsql_database" AND severity>=ERROR' --project ani-hq --freshness 1d`.
2. If the job crashes on start with "Hosted workspaces require isolated
   workers", something in `gateway/src/jobs/mail.ts`'s import graph reaches
   engine code (`worker-command.ts`, `brain.ts`). Mocked job tests miss this;
   `test/mail-job-imports.test.ts` walks the real static imports.
3. `permission denied for table X` from `engram_gateway_runtime` on a SELECT
   usually means `FOR SHARE`/`FOR UPDATE` on an operator-only table. Row locks
   need UPDATE privilege; the runtime role only has SELECT there. Lock only the
   rows the role may write (`FOR SHARE OF i, creator`), and cover it in
   `test/integration-tenant-security.ts` as the runtime role.
4. One bad job blocks the whole queue each run until it hits 5 attempts and is
   marked `retry_exhausted`. Mail then "recovers" on its own, but the next step
   of the same series will hit the bug again, so ship the fix anyway.

**Evidence:** engram, 2026-11-10 to 11-12, PRs #96 and #97; the permission bug
had appeared 56 times since 2026-10-25 before it became constant.
