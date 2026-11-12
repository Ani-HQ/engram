# A release needs the mail job prepared on the new image, and a pinned Cloud SDK

**Problem shape:** `release.py activate` fails with "Mail worker operation failed"
after stage and smoke pass, or the Cloud Build `release-automation-tests` step
fails with `python3: command not found`.

**The procedure:**
1. Pin Cloud SDK build steps by digest. `cloud-sdk:latest` dropped python3 in
   early November 2026; `cloudbuild.yaml` now pins `sha256:aa2b2728…`.
2. After the merge build passes: take an on-demand backup
   (`gcloud sql backups create --instance engram-pg`), then
   `release.py stage --backup-id <id>`, then `bun deploy/smoke-candidate.ts ... --run`.
3. Before `activate`, run `python3 deploy/mail-series.py prepare --project ani-hq
   --image <same image>`. Activation verifies the mail job is on the exact
   release image with delivery off; it does not update the job itself. Activate
   then re-enables delivery and the schedule.
4. A failed activate pre-check leaves traffic on the old revision, so retrying
   after the fix is safe.
5. Activate refuses a smoke older than 2 hours. Re-run the smoke, then activate.
   `prepare` pauses the mail schedule, so activate promptly after it.
6. Every stage and activate pauses the Jev billing exporter unless both carry
   `--jev-enable-customer-billing --jev-markup-bps 0`. Leaving the flag off on
   2026-11-04 paused billing for 8 days without anyone noticing.

**Evidence:** engram, 2026-11-04, PRs #86 and #87, revision `engram-r-1793791850`.
