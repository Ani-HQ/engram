"""Optional framework adapters. Models, prompts, memory deltas and outcomes stay
under application control. Importing this module imports no framework package.
"""
from __future__ import annotations

import inspect


async def _value(value):
    return await value if inspect.isawaitable(value) else value


def _identity(identity, runtime):
    return {**identity, "runtime": runtime}


def _labels(labels):
    result = dict(labels or {})
    if len(result) > 64 or any(not isinstance(name, str) or not isinstance(value, str) for name, value in result.items()):
        raise ValueError("Configure at most 64 explicit progress labels.")
    return result


async def _outcome(task, selector, result):
    if selector is not None:
        known = await _value(selector(result))
        if known:
            await task.end(known["status"], known["outcome"])


class LangGraphMemoryAdapter:
    """Wrap a graph's ainvoke/astream; inject only bounded untrusted context.

    A completed stream is not itself a known completed user task. Only an
    application's explicit outcome selector can report a final result.
    """
    def __init__(self, memory, *, inject_context, progress_labels=None):
        if not callable(inject_context):
            raise TypeError("Provide inject_context(input, untrusted_context) for the graph state.")
        self.memory = memory
        self.inject_context = inject_context
        self.progress_labels = _labels(progress_labels)

    async def prepare(self, input, *, identity, query=None):
        task = self.memory.task(**_identity(identity, "langgraph"))
        started = await task.start(query=query)
        prepared = await _value(self.inject_context(input, started["context"])) if started.get("context") else input
        return {"task": task, "input": prepared, "memory": started}

    async def ainvoke(self, graph, input, *, identity, query=None, config=None, outcome=None):
        prepared = await self.prepare(input, identity=identity, query=query)
        result = await graph.ainvoke(prepared["input"], config=config)
        await _outcome(prepared["task"], outcome, result)
        return {"result": result, "task": prepared["task"], "memory": prepared["memory"]}

    async def run(self, graph, input, **options):
        return await self.ainvoke(graph, input, **options)

    async def astream(self, graph, input, *, identity, query=None, config=None, outcome=None):
        prepared = await self.prepare(input, identity=identity, query=query)
        seen, last = set(), None
        stream = await _value(graph.astream(prepared["input"], config=config, stream_mode=["updates", "custom"]))
        async for event in stream:
            last = event
            update = event[1] if isinstance(event, (tuple, list)) and len(event) == 2 and event[0] == "updates" else event.get("data") if isinstance(event, dict) and event.get("type") == "updates" else event
            if isinstance(update, dict):
                for index, (node, text) in enumerate(self.progress_labels.items()):
                    if node in update and node not in seen:
                        seen.add(node)
                        await prepared["task"].progress(f"node:{index}", text)
            yield event
        await _outcome(prepared["task"], outcome, last)


def create_adk_memory_plugin(memory, *, identify, inject_context, progress_labels=None, outcome=None, base_plugin=None, BasePlugin=None):
    """Lazy Google ADK plugin factory.

    identify(invocation_context) supplies stable application session/task IDs.
    inject_context chooses this application's instruction/context field. No
    invocation transcript or event payload is sent to Engram.
    """
    if not callable(identify) or not callable(inject_context):
        raise TypeError("Provide identify(invocation_context) and inject_context(invocation_context, context).")
    labels = _labels(progress_labels)
    plugin_base = base_plugin or BasePlugin
    if plugin_base is None:
        from google.adk.plugins.base_plugin import BasePlugin as plugin_base

    class EngramMemoryPlugin(plugin_base):
        def __init__(self):
            super().__init__(name="engram_memory")
            self._engram_runs = {}

        async def before_run_callback(self, *, invocation_context):
            identity = dict(await _value(identify(invocation_context)))
            query = identity.pop("query", None)
            task = memory.task(**_identity(identity, "google-adk"))
            invocation_id = invocation_context.invocation_id
            self._engram_runs[invocation_id] = task
            while len(self._engram_runs) > 128:
                self._engram_runs.pop(next(iter(self._engram_runs)))
            started = await task.start(query=query)
            if started.get("context"):
                await _value(inject_context(invocation_context, started["context"]))
            return None

        async def on_event_callback(self, *, invocation_context, event):
            task = self._engram_runs.get(invocation_context.invocation_id)
            author = getattr(event, "author", None)
            if task is not None and author in labels:
                index = list(labels).index(author)
                await task.progress(f"stage:{index}", labels[author])
            return None

        async def after_run_callback(self, *, invocation_context):
            task = self._engram_runs.pop(invocation_context.invocation_id, None)
            if task is not None:
                await _outcome(task, outcome, invocation_context)
            return None

    return EngramMemoryPlugin()


class PydanticMemoryAdapter:
    """Use Pydantic AI's public run(event_stream_handler=...) interface.

    Only named tool-call/result events can trigger configured progress labels.
    FinalResultEvent and stream exhaustion never imply task completion. A model
    or application must separately choose each durable memory delta.
    """
    def __init__(self, memory, *, inject_context, progress_labels=None, on_event=None):
        if not callable(inject_context):
            raise TypeError("Provide inject_context(input, untrusted_context).")
        self.memory = memory
        self.inject_context = inject_context
        self.progress_labels = _labels(progress_labels)
        self.on_event = on_event

    async def run(self, agent, input, *, identity, query=None, outcome=None, **run_options):
        if "event_stream_handler" in run_options:
            raise TypeError("Use on_event on the adapter to observe forwarded stream events.")
        task = self.memory.task(**_identity(identity, "pydantic-ai"))
        started = await task.start(query=query)
        prepared = await _value(self.inject_context(input, started["context"])) if started.get("context") else input
        seen = set()

        async def handler(ctx, events):
            async for event in events:
                kind = type(event).__name__
                if kind in ("FunctionToolCallEvent", "FunctionToolResultEvent"):
                    part = getattr(event, "part", None) or getattr(event, "result", None)
                    name = getattr(part, "tool_name", None)
                    if name in self.progress_labels and name not in seen:
                        seen.add(name)
                        index = list(self.progress_labels).index(name)
                        await task.progress(f"tool:{index}", self.progress_labels[name])
                if self.on_event is not None:
                    await _value(self.on_event(ctx, event))

        result = await agent.run(prepared, event_stream_handler=handler, **run_options)
        await _outcome(task, outcome, result)
        return {"result": result, "task": task, "memory": started}


async def run_with_memory(memory, *, identity, input, inject_context, invoke, query=None, outcome=None):
    """Runtime-neutral async entry point with explicit context injection/outcome."""
    if not callable(inject_context) or not callable(invoke):
        raise TypeError("Provide explicit injection and invocation functions.")
    task = memory.task(**identity)
    started = await task.start(query=query)
    prepared = await _value(inject_context(input, started["context"])) if started.get("context") else input
    result = await _value(invoke(prepared, task))
    await _outcome(task, outcome, result)
    return {"result": result, "task": task, "memory": started}


__all__ = ["LangGraphMemoryAdapter", "create_adk_memory_plugin", "PydanticMemoryAdapter", "run_with_memory"]
