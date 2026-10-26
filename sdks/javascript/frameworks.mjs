// These adapters own lifecycle delivery, never model selection or source transcripts.
// Framework packages are optional and loaded only by their specific factory.
const identityFor = (identity, runtime) => ({ ...identity, runtime });
const labels = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64 || Object.values(value).some(label => typeof label !== 'string' || !label.trim() || label.length > 500)) throw new TypeError('Configure at most 64 short static progress labels.');
  return { ...value };
};

/** LangGraph's invoke/stream interfaces are duck typed, so this adapter does not
 * import LangGraph or constrain the application's chosen model/provider. */
export class LangGraphMemoryAdapter {
  constructor(memory, { injectContext, progressLabels = {} } = {}) {
    if (typeof injectContext !== 'function') throw new TypeError('Provide injectContext(input, untrustedContext) for your graph state.');
    this.memory = memory; this.injectContext = injectContext; this.progressLabels = labels(progressLabels);
  }
  async prepare(input, identity, query) {
    const task = this.memory.task(identityFor(identity, 'langgraph'));
    const start = await task.start({ query });
    return { task, input: start.context ? await this.injectContext(input, start.context) : input, memory: start };
  }
  async run(graph, input, { identity, query, config, outcome } = {}) {
    const prepared = await this.prepare(input, identity, query);
    // Only an application-supplied outcome selector may assert task completion.
    const result = await graph.invoke(prepared.input, config);
    if (outcome) { const known = await outcome(result); if (known) await prepared.task.end(known.status, known.outcome); }
    return { result, task: prepared.task, memory: prepared.memory };
  }
  async *stream(graph, input, { identity, query, config = {}, outcome } = {}) {
    const prepared = await this.prepare(input, identity, query), seen = new Set();
    let last;
    for await (const event of await graph.stream(prepared.input, { ...config, streamMode: ['updates', 'custom'] })) {
      last = event;
      const update = Array.isArray(event) && event[0] === 'updates' ? event[1] : event?.type === 'updates' ? event.data : event;
      if (update && typeof update === 'object' && !Array.isArray(update)) {
        for (const node of Object.keys(this.progressLabels)) if (Object.hasOwn(update, node) && !seen.has(node)) {
          seen.add(node); await prepared.task.progress(`node:${Object.keys(this.progressLabels).indexOf(node)}`, this.progressLabels[node]);
        }
      }
      yield event;
    }
    // Iterator exhaustion is not itself a successful user task.
    if (outcome) { const known = await outcome(last); if (known) await prepared.task.end(known.status, known.outcome); }
  }
}

/** Lazy ADK import. identify() supplies stable application task IDs rather than
 * treating every sub-agent/model/tool callback as a new user task. injectContext
 * decides how this application's agent instructions consume the bounded text. */
export async function createAdkMemoryPlugin(memory, { identify, injectContext, progressLabels = {}, outcome, BasePlugin: injectedBase } = {}) {
  if (typeof identify !== 'function' || typeof injectContext !== 'function') throw new TypeError('Provide identify(invocation) and injectContext(invocation, context).');
  const progress = labels(progressLabels);
  const BasePlugin = injectedBase || (await import('@google/adk')).BasePlugin;
  return new class extends BasePlugin {
    constructor() { super('engram_memory'); this.runs = new Map(); }
    async beforeRunCallback({ invocationContext }) {
      const identity = await identify(invocationContext), task = memory.task(identityFor(identity, 'google-adk'));
      this.runs.set(invocationContext.invocationId, task);
      while (this.runs.size > 128) this.runs.delete(this.runs.keys().next().value);
      const start = await task.start({ query: identity.query });
      if (start.context) await injectContext(invocationContext, start.context);
      return undefined;
    }
    async onEventCallback({ invocationContext, event }) {
      const task = this.runs.get(invocationContext.invocationId), author = event?.author;
      if (task && Object.hasOwn(progress, author)) await task.progress(`stage:${Object.keys(progress).indexOf(author)}`, progress[author]);
      return undefined;
    }
    async afterRunCallback({ invocationContext }) {
      const task = this.runs.get(invocationContext.invocationId);
      this.runs.delete(invocationContext.invocationId);
      if (task && outcome) { const known = await outcome(invocationContext); if (known) await task.end(known.status, known.outcome); }
    }
  }();
}

/** Runtime-neutral wrapper for frameworks with an async entry point. This is
 * also the supported bridge for custom runtimes and framework versions without
 * an event plugin. It never infers success from a returned model response. */
export async function runWithMemory(memory, { identity, query, input, injectContext, invoke, outcome }) {
  if (typeof injectContext !== 'function' || typeof invoke !== 'function') throw new TypeError('Provide explicit injection and invocation functions.');
  const task = memory.task(identity), start = await task.start({ query });
  const result = await invoke(start.context ? await injectContext(input, start.context) : input, task);
  if (outcome) { const known = await outcome(result); if (known) await task.end(known.status, known.outcome); }
  return { result, task, memory: start };
}
