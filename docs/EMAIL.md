# Product email

Engram's email is rendered locally from `gateway/src/mail-templates.ts`, using
the shared design system's email tokens. Every template has a subject, preview
line, HTML body, plain-text body and one primary action. No tracking pixel,
remote font, animation, JavaScript or externally loaded image is required.
Replies go to `ani@odstdio.com`.

## Templates and intent

| Message | Job |
| --- | --- |
| Sign in | Open the requested, single-use sign-in link. |
| Verify email | Confirm the exact invited mailbox before account admission. |
| Team invitation | Identify the inviter and workspace before accepting. |
| Agent authorization | Return to the requested agent connection flow. |
| Welcome | Introduce the shared drive for agent context and open onboarding. |
| Connect an agent | Help someone get their first observed agent call. |
| First memory | Save useful context, then recall it. |
| Second agent | Carry that context into another connected agent. |

Sign-in and verification messages identify the request, link lifetime and what
to do if it was unexpected. They contain no memory contents or access keys.
Invitation-derived verification can expire sooner than 24 hours; OAuth requests
have their own shorter deadline. Do not replace these with generic expiry copy.

## Welcome sequence

Only a **fresh personal workspace created by verified hosted signup** enrolls.
Existing members, repeated sign-ins, team invitations and existing databases
are not backfilled into the series. Account creation and enrollment commit
together; email failure cannot prevent the new account from working.

The intended cadence is welcome when the workspace is ready, then help with
connecting an agent around day 1, saving/recalling around day 3, and using a
second agent around day 7. The worker checks current progress before delivery,
skips steps already completed, and spaces delayed messages instead of sending
a catch-up burst. The exact policy and offsets live in `mail-series.ts`.

Every onboarding message has an unsubscribe link and one-click unsubscribe
headers. GET displays a confirmation; POST updates the preference. Unsubscribe
stops this series, including queued reminders. It does not revoke the account,
agent connections or requested security emails. Recipient tokens grant only
this preference change and are not account credentials.

The application does not log these preference links. Hosting or edge access
logs can retain request URLs under the infrastructure's retention settings;
the URL grants no access to the account or its contents.

## Delivery and reliability

`gateway/src/jobs/mail.ts` runs with the restricted runtime database identity.
It checks the provisioner-owned schema version, handles at most 25 queued
messages, prints aggregate counts and closes its pools. It does not start an
agent engine or use the provisioner credential. Provider errors and message
contents must never be printed.

The shared restricted-runtime configuration also requires the existing tenant
credential key at startup. The job receives that existing runtime secret; it
does not provision tenant databases or launch tenant processes.

The queue stores one unique step per enrollment, leases claims, freezes the
provider payload for retries and checks current membership/access/readiness.
Retries are bounded to the provider's 24-hour idempotency window, with a shorter
local horizon. Delivery exhaustion is visible in durable job state. Do not reset
failed jobs and resend blindly after that window; an ambiguous provider response
can mean the first request was accepted. See [Resend's idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys).

The application records provider acceptance as `sent`; that does not prove inbox
delivery or a read. There is no open/click tracking or provider-webhook analytics
in this implementation. Provider suppression and domain settings still apply.

Feature flags and credentials:

| Setting | Purpose |
| --- | --- |
| `ENGRAM_ONBOARDING_EMAILS=1` | Enable enrollment/delivery; otherwise off. |
| `ENGRAM_PUBLIC_URL` | Canonical HTTPS app origin used by the worker. |
| `RESEND_API_KEY` | Existing Resend sending key. |
| `ENGRAM_MAIL_FROM` | Existing verified sender override. |
| `ENGRAM_MAIL_UNSUBSCRIBE_KEY` | Dedicated random secret for preference links. |

Missing delivery configuration blocks the worker; it never blocks a verified
signup. Keep the unsubscribe key stable: rotation invalidates pending frozen
links and requires a reviewed queue migration. Never paste secret values into
chat or check them into the repository.

## Local review

Run `PORT=18903 bun web/dev-server.ts`, then open
`http://localhost:18903/__mail-preview`. This loopback-only gallery renders the
actual templates with sample data, desktop/phone frames and plain-text views.
Its links are inert local review actions. It sends no email and is not part of
the production asset tree.

Focused checks:

```sh
bun test test/mail.test.ts test/mail-templates.test.ts test/mail-series.test.ts test/mail-job.test.ts test/startup.test.ts
python3 test/mail-infrastructure.py
python3 test/release-automation.py
```

The series fixture runs within `test/integration-postgres.ts` on its dedicated
loopback test cluster; the harness rejects other targets. Do not use a live
database. Both normal CI paths include it, plus the offline mail-infrastructure
check above.

## Release after local approval

Cloud Run scales to zero, so an in-process timer is insufficient. The prepared
delivery job is private and Cloud Scheduler invokes it every 15 minutes through
Google's authenticated Run API. The scheduler identity has job-scoped invocation
only, without execution overrides or project roles.

1. Finish local review, CI and the normal release checks. Use the same reviewed
   immutable image for the service, provisioner and mail job.
2. Inspect the offline mail plan:

   ```sh
   python3 deploy/mail-series.py plan --project ani-hq --image gcr.io/ani-hq/engram:REVIEWED_BUILD
   ```

3. At the approved release step, run the matching `prepare` command. It creates
   the dedicated unsubscribe secret if missing, grants only resource-scoped
   access, configures the restricted mail job **with delivery disabled**, and
   pauses its schedule. No message is sent by preparation.
4. Stage the service using `deploy/release.py`; its separate provisioner applies
   the additive mail schema before the restricted runtime starts. Run the normal
   candidate smoke checks. New verified signups can queue, but the mail worker
   remains disabled.
5. Release activation verifies the prepared image, secret refs and private
   scheduler identity, moves traffic, then enables the prepared mail job and
   resumes the schedule. It records `mailEnabled` in release state. A failed
   enabling step is reported after recording the service's activation so the
   operator can retry it without guessing traffic state.
6. Verify aggregate mail-job outcomes and the opt-out path. A `--dry-run` job
   invocation reads queue counts without claiming, updating or sending messages.

`deploy/mail-series.py pause` pauses the schedule and disables delivery. Release
rollback does this before reverting traffic. Existing queue records remain for
inspection. Already-running job executions can finish their in-flight batch;
the pause applies to future executions. These deployment commands are not part of local preview and must
not run before the user approves release.
