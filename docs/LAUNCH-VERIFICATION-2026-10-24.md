# Launch verification — 24 October 2026

## Current invite-only beta

The hosted site now requires an email-bound invitation and inbox verification.
Hosted console sign-in now uses email; token-based console login is disabled.
Agent bearer access and self-hosted owner recovery remain supported.
Ready revision `engram-r-1792863937` serves 100% of observed traffic; build
`81a0c517-563b-4ee1-b2e2-d346c91bd2fc` passed all seven gates. Candidate and
canonical checks passed 142 exact assets/page routes and their security headers;
all 12 final image, identity, traffic and isolation configuration checks passed.

The email-only release passed 444 local tests and 21 real approved-inbox checks,
including secure email login, valid agent token rejected for console sign-in but
accepted as a bearer, and complete temporary-credential cleanup. All six canonical
authentication checks passed. Both hosted browser screens omit the token option.

The preceding beta implementation's approved-inbox live test passed 38 checks covering issue, mail verification,
single use, non-expiring free access, protected administration, revocation,
unchanged original billing and temporary-session cleanup. The existing personal
workspace was reused. First-time account creation is covered by actual database
tests rather than an additional live inbox. Local regression passed 439 tests;
PostgreSQL passed 339 main, 77 restricted-role and 22 managed/concurrency checks.
Independent security review passed. That implementation image's private Cloud Run isolation
probe passed and its service was deleted. Actual browser inspection confirmed
free access, trial restoration, existing login and the live invite-only landing.

Codes expire after seven days if unused. Admitted personal workspaces are free
until access is revoked, without a card. See [invitation management](BETA_INVITES.md)
and the [current release record](RELEASE.md#verified-email-only-hosted-console--24-october-2026).
Backup and rollback records are archived; no friend invitations or public
announcement have been sent. Stripe and npm verification below remain valid.

## Historical prior public-launch completion

The hosted launch release is verified live on ready revision
`engram-r-1792853391`, serving 100% of observed traffic. Build
`665db6d2-72b3-4cb3-9cc3-9002f40dc127` passed all seven gates for source
`4f697721edc6ea43a909a2bd39e5b56f5f044b8b`. Canonical 139/139 exact-asset
checks, CSP/nosniff, all 12 control-plane checks, and actual email-session browser
switching/reload passed. The release state was archived successfully. The
dedicated Stripe lifecycle and public npm 0.3.0 publication are complete.
The scoped Cloudflare changes removed the previously observed HTML injection
and API user-agent block. A real new customer completed email verification,
workspace provisioning, the cardless
trial, CLI identity/discovery checks, an exact memory save/readback and a task
report visible through the console API. The temporary agent key was revoked.

Guided browser onboarding, interactive CLI setup and operator-specific public
policies are deployed and verified. The original switch failure is preserved
below as a resolved historical finding. [Source PR 26](https://github.com/Ani-HQ/engram/pull/26)
is the release PR; source CI is green for the repair commit. Announcement drafts
are prepared, and no social post has been sent. The revised 62-second motion
export passed encoded checks and normal-rate browser playback
to its end; continuous frame-by-frame perceptual review is not claimed. This
document preserves earlier checkpoints below; their pending edge and
desktop-connection statements are historical.

Private verification records, captures, and local launch-video artifacts are
retained outside this public source release. Descriptions below identify those
records without publishing their contents or machine-local paths.

## Launch completion follow-up

- Both hostname-scoped edge rules are active; see [EDGE.md](EDGE.md). Canonical
  HTML matched the then-deployed source without Cloudflare beacon or email
  rewrites. Default urllib clients reach health, discovery and public API paths;
  authentication and unsigned-webhook rejection remain enforced.
- The actual emailed signup link was consumed in a new HTTP client, rather than
  creating an operator owner session. Resend reported delivery; the recipient’s
  inbox UI was not observed. Provisioning returned a transient 503 before the
  same legitimate session resumed successfully. This is retained as a finding,
  not erased by the successful retry.
- That new workspace received its own 14-day cardless trial with optional
  external AI processing disabled. A dedicated agent key passed the actual
  local CLI doctor, MCP identity and 12-tool discovery. A unique disposable memory
  marker was saved and returned by recall. A completed task report was stored,
  read back and returned by the authenticated console activity API. Key
  revocation was confirmed with 401. This was an HTTP/CLI workflow; browser
  onboarding verification is separate.
- Current Codex desktop calls to recall and task reporting succeed. This
  supersedes the earlier authentication failure for this active desktop session;
  it does not establish every saved client configuration works.
- The dedicated `engram-stripe-test-secret-key` version 1 is ENABLED. The full
  dedicated sandbox run passed 332 checks, including real test-card Checkout,
  signed delivery and database verification, Test Clock renewal, failed payment,
  recovery, and cancellation at period end. Its result was
  `cleanupRequired: false`, with no artifacts left by that run. No real money,
  production billing, or production data was touched. The earlier anonymous
  sandbox's unremoved portal configuration remains a separately scoped
  historical cleanup finding; successful dedicated cleanup does not erase it.
- npm 0.3.0 is publicly published as `latest`. The public registry download is
  byte-identical to the verified archive, contains exactly eight intended files,
  and matches the committed shim at `3db200f6ec89ddc2e96c393b91a62eaa1f87acbf`.
  Extracted offline `connect --list`, `setup --help`, and `doctor --help` passed;
  the independent registry check accessed no npm profile or authentication.
- The earlier complete local unit/process suite passed 425 tests with 3,585
  assertions and one Cloud Run-only capability check skipped locally. Release automation 16,
  billing verifier 5 and edge 10 offline checks passed; runtime asset privacy
  checked 40 files. The repair then passed 24 focused tests with 160 assertions,
  an independent security review, and 237 real PostgreSQL checks, including 16
  additional switch assertions; test cleanup completed. The earlier restricted
  authority and managed/concurrency results were 67 and 22 respectively. The
  replacement Cloud Build passed all seven gates; its exact-image private Cloud
  Run isolation check passed and the temporary service was deleted.
- The earlier deployment and client evidence below remains scoped to its image
  and time. [LAUNCH.md](LAUNCH.md) contains prepared announcement drafts and the
  publication order; no social post or personal outreach has been sent.

## Verified launch release

Cloud Build `665db6d2-72b3-4cb3-9cc3-9002f40dc127` succeeded with all seven
gates for repair commit `4f697721edc6ea43a909a2bd39e5b56f5f044b8b`.
Production revision `engram-r-1792853391` uses immutable image
`sha256:da8068a690afa09b416c9e4e090bcadcb10f10d6cfc319d29ee6951dfe888b73`.
Its 139/139 checked assets/page routes exactly matched source with CSP/nosniff
intact. Authenticated candidate smoke reported `tokenRevoked: true` and
`cleanupRequired: false`. The separate private Cloud Run exact-image isolation
check passed and reported `deleted: true`.

The candidate browser, using the email-authenticated session, successfully switched
from the test workspace to its ready personal workspace and back. The personal
workspace showed zero activity and automatically offered the guide; returning
restored the original five activities. No new key was issued for this retest.
The post-activation canonical browser then independently passed the same switch
and return: the personal workspace opened its guide with zero activities,
reloading preserved that workspace, and returning restored the original five
activities. Selecting Codex in the personal workspace showed the published npm
setup command without a key. The actual desktop screenshot at 1280px was visually
inspected without a layout issue. No new agent keys were created in these
post-activation checks.

The HTTP regression failed before the fix and passed after it. Its 24 focused
tests/160 assertions cover ready-to-ready and ready-to-pending switches,
membership, CSRF, workspace pinning, intact scope guards, no engine startup,
and no session mint before destination metadata is ready. An independent
security review passed. The local real PostgreSQL suite passed 237 checks,
including 16 added assertions, and cleanup completed. Source CI is green for the
repair commit.

The revision is Ready and serves 100% of observed traffic. Canonical verification
passed all 139/139 exact assets/page routes with CSP/nosniff intact. All 12
control-plane checks passed: image/identity for the runtime, dream job, and
provisioner, plus sandbox configuration for the runtime and dream job. Rollback preserves prior revision
`engram-r-1792849141`; successful backup `1792825021777` was reused. Archiving
completed successfully at
`gs://ani-hq_cloudbuild/engram-releases/665db6d2-72b3-4cb3-9cc3-9002f40dc127/release-state.json`.

## Historical initial launch deployment checkpoint

Cloud Build `35b0edd1-93ab-4e25-872d-a0953bfe3ee5` succeeded with all seven
gates passing for source commit `3db200f6ec89ddc2e96c393b91a62eaa1f87acbf`.
Candidate revision `engram-r-1792849141` uses image
`sha256:3486cb136512f78fcff0b5fdc6da2fd1a00b094fd010af9d152f67bf335c123c`.
It was first staged with zero production traffic and later reached ready status
and 100% observed production traffic. After routing converged, the canonical
check matched all 139/139 checked assets/page routes with the expected CSP and
nosniff header. [Source PR 26](https://github.com/Ani-HQ/engram/pull/26) was a draft
with green source CI at that historical checkpoint.

Subsequent canonical browser testing found a real 503 when switching between
two ready workspaces: the destination onboarding check ran while the current
request context still selected the original workspace. The check failed closed.
This was release-blocking despite the exact-asset pass. The repair commit,
replacement image, and successful candidate regression are recorded above;
this initial image is not the final verified launch image.

Rollback preserves prior revision `engram-r-1792829094`. Successful Cloud SQL
backup `1792825021777` was reused within its validity window. Its activated
release state was archived successfully at
`gs://ani-hq_cloudbuild/engram-releases/35b0edd1-93ab-4e25-872d-a0953bfe3ee5/release-state.json`.

Authenticated candidate smoke passed; its temporary read-only agent key was
confirmed revoked before smoke proof was recorded. All 139 checked public
runtime assets and page routes byte-matched the committed source and returned
the expected self-only script CSP and nosniff header. A separate private Cloud
Run service verified this exact image's worker capability/bootstrap boundary
and was deleted successfully. No provider or payment call was involved in that
probe.

The real email-verified test workspace exercised the candidate guide before
activation:

1. A newly issued dedicated key left all three steps pending.
2. Its successful `whoami` call advanced the guide to saving memory.
3. A successful unique memory save advanced the guide to recall.
4. Copying the recall prompt showed copy feedback and did not complete recall.
5. Recall returned the exact saved marker, after which the actual browser guide
   showed all three steps complete. Desktop and 320px layouts were observed;
   content width was 305px within the 320px viewport.
6. The test key was revoked and 401 was confirmed. Completion screenshots capture
   the state before this deliberate revocation; current progress only counts
   usable agent credentials.

The guided test used an actual MCP HTTP client, not a model running behind a
Codex label. The selected Codex setup instructions and the separate actual CLI
doctor checks do not establish a new Codex model tool-call claim.

The final 0.3.0 package contains exactly eight files, each byte-identical to its
committed source. Its SHA-256 is
`4abccae677545eed5497ed3d97c30f31a55c993b81cf8f338b20d144b60e09ee`.
The published npm 0.3.0 tarball downloaded from the public registry has this same
SHA-256 and exact content, and 0.3.0 is the public `latest` version. The earlier
npm authentication failure and missing sandbox secret were resolved before
activation. The full dedicated Stripe run described above supersedes the
anonymous sandbox's incomplete lifecycle result.

Canonical native UI verification at this checkpoint found the switch failure
above. The verified replacement release, regression, and actual canonical
post-activation browser checks now resolve it. The failed checkpoint is retained
as history, not current behavior.

The unchanged motion export completed local browser playback at 1× to 62 seconds,
with no media error. Opening, middle task-card and closing brand/domain frames
were inspected. This adds bounded playback evidence to the earlier phase-sample
checks; it is not a claim to have perceptually reviewed every encoded frame.

## Historical guard-release checkpoint

The table and related evidence below describe the preceding guard release,
before the launch deployment checkpoint and edge corrections above. Its former production
revision, byte mismatches, and pending items are historical, not current status.

| Check | Verified result |
| --- | --- |
| Cloud Build | `282bfc84-5e94-4b67-b3cf-4299ec279699` succeeded with all seven release gates passing |
| Image digest | `sha256:06543a276429d0e47982d54031feec1af0dedd788db6d96fd66b95c0262ef3d7` |
| Production revision | `engram-r-1792829094`, activated and serving 100% of traffic |
| Canonical deployment | 63/67 exact asset matches; 155/156 public assertions. Only the four known Cloudflare-marked HTML differences remain; this is not a full pass |
| Candidate | All 67 exact asset comparisons and 156 public assertions passed; authenticated smoke and both MCP initialization branding protocols passed |
| Owner console | All 12 owner-smoke checks passed; temporary session revoked |
| Control plane | All 11 image, actual digest, sandbox and runtime-identity checks passed ([release verification](RELEASE.md#explicit-page-write-guards--24-october-2026)) |
| Cleanup | Temporary smoke credential and owner session confirmed revoked; no cleanup remains |
| Workspace entitlement | Audited complimentary grant active with `expiresAt: null`; Stripe billing unchanged |
| Rollback | Prior revision `engram-r-1792826117`; successful backup `1792825021777` reused within its validity window |
| Release state | Activated guard-release state archived under the build's release-artifacts path |

The rollback record and deployment evidence are recorded in
[the explicit-page-write-guard release verification](RELEASE.md#explicit-page-write-guards--24-october-2026).
Candidate smoke checked MCP initialization branding for the 2025-06 and 2026
protocols without writing task reports. Owner checks and temporary-credential
revocation passed. Earlier digest-preflight and complimentary-grant failure
history remains recorded in its respective release entries.

The mandatory public `put_page` guard and clarified create-only/versioned-update
metadata are live. Authenticated canonical discovery verified all 12 tools and
the required nullable guard at 08:13 UTC, without model or tool calls
(private catalog proof).
Upstream's legacy internal unconditional mode is unchanged; a missing-page error
with a non-null version is distinct from omitting the version parameter.

## Historical regression and browser results

These earlier results apply to their recorded images and dates. Current launch
build, package, payment, and canonical-asset results are recorded above.

| Suite | Result | Curated evidence |
| --- | --- | --- |
| Local unit/process suite | 394 passed, 1 environment-dependent skip; 3,361 assertions across 395 tests | [Guard release verification](RELEASE.md#explicit-page-write-guards--24-october-2026) |
| Runtime assets and bundles | 37 runtime privacy files passed; gateway bundle 297 modules and browser bundle 20 modules passed | [Complimentary-access release verification](RELEASE.md#complimentary-workspace-access--24-october-2026) |
| Additional operator diagnostics | 8 helper unit tests and 10 managed-role PostgreSQL checks passed after the runtime build | [Complimentary-access release verification](RELEASE.md#complimentary-workspace-access--24-october-2026) |
| Complimentary UI | Live Chrome Plan & billing showed Complimentary / No expiry | Private operator proof (private evidence) |
| Branding browser checks | Actual native CUA at 1280×720 and 320×720; logo loading, keyboard order, feedback and no overflow verified | Private report and desktop/mobile captures |
| Current HTTPS and owner checks | Candidate 67/67 assets and 156/156 assertions; canonical 63/67 and 155/156; owner 12/12 and control 11/11 | [Guard release verification](RELEASE.md#explicit-page-write-guards--24-october-2026) |
| Fresh two-client execution | Both actors completed; 5/5 expected receipts and payload/event/UUID bindings verified; 17 expected tool attempts, zero unexpected calls or approval denials in this run | Final execution proof (private evidence) |
| Production workflow UI | Completed task, two contributor marks, methods, two-step log and updated memory Read/Source verified; 11 privacy-reviewed stills | Operator UI proof (private evidence) |
| Memory reader browser checks | 47 passed | 35 reader checks (private evidence), 12 ordering/date checks (private evidence) |
| Reporting setup browser checks | 28 passed | 21 setup checks (private evidence), 7 focus/navigation checks (private evidence) |
| Offline release automation | 16 passed | [Release verification](RELEASE.md#memory-reader-and-task-reporting--24-october-2026) |

The earlier reader and reporting browser checks used isolated fixtures at
desktop and 390/320px widths. They
covered source/copy fidelity, dates and ordering, keyboard/focus behavior,
reporting states and inventory bounds. They made no production writes or
external requests. Passing fixture tests is separate from a real client sending
a task report to the deployed workspace.

## Historical client verification

This client matrix and its follow-up prose preserve the earlier checkpoint.
The launch-completion follow-up above supersedes its Codex desktop and npm
publication status; other client coverage remains limited to the stated tests.

| Client | Verified | Remaining limitation |
| --- | --- | --- |
| Claude Code | Actual identity, documentation and recall passed; the fresh author wrote/read back the source, applied the bounded guarded clarification and completed its bound report | This verifies the scoped launch task. Other agent configurations are separate; the original unsuccessful run remains closed failed |
| Codex CLI | Actual `whoami`/discovery passed; the fresh reviewer independently read the source, wrote/read back its review memory and completed its bound report | The review made a genuine wording finding, without approving all content. No independent re-review followed the bounded clarification; the running desktop session remains a separate verification gap |
| Codex desktop | Canonical saved connection exists | Refresh of the running desktop session has not been verified. Its saved `gpt-6.1-sol` model was unavailable to the tested CLI; the persistent default was not changed |
| Cursor | Actual public CLI `cursor-agent mcp list-tools engram` discovered all 12 tools, including `whoami`, `recall`, `remember`, `record_action` and `list_actions`, without an Engram authentication error | The approved identity-only model probe exited before model/tool startup because Cursor's own CLI account requires authentication. An actual model tool call and the editor session remain unverified |
| Grok Bot | Existing connector URL was repaired through its documented chat request. Native UI verified the canonical endpoint, account Connected, all 12 tools enabled and a successful identity-only test, with a time-correlated production `whoami` receipt | OAuth client metadata names Cursor, so the server does not independently attest that the caller is Grok. No task report or memory write was performed |
| Remote OpenClaw | Connection attempt to the remembered VM alias timed out | Current host identity and access remain unverified; no remote change was made |
| Hermes | Prior installation references were found | A reachable current installation has not been established; no remote change was made |

After deployment, the Claude Code and Cursor credentials were rotated to two
canonical, member-bound **agent** credentials. Their scopes, secrets permissions
and `can_write` settings were preserved. The legacy owner-level keys remain
revoked. Credential repair is not evidence that the corresponding client has
successfully delivered a task report.

Automatic review rejected an earlier Cursor identity-plus-recall model probe
before execution because it could disclose private Engram memory to the Cursor
model. Broader memory access was not requested again. Normal automatic review
approved the safer identity-only probe, whose disposable project policy allowed
only `Mcp(engram:whoami)` and denied other tools, files, shell and web access.
That probe ran once and exited with status 1 before model/tool startup because
Cursor's CLI account required authentication. This is a Cursor account blocker,
not an Engram authentication failure. There were zero tool calls, reads, writes
or retries, and global configuration byte fingerprints were unchanged. Tool
discovery alone does not establish model tool execution or write permission.

A follow-up identity-only Cursor check after the user's fix notification stopped
at the same Cursor account authentication requirement before any tool call. A
direct check from the running Codex desktop connection also still returned
`Authentication required`. No credentials or persistent settings were changed
by these follow-up checks.

The Grok connector configuration is supported by the
privacy-cropped native UI proof (private evidence).
The repair preserved the existing account, without an OAuth prompt, key entry or
uninstall. Connected status and enabled tools alone do not establish tool calls.
The subsequent identity-only prompt was sent at 05:12:16 UTC; production read-only
audit found exactly one successful `whoami` at 05:12:30.309 UTC in the verification
window after 05:09 UTC, and the native UI reported success at 05:12:34 UTC. The
Cursor model probe made zero calls and the operator made no Engram calls in that
window. This supports the UI test through a time-correlated server receipt, but
the OAuth client name was Cursor rather than Grok. Protocol metadata therefore
does not independently verify the product brand. No task-write E2E claim follows
from this identity test.

The branding deployment publishes canonical Engram logo assets and MCP/OAuth
display hints. Grok's current native connector card still shows a generic **E**,
despite Connected status and all 12 enabled tools; the card has not been fixed.
The current cropped card (private evidence)
records that limitation. The bot reported no logo field or refresh control and
offered only a restart of all connectors. That restart was declined and was not
performed; no connector authorization changed. Updated stdio source remains
unpublished at npm version 0.2.0.

Accessible projects in the current cloud account did not establish the current
OpenClaw/Hermes hosts. Projects with disabled APIs could not be checked. Historical
connection notes do not establish present host availability or expired credentials.

The earlier Codex identity-only proof used existing OAuth with normal approval
review. Only one `whoami` call ran in that probe; workspace ID and write
permission were not returned and were not inferred from tool availability. It is
a fresh CLI result, not proof that the already-running desktop session refreshed.
That identity probe used transient `gpt-6-sol`, required MCP startup with a
60-second timeout, zero optional-startup grace and normal `--approve-for-me`
review. The persistent model default was unchanged.

The first post-grant cross-client run was unsuccessful: Claude saved and read
back the source launch memory, and Codex independently read it. Normal automatic
review rejected the review-page write before it reached the backend because the
advertised contract did not establish create-only safety. Approval review was
not bypassed. Its author was subsequently closed failed as well, leaving both
original activities truthfully failed with their history preserved.

After the guarded contract deployment, a fresh author and reviewer performed
actual memory writes and readbacks. The final read-only execution proof verified
two distinct authenticated actors, both completed, and all five expected
receipts with matching stored payloads, returned action UUIDs, event IDs and
action bindings. All 17 expected tool attempts matched, with zero unexpected
tool calls or approval denials in the fresh run. Two reviewer CLI diagnostics
unrelated to tool execution remain preserved; raw traces remain private
(private final execution proof).
The earlier four-receipt checkpoint is retained as private evidence.

The review identified a genuine operator-UI wording gap; its completed report
does not mean all content was approved. The author changed only checklist item
3 using the current page hash. Exact bounded-edit verification confirmed public
facts, title, metadata and marker preservation, actual readback and an advanced
resulting version. No independent re-review or UI retest was performed by the
CLI agents.

The operator then checked the actual production UI through native CUA: the task
was Completed with two contributor marks, methods and a two-step log, and both
Read and Source showed the updated explicit operator-verification wording.
The operator UI proof (private evidence)
contains 11 privacy-reviewed stills. It resolves the operator-UI-pending flag in
the earlier CLI execution checkpoint; it does not claim a new independent
content review. This completes the scoped two-client product workflow; other
clients remain unverified, and video verification is scoped below.

## Earlier verification and UI status

This section records the morning checkpoint. The follow-up and activated-release
results above supersede its desktop, edge, signup, payment, package and playback
status.

- **Workspace entitlement — resolved:** the user authorized non-expiring access,
  and the owner/workspace-pinned operator grant is active with `expiresAt: null`.
  Live Plan & billing shows Complimentary and No expiry. This is a separate
  entitlement; the original 6–20 October trial dates and Stripe billing were not
  changed. Existing token permissions, membership and scopes still apply. The
  earlier 05:17:43 UTC read-only result was correctly `trial_expired` before this
  grant; it is no longer the current workspace entitlement.
  The first grant attempt returned `database_unavailable`; a subsequent
  read-only inspection proved no grant had committed. The exact request then
  succeeded after operations were sequenced. The initial cause remains unproven
  because that attempt had no SQLSTATE diagnostic. No Stripe change or charge
  occurred.
- **Scoped client write E2E — passed:** the fresh author and reviewer completed
  actual memory writes/readbacks and all five bound receipts, followed by the
  bounded hash-guarded clarification and operator verification of the Completed
  production task and updated memory. There was no independent re-review after
  the clarification. Other clients still require their own proof.
  An earlier startup attempt exposed no tools and made zero calls or writes.
  The corrected attempt produced the Claude source write/read and independent
  Codex read described above, but its review-page write was rejected before
  backend execution. Both original activities were then truthfully closed failed.
  Their history is retained separately from the fresh run.
- **Stripe payment E2E:** on 24 October, the exact dedicated sandbox secret
  `engram-stripe-test-secret-key` returned `NOT_FOUND` in a metadata-only check.
  No secret value was read and no charge was created. Full Stripe payment
  lifecycle testing remains unavailable.
- **Remaining client coverage:** Cursor's model identity call is blocked on its
  own CLI account authentication; its editor session remains unverified. A
  refreshed Codex desktop and reachable OpenClaw/Hermes installations also still
  need actual verification. Grok's identity test has the protocol-branding
  limitation described above; its task-write path remains untested.
- **UI access:** the Mac is now unlocked and native UI work has resumed. Grok
  Bot's connector configuration repair and identity UI test have been checked
  with the evidence limits described above.
- **Launch video — motion-v2 ready for review:** the revised native export is
  Ready with an empty issues list and no cleanup pending. Format/hash, encoded
  frame and silent-audio checks passed; full-rate perceptual playback has not
  been observed. The 62-second edit adds type lifts, opacity transitions and
  camera motion to genuine captured production states, rather than recording
  continuous interaction. Private billing/account proof stays out of the film.
  The rejected 63-second static-v1 is archived with its original MP4 preserved.
  The Yap brief and earlier editable HyperFrames fallback are retained as
  local launch artifacts outside this source release.

## Launch video artifact

Engram motion-v2 MP4 (local launch artifact)
is the native Yap export, reported Ready with no issues. Independent metadata
and hash verification passed. It contains 33 beats and 32 boundaries. Root
checked all 1,860 decoded frames: none were uniform, and measured temporal
variation confirms motion. Root visually reviewed all 33 encoded beat midpoints
across four contact sheets, plus 96 encoded samples spanning all 32 joins,
12 large native proof frames and repaired inverse cards. Type lifts, opacity transitions and actual camera curves execute.
Later local browser playback at 1× reached 62 seconds without a media error,
with opening, middle task-card, and closing frames inspected. This does not
claim continuous frame-by-frame perceptual review. The AAC track decodes to
exact digital silence: 5,952,000 samples, peak 0 and RMS 0. Export issues are
empty and no cleanup is pending. The encoded-motion QA, encoded/audio QA,
delivery record, and review are retained as local launch artifacts.

| Artifact fact | Verified value |
| --- | --- |
| Duration | 62.000 seconds |
| Video | 1920×1080, 30fps, H.264 High, BT.709 |
| Frames | 1,860 |
| Size | 6,115,310 bytes |
| SHA-256 | `0e1ebf7d68028a988dfb34a8d6241a79229fe6843c30031e8d03551308e7a948` |
| Native project | `7404303f-4d06-4feb-b314-b9eca9784698` |
| Native revision | `37badafa-cb1e-4aab-8742-e3d636a08dad` |
| Native export | `83bad83f-7d90-467f-832e-66996a4bd7b4` |

The edit uses genuine production captures and public reviewed captions, not a
continuous screen recording. Fine UI text is soft when upscaled; long paragraphs
are skim-only. The static-v1 metadata (local launch artifact)
is archived separately, and its original MP4 (local launch artifact)
remains intact; its earlier QA does not apply to motion-v2.
One work-log image import was blocked by automatic review before execution and
was omitted entirely; no email-receipt content was used. Yap 0.1.71's CLI, skill
and service were verified. No Yap screen recording was started for this edit.

This report contains curated verification summaries only. Credentials, personal
identifiers, private memory, infrastructure addresses and raw client traces are
excluded. The original morning report summarized existing evidence without
executing a new release or test. The later follow-up above records the additional
staging, activation, package publication, and sandbox verification work; no real
payment was made. Public announcements remain prepared drafts.
