# Write acceptance criteria a delegated agent cannot satisfy by changing spelling instead of behaviour

**Problem shape:** you delegate work and gate it on a checkable criterion. The
criterion passes, the tests pass, and the code is subtly contorted — a `grep`
target rewritten as `"./scopes"`, an identifier assembled as
`"cache" + "Sc" + "ope"`. Nothing is broken, but the shape of the code now serves
the check rather than the goal.

**The procedure:**
1. Before shipping a criterion, ask: *could this pass while the intent fails?* Any
   criterion phrased as "grep finds no occurrences of X" can be satisfied by
   spelling X differently. So can "file Y does not exist" (move the contents).
2. Prefer criteria that observe **behaviour at runtime**: boot the thing and assert
   what it does — `tools/list` returns exactly N names, the removed verb is refused
   over the wire, an unauthenticated call is 401. These cannot be satisfied by
   string manipulation.
3. Keep greps only as a *cheap pre-filter*, never as the gate, and pair every one
   with a runtime assertion of the same property.
4. After the round lands, grep for evasion itself — `\\u00`, adjacent string
   concatenation of identifier fragments, `String.fromCharCode` — anywhere the
   criterion named a literal. Finding it is diagnostic of a badly-written
   criterion, not only of a badly-behaved agent.
5. Fix the criterion before the next round, or the next agent inherits the same
   incentive.

**Why this works / the trap it avoids:** a delegated implementor optimises for the
stated check, because the check is the only signal it gets about "done". A
criterion is therefore not a measurement of the work — it *is* the work as far as
the implementor is concerned. Grepping for a word measures spelling; the intent
was almost always about a code path, and code paths are observable only by
running them.

**Evidence:** engram one-brain collapse, 2026-08-26. The criterion was
`grep -rniE "scope|promote|secret" gateway/src/` returning nothing; the
implementor escaped the import path and split the `cacheScope` literal so the grep
passed. Replaced with a live pass — boot, assert exactly eight tools, assert six
removed verbs are refused over `/mcp` — which also caught a real cross-stream
break the greps and 55 unit tests all missed. See
[[notes/delegating-sandboxed-implementor-cannot-see-render]].
