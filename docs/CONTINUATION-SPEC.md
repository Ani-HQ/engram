# Engram continuation v1 draft plan and specification

Prepared 27 October 2026 against repository HEAD `854c7d4`. Status: stage 1
(protocol and storage) and the console Handoffs view are implemented on
`feat/continuation-v1`; portable local state, runtime adapters and the live
transfer matrix are not. See the implementation log at the end. Nothing here is
a shipped capability until the release gates pass.

Engram should let a person continue the same task in another agent using a
compact, clearly sourced task record. The first release covers deliberate
handoffs and recovery after the outgoing agent becomes unavailable. The product
remains a shared drive for agent context; manager-facing audit is not the lead
job for this release.

## Decisions from the jam

| Decision | Resolution | Source |
| --- | --- | --- |
| Lead outcome | Continue work across agents with trusted context. | User |
| Continuation modes | Both deliberate handoff and interrupted recovery in v1. | User |
| Runtime scope | Claude Code, Codex desktop and Cursor desktop in v1. | User |
| Saving experience | Automatic checkpoints at meaningful decisions and milestones, plus explicit handoff. | User |
| Resume depth | Compact task record, including active plan, decisions, blockers and next step. | User |
| Workspace boundary | Preserve configured personal/team workspace scope and reviewed cross-workspace sharing. | Existing product contract; preserve in v1 |
| Current state | Incoming agent rechecks files, Git and relevant checks; historical reports do not become current facts. | Existing handoff contract; preserve in v1 |
| Pricing and deadline | No price change or delivery date agreed. The attachment's $49 Team price and 30 November target remain proposals. | Not adopted |
| Positioning | Continuation leads the story: start in one agent, continue in another from the last confirmed save. Team audit stays secondary. Hook-captured tool logs, hash chains, phone approvals, digests and a GitHub app are not v1 work. | User, 27 Oct |
| Product name | Engram stays the name. | User, 27 Oct |
| Experience bar | Cheap, simple and elegant; every new surface uses or extends the design system and stays cohesive with the console. | User, 27 Oct |
| Price level | Direction is "very cheap", likely a limited free hosted personal tier plus one flat team price. Measure the cost of an idle workspace (one database each) before choosing numbers. | OPEN, user decision |

The source report is the user-supplied `competitors.md`. It is research input,
not authority to build, change prices, publish, or contact anyone.

## The experience

Illustrative incoming-agent brief, using decisions from this planning chat:

> Recovered the last confirmed checkpoint for Engram's continuation feature.
> Scope: Claude Code, Codex desktop and Cursor; deliberate handoff and interrupted
> recovery. Saving: automatic checkpoints at meaningful milestones, plus explicit
> handoff. Next: finish the spec and review it with Ani before building. No final
> handoff was recorded; newer work may be missing.

**Deliberate handoff:** the user asks the current agent to hand off. The agent
saves an updated checkpoint, waits for a confirmed receipt, and returns a short
task reference and next intended step. A handoff does not mark the task complete.

**Interrupted recovery:** the user asks another agent to continue the task. It
loads the last confirmed checkpoint without depending on the outgoing process.
The brief includes its save time and source. Work after that save remains unknown.
Silence alone does not establish a crash, failure, or completion.

In both modes, the incoming agent checks the relevant repository/worktree,
files and tests before relying on historical state reports. It follows the live
user request and current permissions; a saved checkpoint is reference data and
cannot authorize new actions or override current instructions.

When multiple tasks or branches of work match, the agent asks for a selection.
It must not pick a global latest checkpoint. A unique, properly scoped task can
load without an extra confirmation step. Explicit resume remains available when
automatic discovery or injection is unavailable.

## Compact task record

The record contains:

- Objective and a short task title.
- Active plan with stable step identifiers; progress is attributed reporting.
- Decisions and reasons, preferably referencing existing durable memories.
- Constraints, blockers and unresolved questions.
- Next intended action.
- Bounded references to relevant memory versions and work artifacts.

The server adds authenticated author, workspace/project/task identity, work
lineage, originating attempt, checkpoint identity, parent/revision, trigger and
receipt time. Runtime/version/session labels remain client-declared metadata.

Relationship to `record_action`: the existing `agent.task` action reports remain
the per-attempt history in Activity. A checkpoint stores the attempt's `runId`,
which links a continuation task to the action runs that worked on it. Neither
replaces the other, and the console calls continuation records **Handoffs** so
they are not confused with Activity's reported-task filter.

Task identity is independent of a runtime attempt. A task survives Claude to
Codex to Cursor; each attempt has a distinct run identity. A lineage identifies
one branch of work, including an explicit repository/worktree binding where
available. Parallel attempts do not silently overwrite each other's plan.

Historical file/test/commit reports are optional, separately sourced and dated.
They never replace the incoming agent's current checks. Keep raw prompts,
transcripts, file bodies, tool outputs and raw command arguments outside the
checkpoint workflow. Allowlisted artifact references must exclude credentials
and unrelated absolute local paths; omission is preferred to regex-only cleanup.

Implemented bound: a save is measured as the exact `resume_task` envelope it
would produce (escaping, Unicode and metadata included) and must fit 3,584 bytes,
leaving 512 bytes of the default 4,096-byte response for transport metadata and
the optional freshness notes added at resume time. A
record at the old proposed 4,096-byte cap could never be read back in one default
response, so the gate measures delivery instead of raw JSON. Field and list limits
also apply (objective 500, next 400, 12 plan steps, 10 decisions, 8 references).
Oversized saves fail with `record_too_large` and the excess byte count. Task tools
are exempt from the cumulative per-task retrieval budget, so earlier `recall`
use cannot block a resume; each response is still bounded. A client with a
smaller budget gets an explicit `context_too_small` control response.

## Automatic checkpoints

Checkpoint triggers are an explicit initial objective, a meaningful decision or
correction, a material plan/constraint/blocker change, a real milestone, and an
explicit handoff request. Unchanged content creates no new revision; an explicit
handoff may return the current confirmed checkpoint if its content is unchanged.

The installed workflow instructs the agent to save at those moments without
waiting for the user to request a save. Supported runtime events can supply
reminders. Hooks cannot infer semantic decisions or recover unstated intent.
The baseline uses the active agent's normal tool calls; it adds no transcript
parser, timer-generated summary, or separate inference service.

Stop, SessionEnd, idle, context compaction and usage-limit warnings are additional
opportunities where supported, never the only save trigger. They do not establish
task completion. Record a known completed/failed outcome only when supplied by
the agent or owned application, with its reported source preserved.

The server can guarantee a confirmed checkpoint is retrievable. It cannot
guarantee that the model identified and saved every important decision. The
interface therefore states the recovery boundary as the last confirmed save.

## Storage and operation contract

Proposed implementation choice: explicit continuation task/checkpoint tables in
the workspace's actual brain database. The checkpoint is the sole authoritative
task snapshot. Durable memories remain canonical pages; checkpoint references do
not create a second authoritative copy of those pages. No write-through into
gbrain, central activity insertion, or model processing is required to confirm a
checkpoint save.

One database transaction commits the immutable checkpoint, request fingerprint,
receipt and lineage head. Provision the schema for every existing and newly
created brain database, including legacy `brain_shared`, with a checked feature
version. Do not choose a pool simply because it is named `dataSql`: the legacy
workspace's data and brain bindings can differ.

Three proposed MCP operations form the portable baseline; runtime-specific
commands call the same service contract:

| Operation | Contract |
| --- | --- |
| `checkpoint_task` | Create a task and initial checkpoint atomically, or append a full compact snapshot to an identified task/lineage. Requires stable request ID and expected parent; server computes the canonical payload fingerprint and assigns new task/checkpoint IDs. |
| `find_tasks` | Read a bounded set of authorized candidates for an explicitly bound project and named subject. Return source/save metadata sufficient to select a task. |
| `resume_task` | Read an exact task and selected checkpoint, defaulting to its unique confirmed lineage head. Return the compact record, source/version references, save time and known coverage. No write permission is required merely to read. |

Closing: an agent saves `trigger: "completed"` only for a known completion, which
closes the task; a later save reopens it. People close and reopen from the
console. Only an authenticated workspace member can delete or restore.

Task creation retries reuse the original request ID and receive the original
server-assigned task ID. Scope request identity to the authenticated writer,
workspace and project/task operation; it must not collide across actors or let a
guessed ID disclose another writer's receipt. Check a matching retry before
validating the now-current parent, so later saves do not invalidate an earlier
successful request. Identical authorized retries return the same receipt; the
same request ID with a different payload conflicts. An uncertain response keeps
the same payload/request ID for reconciliation. Existing `remember` writes
retain their current no-replay behavior; new checkpoint guarantees do not
retroactively make memory saves idempotent.

A stale expected parent returns a revision conflict. Do not auto-merge or
silently rebase model-authored intent. The agent loads the current head and
reconciles it, or explicitly creates a separate lineage. Parallel lineages remain
visible candidates. An immutable checkpoint cannot change its task or parent.

Authorization derives workspace and actor from the current credential and request
context, never from task/run IDs. Apply normal read/write permission, agent-write
policy and hosted entitlement. Validate current access before returning a prior
receipt. A workspace switch does not rebind an agent credential. Credential
replacement cannot replay another credential's pending queue.

Private local state may hold a bounded pending checkpoint payload for retry,
with the existing owner-only permissions, symlink checks and exact project/
endpoint/credential scope. Bound queue size and retries. A disconnected service
must not stop ordinary coding work; distinguish unsent, unconfirmed and saved.

Post-commit activity is a derived projection, not a prerequisite for save
confirmation. If needed, a metadata-only outbox in the same transaction can
support retryable projection. Exports must read authoritative task records even
if Activity projection is behind.

Memory references identify the canonical page slug and full version hash, with
optional entry fingerprint or exact excerpt coordinates/hash. Entry IDs alone
are not authoritative. A version hash does not guarantee a historical source
body is still retrievable. Resolve references only under current source access;
approved shared excerpts point to the recipient-visible snapshot and never
grant access to its personal source workspace.

Loading a record proves delivery by Engram, not that the model followed it.
Reported rationale remains attributed. A memory retrieved during a run is not
proof that it caused a change. Missing, changed or retracted source references
must be shown as such rather than silently replaced with current text.

## Runtime coverage

| Runtime | Required integration and validation |
| --- | --- |
| Claude Code | Project guidance plus supported startup/prompt reminders and normal checkpoint tool calls. Verify handoff after earlier decision saves; the current Stop reminder can be suppressed after any saved delta. |
| Codex desktop | Test the local orchestration/hook path and preserve existing runtime-managed/OAuth authentication. Portable skill guidance must call the same task tools when no bearer-backed bridge exists. Do not extract native token caches. |
| Cursor desktop | Install always-loaded task guidance that explicitly loads the task before substantive work. Fix/reconcile startup/deferred delivery bookkeeping; post-tool injection alone does not establish recovery before the first action. Validate the supported live version. |

Publish native-workflow and skill-workflow coverage separately. Configured hooks,
fetched context, returned context, confirmed save and model use are different
facts. Cursor background/cloud agents and Codex Work Cloud are outside the named
desktop contract unless separately validated; installing local hooks does not
configure a cloud orchestrator. All three named desktop runtimes remain release
requirements; sequential implementation does not defer one to a later release.

## Console and data lifecycle

Use the existing Activity detail/handoff surfaces to show the active task record,
save time, source, plan and resume reference. Make the record inspectable to
everyone authorized to read its workspace. Checkpoint history and task type must
be explicit; do not hide a second content collection behind memory-call counts.

Show saved, unsent/unconfirmed, unavailable, read-only/reconnect required,
revision conflict, ambiguous task and no-checkpoint states. Missing progress
does not become failure. Do not claim to know the exact amount of lost work.
Runtime coverage and checkpoint delivery states remain separate.

Preserve personal/team boundaries. Team-bound writes are team-visible. Personal
records cross into a team only through reviewed, authorized sharing of exact
content; no checkpoint feature grants silent access to personal sources. Full
structured cross-workspace task adoption is deferred; approved shared excerpts
remain readable through existing sharing semantics.

Extend the existing JSON export with authoritative task records, revisions and
source labels. Existing exports already cover memories and actions. Define task
closure separately from deletion: closure retains history; explicit soft deletion
removes a task from ordinary discovery/resume and exports until restored through
an authorized path. A delayed retry cannot resurrect a deleted task. No automatic
fallback to a deleted task's older checkpoint. Deletion/restore requires an
authenticated human with the workspace's applicable deletion permission; agent
credentials cannot perform it.
Document operator erasure coverage for checkpoints, receipts, derived activity
and local pending copies. Preserve existing retention disclosures; add no new
age-based deletion promise. Public activity must not expose task titles, record
content, identifiers or references without a separately specified publication
projection. Do not count checkpoint revision volume as productivity.

Before any frontend edit, read the full [design system](DESIGN-SYSTEM.md) and
inspect local `/design-system`. Reuse shared primitives/tokens, add any missing
pattern to its gallery, and validate loading, empty, error, success, focus,
disabled, narrow-screen and reduced-motion states. Preserve CSP, workspace
pinning and immediate keyboard actions.

## Acceptance and release gates

The six ordered transfers are Claude to Codex, Claude to Cursor, Codex to Claude,
Codex to Cursor, Cursor to Claude and Cursor to Codex. Exercise each with deliberate
handoff and abrupt interruption: twelve core live scenarios, plus same-runtime
restart. Record actual app versions, platform, auth mode and evidence; fixtures
alone do not certify the apps.

Required behavior:

1. A meaningful decision and plan change become confirmed checkpoints without
   the user separately requesting a save; unchanged events create no churn.
2. Explicit handoff returns its confirmed task/checkpoint reference. Interruption
   after a confirmed save recovers that revision without the outgoing agent.
3. No checkpoint, an unconfirmed save, or a missing final handoff remains explicit.
   The system never manufactures unsaved intent or marks silence as completion.
4. Timeout before/after commit, retries and process restart preserve one logical
   checkpoint and its receipt. Reusing IDs with different bodies conflicts.
5. Concurrent writers, tasks and worktrees do not acquire each other's plans;
   stale parents and ambiguous candidates are recoverable and visible.
6. Revoked/read-only/expired/wrong-workspace credentials, credential replacement
   and membership changes respect existing access boundaries. Reads remain
   available where normal entitlement policy permits them.
7. Cursor lost startup output, late output, no tool call, a first mutating tool
   attempt and duplicate post-tool events do not silently consume the only
   usable context delivery. Record the actual limitations of each auth path.
8. UTF-8/escaping limits, secret fixtures, malicious saved instructions and stale/
   missing memory references preserve bounded context and live-user authority.
9. Export, explicit task deletion and derived Activity projection preserve source
   labels and never substitute an older/deleted checkpoint as a fallback.
10. Relevant unit and disposable-Postgres integration checks pass; desktop/mobile
    browser review and the real twelve-scenario matrix pass before claiming all
    three runtime integrations work.

## Build plan

The judgment calls most likely to change are the compact-record size, runtime
reminder timing, task-disambiguation presentation and placement of the task view.
Change those in this document with evidence. The chosen continuation modes,
three-runtime release scope and compact-record experience come from the user.

Implementation order:

1. **Protocol and schema:** freeze field/error contracts, implement atomic task/
   checkpoint/receipt/head storage, feature readiness and the three MCP operations.
   Prove retries, conflicts and tenant isolation with real disposable PostgreSQL.
2. **Portable workflow and local state:** add bounded pending delivery, task/
   attempt separation, meaningful-event guidance, explicit handoff and resume.
   Preserve ordinary memory-write uncertainty rules and current auth modes.
3. **Runtime adapters:** implement Claude Code, Codex desktop and Cursor paths
   sequentially, all before v1 release. Address Cursor delivery bookkeeping and
   test native versus portable coverage explicitly.
4. **Console and lifecycle:** expose task records/history, extend export and task
   deletion semantics, add missing shared design-system patterns and update docs.
5. **Release validation:** run targeted regression suites, schema/provisioning
   integration checks, browser review and the live transfer matrix. Publish only
   the coverage established by these checks.

Likely owners are new checkpoint schema/service modules; `gateway/src/proxy.ts`,
`mcp-context.ts`, `mcp-request-context.ts`, `tenant-db.ts`, `activities.ts`;
`shim/memory.js`, `runtime-adapters.js`, `runtime-contracts.js`, `runtime-install.js`
and `onboarding.js`; existing Activity/account views and conformance/integration
tests. Broader SDK/framework expansion is deferred; preserve existing contracts
while introducing the shared task protocol.

No fixed build-day estimate is committed before the protocol and runtime
delivery gates are exercised. Each stage should leave a reviewable change with
appropriate checks. Runtime expansion inside this plan does not weaken the
three-runtime release gate.

## Four quadrant planning map

### Known knowns

The decisions above are settled. Existing project memory and handoff intent are
documented in [HANDOFF.md](HANDOFF.md). Identity, scoped storage and permissions
are established by [ORGS.md](ORGS.md), [SHARING.md](SHARING.md) and
`gateway/src/context.ts`. Bounded MCP retrieval and confirmed write receipts
exist in [MCP-CONTEXT.md](MCP-CONTEXT.md). JSON export exists in
`web/account.js:126`. This is an extension to those foundations.

### Known unknowns

User decisions are closed in the decision ledger. Workspace scope and
revalidation are answered by the existing product contract. Remaining facts to
confirm before their implementation step are OPEN with explicit gates:

| OPEN item | What closes it |
| --- | --- |
| Exact installed desktop versions/platforms and native versus OAuth/skill paths | Inventory the three actual runtime test targets; never infer them from an MCP connection. |
| Cursor pre-work resume behavior | Verify supported live guidance/injection path and lost-startup recovery before claiming automatic delivery. |
| Checkpoint schema authority/readiness across existing deployments | Validate actual brain bindings and provisioner-owned installation, including legacy org 1. |
| Complete-envelope fit for compact records | Exercise proposed bounds through actual MCP serialization, usage metadata, Unicode and adversarial escaping. |

These are engineering/release gates, not invitations to silently reduce scope.
If a runtime cannot satisfy the agreed experience, surface that conflict before
claiming the release is ready.

### Unknown knowns

The jam established that a final outgoing message cannot be required; the agent
may already be unavailable. Saving should happen without manual save prompts,
but the incoming agent needs a compact active task rather than conversation
reconstruction. Broad runtime coverage matters enough that Cursor belongs in v1.
The consumer is the next working agent and the person directing it; manager
reporting is secondary. These answers changed the first build from a tool-capture
ledger into task checkpoints and explicit continuation.

### Unknown unknowns and sharp edges

The read-only sweep covered canonical memory writes, entry indexing, write
coordination, request identity/budgets, tenant provisioning, runtime adapters,
local delivery state, Activity/export, sharing and retention. It is source review,
not a live runtime test. Its load-bearing findings are:

| Evidence | Why it matters | Disposition |
| --- | --- | --- |
| `shim/memory.js:391`–`403` | Uncertain `remember` writes cannot be safely replayed. | Decided: checkpoint-specific idempotency and confirmed receipts; leave memory semantics intact. |
| `gateway/src/proxy.ts:527`–`535`, `memory-entries.ts:89` | Entry indexing is best effort after a canonical page write. An optional entry ID cannot prove a checkpoint committed. | Decided: authoritative task storage; memory entries are references only. |
| `gateway/src/write-coordination.ts:10` | A central advisory-lock transaction does not enclose engine writes in a separate database connection. | Decided: checkpoint/head/receipt commit in one actual-brain transaction. |
| `docs/DATA_RETENTION.md:18`, `gateway/src/tenant-db.ts` | Legacy data/brain bindings differ; new schemas require provisioner authority and readiness. | OPEN implementation gate: verify every actual brain database. |
| `shim/runtime-adapters.js:48`, `:51`; `shim/memory.js:452` | Startup fetch can consume local retrieval state before usable delivery is established, especially for Cursor. | OPEN live-runtime gate plus required delivery bookkeeping work. |
| `shim/runtime-adapters.js:34`; `shim/memory.js:369` | Codex/Cursor Stop currently returns no delta prompt; Claude can suppress it after an earlier save. | Decided: meaningful checkpoints during work; final Stop is supplementary. |
| `shim/memory.js:277` | Current run identity includes credential/runtime/session, so it cannot be the cross-agent task identity. | Decided: durable task and separate attempt identities with explicit lineage. |
| `gateway/src/activities.ts:141` | Memory/task classification currently depends on observed/reported evidence. | Decided: explicit task domain; never promote model text to observed external work. |
| `docs/SHARING.md:3`, `:11` | Direct team writes are team-visible; personal-to-team sharing requires review. | Decided: preserve boundaries; structured cross-workspace task adoption deferred. |
| `docs/DATA_RETENTION.md:14`, `web/account.js:126` | Deletion/export do not automatically cover a new content type. | Decided: explicit task lifecycle, authoritative export and erasure documentation in v1. |

## Deferred work

Tool-call/command capture, full conversation restoration, Git authorship/causal
inference, GitHub apps/comments, Slack/email digests, bulk imports, price changes,
hash-chained audit and broader runtime/framework support are outside this release.
Basic artifact references may link existing work without claiming authorship.

## Implementation kickoff

Suggested next instruction after reviewing this draft:

> Build continuation v1 from docs/CONTINUATION-SPEC.md. Preserve the agreed compact
> task record, automatic checkpoints plus explicit handoff, both continuation
> modes and all three desktop runtimes. Start with the atomic checkpoint protocol
> and its storage/tenant tests. Record deviations and unresolved runtime coverage
> in the spec; do not silently reduce scope. Follow the repo's design-system and
> release contracts.

During implementation, record any change forced by code or real-runtime evidence
with the original assumption, finding, chosen response and whether it needs a
user decision. Keep this document aligned with the implemented behavior.

## Implementation log

Stage 1 and the console, on `feat/continuation-v1`:

- **Storage.** `continuation_tasks`, immutable `continuation_checkpoints` (a
  trigger rejects updates), `continuation_heads` and `continuation_receipts` are
  created by `migrateOrgDataTables`, so they exist in every workspace data
  database, including the legacy org 1 binding. One transaction commits the
  checkpoint, head and receipt. A workspace whose storage is not yet migrated
  returns `continuation_unavailable` instead of an internal error.
- **Protocol.** `gateway/src/continuation.ts` implements the three MCP tools and
  the console API (`/api/tasks`, detail, checkpoint, close, reopen, delete,
  restore, export). Request IDs are scoped to the writer; retries are checked
  before the parent; stale parents conflict with the current head; forks are
  explicit lineages; credentials in record text are refused, not redacted.
- **Agent guidance.** Server instructions and both installed skills tell agents
  to save checkpoints unprompted and to ask when several tasks match.
- **Console.** Activity gains a Handoffs section with a one-click continue
  prompt. The design system gains `taskRecord` and a warning notice tone, with a
  gallery section. Reviewed at 1280px, 390px and 320px.
- **Export.** The workspace export includes authoritative task records.
- **Tests.** Unit tests cover parsing, credential refusal, fingerprints, the
  delivery-size gate and response bounds. Real PostgreSQL checks cover retries,
  conflicts, forks, concurrent saves, workspace isolation, read-only access,
  immutability, closing, deletion without fallback, restore, export and the MCP
  boundary.

Deviations and open work:

| Item | Status |
| --- | --- |
| Memory references are stored but not resolved at resume, so missing or changed pages are not flagged yet. | OPEN, stage 2 |
| Local pending checkpoint queue and unsent/unconfirmed states in the bridge. | OPEN, stage 2 |
| Claude Code, Codex desktop and Cursor desktop adapters, including Cursor startup delivery. | OPEN, stage 3 |
| Activity shows checkpoint calls only as observed audit rows (IDs and trigger). No outbox projection. | Accepted for now |
| Live twelve-scenario transfer matrix. | Not run; required before claiming runtime support |

