# Bounded MCP memory context

Engram measures serialized UTF-8 tool-result bytes at the gateway. This includes
the MCP result envelope and Engram's numeric diagnostics. `estimatedTokens` is
the sum of `ceil(responseBytes / 4)` for those results. It is a rough byte-based
heuristic, not a tokenizer measurement, the client's context usage, or a model
bill. Tool definitions, tool arguments, the rest of a conversation, client-side
caching and provider accounting are outside this measurement.

Every MCP read has a response ceiling: 4,096 bytes by default, configurable from
1,024 to 16,384 bytes. Runtime adapters also provide a bounded run ID through
trusted gateway call context. For these calls the gateway maintains a durable
budget scoped to the authenticated workspace, credential kind and actor, and
hashed run ID. The first request fixes the run's maximum; later requests cannot
increase it. Caller-supplied workspace fields never set accounting authority.

Run accounting serializes in a short database transaction, so concurrent gateway
replicas and process restarts share the same consumed byte count. Identical read
results for the same tool are suppressed within the run. Only a result hash is
kept for deduplication. Queries, prompts, arguments, retrieved text and raw run
IDs are not stored by this accounting feature. Existing audit policies are
separate from these numeric measurements.

Duplicate results and exhausted runs return a small control receipt with no
retrieved memory. These receipts leave the retrieval budget unchanged, but their
bytes still count toward response overhead diagnostics. A database failure or
full run table also returns a small skip receipt instead of releasing unaccounted
memory. Memory writes are not blocked by diagnostic failures. These controls do
not prevent an agent from making repeated tool calls; adapters should stop
automated retrieval on a stop receipt and use bounded retries.

MCP clients that do not send a valid run ID receive the per-response ceiling
only. Their metadata explicitly reports `scope: "response"` and
`runScoped: false`. No hourly or daily actor bucket is substituted, because that
would let one task block unrelated work. Install a runtime adapter for a task
budget. The gateway cannot guarantee automatic use of optional tools in a
client whose runtime offers no lifecycle integration.

Per-result diagnostics are in `_meta.engramContext`: scope, configured budget,
used and remaining retrieval bytes, response bytes, estimated tokens, estimate
method, duplicate suppression, truncation, budget stop, and accounting
availability. Output bytes include this metadata. Successful memory receipts
are distinct from authentication and connection status.

## Private connection diagnostics

The existing authenticated Connections API adds `memoryUse`. Its metrics are
never copied into public activity or public profiles:

- `available` and `trackingSince`: whether this gateway has recorded a numeric
  measurement for that connection, and its first measured call. Earlier activity
  is not backfilled into these counters.
- `lastRecallAt`, `recalls`: successful delivered `recall`, `search`, or
  `get_page` results. Suppressed duplicates and budget stops do not count as a
  delivered recall.
- `lastRememberAt`, `remembers`: successful `remember` or `put_page` receipts.
- `responseBytes`, `estimatedTokens`, `tokenEstimate`: measured response bytes
  and the explicitly labeled `utf8-bytes-divided-by-4` heuristic.
- `duplicateRecalls`, `budgetStops`, `truncatedResponses`: visible safeguards.
- `runScopedResponses`, `responseScopedResponses`: whether the client supplied
  usable run metadata. These do not prove that every other client action was
  measured or that memory is used on every task.

Onboarding uses confirmed delivered-recall/save measurements for new calls.
Successful upstream audits after `memory_usage_started_at` cannot advance
memory proof if the final result was skipped, duplicated or failed. Unambiguous
successful audits from before that stable rollout timestamp retain historical
progress. Re-running migrations does not move the cutoff forward.

Absent measurements use `available: false` and null metrics. They are not
displayed as measured zeros. Historical audit counts remain separate.

### Integration declarations and explicit workflow checks

Task-aware clients may add this bounded declaration to the existing context
metadata, outside tool arguments:

```json
{"com.engram/context":{"runId":"task-opaque-id","maxBytes":4096,"integration":{"id":"engram-sdk-js","version":"0.1.0","runtime":"custom-agent","capabilities":["task-context","lifecycle-events","explicit-deltas"]}}}
```

`id` and `runtime` are ASCII identifiers of 1–80 characters; `version` is 1–40.
Only the three capabilities above are accepted. These are client declarations,
not authenticated product identities or evidence of automatic use. Unknown
fields, proof claims and caller-supplied credential/workspace authority are
rejected. The gateway derives the credential scope from the authenticated bearer.

The private `memoryUse.integration` response separates these levels:

- `connected`: this gateway recorded an authenticated tool response.
- `recallVerified` and `saveVerified`: actual successful delivered read/save
  receipts, with the existing separate memory receipt timestamps.
- `declaration`, `declaredAt`, `lastSeenAt`: bounded reported integration metadata
  and gateway timestamps, without credentials, queries, prompts or returned text.
- `workflowCheck`: `not-checked`, `pending`, `passed` or `expired`, with
  `checkStartedAt`, `checkedAt` and `checkExpiresAt`.
- `automaticWorkflowVerified`: always `null`. MCP receipts cannot independently
  prove that an invocation was automatic or that the model used its result.

An explicit compatibility check starts by calling the existing `whoami` tool
with the same task/integration metadata plus `verification: "begin"`. The gateway
returns a server-issued `emp_…` nonce in the JSON `verification` object. This
control never creates a memory. On subsequent **real** read/save calls, supply
that nonce as `probeId` and keep the same run ID and full integration declaration.
Read the result with `whoami` and `verification: "status"` plus that `probeId`.

The returned object contains `probeId`, `status` (`pending`, `passed`, `expired`
or `not-found`), `startedAt`, `expiresAt`, `checkedAt`, `recallVerified`,
`saveVerified` and `automaticWorkflowVerified: null`. A check passes only after a
successful delivered `recall`/`search`/`get_page` and a successful
`remember`/`put_page` receipt occur within 15 minutes, for the same authenticated
workspace, actor, current credential, run, integration/version/capabilities and
issued nonce. Failed, duplicate and budget-stopped retrievals do not advance it.
Changing credentials or the declared integration clears its current private
check evidence. A matched check proves that explicit transport/read/save sequence;
it does **not** prove automatic use.

SDK verification is opt-in. A client must not manufacture a dummy memory to pass
the check; correlate an intended explicit decision, or leave save unverified.
Checks are limited to eight active probes per actor and 256 per workspace.
Expired probes are removed on the next explicit begin in that workspace. Nonces
and run IDs are stored only as hashes; check records contain timestamps and
bounded scope hashes, not memory text. Scoped read-only shares cannot perform a
read/save workflow check. Operational failure leaves verification unavailable
without blocking ordinary work or replaying a write.

## Storage and rollout

The additive schema creates `memory_context_runs` and
`memory_connection_usage` with the exact readiness marker
`memory_usage_version = 2026102604`. Base authority and every predecessor
feature marker remain unchanged. The normal restricted gateway DML/RLS policy
applies; a memory subprocess does not gain central database access.

On subsequent accounting requests, run rows expire after seven inactive days
and are limited to 128 per actor and 4,096 per workspace. Each run stores at most
128 result hashes. Compact numeric usage aggregates and proof timestamps remain
durable, limited to 4,096 actors per workspace. At that limit existing actors
continue updating; new actors have unavailable measurements, not measured zero.
Cleanup and capacity checks are workspace-scoped under the same
transaction lock; a full table does not evict a live run to replenish its budget.
When an inactive run expires, its old run ID may start a fresh budget. Adapters
must use a fresh ID for each real task and preserve it across retries.

Transactions use bounded statement and lock timeouts. The deployment migration
gate requires the new exact marker. Tests include real PostgreSQL races across
independent pools, run-budget persistence, workspace isolation, duplicate
suppression, numeric receipts, and additive readiness.
