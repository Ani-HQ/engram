# Wiring a Surface to engram

Every surface in one organization uses that organization's brain. Mint one token
per agent so the audit log can attribute writes and reads. A token from another
org cannot see these pages. Capture hooks and daily `remember` calls should use a
token from your personal brain so share rules can copy a slice into the team.
See [SHARING.md](SHARING.md).

Create the agent's access token in the signed-in console's **Connections** screen.
Self-hosted operators can also issue one through the owner CLI described in
[SELF_HOSTING.md](SELF_HOSTING.md). Keep database credentials and bearer values
out of command arguments and shell history.

Tokens identify callers and bind them to one workspace and a permission set.
The gateway exposes twelve tools, subject to that connection's scopes and the
workspace's policies. Access to memory does not automatically report tasks.

## Primary Path

Use guided setup for Claude Code, Codex, Cursor, VS Code or Windsurf:

```bash
npx @ani-hq/engram-mcp setup
```

Choose your agent and hosted or self-hosted Engram, then paste its token at the
hidden prompt. Hosted setup defaults to `https://engram.ani.computer`. To choose
the agent or a self-hosted URL directly:

```bash
npx @ani-hq/engram-mcp setup codex
npx @ani-hq/engram-mcp setup claude --host http://localhost:8080
```

Setup calls only `whoami` and `tools/list` before writing the native HTTP config.
If verification fails, the existing config is preserved. Existing config is
backed up before a successful update, other servers are preserved, and files
containing a saved token are restricted to your user. HTTPS is required except
for loopback self-hosting.

Restart or refresh the agent, then paste setup's unique connection-check prompt
into it. The agent performs the memory write and recall; setup itself does not
read memory, write memory, enable capture hooks or invent task reports. The web
setup guide advances from successful agent receipts. Task reporting and inviting
teammates are optional after the core connection, save and recall steps.

The onboarding API retains informational `hasToken` and `hasPage` fields.
`hasPage` means a successful historical page write/read receipt was recorded;
its absence is not a complete inventory guarantee for imported or pre-audit
content. Verified activation uses the separate successful agent checks.

Check an existing native connection without changing configuration:

```bash
npx @ani-hq/engram-mcp doctor codex
```

For noninteractive setup, pipe a token from your secret manager instead of
putting it in a command argument:

```bash
your-secret-reader | npx @ani-hq/engram-mcp setup codex --token-stdin
```

`your-secret-reader` stands for your own secret-manager command. A protected
process environment containing `ENGRAM_TOKEN` is also supported. During release
preparation, test an unpublished checkout with `node shim/index.js setup` from
the repository root; publishing the npm package is a separate release step.

## Manual Fallback

For clients that can send HTTP headers, configure the gateway endpoint directly:

```text
https://<engram-url>/mcp
Authorization: Bearer <token>
```

## Claude Code

```bash
npx @ani-hq/engram-mcp setup claude
```

This writes the native HTTP entry to `~/.claude.json` without passing the token
to a child command. Use `--host` for a self-hosted server.

## Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "engram": {
      "url": "https://<engram-url>/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

## Codex OAuth

For the hosted service, use the canonical endpoint in `~/.codex/config.toml`:

```toml
[mcp_servers.engram]
url = "https://engram.ani.computer/mcp"
```

Then run `codex mcp login engram` and complete the browser sign-in. For a
self-hosted installation, use its configured canonical public URL instead.

Remove an old static `Authorization` entry from this server's `http_headers`
before switching to OAuth: configured authorization headers take precedence
over stored OAuth credentials. A revoked `eng_` key cannot be renewed through
OAuth refresh. Keep bearer-token mode only when deliberately using a current
workspace-bound agent credential.

Use the canonical URL rather than a Cloud Run service alias so the requested
OAuth resource matches the gateway's configured audience. After changing the
configuration, reload the MCP connection; a running desktop session may require
reopening Codex to load the repaired entry. Check `codex mcp list` for OAuth
status, then call Engram's `whoami` from the agent to verify its live connection.

Reference: [official Codex MCP configuration and authentication](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## See connected agents

Open **Connections** in the signed-in web app to see workspace API keys and
OAuth sign-ins, including retired authorizations. It distinguishes issued
access from actual last contact, memory calls and task reports. A sign-in does
not prove the agent is currently working. Engram cannot inspect installation
configuration on other machines, and arbitrary external tool use appears only
when the agent reports it.

The private console endpoint is `GET /api/connections` with
`X-Engram-Console: 1` and the selected `X-Engram-Workspace`. It requires a current
human owner/member session; agent and delegated credentials cannot read it.
The response includes bounded metadata (`connections`, `checkedAt`,
`recentWindowSeconds`, `more`, `limit`), never bearer values, token hashes,
callback URLs or private call contents. `memoryCalls` and `lastMemoryAt` include
attempts; `successfulMemoryCalls` and `lastSuccessfulMemoryAt` identify successful
memory operations separately. `lastSuccessfulContactAt` includes successful
observed calls and accepted task-report events. Task-report event counts include
lifecycle heartbeats rather than counting each as a new task.
No connection inventory is included in public profiles or public streams.

## Stdio-Only Harnesses

Use the `@ani-hq/engram-mcp` shim as the MCP server command:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@ani-hq/engram-mcp"],
      "env": {
        "ENGRAM_HOST": "https://<engram-url>",
        "ENGRAM_TOKEN": "<token>"
      }
    }
  }
}
```

## Custom Connectors

Claude, ChatGPT, and Grok have no bearer-token field. They discover OAuth from a
401 on `https://<engram-url>/mcp`. Point the connector at that URL. Sign in with
the same magic-link email as the console. Opening `/mcp` in a browser is a 405:
MCP is POST only. Cursor and Claude Code can still send `Authorization: Bearer`.

Hosted already has the signing key. Self-host without `ENGRAM_OAUTH_PRIVATE_KEY` keeps those three closed. See [OAUTH.md](OAUTH.md).

## Headless and Unattended Agents

An agent with no human at the keyboard — a fleet worker, a cron job, a bot — must be
granted engram's tools explicitly, or its tool calls are blocked and it will ask a
person who is not there. In Claude Code:

```bash
echo "<prompt>" | claude --print \
  --allowedTools "mcp__engram__recall,mcp__engram__get_page,mcp__engram__search,mcp__engram__list_pages"
```

Add `mcp__engram__remember` and `mcp__engram__put_page` when the agent should write.
Grant reads only where it should not.

Task reporting also requires `mcp__engram__record_action` in the harness allowlist
and a credential with write access. Include `mcp__engram__list_actions` when the
agent should inspect its receipts. Workspace policy and plan limits still apply.

Note the flag takes a **comma-separated** list. Space-separated values are parsed as
further arguments and will swallow your prompt.

## Task reporting

Connectors grant access; they do not intercept the harness's unrelated tools.
Capture hooks upload conversation trails and do not populate Tasks. A live task
feed needs an agent or an explicit harness adapter to send `record_action` for
real work. The web app's **Set up reporting** guide distinguishes reconnect,
read-only access and received report counts; it never treats authorization as
proof of a working agent or an installed adapter.

For each substantive task, the reporting workflow should:

1. Send a running report with the actual task title, a unique `runId`, a stable
   `actionKey`, the real tool/operation and a concise factual current step.
2. Reuse those IDs for progress and the final completed/failed report; use a new
   `eventId` for each change and reuse an event ID only for an identical retry.
3. Report an outcome supported by the work. Keep secrets, private prompts,
   transcripts and hidden reasoning out of task reports. Reports remain
   agent-reported evidence, even when authenticated.

Server initialization supplies these instructions to direct MCP clients and
the repository's stdio connector. Instructions alone are best effort: harness
instructions or an event adapter must actually execute the reporting calls.
Verify the next genuine task reaches Tasks; do not generate dummy work merely
to make a zero counter look active.

If Tasks stays empty, check these in order:

- Run `whoami` from the agent; a saved sign-in alone is not a successful call.
- Confirm its current tool catalog includes `record_action` and `list_actions`.
  A running client may retain an older catalog; refresh/reload the MCP session.
- Verify write permission, OAuth write scope and workspace policy. Read-only
  memory access can work while reporting is denied.
- Check the agent's tool allowlist and reporting instructions. A memory write,
  transcript capture or successful authorization is not a task report.
- Inspect the next real report's response and the same selected workspace's
  Connections report count. Do not hide reporting failures behind a successful
  memory call.

This is the most common reason a correctly-wired headless agent appears to ignore
engram: it tried, and was denied.

## Capture hooks

Capture is an optional, separate choice after the personal token exists. In a
Bash terminal, read it without echoing it or writing its value into history:

```bash
read -r -s -p 'Personal workspace token: ' ENGRAM_TOKEN
printf '\n'
export ENGRAM_TOKEN
ENGRAM_HOST='https://<engram-url>' npx @ani-hq/engram-mcp hooks install <claude|cursor|codex>
unset ENGRAM_TOKEN
```

That writes the harness hook and `~/.config/engram/capture.json`. `capture --sweep` uploads anything the hook missed.

## Smoke Test Any Wiring

Ask the agent to call engram's `whoami` tool. It should return exactly:

```json
{"token":"<agent-name>"}
```

Use setup's printed prompt to save and recall a unique connection-check memory.
For a manual `put_page` check, supply `expected_hash: null` to create only an
absent page; updating an existing page requires its current `content_hash` from
`get_page`. Then ask another connected agent in the same workspace to find the
phrase with `recall` or `search`.
