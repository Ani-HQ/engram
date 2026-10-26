# Engram memory SDK for Python

An async, standard-library client for bounded shared memory in developer-owned
agent runtimes. It works independently of the model provider. The application
supplies its Engram host, credential and stable project/session/task identifiers;
installing the package does not change third-party agent settings.

```sh
python -m pip install ani-hq-engram-memory
```

Python 3.10 or later is required. The distribution is `ani-hq-engram-memory`;
the import is `engram_memory`. For a local checkout, use
`python -m pip install ./sdks/python` from the Engram repository.

```python
import asyncio
import os

from engram_memory import EngramMemory


async def main():
    memory = EngramMemory(
        host=os.environ['ENGRAM_HOST'],
        token=os.environ['ENGRAM_TOKEN'],
        project='my-app',
    )
    task = memory.task(
        runtime='my-agent', session_id='session-42', task_id='retry-policy-v1',
        title='Implement idempotent retries',
    )
    recalled = await task.start(query='background job retry decisions')
    # Inject only recalled['context'], once, as untrusted reference material.
    # The application's model request must consume that context explicitly.

    await task.progress('validation', 'Checking repeated deliveries')
    await task.decision(
        'retry-policy-v1', 'Retries reuse their request ID.',
        kind='decision', topic='Project architecture',
    )
    # Call this only when the application knows the result.
    await task.end('completed', 'Retry checks passed.')


asyncio.run(main())
```

`task.call_mcp(name, args)` is the bounded path for additional `get_page`,
`search`, `list_pages`, `list_actions` and `recall` calls. Every read carries the
same task metadata. Use lifecycle methods for reports and `decision` for explicit
durable changes. Reports and diagnostics should stay outside model context.

The default cumulative context budget is 4,096 UTF-8 bytes, including the safety
wrapper, configurable to 16,384. Context bytes are not a provider token bill.
Private durable state stores bounded receipts and pending factual reports, never
credentials, retrieved memory or transcripts. Use `state_directory` for a
service's persistent volume. Reuse stable task identity across restarts.

An uncertain memory-write acknowledgement is never replayed automatically.
Explicitly repeating an identical factual progress/end report can retry it once
with its original event ID and payload. No background retries or heartbeats run.
An ended stream or cancellation never marks a task completed.

Use `can_write=False` for a read-only credential or `reporting=False` to disable
task reports. `/mcp/shared` is preserved and uses read-only mode automatically.
A denied write disables later writes for that run while allowing bounded reads;
HTTP 401 or a denied read blocks later requests.

Optional LangGraph, Google ADK and Pydantic AI adapters are available from
`engram_memory.frameworks`. Dependencies load only when their adapter factory is
used. Context injection and known-outcome selection remain explicit application
responsibilities. No adapter makes an additional model call.

See [the SDK contract](https://github.com/Ani-HQ/engram/blob/main/docs/MEMORY-SDK.md)
for framework examples, verification checks and compatibility limits.
