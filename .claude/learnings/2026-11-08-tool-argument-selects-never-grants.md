# A tool argument that picks a tenant must only select among stored grants

**Problem shape:** an agent connection is bound to one workspace, and people
want it to reach other workspaces too, without breaking the rule that a tenant
is never chosen from an untrusted request parameter.

**The procedure:**
1. Store the grant server-side, created only from a live human console session
   (`connection_workspace_links`: home org, actor kind + name, target org,
   exact target membership id, granting email).
2. The tool argument (`workspace: "<slug>"`) only looks up this credential's
   existing grants. Unknown, unlinked, stale and disabled targets return one
   identical error, so probing reveals nothing.
3. Re-check on every call: the exact membership id still exists for that email
   (rejoining makes a new id, so old grants don't revive), the granter still
   owns the home workspace, and the target's policy still allows it.
4. Run the call inside the target with a derived, write-less identity
   (`linked:<actor>`, role agent, canWrite false, same OAuth scopes), and
   refuse the argument on write tools before reaching the tool.
5. For cross-workspace sharing of private memory, reuse the existing
   review-and-commit path instead of granting reads, so only owner-reviewed
   excerpts ever leave.

**Testing traps:**
- A new gateway table needs its own readiness marker (see
  2026-10-30-additive-table-needs-its-own-readiness-marker.md).
- If the visible Chrome tab refuses scripts with "Cannot access a
  chrome-extension:// URL of different extension", another extension has
  hooked the page. Switch to headless Chrome over CDP
  (2026-10-27-mobile-ui-checks-with-headless-cdp.md) instead of retrying.
- After changing a CREATE TABLE, rerun the Postgres suites on a fresh
  container; `IF NOT EXISTS` hides the change on a reused one.

**Evidence:** engram PR #92, 8 Nov 2026.
