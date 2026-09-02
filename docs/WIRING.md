# Wiring a Surface to engram

Every surface uses the same brain. Mint one token per person, agent, or harness so
the audit log can attribute writes and reads:

```bash
ENGRAM_DB_URL_TEMPLATE='postgresql://...__DB__...' bun cli/engram-admin.ts \
  token issue --name <agent-name>
```

Tokens identify callers only. Any valid token can use the same 8 tools against the
same shared brain.

## Primary Path

> **Not published yet.** `@ani-hq/engram-mcp` is not on npm, so the `npx` form below
> does not work today. Until it is published, run it from a clone:
> `node path/to/engram/shim/index.js connect <harness>` — same flags, same behaviour,
> and it needs no dependencies installed.

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

## Smoke Test Any Wiring

Ask the agent to call engram's `whoami` tool. It should return exactly:

```json
{"token":"<agent-name>"}
```

Then ask it to write a page with `put_page` containing a unique phrase, and ask
another surface to find that phrase with `search`.
