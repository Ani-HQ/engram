---------------------------- MODULE EngramMemory ----------------------------
(***************************************************************************)
(* Faithful model of engram's memory write/read and MCP routing.           *)
(*                                                                         *)
(* Code map                                                                *)
(*   handleMcp / resolveMcpRouting : gateway/src/index.ts, proxy.ts        *)
(*   suggestTopic (outside lock)   : gateway/src/reflex/write.ts           *)
(*   serializeBySlug               : gateway/src/proxy.ts                  *)
(*   rememberUnsynchronized        : read → put_page → read-back, 3 tries  *)
(*   rollTopicPage                 : rewrites live from savedBody          *)
(*   recall                        : search snapshot of the page store     *)
(*                                                                         *)
(* gbrain put_page is last-write-wins. There is no compare-and-swap.       *)
(* serializeBySlug is per gateway process, keyed by org:slug.              *)
(*                                                                         *)
(* Two writers (agents) append distinct entries to one topic. Each writer  *)
(* is pinned to a Cloud Run instance via SameInstance:                     *)
(*   TRUE  — both share one appendQueue (in-process test)                  *)
(*   FALSE — two replicas, two queues (deploy / multi-instance)            *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS W1, W2, I1, I2, None
CONSTANTS MaxAttempts
CONSTANTS EnableRoll
CONSTANTS SameInstance

ASSUME MaxAttempts \in Nat /\ MaxAttempts >= 1
ASSUME EnableRoll \in BOOLEAN
ASSUME SameInstance \in BOOLEAN

Writers    == {W1, W2}
Instances  == {I1, I2}

InstanceOf(w) ==
  IF SameInstance THEN I1 ELSE IF w = W1 THEN I1 ELSE I2

VARIABLES
  live,        \* entries on the topic page
  archive,     \* entries on *-archive
  lock,        \* serializeBySlug: instance → writer or None
  pc,          \* per-writer program counter
  snap,        \* last get_page snapshot (the RMW prior)
  saved,       \* body observed at successful read-back (roll uses this)
  attempts,    \* 0 .. MaxAttempts
  acked,       \* remember returned {ok: true}
  failed,      \* remember returned the "did not survive" error
  recallHits,  \* last recall / search snapshot
  recallPc

vars == <<live, archive, lock, pc, snap, saved, attempts,
          acked, failed, recallHits, recallPc>>

States == {"route", "suggest", "lock", "read", "write",
           "readback", "roll", "done", "fail"}

-----------------------------------------------------------------------------
TypeOK ==
  /\ live \subseteq Writers
  /\ archive \subseteq Writers
  /\ lock \in [Instances -> Writers \cup {None}]
  /\ pc \in [Writers -> States]
  /\ snap \in [Writers -> SUBSET Writers]
  /\ saved \in [Writers -> SUBSET Writers]
  /\ attempts \in [Writers -> 0..MaxAttempts]
  /\ acked \subseteq Writers
  /\ failed \subseteq Writers
  /\ recallHits \subseteq Writers
  /\ recallPc \in {"idle", "done"}
  /\ acked \intersect failed = {}

Init ==
  /\ live = {}
  /\ archive = {}
  /\ lock = [i \in Instances |-> None]
  /\ pc = [w \in Writers |-> "route"]
  /\ snap = [w \in Writers |-> {}]
  /\ saved = [w \in Writers |-> {}]
  /\ attempts = [w \in Writers |-> 0]
  /\ acked = {}
  /\ failed = {}
  /\ recallHits = {}
  /\ recallPc = "idle"

-----------------------------------------------------------------------------
\* handleMcp: auth + resolveMcpRouting succeed. Header/body conflict and
\* deny are terminal and write nothing; they do not affect this model.

Route(w) ==
  /\ pc[w] = "route"
  /\ pc' = [pc EXCEPT ![w] = "suggest"]
  /\ UNCHANGED <<live, archive, lock, snap, saved, attempts,
                 acked, failed, recallHits, recallPc>>

\* suggestTopic is fail-open and, in remember(), happens BEFORE
\* serializeBySlug. Both writers target the same explicit topic here.

Suggest(w) ==
  /\ pc[w] = "suggest"
  /\ pc' = [pc EXCEPT ![w] = "lock"]
  /\ UNCHANGED <<live, archive, lock, snap, saved, attempts,
                 acked, failed, recallHits, recallPc>>

Acquire(w) ==
  /\ pc[w] = "lock"
  /\ lock[InstanceOf(w)] = None
  /\ lock' = [lock EXCEPT ![InstanceOf(w)] = w]
  /\ pc' = [pc EXCEPT ![w] = "read"]
  /\ UNCHANGED <<live, archive, snap, saved, attempts,
                 acked, failed, recallHits, recallPc>>

ReadPage(w) ==
  /\ pc[w] = "read"
  /\ snap' = [snap EXCEPT ![w] = live]
  /\ pc' = [pc EXCEPT ![w] = "write"]
  /\ UNCHANGED <<live, archive, lock, saved, attempts,
                 acked, failed, recallHits, recallPc>>

\* put_page last-write-wins: the new body is snapshot ∪ {this entry}.
WritePage(w) ==
  /\ pc[w] = "write"
  /\ live' = snap[w] \union {w}
  /\ pc' = [pc EXCEPT ![w] = "readback"]
  /\ UNCHANGED <<archive, lock, snap, saved, attempts,
                 acked, failed, recallHits, recallPc>>

Release(w) ==
  [lock EXCEPT ![InstanceOf(w)] = None]

ReadBack(w) ==
  /\ pc[w] = "readback"
  /\ saved' = [saved EXCEPT ![w] = live]
  /\ IF w \in live THEN
       IF EnableRoll THEN
         /\ pc' = [pc EXCEPT ![w] = "roll"]
         /\ lock' = lock
         /\ acked' = acked
         /\ failed' = failed
         /\ attempts' = attempts
       ELSE
         /\ pc' = [pc EXCEPT ![w] = "done"]
         /\ lock' = Release(w)
         /\ acked' = acked \union {w}
         /\ failed' = failed
         /\ attempts' = attempts
     ELSE IF attempts[w] + 1 < MaxAttempts THEN
       /\ pc' = [pc EXCEPT ![w] = "read"]
       /\ attempts' = [attempts EXCEPT ![w] = attempts[w] + 1]
       /\ lock' = lock
       /\ acked' = acked
       /\ failed' = failed
     ELSE
       /\ pc' = [pc EXCEPT ![w] = "fail"]
       /\ attempts' = [attempts EXCEPT ![w] = attempts[w] + 1]
       /\ lock' = Release(w)
       /\ failed' = failed \union {w}
       /\ acked' = acked
  /\ UNCHANGED <<live, archive, snap, recallHits, recallPc>>

\* rollTopicPage writes archive then live from savedBody, not a fresh
\* get_page. Entries that landed on live after the confirm snapshot and
\* are not in saved[w] are dropped from live and never copied to archive.

RollLive(w) ==
  /\ pc[w] = "roll"
  /\ live' = saved[w]
  /\ archive' = archive \union (saved[w] \ {w})
  /\ acked' = acked \union {w}
  /\ lock' = Release(w)
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<snap, saved, attempts, failed, recallHits, recallPc>>

\* recall's search is a snapshot of the page store. Modeled as one step
\* so a torn search/get_page is out of scope (see findings — suspicion).

RecallSnap ==
  /\ recallPc = "idle"
  /\ recallHits' = live \union archive
  /\ recallPc' = "done"
  /\ UNCHANGED <<live, archive, lock, pc, snap, saved, attempts,
                 acked, failed>>

-----------------------------------------------------------------------------
WriterNext(w) ==
  \/ Route(w)
  \/ Suggest(w)
  \/ Acquire(w)
  \/ ReadPage(w)
  \/ WritePage(w)
  \/ ReadBack(w)
  \/ RollLive(w)

Next ==
  \/ \E w \in Writers: WriterNext(w)
  \/ RecallSnap

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

-----------------------------------------------------------------------------
\* A remember that returned ok still has its bullet on live or archive.
\* This is the promise the read-back comment in proxy.ts is written for.

AckedWritePresent == acked \subseteq (live \union archive)

\* The in-process queue is not orphaned: a held lock belongs to a writer
\* still inside the critical section.

LockOwned ==
  \A i \in Instances:
    lock[i] # None => pc[lock[i]] \in {"read", "write", "readback", "roll"}

\* Two writers on one instance never occupy the critical section together.

InProcessMutex ==
  SameInstance =>
    ~(\E w1, w2 \in Writers:
        /\ w1 # w2
        /\ pc[w1] \in {"read", "write", "readback", "roll"}
        /\ pc[w2] \in {"read", "write", "readback", "roll"})

\* RecallHits is a snapshot taken at search time. Comparing it to a later
\* store is not an invariant (the page can move). It is recorded so a
\* counterexample can show a client holding a snippet for an entry that
\* a later last-write-wins clobber removed. See findings.md.

\* Every remember request reaches a terminal MCP result.

WritersTerminate ==
  <>[](\A w \in Writers: pc[w] \in {"done", "fail"})

=============================================================================
