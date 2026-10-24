# Hosted retention and manual erasure

Operator: **Outcome Driven Holdings LLC**. Hosted service:
`https://engram.ani.computer`. Support/privacy/security contact:
[ani@odstdio.com](mailto:ani@odstdio.com). Adopted 24 October 2026.

This is an operator procedure. It does not add an automated cleanup job, an
account/workspace deletion API, or a guarantee that every copy is erased on a
particular day. The public notice is `/privacy`; technical data flow is documented
in [PRIVACY.md](PRIVACY.md).

## What the implementation actually does

- Memory page deletion calls the engine's `delete_page` and returns
  `recoverable: true`; `restore_page` can restore it. It is soft deletion, not
  permanent erasure. It does not purge memory-entry records, archive pages,
  action reports, audit history, or backups.
- Memory pages, `memory_entries`, related derived/review data, and capture/trail
  content live in workspace storage. Gateway metadata includes identities,
  memberships, credentials, invitations, OAuth grants, activity/audit records,
  public-profile settings, billing, and inference-job metadata. The legacy org 1
  data binding can share the gateway database; do not assume every workspace has
  an exclusive data database.
- `action_events` is append-only in normal operation. Neither it nor `audit_log`
  has an age-based retention job. An expired session/token/grant is unusable;
  expiry does not prove the database row was deleted.
- Subscription cancellation/trial expiry leaves existing information readable
  and exportable. Revoking credentials, removing a member, and unpublishing a
  profile change access; they do not erase the underlying workspace history or
  copies already shared/exported.
- No whole-workspace/account erasure workflow is implemented. Use the manual
  process below; do not equate a successful page-delete response with completion.

Source checkpoints: `gateway/src/web.ts` page delete/restore routes,
`gateway/src/memory-entries.ts`, `gateway/src/db.ts`,
`gateway/src/actions.ts`, and `gateway/src/orgs.ts` membership revocation.

## Operating policy

Keep workspace memory, activity, and account/access metadata until a verified
request calls for removal. There is no automatic cleanup based on inactivity or
subscription status. Aim to acknowledge support/privacy requests within two
business days and complete approved removal from the active service within 30
days after verifying authority and scope. Explain delays before that target and
document any specific retention exception and review date. These are manual
targets, not a claim about statutory deadlines or guaranteed incident resolution.

Retain only the minimum billing, security, dispute, and request-completion records
needed for a documented purpose; do not use that exception to keep deleted memory
or transcripts without a specific reason. Review exceptions and recovery copies
at least monthly and when responding to an erasure request. Give every retained
on-demand backup an owner, purpose, and next review/removal date. Do not leave a
temporary release backup without a follow-up simply because a deployment succeeded.

## Verified infrastructure settings

Verified by the operator on 24 October 2026:

| Store | Setting / boundary |
| --- | --- |
| Cloud SQL automated backups | Enabled; start-time window `09:00` UTC; `backupRetentionSettings.retentionUnit = COUNT`, `retainedBackups = 14`. The count applies to automated backup copies, not all release backups and not a fixed 14-day deletion promise. |
| Cloud SQL point-in-time recovery logs | `transactionLogRetentionDays = 7`. |
| On-demand backups | Independently retained. Backup `1792825021777` was successful, type `ON_DEMAND`, at 06:58:43 UTC on 24 October 2026. Check the live inventory; one successful backup is not a complete inventory or a restore test. |
| Default application-log bucket | `projects/ani-hq/locations/global/buckets/_Default`: `retentionDays = 30`, not locked. This is the configured bucket retention, not a promise about every system/security/edge log. |
| Other logs/providers | Record the actual relevant system/security bucket, edge, mail/payment, and optional AI settings when needed. Do not assume they inherit the default application-log bucket's value. |

Recheck settings after infrastructure changes and at least monthly. Record the
read time, provider resource, configuration, and any retained exceptions in an
operator-controlled record. Do not commit raw logs, customer identifiers,
credentials, exports, or support correspondence to this repository.

## Process an access, correction, or erasure request

1. Record the request in a private operator record with a reference, received
   time, requester, scope, assigned operator, target date, and status. Ask for
   the account email and workspace name; never request a bearer token, password,
   or pasted private memory. Acknowledge the request and explain verification.
2. Verify the request through the account's registered email/current membership.
   An account request is not automatically authority to erase another person's
   team workspace. Confirm the exact workspace IDs and whether the scope is one
   person's information, a page, an entire workspace, or all of their accounts.
   Resolve ownership/shared-content questions before destructive operations.
3. Offer export where appropriate, explain that subscription cancellation is
   separate, and obtain the verified requester's final scope. Inventory current
   `orgs` storage bindings, linked shared copies, active workers, billing links,
   public profiles, and retained backups. Do not start with a blind database drop.
4. For approved full workspace erasure, stop new work first: unpublish its
   profile, revoke the workspace's tokens/sessions/OAuth credentials, disable
   continuing jobs or sharing rules, and stop/wait for active workspace workers.
   Confirm these changes against the workspace ID. Disabling agent writes alone
   does not stop a human session from writing.
5. Use a separate operator/provisioner identity and a reviewed, workspace-scoped
   erasure plan. Check foreign keys and the current schema before changing data.
   Remove the approved tenant memory/derived data and engine-home artifacts, then
   remove or minimize matching central rows according to the approved scope.
   Review `audit_log`, `action_events`, member/credential/invite/OAuth records,
   `action_profiles`, insight jobs/cursors/budgets, sharing rules/copies, billing,
   and complimentary-access records. The runtime identity intentionally lacks
   database/role administration authority.
6. Drop a tenant database or role only after independently verifying it is
   exclusive to that workspace. **Never drop `engram_gateway` or `brain_shared`
   as a generic workspace/account deletion step.** Legacy/shared bindings require
   a separately reviewed row-scoped procedure. Do not use broad email/name
   matches to select unrelated workspaces or remove other contributors' work.
7. Address external/shared copies and retained exceptions. Ask the relevant
   provider/operator to process an applicable request; do not claim the Engram
   database operation deleted Stripe, Resend, optional AI, exported, or recipient
   workspace records. Record which copies cannot be recalled and explain them.
8. Verify the active service: old credentials fail, the public profile is
   unavailable, approved content is absent from both primary/derived storage,
   and unrelated workspaces remain intact. Record evidence identifiers without
   duplicating deleted customer content. Tell the requester what was completed,
   what remains in recovery/provider/exception records, and the relevant review
   or expiry conditions. Mark active-service completion separately from final
   recovery-copy expiry/removal.

Avoid creating a new full-content export or indefinite pre-deletion backup merely
to prove an erasure request. If an exceptional recovery copy is necessary, record
its access restrictions, purpose, owner, and removal/review date in the request.

## Backups and restoring erased data

Automated backups and transaction logs are recovery media, not ordinary product
access. A multi-workspace database backup cannot selectively erase one tenant's
old records in place. Removing all backup copies can affect other workspaces'
recovery; do not promise or perform that as an incidental account operation.
Inventory separate on-demand/release backups when handling erasure; the automated
14-copy policy does not prove those backups expired.

Maintain a minimal, access-controlled erasure ledger outside any database being
restored, using request references, workspace/storage identifiers, completion
time, scope, retained exceptions, and expiry/review conditions. Do not put deleted
memory contents or access secrets in that ledger. Keep only the identifiers
needed to prevent restoration while relevant recovery copies remain.

Restore into isolation. Before restored data receives normal traffic, reapply
recorded erasures and credential/publication changes, verify isolation and other
workspace data, and then approve service access. Record the restore and erasure
checks. A backup must not silently reverse a completed request.
