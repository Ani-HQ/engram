# Wiring a Surface to engram

Every surface uses the same brain. Mint one token per person, agent, or harness so
the audit log can attribute writes and reads:

```bash
ENGRAM_DB_URL_TEMPLATE='postgresql://...__DB__...' bun cli/engram-admin.ts \
  token issue --name <agent-name>
```

Tokens identify callers only. Any valid token can use the same 10 tools against
the same shared brain.

## Primary Path

Use the shim installer for supported harnesses:

```bash
ENGRAM_HOST='https://<engram-url>' \
ENGRAM_TOKEN='<token>' \
npx @ani-hq/engram-mcp connect <harness>
```

That command writes the MCP config for the target harness and routes local
stdio MCP traffic to `https://<engram-url>/mcp` with the bearer token.

## Manual Fallback

For clients that can send HTTP headers, configure the gateway endpoint directly:

```text
https://<engram-url>/mcp
Authorization: Bearer <token>
```

## Claude Code

```bash
claude mcp add --scope user --transport http engram \
  https://<engram-url>/mcp --header "Authorization: Bearer $ENGRAM_TOKEN"
```

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

Point the connector at `https://<engram-url>/mcp` and set the Authorization
header. Connectors that cannot send bearer headers need a local stdio harness with
the shim.

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

Note the flag takes a **comma-separated** list. Space-separated values are parsed as
further arguments and will swallow your prompt.

This is the most common reason a correctly-wired headless agent appears to ignore
engram: it tried, and was denied.

## Smoke Test Any Wiring

Ask the agent to call engram's `whoami` tool. It should return exactly:

```json
{"token":"<agent-name>"}
```

Then ask it to write a page with `put_page` containing a unique phrase, and ask
another surface to find that phrase with `search`.
