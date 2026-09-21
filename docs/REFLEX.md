# Reflex layer (Jev + Voyage)

engram keeps raw memories as gbrain pages. Jev never writes those pages. It
judges them. Voyage embeddings, when a key is present, make candidate retrieval
semantic. Both providers fail open: a missing or bad key leaves `remember` and
`recall` working the way they did before.

## What is stored where

| Store | Contents |
| --- | --- |
| `brain_shared` | Source pages and gbrain search/embeddings |
| `engram_gateway.memory_entries` | Stable sidecar IDs, fingerprints, live/archive slugs |
| `engram_gateway.reflex_decisions` | Typed Jev sheets (classify, route, pairwise, rerank) |
| `engram_gateway.review_items` | Human-review proposals |
| `engram_gateway.dream_runs` | Nightly job cursor and stats |

Entry IDs are derived from `canonical topic + timestamp + normalized text`.
Rolling a topic page to `*-archive` does not mint a new identity.

## Live path

1. `remember` with an explicit topic still writes there.
2. `remember` without a topic searches a few existing pages and lets Jev route
   only above `REFLEX_MIN_CONFIDENCE`. Otherwise it keeps the dated `notes/` slug.
3. After a successful append, Jev classifies the note and judges a few neighbors.
   Uncertain or conflicting relations become review items. Nothing is deleted.
4. `recall` asks gbrain for 20 candidates, Jev scores them, and five come back.
   Timeouts keep gbrain order.

## Nightly dream cycle

Cloud Scheduler fires the `engram-dream` Cloud Run Job at 03:00 Asia/Kolkata.
The job:

- takes a Postgres advisory lock
- backfills sidecar rows for changed pages
- judges neighbors
- proposes derived clusters under `meta/clusters/...`
- never rewrites `projects/*` bodies

Run by hand:

```
ENGRAM_DB_URL_TEMPLATE=... bun cli/engram-admin.ts dream run
```

or `gcloud run jobs execute engram-dream --region us-central1`.

## Review

The console **review** view lists pending items. Approve may add a link or tag,
write a derived meta page, or mark a sidecar entry superseded. Reject and defer
only change queue state. Source-page deletes stay a human console action.

## Providers

| Env / secret | Role |
| --- | --- |
| `TYPESAFE_API_KEY` / `typesafe-api-key` | Jev decisions |
| `VOYAGE_API_KEY` / `voyage-api-key` | `voyage-4-large` at 1024 dims |
| `REFLEX_MODEL` | default `jev-latest` |

`typesafe-api-key` is mounted as `TYPESAFE_API_KEY` on the Cloud Run service
and the `engram-dream` job. Voyage stays unmounted until a real
`voyage-api-key` exists; a missing Voyage key cannot block main. The nightly
scheduler is applied in the same build (`deploy/setup-scheduler.sh`); a
permission miss there does not block the service deploy.

If the live brain already has a different embedding width, `maybeEnableVoyage`
resizes `content_chunks.embedding` after clearing old vectors, then re-inits
and runs `gbrain embed --stale`. Take a Cloud SQL backup first.

## Rollback

- Unset or rotate the TypeSafe secret: Jev calls no-op, writes/recalls continue.
- Traffic rollback of the Cloud Run service is unchanged.
- Pause the scheduler job to stop nightly proposals.
- Sidecar tables can be left in place; they are derived.
