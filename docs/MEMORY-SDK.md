# Owned-runtime memory SDKs

The JavaScript/TypeScript and Python SDKs connect Engram to an application's
actual task lifecycle independently of its model provider. They do not inspect
transcripts, auto-detect task success, or enable themselves in third-party apps.
The gateway remains the authority for workspace access, versioned writes,
idempotent action events and cumulative response budgets.

## Local packages

These are repository source packages; this change does not publish them to npm
or PyPI or install them into users' runtimes.

```sh
npm install ./sdks/javascript
python -m pip install ./sdks/python
```

The Node SDK uses built-in modules and `fetch`; the Python SDK uses the standard
library and async entry points. Neither brings a model SDK or starts a second
model. Framework dependencies are optional and loaded only by the corresponding
adapter factory. This is runtime integration, not a separate integration per
model brand.

## Stable task contract

Construct a memory client with the explicit HTTPS Engram host and token through
a secure environment or constructor. HTTP is allowed only for loopback testing.
Credentials never go into command arguments, state filenames or SDK error text.
The client rejects redirects rather than forwarding a bearer to another host.
Hostnames must be canonical ASCII, using their `xn--` punycode form for an
international domain; percent-encoded hostnames are refused. Unicode URL paths
are percent-encoded consistently. This avoids differing JavaScript/Python IDNA
rules sending a credential to different hosts. Embedded whitespace, controls and
backslashes are rejected before URL parsing.

The ordinary `/mcp` and read-only `/mcp/shared` endpoint suffixes are preserved.
A scoped-share endpoint automatically disables every write; its server enforces
the approved snapshot boundary and per-response cap, while the SDK also enforces
the local cumulative task budget. Action history and workflow read/save
verification are unavailable on scoped shares.

For an ordinary read-only credential, set `canWrite:false` in JavaScript or
`can_write=False` in Python. `reporting:false` / `reporting=False` disables
lifecycle reports while allowing explicitly requested decisions if permitted.
Both modes still perform targeted recall. A write denied by HTTP 403 or an MCP
permission response disables subsequent writes for that credential-bound run;
the SDK still attempts its bounded read. HTTP 401 or a denied read blocks further
calls in that run. There are no authorization retry loops. `progress`, `decision`
and `end` return `permission_denied` when their write is disabled; a denied `end`
does not mark the task completed locally. `status()` exposes `canWrite` and
`reporting` alongside actual receipts.

Supply a stable project ID, runtime, session ID and **application task ID**. The
run ID is a hash of endpoint, credential digest, project, runtime, session and
task. It is stable across process restart, compaction and replay. A different
logical task needs a different ID; a conversational follow-up does not
necessarily start a task. Parent and child agents need separate IDs only when
the application tracks them as separate tasks.

| Operation | JavaScript | Python | Meaning |
| --- | --- | --- | --- |
| Start and targeted recall | `task.start({query})` | `await task.start(query=...)` | Factual running report when permitted, then one targeted memory read. |
| Additional read | `task.callMcp(name,args)` | `await task.call_mcp(name,args)` | Same run metadata and cumulative context budget on every read. |
| Known progress | `task.progress(id,step)` | `await task.progress(id,step)` | Bounded application-defined stage, outside model context. |
| Durable delta | `task.decision(id,text,{kind,topic})` | `await task.decision(id,text,kind=...,topic=...)` | Explicit decision/correction/constraint/handoff only. |
| Nothing durable changed | `task.noChange()` | `await task.no_change()` | Local acknowledgement; no invented memory write. |
| Known result | `task.end(status,outcome)` | `await task.end(status,outcome)` | Explicit `completed` or `failed` with factual outcome. |
| Delivery diagnostics | `task.status()` | `await task.status()` | Actual local receipt/uncertainty state. |

Only the returned `context` should enter the model's context, as untrusted source
data. The wrapper labels that boundary. Reports, probe receipts and byte counters
stay outside the model conversation. `callMcp` is read-only; it does not expose a
generic write escape hatch. A successful framework return, `FinalResultEvent`,
stream ending, user interruption or process exit is not sufficient evidence that
the user's task succeeded. No SDK context-manager exit marks work completed.

Every MCP read—including full page reads, searches, lists and action history—has
`params._meta["com.engram/context"] = {runId,maxBytes,integration,probeId?}`. The
original maximum is stable for the run, rather than a shrinking per-call number.
The gateway's cumulative retrieval budget and duplicate suppression still apply.

SDK cumulative context defaults to 4,096 UTF-8 bytes and can be configured to
16,384. This local count includes its untrusted-source wrapper. Responses and
requests have separate hard byte ceilings. If an entire structured response will
not fit the remaining local context, it is withheld; JSON and cited spans are not
cut into misleading fragments. The typed MCP result remains available for
application processing when the read fits. These are context-output bytes, not
actual provider tokens, cached-token charges or an overall spending guarantee.

## JavaScript / TypeScript

```js
import { EngramMemory } from '@ani-hq/engram-memory';

const memory = new EngramMemory({
  host: process.env.ENGRAM_HOST,
  token: process.env.ENGRAM_TOKEN,
  project: 'checkout-service',
});
const task = memory.task({runtime:'custom-agent',sessionId:'session-42',
  taskId:'retry-policy-v1',title:'Implement retry handling'});
const start = await task.start({query:'background job retry decisions'});
if (start.context) await runtime.injectContext(start.context);
const page = await task.callMcp('get_page', {slug:'projects/retries'});
if (page.context) await runtime.injectContext(page.context);
await task.progress('validation', 'Checking repeated deliveries');
await task.decision('retry-policy-v1', 'Retries reuse the original request ID.',
  {kind:'decision',topic:'Project architecture'});
// Only after application validation establishes this actual outcome:
await task.end('completed', 'Relevant retry checks passed.');
```

## Python

```python
import os
from engram_memory import EngramMemory

memory = EngramMemory(host=os.environ['ENGRAM_HOST'],
    token=os.environ['ENGRAM_TOKEN'], project='checkout-service')
task = memory.task(runtime='custom-agent', session_id='session-42',
    task_id='retry-policy-v1', title='Implement retry handling')
start = await task.start(query='background job retry decisions')
if start.get('context'):
    await runtime.inject_context(start['context'])
page = await task.call_mcp('get_page', {'slug': 'projects/retries'})
if page.get('context'):
    await runtime.inject_context(page['context'])
await task.progress('validation', 'Checking repeated deliveries')
await task.decision('retry-policy-v1', 'Retries reuse the original request ID.',
    kind='decision', topic='Project architecture')
await task.end('completed', 'Relevant retry checks passed.')
```

## Framework adapters

Adapters require an application-defined injection function and stable identity.
The application controls how bounded memory enters graph state, dependencies or
agent instructions. Merely assigning a state field that the model never reads
does not prove effective use.

**LangGraph:** JavaScript's `LangGraphMemoryAdapter` wraps `invoke` or `stream`;
the Python adapter wraps `ainvoke` or `astream`. A configured map turns selected
node names into static progress labels. Node state, tool arguments and message
streams are not copied into Engram reports. No node or subgraph finishing marks
the parent task successful. Supply an outcome selector only when it can validate
the application's actual result. [LangGraph streaming](https://docs.langchain.com/oss/python/langgraph/streaming)

```js
import { LangGraphMemoryAdapter } from '@ani-hq/engram-memory/frameworks';
const adapter = new LangGraphMemoryAdapter(memory, {
  injectContext: (input, context) => ({...input, engram_context: context}),
  progressLabels: {validate: 'Validating retry handling'},
});
const run = await adapter.run(graph, input, {
  identity: {sessionId:'session-42',taskId:'retry-policy-v1',title:'Retry handling'},
  query:'background job retry decisions',
});
// The graph's prompt must consume input.engram_context as untrusted references.
// Explicit task.end remains available on run.task.
```

**Google ADK:** `createAdkMemoryPlugin` / `create_adk_memory_plugin` lazily load
the framework's `BasePlugin`. An `identify(invocation)` callback maps its root
invocation to a stable application task; `injectContext` / `inject_context`
places bounded text where the application's model request consumes it. Start
callbacks return no content, so they do not short-circuit the original agent.
Configured event-author labels provide meaningful progress. Run-end reporting
requires an explicit known-outcome selector. Cancellation/error handlers must not
turn into success. [ADK plugin callbacks](https://adk.dev/plugins/)

The JavaScript plugin import and callback shapes were checked against the
official ADK TypeScript **2.2.1** API reference: it exports `BasePlugin` from
`@google/adk`, constructs it with a name string, passes `{invocationContext}` to
run callbacks, and exposes `invocationContext.invocationId`. The automated suite
uses an injected fixture base class; it does not claim an installed ADK package
or model execution. [BasePlugin reference](https://adk.dev/api-reference/typescript/classes/BasePlugin.html),
[InvocationContext reference](https://adk.dev/api-reference/typescript/classes/InvocationContext.html)

**Pydantic AI:** Python's `PydanticMemoryAdapter` wraps `agent.run()` with an
event-stream handler. Only configured tool names produce progress labels; model
tokens and tool payloads are not saved. Context injection is explicit through
the application's dependencies/input setup. The wrapper does not equate
`FinalResultEvent` with task completion. A known-outcome selector or explicit
`task.end` is required. [Pydantic AI execution](https://pydantic.dev/docs/ai/core-concepts/agent/)

```python
from engram_memory.frameworks import PydanticMemoryAdapter

adapter = PydanticMemoryAdapter(memory,
    inject_context=lambda prompt, context: context + '\nCurrent task:\n' + prompt,
    progress_labels={'check_retries': 'Checking retry handling'})
run = await adapter.run(agent, user_prompt,
    identity={'session_id': 'session-42', 'task_id': 'retry-policy-v1',
              'title': 'Retry handling'},
    query='background job retry decisions')
# run['task'].decision(...) records an explicitly chosen durable delta.
# run['task'].end(...) requires a known outcome, not a final text event.
```

Other owned runtimes can use the same task API or generic `runWithMemory` /
`run_with_memory` wrapper. Semantic Kernel and CrewAI are generic integrations
until a framework-specific adapter/version passes conformance; no blanket
automatic-usage claim is made.

## Private state and delivery

SDK state defaults to `$XDG_STATE_HOME/engram-sdk` or
`~/.local/state/engram-sdk`, with an optional explicit state directory for a
service's persistent volume. Directories use 0700, files 0600, symlink paths are
rejected, and per-run exclusive locks prevent duplicate concurrent delivery.
Credentials and retrieved source text are not stored. Bounded pending factual
reports may contain the supplied task title, stage or outcome; choose safe labels.
State is capped and contains hashes, receipt IDs and uncertainty markers. Keep
the same state volume across runtime resume/replay.

Write intent is persisted before transmission. A lost `remember` acknowledgement
is uncertain and is never automatically replayed, including after restart.
Inspect the workspace before deliberately writing a new delta. Repeating an
identical progress/end event explicitly can retry a factual report once, with the
same event ID, timestamp and payload; a changed payload under the same ID is
refused. There are no retry loops, background timers or synthetic heartbeats.
Revoked credentials block further calls in that credential-bound run; replacing
the credential creates a new scope rather than replaying old payloads.

Operational failures return small status objects so the application can continue.
HTTP attempts have a two-second default deadline. `start` can perform one report
and one read; framework/runtime code remains responsible for its own deadlines
and cancellation. Application programming errors and invalid constructor inputs
should be fixed rather than hidden by the integration.

## Explicit compatibility check

On a fresh, intentionally selected task, call `beginVerification()` /
`begin_verification()`. It only asks `whoami` to issue a short-lived server nonce.
Continue that run with a real targeted read and an explicitly selected durable
decision, then call `verificationStatus()` / `verification_status()`.

The SDK sends its versioned declaration and nonce on subsequent calls. A passed
check requires the gateway to correlate actual successful read and save receipts
for the same credential, actor, workspace, run and full declaration. SDK
declarations alone do not pass a check. `automaticWorkflowVerified` remains
`null`: a correlated delivery sequence cannot prove automatic triggering or model
understanding. No SDK setup routine performs an unsolicited test memory write.

## Conformance

`test/fixtures/memory-conformance.json` defines common synthetic data, read tools,
budgets and required checks. SDK fixtures use actual loopback HTTP clients to
exercise handoff, read metadata, Unicode limits, restart deduplication, uncertain
writes, stable report retries, cancellation, isolation and explicit checks.
Framework fixture classes test callback/state boundaries without downloading
models or making provider calls. Passing these fixtures does not imply every
future framework version has been tested; package/version compatibility should be
confirmed by the consuming application's integration tests.
