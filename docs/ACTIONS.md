# Activity across agents

Engram exposes the same authenticated action history through MCP and the web
app. Reported task activity and directly observed memory operations can be read
together in All activity (the web default), or as explicit Tasks and Memory
streams. The web app uses local assets and black-and-white styling.

## Record and query from an agent

Give each agent a named connection. OAuth identities include the authenticated
client ID, so two clients signed in as the same person remain distinguishable.

```js
record_action({
  tool: "files.write",
  summary: "Updated the launch checklist",
  taskTitle: "Prepare the October launch",
  outcome: "The release checklist now includes the required checks",
  harness: "codex",
  resource: "docs/launch.md",
  status: "completed",
  runId: "launch-prep",
  approach: "Compared the release checklist with the changed files and recorded the missing checks.",
  detail: "Added the release checks requested in the originating task."
})

list_actions({ runId: "launch-prep", limit: 20 })
```

`record_action` returns `{ action }`. The server supplies the ID, authenticated
agent, receipt time, and evidence. Callers cannot claim another identity or mark
a report as independently observed. Status is `completed`, `failed`, or `running`.
`occurredAt` may be supplied as an ISO timestamp with a timezone, no more than
five minutes in the future. Credential-like values are redacted before storage.
`approach` is an optional concise description of the high-level method used,
limited to 1,000 characters. Supply an explanation suitable for a collaborator;
do not include hidden reasoning or credentials. Its authenticated author and
evidence stay attached to it. Changing an approach changes the report payload
for event-id retry validation.

Optional task context is explicit, agent-reported text: `taskTitle` (300
characters), `outcome` (2,000), and `currentStep` (500). Use a task title only when
there is an originating task; a standalone memory or tool call does not imply a
larger task. `outcome` is the contributor's reported result, not independent
verification or a separate declaration that every action in a run has finished.
`currentStep` is exposed only while the logical action is running. Missing
context remains absent; Engram does not infer a task title, result, or phase.

`list_actions` returns `{ actions, more, agents, tools }`. It accepts `q`, `agent`,
`tool`, `status`, `resource`, `runId`, `limit`, and `offset`. Agent, tool, status,
and run filters are exact; resource and text searches use literal, case-insensitive
substring matching. The default limit is 40, capped at 100.

Each action contains `id`, `agent`, `tool`, `summary`, `resource`, `status`,
`evidence`, `runId`, `actionKey`, `eventId`, `occurredAt`, `recordedAt`, `startedAt`,
`approach`, `detail`, `taskTitle`, `outcome`, `currentStep`, `harness`,
`sourceLabel`, and `sourceKind`. The latest logical-action projection preserves
its earliest occurrence and latest nonempty approach/task context when a later
heartbeat or completion omits those fields. A source is retained as one snapshot;
labels from different source reports are never mixed. Original append-only
reports remain unchanged. The immediate ingestion response describes the newly
stored event; list/detail projections provide the inherited context.

## Private activities and contributors

The web app groups reports with the same nonempty `runId` into one activity
within the current workspace. Several authenticated agents can contribute to
the same run. A report cannot name or impersonate another contributor: agent
names always come from their authenticated connections. A shared run ID is an
agent-reported correlation, not independent proof that external work occurred.

- `GET /api/activities` lists grouped work, contributors, tools, method summaries,
  status counts, and pagination.
- `GET /api/activities/:id` returns the activity plus its latest logical actions.
  Treat the returned ID as opaque and apply `encodeURIComponent` in the URL.

Both routes accept bearer authentication or the usual authenticated browser
session and `X-Engram-Console: 1` header. `X-Engram-Workspace` may pin the request
to the selected workspace; a mismatch returns 409. Neither route is public.
They remain readable after a hosted subscription ends.

The list accepts the same bounded filters as `list_actions`: `q`, `agent`, `tool`,
`status`, `resource`, `runId`, `limit`, and `offset`, plus `kind`:

- `tasks`: groups containing agent-reported actions, including legacy standalone
  reports; those remain single actions unless an explicit task title or run is present.
- `memory`: observed-only Engram operations, including legacy single memory calls.
- `all`: both streams; the default preserves existing clients.

Stream selection happens on the server before pagination, counts and facets.
If a group contains both evidence sources, it stays together in the tasks stream.
Observed calls currently have no run correlation; Engram does not attach them to
nearby tasks by time or connection name. Search also covers explicit task titles,
outcomes and current steps. Search and membership filters
select whole activities, so filtering one contributor or tool retains every
other contributor, action, tool, and approach in that activity. Status counts
apply those filters before the selected status filter; facets cover the current
workspace within the selected stream. Pagination and sorting happen after
grouping, by latest receipt.

The response contains `activities`, `more`, workspace-wide `agents` and `tools`,
`stats: { running, completed, failed, total }`, `checkedAt`, and
`freshnessSeconds: 900`. Each activity contains `id`, `summary`, `status`,
`startedAt`, `updatedAt`, `agents`, `tools`, `approaches`, `actionCount`, `runId`,
`evidence`, `workingActions`, and `staleActions`. It also returns `kind`
(`task`, `action`, or `memory`), optional `taskTitle`, `outcome`, `currentStep`,
and `resources`: the deduplicated resource identifiers from the complete group.
A resource may have been read or changed; the API does not claim it is an output.
Detail adds `actions`. The response's top-level `kind` echoes the selected stream.
Contributor records contain `name`, `status`, `actionCount`, `lastActiveAt`,
`workingActions`, `staleActions`, optional `harness`, `sourceLabel`, and
`sourceKind`; approaches contain `text`, `agent`, and `evidence`. The compatibility
`summary` remains the earliest action's reported summary. `taskTitle` and `outcome`
use the latest nonempty explicitly reported values in the group; `currentStep`
comes from a running action. These fields remain contributor reports, including
when other contributors still have running work.

An activity is running if any current action is running, failed if none are
running and at least one failed, and completed otherwise. The same precedence
applies to each contributor. Running reports older than 15 minutes remain
running with uncertain freshness: they count in `staleActions` and are excluded
from `workingActions`. Receipt timestamps determine freshness. Completion and
heartbeat events for a keyed action count as one logical action. This status
summarizes the currently known children; the protocol does not declare a run
permanently finished or prevent another contributor from adding work later. Without a run
ID, a keyed logical action keeps a stable activity URL across updates; legacy
unkeyed actions and observed Engram calls remain individual activities.

Contributor aliases, raw tools, approaches, and action details are private
workspace data. Public profiles share aggregate counts by default. A separate
owner option adds fixed action labels, canonical agent products and services,
statuses, evidence, and receipt times; it never publishes the original text.

## Source registration and attribution

Source metadata describes the harness/product, separately from the authenticated
connection name. Examples include `codex`, `claude-code`, `cursor`, `grok-bot`,
`chatgpt`, `gemini-cli`, and `other`. Safe extensible lowercase identifiers accept
letters, numbers, dots, underscores and hyphens, up to 80 characters; optional
`sourceLabel` is redacted text up to 100 characters. Source metadata does not
identify or verify the underlying model, and accepts no remote logo URLs.

`POST /api/tokens` accepts `{ name, canWrite, harness?, sourceLabel? }` and returns
those source fields alongside the existing one-time credential/wiring response.
A source label requires a harness identifier. `GET /api/tokens` includes the
registered source for each connection. An authenticated workspace owner can
update an existing active connection using
`POST /api/tokens/source { name, harness, sourceLabel? }`; the response is
`{ name, harness, sourceLabel }`. The update binds the workspace and connection,
changes no identity or permissions, and returns 404 for a missing active
connection. A null/empty harness and label clear the registration.

A registered token source takes precedence over incoming `record_action`
`harness`/`sourceLabel` values and is exposed as `sourceKind: "registered"`.
Unregistered reports may supply those fields, exposed as `sourceKind: "reported"`.
Both are display metadata, not proof of which product performed the operation.
`agent` always stays the authenticated connection identity. OAuth attribution
continues to distinguish the signed user and client ID; an opaque client ID is
not treated as a known harness. A connector can report its harness explicitly.

Source snapshots on reported action events remain immutable after a connection
registration edit. Future requests use the new registration; retrying an old
event returns its original snapshot. Observed memory operations resolve the
connection's current registered display source. Custom source labels and task
content remain private. The optional public activity stream maps known harness
values to canonical product names; unknown products become Agent.

The additive migration requires activity feature version `2026102301`, while
the base authority schema stays at `2026102202` for old-runtime compatibility.
The provisioner sets both markers only after migration; the new runtime requires
both, so missing feature columns cannot pass readiness. Run the migration with
the separate provisioner identity before starting this runtime. Optional columns
leave existing event payloads and delivery fingerprints compatible; existing
unregistered connections and legacy operations retain unknown source metadata.

## Running actions, heartbeats, and completion

Use an `actionKey` for one logical action from start to finish. Use a new
`eventId` for each update and reuse that event ID only when retrying delivery
of the same update. Both identifiers are scoped to the authenticated agent in
its workspace. They accept 1–200 ASCII letters, numbers, dots, underscores,
colons, slashes, or hyphens; start with a letter or number. Keep them opaque
and free of credentials or private content.

```js
record_action({
  actionKey: "release-42:build",
  eventId: "release-42:build:start",
  tool: "code.build",
  summary: "Building the release",
  status: "running",
  runId: "release-42"
})

// Send a new heartbeat while the action is still known to be running.
record_action({
  actionKey: "release-42:build",
  eventId: "release-42:build:heartbeat-1",
  tool: "code.build",
  summary: "Building the release",
  status: "running",
  runId: "release-42"
})

record_action({
  actionKey: "release-42:build",
  eventId: "release-42:build:completed",
  tool: "code.build",
  summary: "Release build completed",
  status: "completed",
  runId: "release-42"
})
```

The three reports remain separate, immutable storage events. The private action
list and public counts project the latest event as one logical action. Filters
and facets apply to that current projection. Its server-generated `id` identifies
the latest event; `actionKey` identifies the logical action across updates.
Each update is a complete report, not a patch: repeat the `runId`, `resource`,
and other context fields you want present in the current view. The concise
`approach` is the exception: the private projection retains its latest nonempty
value if a later update omits it. Task titles, outcomes and running-step context
also retain their latest nonempty explicit values; terminal actions never expose
an inherited current step.

An exact `eventId` retry returns the original action and original `recordedAt`.
It does not insert another event or refresh the working indicator. Reusing an
event ID with a different canonical payload returns **409 Conflict**. If
`occurredAt` was omitted, its generated timestamp is excluded from the retry
fingerprint; retries need not remember a timestamp assigned by the server.
Explicit timestamps are compared as normalized UTC instants.

A logical action cannot change tools or its `runId`. Repeat the original run ID
on every update; a logical action started without one must remain ungrouped.
Use a new `actionKey` to start work in a different run. Updates older than its latest
`occurredAt` are rejected with 409. `completed` and `failed` are final: a later
update cannot reopen or change the result. Retrying delivery with the original
event ID remains valid; starting another attempt requires a new `actionKey`.
Database transactions and an advisory lock serialize reports from the same
authenticated agent across service instances.

For current activity, report the start and result immediately. A running action
needs a new heartbeat periodically while the agent or adapter still knows it is
running; roughly once per minute is sufficient for the 15-minute freshness
window. A running report last received more than 15 minutes ago becomes stale,
not implicitly completed or failed. Freshness uses the server receipt time,
so an old client timestamp or a delivery retry cannot manufacture a fresh
receipt. This remains **agent-reported working activity**, not independent
observation of the external tool.

Without an `actionKey`, each legacy report is an independent action. Without an
`eventId`, retries are not deduplicated. New adapters should send both fields.

## HTTP access

`GET /api/actions` has the same filters and response as `list_actions`.
`POST /api/actions` accepts the same report as `record_action` and returns 201.
Both accept an agent bearer token. Browser requests use the existing session
cookie and `X-Engram-Console: 1` CSRF header. The same permissions apply through
both transports: reads require read access; reports require write access and
respect the workspace’s agent-write policy.

Actions are stored append-only in `engram_gateway.action_events`, isolated by
organization. Queries combine reports with the organization’s existing
`audit_log` records. Reading action history does not generate visible feed noise.
The raw lifecycle history is retained even though list and aggregate queries
return the current logical state.

## Evidence and coverage

- **Reported by agent:** authenticated report of an external action. The external
  change has not been independently verified by Engram.
- **Observed by Engram:** a call to Engram itself, derived from its existing audit.
  This says nothing about external tool calls.

Connecting an MCP client supplies access to Engram; it does not intercept the
client’s other tools. Agent instructions or tool-boundary adapters must call
`record_action` for external activity. There is no external conflict detector,
automatic intervention, or provider integration in this change.

To follow a task through several tools, use the same `runId` on its reports. To
inspect a shared object’s history, filter by `resource`. The web detail view links
to both and can copy an action as JSON.

## Local UI preview

```sh
bun web/dev-server.ts
```

Open the printed local URL. This fixture server uses sample records across files,
code, email, cloud, calendars, browsers, and databases, with a persistent preview
banner. It never connects to those services. `PORT=8101 bun web/dev-server.ts`
selects another local port.

## Public activity profile

Workspace owners can create a profile under **Public profile**. Its
preview is private until the owner publishes it. The profile counts all activity
in the selected workspace; it does not combine other workspaces implicitly.

- `GET /api/showcase`: owner settings, public URLs, and a private safe preview.
- `PUT /api/showcase`: replace `{ slug, displayName, bio, published, showActivity }` as an owner; omitted `showActivity` defaults to false.
- `GET /u/:slug`: public profile with social preview metadata.
- `GET /api/public/activity/:slug`: public JSON, with CORS for portfolio websites.
- `GET /api/public/activity/:slug/card.svg`: scalable image for portfolio embeds.
- `GET /api/public/activity/:slug/card.png`: 1200×630 social preview image.

Public JSON contains the explicitly chosen profile name/bio, action totals,
unique contributor count (`activeAgents`), active days, an 84-day UTC contribution
grid, broad tool categories, and the latest activity timestamp. With explicit
`showActivity: true`, it also includes up to 20 latest logical actions represented
by canonical agent products, services, fixed action labels, status, evidence,
and receipt times. It never returns personal agent aliases, original action
summaries, resource names/paths/URLs, details, runs, or transcripts.
Counts combine agent reports and directly observed Engram operations. They are
activity counts, not a productivity or success score.

Settings require owner access, normal write permissions, and the browser CSRF
header or bearer authentication. Public endpoints are unauthenticated only after
publication. Unpublishing makes them return 404 immediately; responses use
`Cache-Control: no-store`. Copies already downloaded or cached by third parties
are outside Engram’s control.

The JSON endpoint is intentionally easy to use in a portfolio:

```js
const activity = await fetch("https://YOUR_ENGRAM_HOST/api/public/activity/YOUR_SLUG")
  .then(response => response.json());
console.log(activity.stats.totalActions);
```

The profile settings also provide a copyable SVG image embed. Only the local
fixture server simulates publication against sample data.
