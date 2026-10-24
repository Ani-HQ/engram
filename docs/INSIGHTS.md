# Private insights

Attention runs read-only checks over up to 200 latest logical actions in the
authenticated workspace, or one explicitly selected activity. Coverage is
returned with every result. It never changes lifecycle state, moves a memory,
blocks a tool, or performs an external action.

## Evidence and interpretation

The local analyzer works without a model, key or external-processing consent:

- Running actions without a receipt for 15 minutes get a **No recent update**
  notice. The outcome stays unknown; this is not a failure verdict.
- Three distinct failed actions for the same tool and resource in 24 hours get
  a repeated-failure notice. This does not establish a shared cause or a retry.
- Identical reports from different agents for the same tool and resource within
  five minutes get a similar-work suggestion, not a verified duplicate verdict.
- Search uses bounded lexical candidates. Extractive handoffs quote reported
  summaries, methods and states with evidence labels and source IDs.

Optional Jev judgments score those candidates and inspect up to four ambiguous
same-resource report pairs. Relations require reported confidence >=0.85 and
search scores require >=0.75. These are provisional abstention thresholds, not
calibrated probabilities. Every suggestion includes action IDs, stable activity
IDs, its rule/model method, and evidence previews. Recorded external actions
remain **reported**; inference cannot upgrade them to observed evidence.

The optional OpenAI Responses adapter can produce a short handoff. It receives
at most eight redacted summaries, states and evidence labels with opaque action
IDs, uses `store:false`, has no tools, and has a 500-token output cap. Unknown
citations, incomplete responses, timeout and errors preserve the extractive
brief. Citation checks establish source linkage, not factual correctness.
Model briefs are labeled; users should inspect their cited reports.

## Queue, consent and bounds

`POST /api/insights` accepts `{q?:string,activityId?:string}` and returns HTTP202
with a durable job. `GET /api/insights?jobId=<uuid>` returns that workspace's job
and completed result; omitting jobId returns its latest activity check. Requests
use the normal console CSRF/workspace pin or authenticated API boundary.
Enqueue requires write permission and hosted entitlement. Reading past results
remains available. A different active request returns409; identical requests
coalesce. Activity checks are capped at ten per workspace per hour.

Jobs are persisted in PostgreSQL with tenant identity, bounded request metadata,
attempt count and conditional lease tokens. Workers use `SKIP LOCKED`, renew
90-second leases, and recover a crashed worker at most three times. Two workers
run per process by default, with an operator maximum of four. A slot remains
occupied until its actual work settles, including a transport that ignores
cancellation; repeated clients cannot create abandoned unbounded inference work.
The visible job fails after60seconds; late results cannot overwrite that state,
while an uncooperative call continues to occupy its actual worker slot.
All failures expose only a generic error. Provider response bodies and request
inputs are never logged.

External AI processing defaults off for every workspace. Server keys are not
consent. Immediately before every actual Jev or brief call, Engram rereads saved
workspace consent and policy, checks hosted entitlement, and atomically reserves
one call from a shared daily PostgreSQL budget. Failed calls also count. Default
budget: 24 calls/workspace/UTC database day. Recall, memory review, dream jobs,
Attention and briefs share it. Normal policy changes cannot retract data already
transmitted; they stop subsequent preflight-approved calls.

Inputs are bounded and credentials, email addresses and URLs are redacted before
serialization. Redaction is best effort; free-form memory text can still contain
private content. Operators must disclose the chosen provider and its retention
terms. `store:false` is not a zero-retention or no-training guarantee. Local
operation remains functional with all providers disabled.

## Models and configuration

`REFLEX_MODEL` defaults to the explicit `jev-1.13.0` version. Production Jev
requests reject aliases such as `jev-latest`; reported model-version mismatches
abstain. Decisions record requested and reported model identity where available,
and whether the provider supplied its identity. Importance and confidence are
separate values. Answers are validated against the requested question type,
choice allowlist, score scale, finite numbers and [0,1] confidence range.

Configuration (server only; never returned by the UI):

| Variable | Default / purpose |
|---|---|
| REFLEX_API_KEY / TYPESAFE_API_KEY | Optional Jev credential |
| REFLEX_MODEL | jev-1.13.0 |
| ENGRAM_INSIGHT_CONCURRENCY | 2, maximum4 |
| ENGRAM_INSIGHT_DAILY_PROVIDER_CALLS | 24, maximum1000 |
| ENGRAM_INSIGHT_TIMEOUT_MS | 6000, maximum15000 |
| ENGRAM_BRIEF_API_KEY | Separate optional OpenAI API key |
| ENGRAM_BRIEF_MODEL | Required explicit date-versioned model; no default |

No unrelated server key is reused for briefs. Recall reranking has a 400ms
caller deadline, one attempt, and aborts the underlying provider request. Its
original deterministic search order survives timeout, invalid answers, missing
consent, exhausted budget or provider failure. In-flight preflight work retains
its client slot until settlement. Memory writes no longer wait for a provider:
`afterRemember` enqueues the committed entry ID, then the background worker
proposes classification and relationships through the existing review queue.
At most32 memory jobs can wait/run per workspace. A post-write queue failure
does not undo an already saved memory and is logged without its content. A
startup/60-second reconciler recovers missed enqueues from active entries created
within24hours, checking at most50 entries per eligible workspace/pass and50
workspaces/pass. Durable per-tenant cursors and unique entry-ID jobs make repeat
scans safe. This is bounded post-commit recovery, not an atomic cross-database
memory/outbox transaction; entries older than that recovery window need explicit
reprocessing after a prolonged outage.
Implicit model-selected topic destinations are disabled; writes use explicit
destinations. Review approval remains governed by workspace policy and preserves
the original evidence/history.

## Evaluation and operations

Run `bun test test/insights.test.ts test/reflex.test.ts test/privacy.test.ts` for
runtime validation, privacy, cancellation, source linkage and queue boundaries.
The guarded disposable PostgreSQL integration invokes
`test/integration-insights.ts` for actual lease recovery, tenant isolation,
stable identifiers, exact concurrent daily budget and consent revocation.

Run `bun test/eval-insights.ts` for a reproducible offline retrieval smoke eval.
It compares lexical ranking against a chronological baseline on six synthetic
labeled queries, including a no-evidence query. It calls no provider and makes
no Jev quality claim. Before claiming production improvement, evaluate a held-out
consented/anonymized corpus for recall@k/MRR, relation precision and false alerts
per thousand actions, confidence calibration/abstention, citation entailment,
latency/cost and review acceptance. Record model pin and question-schema version
with each run; do not equate provider confidence with measured correctness.

Sources: [Typesafe model versions](https://docs.typesafe.ai/models),
[OpenAI Responses migration/storage](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[OpenAI Responses request schema](https://developers.openai.com/api/reference/resources/responses/methods/create).
