# @ani-hq/engram-mcp

One-command MCP harness connector and stdio-to-HTTP proxy for engram.

## Install

```bash
npm install -g @ani-hq/engram-mcp
```

## Environment

`ENGRAM_HOST` is the base URL of your engram gateway, for example
`https://engram.example.com`.

`ENGRAM_TOKEN` is the bearer token issued for this harness.

The stdio proxy uses both variables when an MCP client launches `engram-mcp` with
no subcommand.

## Connect a Harness

```bash
engram-mcp connect <harness> --host https://engram.example.com --token tok_...
```

`--host` and `--token` can be omitted when `ENGRAM_HOST` and `ENGRAM_TOKEN` are
set. A missing host or token exits non-zero and does not write any config.

List supported harnesses and target paths:

```bash
engram-mcp connect --list
```

Running `engram-mcp connect` with no harness prints the same list.

Every file write first copies the existing config to `<file>.engram-backup`.

## Cold Starts

engram runs scale-to-zero, so an idle service is asleep and the first request pays a
full container start. That is longer than a harness allows an MCP server to come up,
and the harness reports it as a server that failed to connect.

The proxy answers `initialize` locally, so `tools/list` is the only network call in
the handshake. It is served from a cache at
`$XDG_CACHE_HOME/engram-mcp/tools-<host>.json` and refreshed behind the reply, which
means a sleeping engram is invisible at startup. The wake-up lands under the first
real tool call instead, which is far more patient, and `connect` fills the cache up
front so even a first run is instant.

The proxy also pings `/health` when it starts, so the container is waking while you
are still typing. Set `ENGRAM_TIMEOUT_MS` to change the per-request ceiling, which
defaults to 90 seconds.

## Supported Harnesses

`claude` registers engram through the Claude Code CLI:

```bash
claude mcp add --scope user --transport http engram https://engram.example.com/mcp --header "Authorization: Bearer tok_..."
```

If the `claude` binary is missing, `engram-mcp connect claude` prints the command
to run by hand.

`codex` writes `~/.codex/config.toml` under `[mcp_servers.engram]`.

`cursor` writes `~/.cursor/mcp.json` under `mcpServers.engram`.

`vscode` writes the user MCP config:

- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Linux: `~/.config/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`

VS Code uses `servers.engram` with `type = "http"` semantics in JSON.

`windsurf` writes `~/.codeium/windsurf/mcp_config.json` under
`mcpServers.engram`.

## Stdio Proxy

For stdio-only clients, configure the installed binary:

```json
{
  "mcpServers": {
    "engram": {
      "command": "engram-mcp",
      "env": {
        "ENGRAM_HOST": "https://engram.example.com",
        "ENGRAM_TOKEN": "tok_..."
      }
    }
  }
}
```
