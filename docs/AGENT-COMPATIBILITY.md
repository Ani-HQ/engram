# Agent compatibility

Engram integrates with runtimes, not individual models. The MCP gateway is the
shared memory boundary. Runtime adapters arrange when to retrieve, how to inject
bounded context, and when to report an explicit outcome. A compatible connection
does not prove automatic use or semantic understanding of retrieved text.

## Integration paths

| Runtime | Local integration | Boundary |
| --- | --- | --- |
| Claude Code | Project binding and native command hooks | First substantive task heuristic; later tasks need explicit identity or a known task-end |
| Codex | Native command hooks with local orchestration and execution | Requires hook trust; Work Cloud sessions do not load local hooks, even with a local executor |
| Cursor desktop | Native hooks | Prompt hook output cannot inject context; supported startup/tool outputs deliver it |
| Gemini CLI | Native hooks | BeforeAgent injects context; AfterAgent does not prove task completion |
| Copilot / VS Code Copilot runtime | Native hooks | Context delivery uses supported startup/tool outputs; other session targets have different APIs |
| OpenCode | Local plugin | Existing text parts receive bounded reference context; idle is not completion |
| OpenClaw | Gateway plugin | Explicit plugin grants control conversation access and prompt injection |
| Windsurf / Cascade | Native factual event reporting | No context-injection output contract is claimed; use the portable workflow for retrieval |
| Grok Bot, Cline extensions, Goose and other compatible MCP clients | Portable skill and server instructions | Model-chosen workflow; native automatic behavior is not established by a connection |
| Developer-owned applications | JavaScript/Python SDK and generic CLI bridge | Application supplies stable task IDs, injection points and known outcomes |

These are implemented integration paths tested with synthetic runtime events and
local protocol fixtures. They are not claims that every installed app version,
operating system, cloud edition or enterprise policy has been tested. The
executable registry in `shim/runtime-contracts.js` lists documented events,
injection points, supported installer platforms and limitations. Its
`verifiedDocsAt` records a documentation review, not a live app certification.

Run `engram-mcp memory capabilities` to inspect that registry. Installing is
explicit and preserves unrelated configuration. Review generated hooks/plugins,
their permissions and the project/endpoint before enabling them. See
[the lifecycle guide](AGENT-MEMORY.md) for setup and credential handling. Building
the repository does not modify global agent settings.

## Task context on every read

Every SDK read sends `params._meta["com.engram/context"]` with the same `runId`
and original `maxBytes`. Gateway authorization still derives from the current
credential and workspace. Client-supplied IDs never grant access.

Native hooks tag their bridge retrieval. An explicitly opted-in stdio connector
can propagate the active bound task to ordinary MCP reads. Native HTTP requests
outside that integration remain response-scoped unless the client supplies task
metadata. A lifecycle report's `runId` argument does not set retrieval accounting.
Never describe an unscoped HTTP connection as having a cumulative task budget.

The SDKs preserve task identity, bounded private receipt state and retry safety
across restarts. Tool reports travel outside injected model context. Memory
updates are explicit decisions, corrections, constraints or handoffs; uncertain
saves are not automatically replayed. No adapter uploads transcripts or derives
successful task completion from Stop, idle, stream exhaustion or cancellation.

## Explicit workflow checks

An integration can ask `whoami` to begin a check using request metadata. The
gateway issues a random, fifteen-minute probe bound to the current credential,
workspace, actor, run and full integration declaration. The same scope must
produce a successful delivered memory read and an explicit save to pass. The
server does not create a dummy memory or initiate any write.

Connections show separate access, recall/save receipts, and workflow-check
evidence. Integration identity/version/capabilities are labeled client-declared.
A passed check proves the correlated read/save sequence. It never changes
`automaticWorkflowVerified` from unknown, because MCP requests alone cannot prove
that a model will use memory on every task. Current credential or declaration
changes clear the displayed check association. Private probes and credential
digests never enter public profiles.

## Conformance and real-runtime validation

`test/fixtures/memory-conformance.json` defines the shared acceptance contract:
cross-agent handoff, task metadata on every read, restart deduplication, Unicode
budgets, uncertain-write safety, stable report retries, truthful terminal states,
workspace separation, and receipt-based checks. Language tests exercise actual
HTTP clients. The interop test exchanges decisions between JavaScript and Python
in both directions. Native event fixtures also ensure the setup UI agrees with
the executable adapter registry.

These deterministic checks use synthetic data and no paid model calls. Before
claiming live support for a particular app/version, install on a disposable
runtime and verify a real handoff, task boundaries, resume/compaction, parallel
agents, permission denial and offline recovery. Record the runtime version,
platform and result; keep unknown combinations explicit.

The remote endpoint supports stateless POST/JSON MCP and the connector supplies
stdio. Legacy SSE-only clients need a bridge. Browser-origin clients on another
origin need an appropriate trusted proxy; the endpoint does not advertise
unrestricted cross-origin browser access.
