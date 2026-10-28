# @ani-hq/engram-mcp

One-command MCP harness connector and stdio-to-HTTP proxy for engram.

## Connect this computer

Run this in your terminal:

```bash
npx -y @ani-hq/engram-mcp@latest
```

It finds Claude Code, Codex and Cursor on this computer, including their
desktop apps, and opens your browser. Check that the code matches, click
Approve, and each agent is connected with its own access key. Engram then works
in every repository on this computer: the project is taken from the git
repository the agent is working in, and nothing is written into project
folders. Restart any agent that was already open. Codex asks once before it
runs new hooks; run `/hooks` in Codex and approve Engram.

For a self-hosted server, add `--host https://your-engram.example`.

## Per-agent setup

To set up one agent or one project folder instead, name the agent:

```bash
engram-mcp setup claude
engram-mcp setup codex
engram-mcp setup cursor --host https://engram.ani.computer
```

Choose an existing project folder, a short memory topic, and Engram hosted or
your self-hosted server, then paste an access token from the workspace's
**Connections** screen at the hidden prompt. The token is not echoed or included
in your command history. A binding for a specific project folder takes priority
over the computer-wide one.

Setup checks live token identity and tool discovery before installing the MCP
connection and the project memory workflow together. You do not edit Markdown or
configuration files. If a check or configuration preflight fails, setup leaves
the agent config unchanged and explains the next action. The endpoint must
use HTTPS; HTTP is accepted only for a loopback self-hosted server.

On success, setup shows the exact paths, backs up changed existing files, and
updates the Engram entry and managed memory hooks/plugin. Other agent servers and settings are preserved. Config
and backup files are private to your user; existing owner-only permissions are
preserved, and group/world access is removed when a token is saved. Existing
backups are retained. Symbolic-link config files are rejected so a token is not
written into a linked dotfiles repository.

Hook code is copied into a private versioned runtime under
`$XDG_DATA_HOME/engram-mcp/runtimes` (default `~/.local/share/engram-mcp/runtimes`).
It keeps working if `npx` clears its cache. No transcript capture is enabled.
Native guidance points to that exact executable with a quoted absolute command;
decision, no-change and known-outcome reporting do not require a global
`engram-mcp` binary in `PATH`.
Setup preflights every destination, commits files atomically, and restores files
it changed if a later write fails. A concurrent user edit is preserved and
reported instead of being overwritten during recovery.

Restart or reload your agent after updating its memory workflow. For Claude Code,
settle running work, exit, and run `claude --continue` in the same project to
resume with the updated hooks. Refreshing MCP alone does not confirm the hooks
are loaded. Codex still requires native
hook review and trust through `/hooks`; managed or disabled policy is preserved.
Setup itself never reads or writes memories or reports a task on your behalf.
Run a real task, then review retrieval/save receipts in Connections → Memory use.
Access checks and installed files do not prove automatic model use.

Explicit memory saves wait up to fifteen seconds for a receipt; quick reads and
hook checks keep their two-second network deadline. A timeout is reported as an
unconfirmed save, not proof that Engram is offline. The bridge retains only the
attempt time and a bounded failure code for diagnostics and never automatically
replays an unconfirmed memory write.

Existing users run the same command, or `engram-mcp upgrade <agent>`. An existing
key is reused only for the same endpoint and is checked again before any write.
An existing runtime-managed/OAuth connection without a saved bearer is preserved;
setup installs the packaged project skill instead of copying authentication
tokens or replacing that connection. CLI access remains unchecked in that mode.
The skill is model-chosen guidance, with no hard cumulative task-budget claim.
Use `--portable` to choose that skill workflow explicitly on a supported runtime.
Skills default to project scope. Codex users can choose
`engram-mcp upgrade codex --project . --skill-scope user` to install one managed
personal skill at `~/.agents/skills/engram-memory/SKILL.md` instead. This selects
portable guidance, leaves project files unchanged, and preserves any existing
unmanaged skill. Automatic user scope currently supports Codex only.

Supported local targets are `claude`, `codex`, `cursor`, `gemini`, `vscode`,
`copilot` (Copilot CLI), `opencode`, `openclaw`, and `windsurf`. Run setup on the
actual runtime host; a Mac install cannot configure a cloud Bot. Grok Bot uses
its own Connect apps and Private skills controls, not a local filesystem path.

## Check a connection

```bash
engram-mcp doctor codex
engram-mcp doctor cursor
engram-mcp doctor --host https://engram.ani.computer
```

With an agent name, `doctor` reads the native HTTP connection from that agent’s
user config. Without one, it uses the hidden token prompt or `ENGRAM_TOKEN`.
`verify` is an alias for `doctor`. These commands call only `whoami` and
`tools/list`, do not change config or cache files, and never read stored memories
or perform a write. Successful discovery proves live identity and catalog access;
it does not prove that your agent has loaded its config, or that a memory write
will be permitted by workspace policy or billing. Use the printed test prompt
from the agent to verify the full journey.

The separate lifecycle command `memory verify begin|status --run <known-run-id>`
starts or reads an explicit server-issued workflow check. Beginning the check
writes no memory or task report; real later bounded reads and explicit decision
saves on that run supply the receipts. Checks expire after 15 minutes and never
prove automatic model use. See [memory lifecycle](../docs/AGENT-MEMORY.md).

## Opt-in memory lifecycle

MCP access alone does not ensure an agent uses shared memory. Version 0.5 adds
an explicit project-scoped lifecycle bridge:

```bash
engram-mcp memory install claude --project /absolute/project --topic "Project architecture"
engram-mcp memory doctor --project /absolute/project
```

Installation verifies access, backs up existing settings, and adds lightweight
Claude Code command hooks. It retrieves targeted context for the first substantive
prompt per session, deduplicates calls across restart/compaction, and limits returned memory
to 4096 UTF-8 bytes per task by default (configurable up to 16384). Decisions and
handoffs are saved only through explicit structured `memory decision` events.
There is no transcript capture, second model call, or per-message recall. A Stop
notification never marks a task completed. Operational failures do not block work.
Later task boundaries need an explicit `Engram task: <name>` prompt or a recorded
task-end; arbitrary natural-language task changes are not reliably inferred.

Native opt-in installers also cover `codex`, `cursor` (desktop), `gemini`,
`copilot` (the VS Code Copilot runtime/CLI), `opencode`, `openclaw`, and `windsurf`.
Run `engram-mcp memory capabilities <runtime>` to inspect the exact surface and
limitations. Install on the actual runtime host, then reload it. Windsurf reports
factual lifecycle events only. Cursor/Copilot prompt hooks cannot inject context
directly; their adapters use documented startup/post-tool outputs instead.

Clients without a certified native adapter can export portable MCP guidance:

```bash
engram-mcp memory instructions goose
engram-mcp memory skill cline --output /absolute/review/engram-memory/SKILL.md
```

Instructions alone are best-effort. Native HTTP MCP calls receive per-response
limits unless their client sends task metadata. To propagate metadata on ordinary
model reads through the **stdio connector**, explicitly set
`ENGRAM_MEMORY_PROJECT=/actual/project` on that connector. Endpoint and credential
must match the private binding. Ambiguous sessions need an explicit
`ENGRAM_MEMORY_SESSION_ID` or owned `ENGRAM_MEMORY_RUN_ID`; otherwise calls stay
response-scoped. Caller task/probe IDs take precedence. See
[agent compatibility](https://github.com/Ani-HQ/engram/blob/main/docs/AGENT-COMPATIBILITY.md)
for implemented surfaces, fixture checks, and remaining real-app validation.

Grok Bot has an included skill workflow, with honest best-effort status:

```bash
engram-mcp memory instructions grokbot
engram-mcp memory skill grokbot --output /absolute/review/engram-memory/SKILL.md
```

Review and enable the skill in Grok Bot. Its default path uses an existing MCP
connection without a CLI or local binding. Plain MCP has the server’s 4096-byte
per-response default; cumulative task budgets need client context metadata or
the bridge. The skill remains best-effort agent guidance.

Grok Bot works on a persistent cloud computer. A CLI installed on your Mac does
not configure that cloud runtime. Only if the CLI is installed on the actual
agent runtime should you bind its project there using `memory install grokbot`.
Do not supply credentials in chat. This optional installer writes only that
runtime’s private Engram binding; it does not edit Grok Bot settings or install
native hooks. Owned runtimes can use `memory task-start`, `task-progress`,
`decision`, and `task-end` directly on factual lifecycle events. `memory doctor` distinguishes
connected access from actual retrieval/save receipts; returned bytes are measured
context, not a model token bill. See
[the lifecycle contract](https://github.com/Ani-HQ/engram/blob/main/docs/AGENT-MEMORY.md)
for setup, the generic bridge protocol, private state, retry limits, and caveats.

## Automation and environment

`ENGRAM_HOST` is the base URL of your engram gateway. Guided setup and doctor
default to `https://engram.ani.computer` when it is omitted.

`ENGRAM_TOKEN` is the bearer token issued for this harness.

The stdio proxy uses both variables when an MCP client launches `engram-mcp` with
no subcommand.

For noninteractive setup, specify an agent and supply `ENGRAM_TOKEN` securely
through your process environment, or pipe the token with `--token-stdin`:

```bash
your-secret-reader | engram-mcp setup codex --project . --host https://engram.ani.computer --token-stdin
```

`your-secret-reader` stands for your own password/secret manager command. Setup
and doctor reject `--token` arguments to keep credentials out of history. Missing
input outside a terminal exits with an actionable error and does not wait for a
prompt.

Outside a terminal, `--project` selects full setup and `--topic` defaults to the
project folder name. `--memory` and `upgrade` require an explicit `--project`
there. Legacy noninteractive `setup <agent>` without a project remains
connection-only; its output states that no memory workflow was installed.
`--connection-only` chooses that behavior explicitly.

## Existing connect command

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

The existing `connect` command remains available for scripts. It writes config
before attempting discovery, so its success alone does not prove live access.
Prefer `setup` for guided, verified onboarding. Every file write first copies the
existing config to `<file>.engram-backup`; later backups get unique suffixes.

## Cold Starts

engram runs scale-to-zero, so an idle service is asleep and the first request pays a
full container start. That is longer than a harness allows an MCP server to come up,
and the harness reports it as a server that failed to connect.

The proxy answers `initialize` locally with the same bounded memory and task-reporting
instructions as the HTTP gateway. No upstream response is needed for initialization.
These instructions ask the agent to report real work; connecting does not capture
other tools automatically or backfill old tasks.

`tools/list` prefers a fresh upstream catalog. When a cached catalog exists, it waits
up to 750 ms for the fresh result before using the cache. A later change sends the
MCP tool-list-changed notification so supporting clients can refresh in the same
session. Without a cache, discovery needs the upstream response and remains bounded
by `ENGRAM_TIMEOUT_MS`. A failed discovery can refresh again after a successful real
tool call. An explicit upstream authorization rejection removes that credential's
disk cache and is returned, rather than presenting cached tools as current access.
If a fallback list was already shown, one change notification clears it to an empty
catalog marked `authorization_required`; reconnect after repairing access.

Catalogs live at `$XDG_CACHE_HOME/engram-mcp/tools-v2-<digest>.json` (or under
`~/.cache`), keyed by the endpoint and credential together. Bearer values are never
written to the catalog or filename; files are replaced atomically with mode 0600.
Old host-only caches are ignored. `connect` seeds the new cache when the service is
reachable. Clients that do not honor tool-list changes may still need a reconnect.

The proxy also pings `/health` when it starts, so the container is waking while you
are still typing. Set `ENGRAM_TIMEOUT_MS` to change the per-request ceiling, which
defaults to 90 seconds.

Automatic retries require an explicitly idempotent operation. Tool calls, including
task reports, do not retry automatically after an uncertain response or HTTP error;
an error status cannot establish that a write was not applied. For an uncertain
`record_action` delivery, an agent may retry the identical payload with its original
`eventId` so the gateway can deduplicate it.

## Supported Harnesses

`claude` registers engram through the Claude Code CLI:

```bash
claude mcp add --scope user --transport http engram https://engram.example.com/mcp --header "Authorization: Bearer tok_..."
```

`connect claude` requires the Claude Code CLI. Guided `setup claude` writes the
native HTTP entry to `~/.claude.json` directly and does not need to pass a token
to a child command.

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
