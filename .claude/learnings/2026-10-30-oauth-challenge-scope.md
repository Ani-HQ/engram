# When MCP sign-ins come out read-only, check the scope in the 401 WWW-Authenticate challenge

**Problem shape:** an agent connected through OAuth (chat connector, Grok Bot, Cursor)
can recall but every save is denied, and reconnecting gives the same result. Other
agents in the same workspace write fine.

**The procedure:**
1. Call `list_actions` with `q: "denied"`. If every denied row has the same
   `oauth:<email>:<client_id>` agent, the cause is that connection's grant, not the workspace.
2. Call `list_actions` with `tool: "remember"` and `status: "completed"`. Recent successes
   from other agents rule out billing (`requireHostedWriteAccess`) and `agentsMayWrite`.
3. Read `wwwAuthenticate()` in `gateway/src/oauth.ts`. MCP clients request exactly the
   `scope="..."` named there. It must equal the authorization server's default grant
   in `parseAuthorize()` (`gateway/src/oauth-as.ts`).
4. Existing grants keep their scope through refresh. After the fix, delete the
   connection in Connections and sign in again from the agent.
5. Do not change the base denial text `denied: <tool> is not allowed for this token`.
   `shim/memory.js` matches it exactly; only append to it.

**Why this works / the trap it avoids:** the authorization server already defaults to
read+write, so the code looks correct. But spec-following clients never omit `scope`:
they copy it from the challenge. Fixing the dashboard toggle or reconnecting does nothing.

**Evidence:** PR #74 (Ani-HQ/engram), 2026-10-30.
