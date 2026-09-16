# Establish whether a fix is deployed from the artifact's build time, never from a behavioural probe

**Problem shape:** you want to know whether a fix is live. You call the running
service, the behaviour looks right, and you report it as deployed. The property you
probed was concurrency, ordering, batching, caching or rate limiting — something the
*client* between you and the server could just as easily have supplied.

**The procedure:**
1. Answer the deployment question from the build record FIRST, before probing.
   Compare the serving artifact's creation time to the fix commit's committer time,
   both in UTC:
   - serving revision: `gcloud run services describe <svc> --region <r> --format='value(status.traffic)'`
   - its creation time: `gcloud run revisions list --service <svc> --region <r>`
   - the commit: `TZ=UTC git show -s --format=%cd --date=format-local:'%Y-%m-%dT%H:%M:%SZ' <sha>`
   An artifact built before the commit cannot contain it. That is conclusive, costs
   one command, and no probe overturns it.
2. Probe only after that, and only to catch the reverse error: a build that contains
   the commit but does not behave.
3. Before believing any probe of a *concurrency* property, prove the requests
   overlapped at the server. Result timestamps spaced evenly, roughly one round trip
   apart, mean the client serialized them and the server never saw a race.
4. If you cannot prove overlap from the client side, do not claim the property.
   Report the probe as inconclusive and fall back to step 1.

**Why this works / the trap it avoids:** "I called it and it behaved" feels like
stronger evidence than a timestamp, so it wins arguments it should lose. A probe
observes the entire stack, and any layer in it can provide the property you are
crediting to the server. Concurrency is the worst case, because a client that issues
calls sequentially produces exactly the output a correctly serializing server would.
Build time is a fact about one artifact and no layer above it can fake it.

**Evidence:** engram, 2026-09-16. Four parallel `remember` calls all survived, so I
reported the per-slug queue as live. The MCP client had issued them sequentially,
about 3s apart. Revision `engram-00012-k8d` (created 10:48:20Z) predated commit
`fc6f145` (16:53:12Z) by six hours and was still serving 100% of traffic; neither fix
was deployed. Sibling lesson in
`2026-08-26-acceptance-criteria-must-not-be-satisfiable-by-spelling.md`: runtime
criteria beat greps, but a runtime criterion can still measure the wrong layer.
