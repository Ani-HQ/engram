# Engram memory and routing — TLC findings

Analysis only. No application code was changed.

The model is `docs/architecture/formal/`. It follows poteto / pstack’s
`create-formal-verification-skill` approach: name a promise the code makes,
model the steps the code actually takes, keep a failing property as a finding,
and show the same property holding on a tighter bound (one replica). The
pstack skill itself is not in this workspace; the spec and TLC configs were
written by hand to that end.

Tool: TLC 2 (tla2tools 1.8.0, rev `606dfa4`), Java 21, 2 workers.
Bounds: two remember writers, two gateway instances, one topic, at most three
append attempts, optional rollover, two dream jobs × two pooled connections
each. Recall is an atomic snapshot of the page store.

## Confirmed

These are invariant violations TLC produced, mapped to code. The property was
not weakened to make the check pass.

### 1. A `remember` that already returned `ok` can still vanish

**Invariant.** `AckedWritePresent` — if remember returned `{ok: true}`, that
entry is still on the live page or the archive.

**Severity.** High. Hosted engram is a stateless Cloud Run service. Multiple
replicas, a console `put_page`, and a deploy overlap are the normal case, not
a stretch. The in-process queue does not cover them. The client is told the
note was saved.

**Code.**

- `serializeBySlug` is a `Map` on the process (`gateway/src/proxy.ts`).
- `rememberUnsynchronized` is read → `put_page` → `get_page`. Success is
  `savedBody.includes(entry)`, then roll, sidecar, `ok`.
- gbrain `put_page` is last-write-wins. There is no compare-and-swap. The
  file says so.

`test/verbs.test.ts` covers two things the queue *does* handle: two appends
in one process, and a clobber *between* `put_page` and read-back. It does not
cover a clobber *after* the success check.

**Counterexample (rollover on, `EngramMemory.cfg`).** First violation at
depth 13. Raw log: `formal/tlc-out/memory-cross-roll.txt`.

| Step | Action | Store |
| --- | --- | --- |
| 1–5 | W1 routes, takes instance I1’s lock, `get_page` → empty | `live = {}` |
| 6–9 | W2 routes on I2, `get_page` → still empty | `snap[W2] = {}` |
| 10 | W1 `put_page` | `live = {W1}` |
| 11 | W1 read-back sees its bullet, keeps `saved = {W1}` | |
| 12 | W1 `rollTopicPage` (rewrite live from `saved`), returns `ok` | `acked = {W1}` |
| 13 | W2 `put_page` of `snap ∪ {W2}` = `{W2}` | `live = {W2}`, `acked = {W1}` |

W1 has already answered `ok`. The page no longer contains W1. W1 will not
retry: the loop is over.

The same invariant fails with rollover off (`EngramMemoryNoRoll.cfg`): W1
acks at read-back (step 11), W2’s stale `put_page` clobbers at step 12.
`formal/tlc-out/memory-cross-noroll.txt`.

**Second shape, same invariant.** A later acked write is wiped by a *stale
roll*. W2 reads `{W1}`, writes `{W1,W2}`, read-back succeeds, returns `ok`.
W1 then runs `rollTopicPage` from an earlier `savedBody = {W1}` and
`put_page`s live back to `{W1}`. W2 is gone after it was acked. TLC reached
that state in the completed space (depth 19 in the `-continue` run). The
live rewrite is `rollTopicPage`’s second `put_page` in `proxy.ts`, which
uses the confirm snapshot, not a fresh `get_page`.

**Control.** The same invariant holds when both writers share one instance
(`EngramMemoryInProcess.cfg`): 232 states generated, 132 distinct, depth 16,
no error, temporal properties checked. That is the `serializeBySlug` the
unit test exercises.

### 2. Dream unlock can miss the session that holds the lock

**Invariant.** `LockReleasedWhenIdle` — after every dream job has finished or
skipped, no connection still holds `pg_try_advisory_lock`.

**Severity.** Medium. The next `engram-dream` on that database skips with
`lock held` until the pooled backend that still holds the session lock is
closed. Source pages are not rewritten; clusters just stop landing.

**Code.**

```5:20:gateway/src/dream/lock.ts
export async function tryDreamLock(): Promise<boolean> {
  const rows = await dataSql()`SELECT pg_try_advisory_lock(${DREAM_LOCK_KEY}) AS locked`;
  ...
}
export async function releaseDreamLock(): Promise<void> {
  await dataSql()`SELECT pg_advisory_unlock(${DREAM_LOCK_KEY})`;
}
```

`dataSql()` is a postgres.js pool (`gateway/src/db.ts`, `max: 3` on an org
database, `max: 5` on `engram_gateway`). Each tagged template checks a
connection out and returns it. Session-level advisory locks stay on the
backend. Unlock on a session that does not hold the lock is a no-op. The
return value is ignored.

**Counterexample (`EngramDreamLock.cfg`, two Cloud Run jobs, two pools).**
`formal/tlc-out/dream-lock.txt`.

| Step | Action | Lock |
| --- | --- | --- |
| 2 | J1 `pg_try_advisory_lock` on C1 | `heldBy = C1` |
| 3 | J1 works (backfill / judge) | still C1 |
| 4 | J1 `pg_advisory_unlock` on C2 | still C1 |
| 5 | J2 `pg_try_advisory_lock` on C3 | skipped |

**Narrower sibling.** On one process / one pool
(`EngramDreamLockSamePool.cfg`), `AtMostOneRunning` fails: J1 acquires on
C1, returns the connection, J2 checks out C1, and `pg_try_advisory_lock`
succeeds because that session already holds it. Two `runDreamCycle` calls
then both believe they are exclusive. The nightly job is sequential per org
and a second Cloud Run execution is a second process, so this needs two
overlapping calls in one process (admin + something else). Confirmed in the
model; uncommon in the current job. `formal/tlc-out/dream-lock-same-pool.txt`.

### 3. No routing deadlock in the bound

**Property.** `WritersTerminate` — every remember reaches `done` or `fail`.
Also `LockOwned` (a held slug lock belongs to a writer still in the critical
section) and `InProcessMutex` (one replica never interleaves two critical
sections on the same slug).

**Result.** No violation.

Cross-replica, ack invariant dropped so TLC could finish
(`EngramMemoryLiveness.cfg`): 1,060 states generated, 662 distinct, depth 22,
temporal properties checked, no error.

The queue is `prior.catch(() => {}).then(work)`. A thrown append does not
block the next. Header/body disagreement is a 400 and never takes the lock
(`resolveMcpRouting` in `proxy.ts`). `ensureBrain` coalesces in-flight starts
and deletes the promise in `finally`.

## Suspicions

Read from the code. Not model-checked. Not counted as TLC results.

| Suspicion | Where | Why it is not a finding |
| --- | --- | --- |
| `upsertMemoryEntry` returns null and remember still answers `ok` without `entry_id` | `memory-entries.ts`, `proxy.ts` | Fail-open is explicit. Dream backfill can rebuild the sidecar. |
| `resolveReview` runs `applySafeAction` then CAS-es `pending` → `applied` | `review/apply.ts` | Two approvers can both apply (duplicate link / meta page). Not in the memory spec. |
| Recall `search` then `get_page` for `full` are two snapshots | `proxy.ts` `recall` | Expected tear under a concurrent write. |
| Archive `put_page` succeeds, live rewrite throws | `rollTopicPage` | Roll is swallowed. Next roll can append the same bullets to the archive. Duplication, not loss. |
| `savedBody.includes(entry)` | `rememberUnsynchronized` | A later page that quotes the exact bullet would false-ack. Unlikely with the ISO stamp. |
| Brain idle evict (default 10 minutes) during a long remember + Jev | `brain.ts`, `config.ts` | Timer is only refreshed in `ensureBrain`, not on each `brainClient()` call. |
| Jev 429 retries increment `consecutiveFailures` | `reflex/client.ts` | Fail-open. Can open the 10-minute circuit faster than a single call’s three attempts. |

## TLC stats

First-fail numbers are what TLC printed when it stopped on the first
violation (queue not empty). Complete-space numbers are a finished search
of the same spec: `-continue` after the violation, or a config that drops
the failing invariant (`EngramMemoryLiveness.cfg`). Depth is the depth TLC
reported for that search.

| Run | Result | First-fail (gen / distinct / depth) | Complete space (gen / distinct / depth) |
| --- | --- | --- | --- |
| `EngramMemory.cfg` (2 replicas, roll on) | `AckedWritePresent` violated | 362 / 209 / 13 | 1,060 / 662 / 22 |
| `EngramMemoryNoRoll.cfg` (2 replicas, no roll) | `AckedWritePresent` violated | 238 / 132 / 12 | 468 / 294 / 17 |
| `EngramMemoryInProcess.cfg` (1 replica) | no error | — | 232 / 132 / 16 |
| `EngramMemoryLiveness.cfg` (2 replicas, no ack invariant) | no error | — | 1,060 / 662 / 22 |
| `EngramDreamLock.cfg` (2 jobs, 2 pools) | `LockReleasedWhenIdle` violated | 36 / 31 / 5 | 97 / 77 / 7 |
| `EngramDreamLockSamePool.cfg` (1 pool) | `AtMostOneRunning` violated | 10 / 10 / 3 | 121 / 75 / 7 |

Fingerprint collision estimates on the completed memory runs were on the
order of 10⁻¹⁴ to 10⁻¹⁶.

Re-run:

```bash
docs/architecture/formal/run-tlc.sh
```

## What this does not cover

- gbrain’s own store, index lag, or `put_page` atomicity inside the child
- Sharing mirrors, OAuth, console review apply
- More than two writers, more than one topic, crashed replicas
- Fairness of real network delay (the model interleaves every step)

A pass is a pass of this model at this bound, not of the whole gateway.
