# Staged hosted releases

Private operator captures and verification records described in the historical
release entries are retained outside the public source release. Their local
paths and raw contents are not published here.

## Launch candidate, 24 October 2026

Cloud Build `35b0edd1-93ab-4e25-872d-a0953bfe3ee5` passed all seven gates for
source commit `3db200f6ec89ddc2e96c393b91a62eaa1f87acbf` and staged revision
`engram-r-1792849141` with zero production traffic. The immutable image is
`gcr.io/ani-hq/engram@sha256:3486cb136512f78fcff0b5fdc6da2fd1a00b094fd010af9d152f67bf335c123c`.
Backup `1792825021777` was verified successful at 06:58:43 UTC on 24 October before
staging. The previous production revision remains `engram-r-1792829094`.

Public/private candidate smoke passed and its temporary credential was revoked.
All 139 checked public assets/page routes matched source with CSP/nosniff intact.
The exact image's separate private Cloud Run isolation probe passed and its
temporary service was deleted. Real browser onboarding advanced through contact,
save and recall only after corresponding successful calls; its dedicated agent
key was then revoked. See [launch verification](LAUNCH-VERIFICATION-2026-10-24.md#staged-launch-candidate).

This candidate adds guided onboarding, credential-safe interactive CLI setup,
operator privacy/support/retention disclosures and an atomic central ACL/RLS
refresh. The latter removes an observed source race during provisioning;
it does not establish the cause of the earlier transient signup 503.

Activation is intentionally pending the new npm package publication and full
Stripe sandbox lifecycle verification. Source PR 26 remains a draft. Recheck
smoke freshness before activation; a successful candidate is not an activated
production release, and neither staging nor these read checks completes a
payment round trip.

The release automation does not create credentials, change IAM or grant the
runtime administrative database access. Complete the separately approved
database/IAM setup first. The web runtime receives a restricted database URL and
tenant credential key. Only the dedicated provisioner job identity receives the
administrative URL. Engine sandboxes use a SQL-connect-only identity.

Cloud Build gates unit tests, offline retrieval fixtures, actual PostgreSQL
tenant/queue/billing tests, restricted-role authority tests, the built container's
actual pinned GBrain isolation/CAS integration, and offline release-template
tests. It pushes an explicit build tag and emits a release plan by default.
Only an explicit `_RELEASE_COMMAND=stage` substitution, approved setup and fresh
`_BACKUP_ID` execute the provisioner and stage a tagged revision with **zero
production traffic**. Missing prerequisites fail
the build; no test is silently skipped. The Docker CI gate must be verified in
Cloud Build's actual daemon/network environment before calling it proven there.

`deploy/release.py plan` is read-only and needs no cloud credential. `stage`
requires an operator-provided successful Cloud SQL backup from the last 24 hours,
pre-existing secrets and service accounts, and a fresh state-file path. It checks
that the runtime lacks direct access to the provisioner secret or broad project
roles. No secret value appears in state files, subprocess arguments or output.

The legacy `engram-db-url-template` also contains administrative authority. Its
existing runtime secret-access grant must be removed before `stage` can pass.
Coordinate that removal with the cutover: the old revision may fail a cold start
after the grant is removed, and traffic rollback alone cannot restore it. The
separate provisioner job must grant the runtime permission to run only that job,
without execution overrides or job-update authority. These IAM changes require
the separately approved setup; the release tool never creates those grants.

This migration revokes unattributed legacy agent keys. Existing OAuth connectors
without a signed membership ID must reconnect. Reissue authorized credentials
and verify one connector before announcing the release. Removed and rejoined
members must receive fresh credentials; old credentials deliberately stay invalid.

```sh
python3 deploy/release.py stage --project ani-hq --region us-central1 \
  --image gcr.io/ani-hq/engram:BUILD_ID --backup-id VERIFIED_BACKUP_ID \
  --state-file release-state.json

python3 deploy/release.py smoke --project ani-hq \
  --image gcr.io/ani-hq/engram:BUILD_ID --state-file release-state.json \
  --smoke-token-secret EXPLICIT_SHORT_LIVED_WORKSPACE_1_TOKEN_SECRET

python3 deploy/release.py activate --project ani-hq \
  --image gcr.io/ani-hq/engram:BUILD_ID --state-file release-state.json
```

Smoke validates the tagged candidate's identity before transmitting a credential,
checks health and hosted plans, verifies unauthenticated activity returns401,
reads only the authorized workspace1 activity, verifies the task and memory
streams (including evidence, counts, pagination and invalid-kind rejection),
rejects a mismatched workspace pin, and launches its isolated memory worker
through read-only MCP tools/list.
Responses and bearer values are never printed. Use a temporary operator-issued
credential and revoke it after the smoke. Prefer `--smoke-token-stdin` to pipe
that value directly from a trusted operator process; do not place it in arguments,
files, build logs or a persistent release
credential merely for automation. Payment, provider processing and publication
are never triggered. An absent private credential leaves activation blocked.

The operator helper `bun deploy/smoke-candidate.ts --project ani-hq --image
gcr.io/ani-hq/engram:BUILD_ID --state-file release-state.json` prints an offline
plan. After ownership recovery and staging, append `--run` to issue a temporary
workspace-1 agent credential with writes disabled, pass it only through the
release process's stdin, and revoke it in `finally`. It requires an existing
owner and refuses enabled external AI processing. The public/private activation
proof is published only after revocation is confirmed. A cleanup failure
reports the credential's name and workspace for operator revocation, never its
bearer value, and leaves activation blocked. Abrupt host loss still requires
checking for an unrevoked `operator-candidate-smoke-*` credential before
continuing. This helper does not issue owner sessions or run migrations.

Activation requires fresh successful public/private smoke for the same ready
revision. It updates the dream job to the reviewed image and sandbox setting,
then changes traffic. Existing traffic is pinned by revision before staging, so
a later candidate cannot silently become the production target. REST v1 handles
`containers[].sandboxLauncher` because older installed gcloud schemas reject it.
The state artifact preserves previous traffic and revision identity; Cloud Build
stores it under its source bucket's `engram-releases/BUILD_ID/` prefix. That
bucket and artifact-write permission must already exist.

```sh
python3 deploy/release.py rollback --project ani-hq \
  --image gcr.io/ani-hq/engram:BUILD_ID --state-file release-state.json
```

Rollback restores recorded **service traffic**. It does not restore the database,
undo credential revocation, regrant administrative authority, or restore the old
dream job. Inspect schema compatibility before traffic rollback; restore a
backup only through an explicitly authorized database-recovery procedure.

Launch limits are maximum1 instance and minimum0, with CPU allocation enabled
outside requests. Durable insight jobs normally finish during an instance's idle
life; after a full idle shutdown they wait for the next instance/request. This
avoids a forced warm-instance cost. If predictable unattended latency becomes a
requirement, add an explicitly configured scheduler/worker or paid warm capacity.

Keep the original pre-migration backup `1792649176475` for recovery. The
current staging backup is `1792728364590`, completed successfully on
23 October 2026 at 04:07:15 UTC after owner recovery and central migration,
before the managed-role repair. Verify backup age before each new release;
a recorded backup is never assumed to satisfy the 24-hour requirement.

References: [Cloud Run service replacement and optimistic concurrency](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.services/replaceService),
[Cloud Run sandbox configuration](https://docs.cloud.google.com/run/docs/configuring/services/sandboxes).

## Live release, 23 October 2026

Cloud Build `a70da10b-fd06-4651-a965-29cdcdbae18c` passed its release gates,
including 142 baseline PostgreSQL checks, 58 credential/authority checks,
13 managed-provisioner checks and 25 actual GBrain Docker isolation/CAS checks.
The corrected immutable image is:

`gcr.io/ani-hq/engram@sha256:08c1bd25ab1a75ded340bd7b72ddc05d0669b9b0015ed363e0b80bbb89bca889`

The managed PostgreSQL provisioning failure is resolved. The regression uses a
real non-superuser provisioner and covers initial setup, safe reruns, separate
extension ownership, tenant-owned application routines and restricted engine
privileges. The provisioner job also fails when queued workspaces remain pending,
including backoff retries, and reports only sanitized failure categories.

Revision `engram-r-1792729475` is ready and serves **100% of canonical
production traffic**. Its image and sandbox configuration were verified after
activation. The dream job uses the same image and sandbox with the restricted
runtime identity and no administrative database secret.

Post-migration read-only checks confirm the selected owner, schema version,
workspace readiness, retired legacy credentials and restricted database roles.
Private candidate worker smoke and the real Cloud Run sandbox probe passed for
this exact image; temporary smoke credentials were revoked and probe resources
were removed. The probe verifies usable-capability removal and NNP through the
engine/child execution chain, parent-path masking, credential-file handoff,
stdin and worker cleanup.

The split database secrets and scoped IAM grants are installed. The runtime no
longer has access to the administrative database secret and can invoke only the
fixed provisioner job.

Authenticated owner onboarding passed: secure session cookie, selected owner,
ready workspace, billing/policy/showcase access, wrong-workspace rejection and
confirmed temporary credential revocation. Canonical health, plans, app,
pricing, privacy and self-hosting pages return 200. Anonymous console access
returns the required 401, and GET on the MCP endpoint returns 405.

Live Stripe verification passed for the $19 USD monthly price, approved account,
portal and webhook configuration. A correctly signed ignored-event probe returns
200; missing or altered signatures return 400. These probes created no charges.
An actual Stripe delivery and the paid subscription lifecycle remain unverified;
`stripeDeliveryVerified` is false. Complete the payment lifecycle with an
explicitly configured test key before broad distribution.

The release is live. **Broad distribution remains pending** the payment checks
and scoped edge remediation: Cloudflare blocks the default Python urllib user
agent with 403/1010 while an explicit user agent returns 200; injected Cloudflare
analytics is blocked by the app's strict self-only CSP; and an existing token
receives 403 on settings/rules access. Preserve the CSP and credential boundaries
while applying the two hostname-scoped rules prepared in [EDGE.md](EDGE.md).
Earlier candidates and image digests
are superseded.

The follow-up edge helper and its 10 offline checks are ready. Release automation
(9 checks), billing verification (5 checks) and edge configuration checks passed
locally and are included in the future Cloud Build/GitHub automation gates.
The currently deployed application image did not change during this follow-up.
Fresh isolated-browser desktop checks verified the canonical sign-in and pricing
pages. A reliable fresh mobile viewport check was not obtained.

The edge apply command was stopped before execution by automatic approval
review, which requires explicit human authorization for the exact production
settings and scope. No edge changes were applied. The configuration endpoint
also still returns403 with the current token; the exact Stripe test secret
metadata check returns NOT_FOUND/no versions. Both external prerequisites remain
open.

## Activity UI release, 23 October 2026

Cloud Build `c404cfaf-ce58-4135-a6b6-aa98c0726c75` passed unit tests, runtime
asset privacy checks, PostgreSQL boundary and managed-provisioner checks,
actual GBrain Docker isolation checks, and the release/billing/edge automation
tests. This supersedes the earlier activity UI build before its final visual
corrections. The deployed immutable image is:

`gcr.io/ani-hq/engram@sha256:bd6d0d25ff5058c6d73e84731a1ff782b06b25c6ed74c7ef3fe24f6b0e0c2e81`

Revision `engram-r-1792759710` is ready and serves 100% of production traffic.
Its service and dream job image, sandbox flags and restricted runtime identity
were verified after activation. The successful pre-migration backup is
`1792758489553`, completed at 12:29:20 UTC. The local rollback record is
`.engram-release-20261023-c404cfaf.json`; its credential-free artifact is stored
under the build's existing private `engram-releases/` prefix.

The UI separates task reports from observed memory operations. Task cards and
details lead with explicitly reported task context, current steps or outcomes,
contributors and resources. Methods, chronological steps and technical receipts
remain available when recorded. Missing intent or outcomes are not invented.
Connections support registered harness metadata and editable owner-only source
attribution; known product logos, including Grok Bot, are self-hosted. The login
column is aligned and the interface uses 10/14/18px control/card/panel radii.

The additive activity migration records feature version 2026102301 while keeping
base authority version 2026102202 compatible with the previous runtime. Read-only
post-migration checks verified both markers, the selected owner, all workspace
readiness, retired legacy credentials, database isolation and 25 protected central
tables. Candidate checks passed for both activity streams, invalid-kind
rejection, workspace mismatch rejection and isolated read-only MCP tools/list.
An initial authenticated smoke attempt failed; its diagnostic rerun passed and
candidate request logs showed no server errors. Both temporary agent
credentials were confirmed revoked. The subsequent owner-session check passed
secure cookies, owner identity and workspace/account reads; its temporary
session was also confirmed revoked.

Integrated browser checks covered desktop and true 320/390px phone viewports,
Tasks, Memory log, Connections, resource opening, disclosures and More options.
The canonical health, hosted plans and public pages passed after activation;
anonymous activity access returns 401. Live JavaScript, CSS, font and all 11 new
logo assets match the locally reviewed source. Canonical HTML is not claimed
byte-identical because the existing edge can rewrite it.

This UI release does not change the pending payment-lifecycle verification or
the separately scoped edge authorization and token-permission prerequisites
described above. No Stripe charge, provider processing, public-profile
publication or edge-configuration change was triggered by this release.

### Agent reconnection remains outstanding

A subsequent metadata-only connection audit found all seven historical agent
credentials revoked by the legacy-key migration and no active ordinary agent
credential in workspace 1. Local Claude Code and Codex configuration credentials
were matched in memory to the retired `mac-claude` and `codex` entries. These
clients require fresh workspace-bound credentials and reconnection. The public
web service is healthy, but that does not establish working agent integrations.
Reconnecting normal agents was missed during the earlier cutover and remains a
release-completeness prerequisite.

The workspace currently has historical memory calls and no explicit task
reports. MCP access alone does not report external tasks. The Connections UI
currently lists API credentials and omits OAuth authorizations; configured,
authenticated, memory-active and task-reporting states are not yet a complete
inventory. Other machines and custom OpenClaw/Hermes/Grok Bot configuration
locations were not surveyed by this bounded audit.

## Boolean rendering hotfix, 23 October 2026

The authenticated app shell passed a disabled preview condition directly to
the browser's native `replaceChildren`, which displayed the literal text
`false` above the workspace. The one-line fix omits the optional banner argument
when preview mode is disabled. Isolated browser checks using sample data covered
both normal and preview modes: neither has a root text node, normal mode has no
preview banner, and preview mode retains exactly one banner. The other native
DOM insertion calls were reviewed for the same issue; no additional concrete
boolean leak was found.

Cloud Build `eb257123-83f2-4471-a84d-c3be6f91c1ae` passed all existing release
gates. The deployed immutable image is:

`gcr.io/ani-hq/engram@sha256:6ae1b9cf9c3beda68f95ef9a6c482f59c88e645545830344e414fe3d953caf8a`

Revision `engram-r-1792779398` was activated after candidate public/asset checks,
authenticated activity/worker checks and database-isolation metadata checks
passed. The temporary read-only credential was confirmed revoked. The rollback
state is `.engram-release-20261023-eb257123.json`, retaining prior revision
`engram-r-1792759710` and successful backup `1792758489553`.

Post-activation canonical checks passed: the corrected JavaScript and other
runtime assets match the reviewed source, health and public pages respond,
private activity remains authentication-protected, and the verified revision
serves 100% of traffic. The service and dream job retain the reviewed sandbox
settings and restricted runtime identity.

This hotfix does not reconnect the retired agent credentials described above.


## Complete activity stream and connection inventory, 23 October 2026

Activity now opens on All activity, combining real observed memory operations
with agent-reported tasks in receipt order. Explicit Tasks and Memory filters
remain available. Compact monochrome timeline rows replace repeated large cards;
known tool namespaces use local Simple Icons/Lobe marks with Lucide fallbacks.
OpenClaw and Hermes Agent have their own verified source marks. Runtime logo
rendering makes no external requests. Emil Kowalski's design-engineering skill
guides the restrained pointer feedback, immediate keyboard interactions,
reduced-motion support and removal of polling entrance animations.

The human-only private connection inventory includes API keys and OAuth grants,
revoked/expired/membership-bound status, last actual contact, memory-call counts
and raw task-report counts. It never equates an issued authorization with running
work, and never exposes credentials, callback URLs or private call contents.
The web app shows reconnect reasons and a guided transition to a fresh-key form;
that transition retains focus and read-only permission from both entry paths.
Connection metadata and UI state follow the selected workspace and remain out
of public profiles and streams. No schema change was required.

Cloud Build `cc88a708-264c-4625-a734-614b08f6cb29` passed every release gate,
including PostgreSQL boundaries, the actual pinned engine/sandbox integration,
and release-automation checks. The superseded build `c7cb6626-4eea-475e-a328-14d978183673`
was cancelled to include the final reconnect-focus repair.

The deployed immutable image is:

`gcr.io/ani-hq/engram@sha256:496ead626b3329de1414d1013e54a9f24b8e9e165ec17531c3628e5afe109eff`

Revision `engram-r-1792782526` was activated after candidate public/asset checks,
authenticated activity/MCP smoke and the selected owner's private Connections
checks passed. The owner smoke verified metadata-only responses and workspace
pinning; both temporary credentials were confirmed revoked. Production metadata
checks confirmed the selected owner, ready storage, revoked legacy credentials,
restricted roles and central RLS.

Isolated native Chrome checks used sample data in production-like mode at
1440, 390 and 320 pixels. All 18 browser checks and both fresh-key focus transitions
passed: no document/drawer overflow, literal boolean text, missing logos, runtime
errors, external requests or mutations. Keyboard navigation, drawer disclosure
and focus across polling, Escape restoration, hover and reduced motion were
checked. Local screenshots are in `/tmp/engram-timeline-visual-gpG98U/` and
fresh-key proof in `/tmp/engram-key-focus-qa-DezoPN/`. These were local fixture
checks; deployed-source equality was then verified independently over HTTPS.

Post-activation canonical checks passed for health/public pages, private endpoint
authentication, all 43 reviewed runtime assets, the ready revision serving 100%
of traffic, and the service/dream sandbox image and restricted runtime identity.
Rollback state: `.engram-release-20261023-cc88a708.json`, preserving prior revision
`engram-r-1792779398` and successful backup `1792758489553`.

The retired agent credentials identified by the earlier audit remain revoked.
This release makes their state visible; each affected client still needs fresh
sign-in or a replacement key. External work requires explicit agent reports;
memory operations are observed automatically. The current desktop MCP session
still returned Authentication required during this turn, despite the previously
repaired canonical Codex configuration and active OAuth grant. Live integration
must be checked from each reloaded agent; it is not inferred from authorization.


## Memory drawer loading feedback, 24 October 2026

Memory drawers now show “Reading your memory…” with a restrained monochrome
shimmer, the requested memory name and a page-shaped skeleton. The supporting
text describes the actual content/links request. After eight seconds, a single
long-wait message appears. Failed requests offer Retry. There are no invented
stages, percentages or minimum loading delays; content replaces the loader as
soon as it arrives. Drawer close/replacement clears the timer, and existing
request/workspace guards prevent stale responses from replacing another memory.
Reduced-motion and forced-colors modes preserve readable static feedback.

Cloud Build `2f7008da-5ba6-4d0e-8c04-10f7b9cb507e` passed every release gate,
including PostgreSQL boundaries, actual engine/sandbox isolation and release
automation. The deployed immutable image is:

`gcr.io/ani-hq/engram@sha256:193fdd45eae7f9f92a5c6a12f55fd636ad4e7b1bb722b11f00faabe37bea55b9`

Revision `engram-r-1792784087` was activated after candidate route/asset checks
and authenticated activity/MCP smoke passed. The temporary read-only credential
was confirmed revoked. No schema or backend changes were introduced by this
loading UI update.

Local verification passed: 340 unit tests (one environment-dependent skip),
browser bundle, 29 runtime-asset checks and 17 native Chrome checks. Isolated
fixture checks covered desktop and 390/320-pixel layouts, visible shimmer, the
eight-second note, immediate success, error/retry, Escape focus restoration,
native close/timer cleanup, out-of-order requests, workspace changes, reduced
motion and forced colors. There were no runtime errors, external requests or
upstream mutations. Evidence is in `/tmp/engram-memory-loading-visual-BCBXzi/`
and `/tmp/engram-memory-320-stable-VaeNmy/`.

Post-activation canonical HTTPS checks passed for public health/pages, private
endpoint authentication and all 45 reviewed runtime assets. The ready revision
serves 100% of traffic; the service/dream image, sandbox settings and restricted
runtime identity match the release. Browser screenshots used local fixtures;
deployed-source equality was verified separately over HTTPS.

Rollback state: `.engram-release-20261023-2f7008da.json`, preserving prior revision
`engram-r-1792782526` and successful database backup `1792758489553`. This UI
release does not change the previously identified desktop MCP reload requirement.


## Memory reader and task reporting — 24 October 2026

Cloud Build `69a7db88-4d5f-4934-8afa-de060fb5ac28` passed all release gates,
including unit/process tests, runtime-asset and retrieval checks, baseline,
restricted-runtime and managed-role PostgreSQL checks, actual engine/startup
isolation, and offline release/billing/edge checks. The reviewed image is
`gcr.io/ani-hq/engram@sha256:e3c6390895f32cd08be68e9e2ac2ea208b735bd7ff85545b57e829c1c349a5b9`.
Candidate `engram-r-1792815403` was staged and passed authenticated candidate
smoke, all 57 candidate asset-hash/route checks, and all 12 owner-smoke checks.
The temporary read-only credential and owner session were confirmed revoked;
no cleanup remained. Candidate smoke verified lifecycle guidance in MCP
initialization and discovery of `record_action`, `list_actions`, `whoami`,
`recall` and `remember`, without writing task reports.

Revision `engram-r-1792815403` is activated and serves 100% of production traffic.
Canonical HTTPS checks passed for all public/private route boundaries and all 53
reviewed runtime assets. The service and dream job use the reviewed image and
sandbox; the dream job retains its restricted runtime identity without an
administrator database secret. The credential-free release state is archived at
`gs://ani-hq_cloudbuild/engram-releases/69a7db88-4d5f-4934-8afa-de060fb5ac28/release-state.json`.

The memory reader replaces the raw Markdown wall with Read/Source tabs, compact
dated disclosures, local search, eight-entry batches and expand/collapse
controls. Fully timed journals show newest first; journals with date-only
entries preserve their labeled source order without invented within-day timing.
Expanded notes, Source and its secondary Copy text control preserve the complete stored text.
Ordinary documents retain actual headings and introductory/closing context.
Loading and in-dialog navigation preserve focus; linked memories open at the top.

Tasks and Connections now distinguish reconnect needs, read-only access, no
received reports and received reports, with a setup guide and copyable agent
instructions. HTTP and stdio share packaged guidance for truthful task
start/update/result reports; stdio initialization needs no upstream response.
The connector refreshes credential-scoped v2 tool caches in the same session
through `tools/list_changed`. HTTP 401/403 clears the matching cache even for
non-JSON responses, and uncertain writes are never automatically replayed.
Discovery and warmup do not manufacture task reports.

Final local verification passed: 364 unit/process tests, one environment-dependent
Cloud Run capability skip, 2,999 assertions, browser/gateway bundles, 35 runtime
asset privacy checks and 16 offline release-automation tests. Actual stdio
process fixtures cover lifecycle forwarding, discovery refresh, credential
isolation, authorization denial/cache invalidation and an applied-write timeout
without replay. CI uses Bun; an earlier four-process proof also ran under Node
before the final authorization/retry regressions were added.

The 47 reader browser checks cover desktop and 390/320px layouts, exact
source/copy including CRLF, dates/order/timezones, heading semantics,
search/batching, keyboard navigation, linked-memory and Escape focus, reduced
motion/forced colors, and immediate loader replacement. Another 28 reporting
browser checks cover setup statuses/inventory bounds, literal escaping,
source/instruction copy fidelity, 320px layouts, keyboard disclosures, pane
navigation and fresh-key focus without submitting a mutation. These checks used
isolated fixtures with no production writes, external requests or runtime errors.
Evidence directories:

- `/tmp/engram-memory-reader-visual-Z05NDy/`
- `/tmp/engram-memory-reader-timezone-8RTJjH/`
- `/tmp/engram-task-reporting-visual-nJgqAb/`
- `/tmp/engram-task-reporting-focus-IjJ18R/`

Rollback state: `.engram-release-20261024-69a7db88.json`, preserving prior revision
`engram-r-1792784087` and database backup `1792758489553`, successfully completed
`2026-10-23T12:29:20.713Z`.

Existing clients still need a valid canonical connection and reconnect/reload to
receive fresh instructions and tools. Reporting remains a best-effort agent
workflow, without deterministic harness event adapters. Connecting, reading
memory or capturing a transcript does not create task reports; verify reporting
with the next genuine task. The updated stdio npm connector remains version
0.2.0 and has not been published, so the web deployment alone does not update
installed stdio clients. No existing agent configurations or credentials were
changed by these UI/source changes.


## Connector branding — 24 October 2026

Cloud Build `1955355b-9332-4892-a5de-9f20e251dec1` succeeded with every release
gate passing. Image tag `gcr.io/ani-hq/engram:1955355b-9332-4892-a5de-9f20e251dec1`
resolves to the reviewed immutable digest:

`gcr.io/ani-hq/engram@sha256:79da3d2a07ec4277e5e9f23bb6a3cfae7b511876d68ac4254b331b189ce04e79`

Revision `engram-r-1792820184` is activated and serves 100% of production traffic.
The release publishes one monochrome Engram pulse mark as SVG, derived 512px and
192px PNGs, SVG/ICO favicons, a 180px Apple touch icon and a web manifest. Shared
HTTP/stdio MCP identity and registered OAuth metadata expose consistent display
hints and canonical public logo URLs. The OAuth presentation is white and
branded. This release changes no authentication, scopes, redirects or billing.
The stdio source is updated, but npm version 0.2.0 remains unpublished.

Local verification passed: 379 unit/process tests, one environment-dependent
skip, 3,259 assertions across 380 tests in 60 files, 36 runtime privacy files,
and browser/gateway bundles. Actual native CUA checks at 1280×720 and 320×720
verified logo loading, keyboard order, control feedback and no overflow:
report (private evidence),
desktop (private evidence),
mobile (private evidence).

Candidate verification passed all 65 exact asset comparisons and 156 public
assertions, including anonymous branding GET/HEAD, MIME types, nosniff, empty
HEAD bodies, scoped CORS, missing-brand 404s and canonical OAuth branding hints.
Authenticated candidate smoke and two MCP initialization branding checks
(2025-06 and 2026 protocols) passed. The temporary read-only token was revoked.
All 12 owner-smoke checks passed and the temporary session was revoked, leaving
no cleanup. The initial owner preflight stopped at a tag-versus-resolved-digest
mismatch before creating a session. The same guard then passed against a derived
scratch state containing the known matching build/revision digest; the original
release state and guard were unchanged. No task reports or payment changes were
made by these checks.

Canonical verification is **not a full pass**: 61/65 asset bytes and 155/156 public
assertions match. `/app`, `/pricing`, `/privacy` and `/self-host` have byte
differences containing Cloudflare injection markers. A targeted head check
confirmed the four new icon links, application name and self-only CSP on each
page; it does not turn those byte differences into matches. All 11 control-plane
checks passed for the actual digest, service/dream images, isolation settings and
restricted runtime identity. Curated results:

- Candidate (private evidence)
- Canonical head checks (private evidence)
- Control plane (private evidence)

Rollback state `.engram-release-20261024-branding-1955355b.json` preserves prior
revision `engram-r-1792815403` and fresh successful backup `1792758489553`.
The archive destination is
`gs://ani-hq_cloudbuild/engram-releases/1955355b-9332-4892-a5de-9f20e251dec1/release-state.json`;
copy completion was confirmed successful.

Grok's current connector card still shows a generic E, while Connected with all
12 tools enabled. The cropped current card (private evidence)
is evidence of that remaining limitation, not a repaired logo. The bot reported
no logo field or refresh control; its proposed restart of all connectors was
declined and none occurred. No connector credentials or authorization changed.
At the time of the branding release, client write E2E, expired workspace
entitlement, the unavailable Stripe sandbox key, remaining client
authentication/remote-host coverage and the launch video were open. The
complimentary-access release below resolves that workspace's entitlement;
current limitations are recorded in [launch verification](LAUNCH-VERIFICATION-2026-10-24.md).


## Complimentary workspace access — 24 October 2026

Cloud Build `40253aed-3f4e-4b6b-9cf5-a2f78e185702` succeeded with all seven release
gates passing. The reviewed immutable image is:

`gcr.io/ani-hq/engram@sha256:52f67b494902ee8815161a773329707dd013ac50601bad7b19987d535f1b5daa`

Revision `engram-r-1792826117` is activated and serves 100% of production traffic.
Rollback state `.engram-release-20261024-complimentary-40253aed.json` preserves
prior revision `engram-r-1792820184` and successful backup `1792825021777`.
The archive destination is
`gs://ani-hq_cloudbuild/engram-releases/40253aed-3f4e-4b6b-9cf5-a2f78e185702/release-state.json`;
copy completion was confirmed successful.

Hosted complimentary access is a distinct operator-managed entitlement with a
real nullable expiry. It does not falsify a trial or represent a paid Stripe
subscription. The request runtime can read grants and audit records but cannot
grant, revoke or modify them. The separate provisioner migrates an additive
billing readiness marker while preserving the older base/activity markers.
Existing paid periods, trials, tenant permissions and billing portal access
retain their independent behavior. See [billing operations](BILLING.md#operator-managed-complimentary-access)
for grant/revoke, exact target binding, audit and provisioner downgrade limits.

The explicitly authorized owner/workspace-pinned grant was applied with no
expiry and returned `ownerVerified: true`, `workspaceVerified: true`, active
complimentary access and `stripeBillingChanged: false`. Live Chrome Plan &
billing confirmed Complimentary / No expiry in the
private operator proof (private evidence).
Keep this private account-tier proof out of launch-demo assets.
The original trial and Stripe data were unchanged; no subscription or charge was
created. The first grant attempt returned `database_unavailable`. A read-only
inspection then verified that no grant had committed, and the same exact request
succeeded after operations were sequenced. The first attempt's cause remains
unproven because no SQLSTATE was captured; a later disposable managed-role test
reproduced lock contention as a possible failure mode, not a production diagnosis.

Candidate checks passed all 67 exact asset comparisons and 156 public assertions.
Authenticated smoke and both MCP initialization branding checks passed, and the
temporary read-only credential was revoked. All 12 owner checks passed against
a derived exact-digest state with the existing guard intact; this release had no
failed owner preflight. Its temporary session was revoked. Post-activation
control-plane checks passed all 11 assertions for image/digest, service/dream
isolation and restricted runtime identity:
owner (private evidence),
control plane (private evidence).

Canonical verification remains **not a full pass**: 63/67 exact asset matches and
155/156 public assertions. Only the four previously identified Cloudflare-marked
HTML byte differences remain on `/app`, `/pricing`, `/privacy` and `/self-host`.
They are not counted as exact matches.

Local verification passed 393 tests with one environment-dependent skip, 3,358
assertions across 394 tests in 62 files, 37 runtime privacy files, a 297-module
gateway bundle and a 20-module browser bundle. Real PostgreSQL baseline checks
passed 205 assertions and restricted authority checks passed 67, including
runtime denials for grant/revoke and audit modification and unchanged foreign
workspace billing. After the runtime build, an operator-only diagnostic formatter
added safe SQLSTATE output; eight helper unit tests and ten additional real
managed-role PostgreSQL checks passed. It changed no runtime/schema behavior and
required no image rebuild. Credentials, queries, parameters and identities are
excluded from diagnostic output.

Client write E2E and the launch video remain incomplete. The initial author
attempt after the grant had no tools available and made zero calls or writes;
a corrected documented-startup-wait attempt is running, without a claimed result.
Cursor/Codex desktop authentication and remote OpenClaw/Hermes verification still
have the previously documented limitations. Grok remains Connected with 12 tools
but its current card still displays a generic E; no all-connector restart or
authorization change occurred. The dedicated Stripe sandbox key is unavailable,
so payment lifecycle testing remains unverified. No full client write E2E or
completed video is implied by this entitlement deployment.

## Explicit page-write guards — 24 October 2026

Build `282bfc84-5e94-4b67-b3cf-4299ec279699` passed all seven release gates and
activated revision `engram-r-1792829094` at 100% traffic. Its reviewed digest is
`gcr.io/ani-hq/engram@sha256:06543a276429d0e47982d54031feec1af0dedd788db6d96fd66b95c0262ef3d7`.
The existing successful backup `1792825021777` was reused within its validity
window; no database restore or new entitlement grant occurred.

Public MCP `put_page` requires an explicit `expected_hash`: null atomically
creates only an absent page; an existing page needs the hash from `get_page`.
The compact live schema now preserves this guarantee. Omitted or mistyped
guards are rejected after authorization and billing checks, before engine calls
or activity storage. Browser Add memory supplies null. Existing internal direct
engine callers retain their documented legacy behavior.

Local verification passed 394 tests with one environment-dependent skip and
3,361 assertions across 395 tests. Candidate checks passed 67/67 exact assets
and 156/156 assertions; authenticated read smoke, both branding initializations,
all 12 owner checks and all 11 post-activation control checks passed. Temporary
credentials and sessions were revoked. The canonical check remains 63/67 exact
assets and 155/156 assertions because the same four Cloudflare-mutated HTML
documents differ; this is not a full exact-asset pass.

Authenticated canonical discovery verified 12 tools and the required nullable
guard at 08:13 UTC, with no model, page or tool calls. The activated release
state was archived under the build's existing release-artifacts path. A fresh
two-client workflow is being verified separately; release activation alone
does not establish its result or a completed launch video.
