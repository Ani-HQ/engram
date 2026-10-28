# Agent memory lifecycle

Connecting an MCP server proves access. It does not make a model retrieve or save
memory. Engram separates connection checks, actual retrieval/save receipts, and
runtime-reported work. The optional lifecycle bridge in `shim/memory.js` provides
bounded retrieval and factual reporting without a second model call.

## Guided setup and repair

New and existing users run the same guided command on the actual runtime host:

```sh
npx -y @ani-hq/engram-mcp setup claude
```

Choose the agent in the command or prompt, select an existing project folder,
accept or change its short memory topic, and paste a key at the hidden prompt
when needed. The connection and managed workflow are installed together. No
Markdown or configuration editing is required. `upgrade <agent>` is an
idempotent repair alias; an unchanged successful installation creates no extra
backups. Automation uses `--project .` (or an explicit folder), optional `--topic`
and `--budget`, and a secure environment token or `--token-stdin`.

The installer checks the key again, reuses saved credentials only for the exact
same endpoint, and preflights all configuration before writing. It preserves
unrelated settings, explicit disabled policies and runtime trust controls. A
failed multi-file commit restores files it changed; concurrent user edits and
private backups are preserved. Managed hooks/plugins reference a private
versioned copy of the package under `~/.local/share/engram-mcp/runtimes` (or
`$XDG_DATA_HOME/engram-mcp/runtimes`), so `npx` cache eviction cannot remove them.
Session guidance, bounded context and the Stop delta check all name that copy
through a quoted absolute runtime command. Their decision/no-change/task-end
actions do not depend on a globally installed connector command.

Existing runtime-managed/OAuth connections without a saved bearer are preserved
byte-for-byte. On documented native skill surfaces, guided setup installs a
project memory skill instead of extracting authentication tokens or claiming a
native hook install. Access is then verified through the agent, not the raw HTTP
CLI. `--portable` explicitly selects this model-chosen skill workflow for other
supported local targets. Its ordinary MCP reads keep a per-response limit, with
no claimed hard cumulative task budget. Windsurf receives the portable skill
alongside its factual reporting hooks.

Portable skills default to project scope. Codex also supports the documented
personal skill directory with `--skill-scope user`:

```sh
engram-mcp upgrade codex --project . --skill-scope user
```

That selects portable guidance and installs one managed
`~/.agents/skills/engram-memory/SKILL.md`, leaving the project untouched. Existing
unmanaged skills are preserved. OAuth authentication remains owned by Codex;
the installer neither reads token caches nor replaces the connection. Other
runtime user-scope destinations are rejected until supported explicitly.

Local setup targets include Claude Code, Codex, Cursor, Gemini CLI, VS Code,
Copilot CLI, OpenCode, OpenClaw Gateway and Windsurf. The one-step computer setup
(`npx -y @ani-hq/engram-mcp@latest`) covers Claude Code, Codex, Cursor, OpenClaw,
Hermes Agent, Amp and Devin CLI; [WIRING.md](WIRING.md#primary-path) lists the
files and events it uses for each. `memory install hermes|amp|devin --project`
installs the same hooks for one project folder. VS Code uses `setup vscode`;
Copilot CLI uses `setup copilot`, preserving their distinct MCP configuration
files. Grok Bot is a separate cloud product with app-controlled skills; no
filesystem installation API is assumed. Use its Connect apps and Private skills
controls. Setup does not create a dummy memory, task report, or workflow proof.

Legacy noninteractive `setup <agent>` without `--project` remains connection-only
for compatibility and says so in its output. Interactive setup installs the
project workflow by default. Explicit `--memory` and `upgrade` require a project
outside a terminal. `--connection-only` explicitly opts out of workflow setup.

Automatic project skill locations follow the runtime documentation:
[Claude Code](https://code.claude.com/docs/en/skills),
[Codex](https://learn.chatgpt.com/docs/build-skills),
[Cursor](https://cursor.com/docs/skills),
[Gemini CLI](https://geminicli.com/docs/cli/skills/),
[Copilot/VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills),
[OpenCode](https://opencode.ai/docs/skills/), and
[Windsurf/Cascade](https://docs.devin.ai/desktop/cascade/skills).
Grok Bot's documented [Private skills controls](https://docs.x.ai/grok-bot/skills-routines-and-automations)
are distinct from Grok Build's filesystem skill format.

## Claude Code: explicit installation

Build or install the local `@ani-hq/engram-mcp` 0.5 package first. No user settings
are changed by building the repository. An operator explicitly opts in:

```sh
engram-mcp memory install claude --project /absolute/project --topic "Project architecture"
```

Supply an access token through `ENGRAM_TOKEN`, a hidden terminal prompt, or pipe a
token using `--token-stdin`. Do not put credentials in arguments. `--host` supports
HTTPS or loopback HTTP only. `--budget` accepts 1024–16384 bytes; default 4096.
The budget includes the safety and installed-command wrappers. Retrieval needs
at least 128 bytes left for source context; an exceptionally long runtime path
that cannot fit is skipped instead of exceeding the selected budget.

Installation first verifies identity and tool discovery. It then stores a private
binding in `$XDG_CONFIG_HOME/engram/memory.json` (default
`~/.config/engram/memory.json`) and adds command hooks to
`~/.claude/settings.json`. Other settings and hooks are preserved. Existing files
receive uniquely named owner-only backups. Settings, credentials, and state are
written atomically with mode 0600, with 0700 private directories; symbolic-link
destinations and ancestors are rejected. Restart Claude Code after installing or
upgrading hooks. Once running work is settled, exit and run `claude --continue`
from the same project to resume the conversation. Refreshing MCP connections
alone does not confirm that updated hook commands are loaded. If a Stop message
still shows a bare `engram-mcp memory` command instead of the quoted installed
bridge, check `/hooks` for the command Claude is actually running.

Health checks, reads, and hook requests have a two-second network deadline.
Explicit memory saves have a separate fifteen-second deadline for the confirmed
write receipt; this does not extend native hook execution. A timed-out save can
already have reached the server, so its delivery stays unconfirmed and the bridge
does not replay it. Run status exposes a bounded failure code and attempt time,
without saving the memory text in diagnostics. Older unconfirmed attempts may
have no recorded failure cause.

The installed hooks do not read `transcript_path` or enable the older conversation
capture feature:

| Event | Behavior |
| --- | --- |
| SessionStart (startup/resume/compact/clear) | Brief workflow guidance, no memory request. |
| UserPromptSubmit | The first substantive prompt per session in a bound project gets one targeted recall and a factual running report. Ordinary follow-up messages do not recall again. A recorded task-end allows a later substantive prompt to begin a fresh run. |
| Explicit `Engram task: <name>` or `/engram-task <name>` | Starts a distinct named task in the current session. Reusing a running name reuses its stable run; after an explicit task-end, the same name starts a fresh run. |
| Stop | At most one request to save a meaningful delta or record no-change, only after retrieval and a live access check. `stop_hook_active` suppresses recursion. Offline/denied checks fail open. **Never marks work completed.** |

An explicitly named task should describe the project decision or task, not contain
secrets. The automatic first-task heuristic queries only the installed topic; it
does not forward the full prompt. A model or owned runtime must call `task-end`
with an explicit outcome when it actually knows that outcome. Session guidance,
the bounded recall wrapper, and the one-time delta check teach the exact
`task-end --run <run-id>` command and `status`/`outcome` JSON fields, with completion
or failure conditional on an actual known result. The command hooks
cannot infer completion from a response stopping, or reliably infer every new
task from arbitrary follow-up language. Later task boundaries need an explicit
name or a recorded task-end; the initial prompt heuristic is not an all-task
guarantee.

## Other native runtime adapters

`shim/runtime-contracts.js` declares executable capabilities, supported events,
context outputs, platforms, sources, and limits. Inspect it before installing on
the **actual execution host**:

```sh
engram-mcp memory capabilities cursor
engram-mcp memory install codex --project /absolute/project --topic "Project architecture"
```

Replace `codex` with `cursor`, `gemini`, `copilot`, `opencode`, `openclaw`, or
`windsurf`. Native installers support macOS/Linux and require the documented
hook/plugin API. Alias `vscode` selects the Copilot runtime, not another VS Code
session target. See [agent compatibility](AGENT-COMPATIBILITY.md) for the complete
matrix and explicit verification protocol. Fixture conformance is not live app
certification of every runtime version.

Codex command hooks require local orchestration and execution. Work Cloud
orchestration does not load these local command hooks, including with Local
computer access. Review and trust generated definitions with `/hooks`; a
disabled hooks feature or managed-only policy remains authoritative. The
installer configures files and does not silently grant runtime hook trust.

Cursor/Copilot startup topic prefetch performs a bounded read without inventing
a running task. The first actual task inherits that run and budget. Their prompt
hooks cannot inject context directly; later recall waits for a documented
post-tool output. Only a run marker is held for up to two minutes; no retrieved
memory text is stored for delayed delivery. Cursor startup is fire-and-forget. Windsurf reports factual starts only;
it never injects unsupported context, reads transcripts, or uploads responses.
OpenCode appends reference data to the actual message text; OpenClaw reads only
explicit `currentUserMessage`, never reconstructed history. OpenClaw installation
explicitly enables conversation-access/prompt-injection grants for this plugin.

Installers preserve unrelated settings and memory-provider slots, preflight all
paths, reject symlinks/malformed JSON/unsupported hook versions/explicit disable
policies, and create unique private backups. JSON5 comments need manual/native
configuration; they are not silently stripped. Generated plugins contain module
paths, never tokens. Review project hook files before sharing: absolute local
paths do not configure a cloud host. No native Stop, idle, turn-end, or session
termination event fabricates a completed/failed task. Known outcomes still need
explicit `memory task-end` reporting.

Bindings are scoped to the project and runtime. Installing Codex alongside
Claude preserves each connection's credential and permissions. Commands without
`--run` need `--runtime` when multiple project bindings are present. A known run
selects its original connection; it never switches to another agent's token.
Unlabeled legacy bindings remain Claude-only; explicit `runtime: "generic"`
bindings opt into portable use. The nearest eligible project scope wins, with
an exact runtime preferred over generic within that scope. Ambiguous
configurations require an explicit choice. Existing runtime configuration directory permissions stay
unchanged; dedicated Engram state directories and files remain private.

## Opt-in task metadata on ordinary stdio calls

Native hooks do not alter an unrelated HTTP MCP connection. To propagate task
metadata on ordinary `search`, `get_page`, `list_pages`, `list_actions`, and other
calls through this **stdio connector**, explicitly set
`ENGRAM_MEMORY_PROJECT=/actual/project` on that connector alongside its existing
secure `ENGRAM_HOST`/`ENGRAM_TOKEN` configuration.

The connector requires an endpoint and credential-digest match with the private
binding. It uses one recently active, non-ended private task and preserves caller
task/probe IDs. Multiple active sessions are ambiguous: set a stable
`ENGRAM_MEMORY_SESSION_ID` or explicitly supply an owned `ENGRAM_MEMORY_RUN_ID`.
Otherwise calls stay response-scoped. Tokens never enter metadata. Direct native
HTTP calls keep per-response limits unless that client separately supplies task
metadata. This covers only calls that actually pass through the opted-in stdio
process, not every client or connection.

Clients without a certified native adapter can export portable MCP guidance with
`memory instructions <client>` or `memory skill <client> --output <SKILL.md>`.
Guidance remains model-chosen; only explicit host integration can enforce events.

## Grok Bot: provider-managed skill, honest limits

Grok Bot runs work on a persistent cloud computer and supports skills and
persistent instructions. Its documented integration does not expose Claude-style
task lifecycle command hooks. Its
enterprise inference hooks forward complete conversations and are not used here.
Engram does not edit `~/.grokbot/settings.json` or claim automatic Grok Bot usage.

Use the Grok Bot setup guide in Engram's onboarding or Connections. Copy its
prompt into the Bot that already has the Engram connector and ask it to save the
workflow as a private skill. In the current macOS app, open **Connect apps → Your
plugins → Private skills** to review its name, description, and instructions.
The account library does not show a Bot-specific enable control. In the intended
Bot, ask **“Use Engram shared memory for this task”**, start real work, and check
Engram for actual call receipts. Select it through a skill picker only if that
client offers one; no specific shortcut or private-skill picker is guaranteed.
No Markdown or config editing is needed.

Availability in the shared skill library does not guarantee use in every session.
Its **default path uses the existing connected MCP tools directly**, without a
CLI or local binding: targeted recall once when context is missing, explicit
durable `remember` deltas, and factual start/progress/end `record_action` reports.
It remains a model-chosen workflow. Plain MCP has the server’s default 4096-byte
per-response cap. Cumulative task enforcement requires stable context metadata
from the client or the bridge; prompting alone is best-effort, not a hard cap.
A selected skill or healthy connection does not prove use; actual call receipts do.

The optional CLI path requires `engram-mcp` and a project binding **on the actual
agent/cloud runtime**. Installing or binding it on a Mac does not reach Grok Bot’s
cloud computer. Only if the CLI exists there should an operator explicitly run:

```sh
engram-mcp memory install grokbot --project /actual/runtime/project --topic "Project architecture"
```

Use a hidden prompt or secure environment on that runtime, never credentials in
chat. The installer writes only that runtime’s private Engram binding, not Grok
Bot settings. The skill falls back to the direct MCP path if the CLI is absent.
The bridge’s default cumulative 4096-byte per-task budget applies only where that
bridge is actually running. An owned runtime can wire factual events to the
generic bridge below for stronger lifecycle automation.

## Generic owned-runtime bridge

Bind the project with `memory install generic`, then call the CLI from actual
runtime events. Supply short JSON on stdin, never a conversation transcript.

```sh
engram-mcp memory task-start --runtime my-agent --session stable-session-id --task retry-policy < task.json
```

`task.json`:

```json
{"title":"Implement idempotent retries","query":"background job retry decisions"}
```

The response contains a stable `runId`, `context`, and local delivery status.
Inject **only `context`** into model context. Reporting receipts do not need to
enter it. The retrieved context explicitly labels memory untrusted reference
data, never instructions. Reuse the session/task IDs across compaction or process
restart. Do not start another run for every message. A changed task gets a new ID.
Run the commands from the bound project, or pass `--project` explicitly.

Report meaningful known work stages directly, outside model context:

```sh
engram-mcp memory task-progress --run em_<run-digest> < progress.json
```

```json
{"progressId":"validation-started","currentStep":"Validating repeated delivery"}
```

Each real progress event needs a stable ID and a factual current step. The bridge
keeps the task’s action key and creates a fresh event ID per new stage. Repeating
the same progress ID is deduplicated; changing its payload is rejected. Up to 64
meaningful stages are permitted per task. There are no heartbeat timers or
background progress reports.

Record a model/user-selected durable delta:

```sh
engram-mcp memory decision --run em_<run-digest> < decision.json
```

```json
{"kind":"decision","deltaId":"retry-policy-v1","text":"Retries reuse the request ID so a repeated delivery cannot create another job."}
```

Allowed kinds are `decision`, `correction`, `constraint`, and `handoff`. Text is
bounded to 1200 characters and common credential patterns are redacted before
delivery. Keep it to one or two sentences; redaction is a safeguard, not permission
to send secrets. Identical `deltaId` retries do not resend. A reused delta ID with
different text is rejected. A save is confirmed only by Engram’s success receipt;
an uncertain acknowledgement is never replayed automatically because `remember`
does not have a cross-request idempotency contract. Inspect before deliberately
submitting a new delta after uncertainty. A task permits at most 64 deltas.

When nothing durable changed, call `memory no-change --run <run-id>`. When the
runtime knows the real task outcome, call:

```sh
engram-mcp memory task-end --run em_<run-digest> < outcome.json
```

```json
{"status":"completed","outcome":"Implemented retry handling and verified the relevant checks."}
```

Only `completed` or `failed` is accepted, with an explicit outcome. Do not derive
success from silence, Stop, an idle connection, or a successful memory call.
Lifecycle reports remain **agent-reported** factual events; they are not independent
observation of tool execution. A bridge must only call its hooks for real events.

## Context and delivery budgets

- Default cumulative retrieval budget: **4096 UTF-8 bytes per task**, maximum
  **16384**. Locally measured returned context includes its safety/run wrapper.
  Repeated queries and identical returned responses are suppressed. Additional
  reads stop when the remaining budget is too small. This is not a token bill:
  tool definitions, input arguments, client-added prompts, cached tokens, and
  model output are outside this byte counter.
- Request metadata stays outside tool arguments:
  `params._meta["com.engram/context"] = {runId,maxBytes}`. The stdio proxy preserves
  request/response metadata and structured content. The server also bounds its
  own responses; the bridge clips returned context to the remaining local budget.
  The server receives a stable original run ceiling, not a shrinking per-call
  ceiling. Budget stops, duplicate-recall controls, and unavailable accounting
  receipts are not injected and do not count as retrieved memory. A successful
  empty recall is acknowledged separately without injecting invented context.
- Hook JSON input: maximum 32 KB; upstream response: maximum 64 KB; each lifecycle
  HTTP request: two seconds, redirects rejected. No second LLM call, polling,
  background timer, or retry loop. Installed Claude command hooks have a six-second
  harness timeout and always exit successfully on operational failure.
- Routine reports go directly over HTTP outside model context. A factual
  `record_action` with a lost/transient response may be retried **once on a later
  real lifecycle event**, using exactly the same payload, timestamp and event ID.
  There are at most four pending reports per run. Other errors clear the queue;
  revoked credentials block the old credential’s run and drop pending writes.
  Repairs create a new credential-bound scope, never replay another credential’s
  queued payload.
- Per-run lock/state lives below `$XDG_STATE_HOME/engram-mcp/memory` (default
  `~/.local/state/engram-mcp/memory`). It is scoped to endpoint, credential digest,
  and project. The token is never copied into run files or log output. Concurrent
  calls return `busy` instead of duplicating reports; stale dead-process locks can
  be reclaimed. State survives restart and compaction. It stores hashes/receipts
  and bounded pending factual report payloads, not transcripts or recalled text.
- Read-only connections can retrieve bounded memory. A denied write disables
  further writes for that run without blocking reads; authentication revocation
  blocks the credential-bound run and drops queued writes.

The retrieval ceiling is not an overall token or spending limit. Server guidance,
loaded skills, tool definitions, input arguments and model output add overhead.
Claude's one-time Stop delta check can also request an extra agent continuation
when the task has neither saved a delta nor acknowledged no-change. Saving or
acknowledging no-change before Stop avoids that check; the bridge does not run a
separate summarization model.

Optional Jev passage selection has its own consent, access and metering boundary.
It considers at most 20 local recall hits, removes duplicate content, and sends
at most 16 candidates with up to three existing 180-character passages each.
Both the raw request and the final redacted JSON body, including the model and
questions, fit within 12,288 UTF-8 bytes. A recall uses a 400 ms selection deadline
before retaining the local order. Validated numeric selection plans
can be reused for 30 seconds in the same authorized scope; cached plans do not
store retrieved text. Jev usage is separate from the calling agent's token bill.

The offline duplicate-heavy fixture in `test/reflex-passages.test.ts` reduces
serialized selection input from 18,608 to 6,797 bytes while retaining each known
late decision among candidate passages. That measures synthetic payload shape,
not live Jev relevance, latency, provider tokens or production cost savings.

Use `memory status --run <run-id>` for a run’s receipt state, or
`memory doctor --project /absolute/project` to compare live identity/catalog
access with actual local retrieval and save receipts. Doctor does not invent a
test task or write a dummy memory to make a connection appear active. Historic
receipts prove delivery at their timestamp, not current semantic use by the model.

For an explicit workflow check on an existing private run:

```sh
engram-mcp memory verify begin --run <run-id> --project /absolute/project
# Continue a real targeted read and explicitly save a meaningful decision.
engram-mcp memory verify status --run <run-id> --project /absolute/project
```

Beginning checks identity and obtains a server nonce; it creates no memory or
task report and does not replenish the task budget. Subsequent bridge calls and
matching opted-in stdio calls carry the same integration declaration and nonce.
The check confirms bounded read/save receipts for that connection, run, and
integration within 15 minutes. It never certifies automatic model invocation or
semantic use (`automaticWorkflowVerified` remains `null`). Expired checks are
diagnostic; ordinary work continues without the expired nonce. Read-only
connections cannot pass a save check. No dummy memory or paid model call is used.

## Verification

`test/shim-memory.test.ts` uses real loopback HTTP requests to check a cross-agent
decision handoff, bounded Unicode context, restart/compaction deduplication,
uncertain-write safety, identical event retries, denied credentials, concurrent
events, offline Stop behavior, settings preservation and symlink rejection. No
production account, actual conversation, or private memory is used.

Integration references: [Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Grok Bot skills](https://docs.x.ai/grok-bot/skills-routines-and-automations), and
[Grok Bot enterprise inference hooks](https://docs.x.ai/grok-bot/inference-hooks).
[Grok Bot runtime FAQ](https://docs.x.ai/grok-bot/faq) describes its cloud computer.
