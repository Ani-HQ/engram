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
