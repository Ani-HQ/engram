# Optional Jev analysis and embeddings

Engram stores memory in the selected workspace. Jev supplies optional typed
judgments for memory review, recall ranking, activity analysis and trail digest
selection. Missing consent, credentials, budget or a usable provider response
leaves the local storage/search path available. Jev does not generate replacement
source pages or apply its own review proposals.

## Separate controls

`jevProcessing` is an exact-boolean workspace policy, defaulting to `false`.
An owner manages Jev through Workspace settings and the email-session-only
`GET/PUT /api/jev` API. A configured server key alone grants no permission.

The older `externalAiProcessing` policy covers configured Voyage embeddings and
optional OpenAI briefs. It does not enable Jev, and enabling Jev does not enable
either of those providers. `jevMayPropose` separately controls memory/dream
proposals; it is not permission to transmit data or a gate on ordinary recall
ranking. Hosted requests without current write access disable effective optional
processing while retaining the saved preferences.

Hosted customer use also requires an active Cloud subscription, a positive
monthly soft budget and acceptance of the explicitly approved rate version.
Customer billing remains off until its separate operator configuration is
approved. A provisioner can apply an authorized operator-funded default to one
unambiguously selected sole owner: enabled, a $1 USD monthly soft budget,
and no customer charge. This is a scoped, one-time bootstrap, not a default for
other accounts; email-only selection applies to personal workspaces, while an
existing team requires its explicit workspace ID as well. Rerunning the setup
does not undo a later opt-out. See [Billing](BILLING.md).

## What is stored where

| Store | Contents |
| --- | --- |
| Workspace brain database | Source pages and local search data; optional embedding vectors. |
| Workspace data database | `memory_entries`, `reflex_decisions`, `review_items` and `dream_runs`. |
| Central control database | Opaque memory-job identifiers, bounded activity-analysis jobs/results, Jev settings, usage receipts and invoice batches. |

Memory entry IDs derive from canonical topic, timestamp and normalized text.
Rolling a topic page to `*-archive` does not create a new entry identity. The Jev
usage ledger stores task identifiers, models, counts, rates and accounting state;
it does not store provider prompts, memory text, answers or API keys.

## Live and background paths

1. `remember` writes to its explicit topic or the dated notes destination. Jev
   does not choose or move the destination. After a successful save, eligible
   work queues an opaque entry ID for later analysis.
2. The worker checks current Jev consent, proposal permission and access before
   loading the entry. Classification and comparisons with a few neighbors can
   create typed decisions and review proposals. Nothing is deleted automatically.
3. `recall` retrieves up to 20 candidates and returns up to five. Optional Jev
   ranking has a 400ms overall caller deadline; unavailable, low-confidence or
   late results preserve the local search order.
4. Activity checks always have deterministic rules, lexical search and an
   extractive handoff. With separate permission and funding, Jev can judge bounded
   report relationships/relevance. Optional generated briefs retain their own
   provider configuration and the older external-AI consent.
5. Trail digest selection can ask Jev to choose among local heuristic variants.
   The local digest remains available when the provider cannot be used.

`Memory → Review proposals` and the authenticated `/api/review` endpoints expose
the queue. Approving may add a link/tag, write a derived meta page or mark a
sidecar entry superseded. Rejecting or deferring changes queue state. Existing
authenticated page deletion/restoration is separate from proposal handling.

## Nightly dream cycle

The separately configured `engram-dream` job runs at 03:00 Asia/Kolkata. It skips
workspaces without Jev consent, proposal permission, a supported configured model
or hosted write access. It takes a workspace database advisory lock, backfills
sidecar entries, judges neighbors and proposes derived `meta/clusters/...`
organization for review. It does not rewrite `projects/*` bodies.

The local admin command is `bun cli/engram-admin.ts dream run`; it requires the
deployment's complete database/provider configuration. Hosted job execution and
scheduling are explicit operator actions. See [Release](RELEASE.md).

## Provider configuration and data

| Setting | Role |
| --- | --- |
| `JEV_API_KEY` | Canonical server-only TypeSafe key; self-hosters supply their own. |
| `REFLEX_API_KEY`, then `TYPESAFE_API_KEY` | Legacy fallbacks when earlier keys are blank or `unset`. |
| `REFLEX_MODEL`, then `TYPESAFE_MODEL` | Default `jev-latest`, the stable provider alias. An exact `jev-x.y.z` version can be configured if available to the account. Preview and unknown aliases are rejected. |
| `REFLEX_ENDPOINT` | Hosted endpoint is pinned to `https://api.typesafe.ai/v1/systemone`; explicit self-host overrides require HTTPS, with HTTP allowed only on loopback. |
| `ENGRAM_INSIGHT_DAILY_PROVIDER_CALLS` | Shared durable daily attempt allowance, default 24, capped at 1,000. |
| `VOYAGE_API_KEY` | Optional embeddings under the separate external-AI policy. |

Hosted Jev credentials are bound only to the gateway and dream job, not tenant
memory processes, mail, billing-export or provisioner jobs. Hosted transmission
never follows redirects. Inputs are bounded and redacted, and response bodies
are bounded; this reduces exposure but does not guarantee removal of all
sensitive information. Relevant memory snippets, query context, activity reports
or trail context can still reach TypeSafe when the corresponding work is enabled.

The client requires actual reported token counts and an accepted reported model.
TypeSafe's [model catalogue](https://docs.typesafe.ai/api/list-models) lists the
names available to a key; its API allows a response model to differ from a
requested alias. For `jev-latest`, Engram accepts a reported `jev-latest` or exact
`jev-x.y.z` version. An explicitly requested version must be returned unchanged.
The stable alias can change underlying versions: it does not pin weights, and a
response containing only the alias does not reveal the underlying version.
Engram records the requested and reported strings separately without inventing
a resolved version. The same disclosed token rate and consent/budget rules apply.

Hosted usage is settled before answer validation, so unusable answers can still
represent real provider work. Missing/malformed usage, preview or unknown model
names, and exact-version mismatches do not become customer charges. Hosted calls
have one transmission attempt. Stable
operation IDs prevent replaying the same queued/dream operation after a crash;
cached results do not cause a new provider call or a new usage charge.

TypeSafe documents the [System One API](https://docs.typesafe.ai/api/system-one),
[token usage](https://api.typesafe.ai/openapi.json) and
[request/error behavior](https://docs.typesafe.ai/api/errors). Its
[data-handling notice](https://help.typesafe.ai/articles/5974925716-how-is-submitted-data-used-or-retained)
says customer requests/responses are not used to train Jev; retention and
deletion depend on applicable terms and any agreed zero-data-retention
arrangement. Engram does not infer that such an arrangement exists for its key.

Voyage embedding-width changes remain a separate maintenance operation:
`maybeEnableVoyage` can clear old vectors, resize the embedding column and
re-embed stale content. Take a verified backup before an approved change.

## Disabling and recovery

Turn off Jev in Workspace to deny future Jev reservations. Removing the server
key also disables new calls. Pause dream scheduling to stop its background work.
Previously stored decisions/proposals are retained, and disabling processing
does not erase data already sent to a provider. Keep usage and invoice receipts
for reconciliation; do not replay ambiguous operations or delete accounting
records to force another attempt. See [Privacy](PRIVACY.md) and [Billing](BILLING.md).
