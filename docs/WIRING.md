# Wiring a surface to engram

Every agent connects to the same endpoint: `https://<engram-url>/mcp` with a
per-agent bearer token. Mint tokens with:

```bash
ENGRAM_DB_URL_TEMPLATE='postgresql://...__DB__...' bun cli/engram-admin.ts \
  token issue --name <agent-name> --scopes shared:rw [--secrets]
```

New/untrusted agents start with `--scopes shared:r` and no `--secrets`.

## Mac — Claude Code
```bash
claude mcp add --scope user --transport http engram \
  https://<engram-url>/mcp --header "Authorization: Bearer $ENGRAM_TOKEN"
```

## Mac — Cursor
`~/.cursor/mcp.json`:
```json
{ "mcpServers": { "engram": {
  "url": "https://<engram-url>/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } }
```

## Fleet VM — OpenClaw agents
OpenClaw agents are Claude Code sessions; one user-scope registration on the VM
covers the whole fleet:
```bash
claude mcp add --scope user --transport http engram \
  https://<engram-url>/mcp --header "Authorization: Bearer $ENGRAM_TOKEN"
```

## Fleet VM — Hermes agents
Per-agent MCP config in each `HERMES_HOME` (url + Authorization header). If the
installed Hermes build lacks header support, use the stdio shim (below).

## ai-holdingco Telegram bot
Same user-scope `claude mcp add` under the bot's VM user — spawned
`claude --print` sessions inherit it.

## ChatGPT / Grok custom connectors
Point the connector at `https://<engram-url>/mcp`. Use a **read-only, no-secrets**
token. If the connector UI can't set an Authorization header, ask for the
path-token route (v1 fallback, `/t/<token>/mcp`).

## Anything stdio-only
The `@ani-hq/engram-mcp` shim (v1) proxies stdio→HTTP via `ENGRAM_HOST` +
`ENGRAM_TOKEN` env vars.

## Smoke test any wiring
Ask the agent: “call engram's whoami tool” — it should report the token name and
scopes you issued. Then: “remember that <fact>” and, from another surface,
“search the brain for <fact>”.
