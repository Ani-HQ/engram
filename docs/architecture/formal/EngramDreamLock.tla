--------------------------- MODULE EngramDreamLock ---------------------------
(***************************************************************************)
(* Session-level Postgres advisory lock used by the nightly dream cycle.   *)
(*                                                                         *)
(*   tryDreamLock     : gateway/src/dream/lock.ts                          *)
(*   releaseDreamLock : same file, a second dataSql() query                *)
(*   runDreamCycle    : gateway/src/dream/reconcile.ts                     *)
(*   pool             : gateway/src/db.ts  dataSql() → postgres.js pool    *)
(*                                                                         *)
(* pg_try_advisory_lock / pg_advisory_unlock are per backend session.      *)
(* postgres.js returns the connection after each query. lock.ts does not   *)
(* reserve a client, so acquire and release may use different sessions.    *)
(*                                                                         *)
(* SamePool = FALSE  two Cloud Run jobs, two pools (production overlap)    *)
(* SamePool = TRUE   one process, one pool (re-acquire on a leased conn)   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS C1, C2, C3, C4, J1, J2, None
CONSTANTS SamePool

ASSUME SamePool \in BOOLEAN

Connections == {C1, C2, C3, C4}
Jobs        == {J1, J2}

\* Job J1 always uses {C1,C2}. J2 uses the same pair only when they share
\* a process pool; otherwise it has {C3,C4}.
Pool(j) ==
  IF SamePool \/ j = J1 THEN {C1, C2} ELSE {C3, C4}

VARIABLES
  heldBy,      \* connection whose session currently holds the lock
  jobPc,
  jobConn,
  running

vars == <<heldBy, jobPc, jobConn, running>>

JobStates == {"acquire", "work", "release", "done", "skipped"}

TypeOK ==
  /\ heldBy \in Connections \cup {None}
  /\ jobPc \in [Jobs -> JobStates]
  /\ jobConn \in [Jobs -> Connections \cup {None}]
  /\ running \subseteq Jobs

Init ==
  /\ heldBy = None
  /\ jobPc = [j \in Jobs |-> "acquire"]
  /\ jobConn = [j \in Jobs |-> None]
  /\ running = {}

\* SELECT pg_try_advisory_lock(k). Succeeds if no session holds it, or if
\* THIS connection's session already holds it (PG re-acquire).
Acquire(j, c) ==
  /\ jobPc[j] = "acquire"
  /\ c \in Pool(j)
  /\ IF heldBy \in {None, c} THEN
       /\ heldBy' = c
       /\ jobPc' = [jobPc EXCEPT ![j] = "work"]
       /\ jobConn' = [jobConn EXCEPT ![j] = c]
       /\ running' = running \union {j}
     ELSE
       /\ jobPc' = [jobPc EXCEPT ![j] = "skipped"]
       /\ jobConn' = [jobConn EXCEPT ![j] = c]
       /\ UNCHANGED <<heldBy, running>>

Work(j) ==
  /\ jobPc[j] = "work"
  /\ jobPc' = [jobPc EXCEPT ![j] = "release"]
  /\ UNCHANGED <<heldBy, jobConn, running>>

\* SELECT pg_advisory_unlock(k) on a possibly different pooled connection.
\* Unlock against a session that does not hold the lock is a no-op.
Release(j, c) ==
  /\ jobPc[j] = "release"
  /\ c \in Pool(j)
  /\ jobConn' = [jobConn EXCEPT ![j] = c]
  /\ jobPc' = [jobPc EXCEPT ![j] = "done"]
  /\ running' = running \ {j}
  /\ IF heldBy = c THEN heldBy' = None ELSE UNCHANGED heldBy

Next ==
  \E j \in Jobs:
    \/ \E c \in Pool(j): Acquire(j, c)
    \/ Work(j)
    \/ \E c \in Pool(j): Release(j, c)

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

AtMostOneRunning == Cardinality(running) <= 1

LockReleasedWhenIdle ==
  (\A j \in Jobs: jobPc[j] \in {"done", "skipped"}) => heldBy = None

JobsTerminate ==
  <>[](\A j \in Jobs: jobPc[j] \in {"done", "skipped"})

=============================================================================
