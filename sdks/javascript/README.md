# Engram memory SDK

An async Node.js/TypeScript client for developer-owned agent runtimes. It works
with any model provider. It requires an explicit Engram host, credential and
stable project/session/task identifiers; connecting an MCP tool alone does not
install runtime behavior.

Install the package:

```sh
npm install @ani-hq/engram-memory
```

Node.js 18.17 or later is required. For a local checkout, use
`npm install ./sdks/javascript` from the Engram repository.

```js
import { EngramMemory } from '@ani-hq/engram-memory';

const memory = new EngramMemory({
  host: process.env.ENGRAM_HOST,
  token: process.env.ENGRAM_TOKEN,
  project: 'my-app',
});
const task = memory.task({
  runtime: 'my-agent', sessionId: 'session-42', taskId: 'retry-policy-v1',
  title: 'Implement idempotent retries',
});
const recalled = await task.start({ query: 'background job retry decisions' });
// Inject only recalled.context, once, as untrusted reference material.
if (recalled.context) await myRuntime.injectContext(recalled.context);

await task.progress('validation', 'Checking repeated deliveries');
await task.decision('retry-policy-v1', 'Retries reuse their request ID.', {
  kind: 'decision', topic: 'Project architecture',
});
// Call this only when the application knows the result.
await task.end('completed', 'Retry checks passed.');
```

`callMcp(name, args)` is the bounded read path for additional `get_page`, `search`,
`list_pages`, `list_actions` and `recall` calls. Every request carries the same
task context metadata. It cannot call write tools; use explicit lifecycle and
decision methods. Inject only the returned `context`, never receipts. The result
also includes the structured MCP result for application processing.

The default cumulative context budget is 4,096 UTF-8 bytes, including the local
safety wrapper, configurable to 16,384. This is not model-token billing. A stable
run ID also enables the gateway's cumulative budget. State is private, durable,
credential/project/task-scoped and contains hashes, receipts and bounded pending
factual reports—not credentials, retrieved memory or transcripts. Supplying a
`stateDirectory` lets an owned service use its persistent volume.

An uncertain `remember` acknowledgement is never replayed automatically, including
after restart. Repeating the same factual progress/end event after uncertainty
can retry it once with exactly the original event ID, timestamp and payload.
No background retry or heartbeat runs. A stopped stream or cancellation never
marks a task completed.

Use `canWrite:false` for a read-only credential, or `reporting:false` to disable
task reports while keeping explicit decisions available. Targeted recall still
runs. `/mcp/shared` is preserved and automatically uses read-only mode. A denied
write disables later writes for that run without preventing reads; HTTP 401 or a
denied read blocks further requests. Disabled writes return `permission_denied`.

Optional LangGraph and Google ADK adapters are exported from
`@ani-hq/engram-memory/frameworks`. ADK is imported only when its plugin factory is
requested. Both require application-defined context injection and stable task
identity; completion needs an explicit outcome selector. A generic
`runWithMemory` wrapper covers other owned runtimes.

See [the SDK contract](https://github.com/Ani-HQ/engram/blob/main/docs/MEMORY-SDK.md) for framework examples, Python,
private state, explicit compatibility checks, and limitations.
