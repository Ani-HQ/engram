import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EngramMemory, READ_TOOLS } from '../sdks/javascript/index.mjs';
import { LangGraphMemoryAdapter, createAdkMemoryPlugin, runWithMemory } from '../sdks/javascript/frameworks.mjs';
import fixture from './fixtures/memory-conformance.json';

const roots: string[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) server.stop(true); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function gateway() {
  const root = await mkdtemp('/private/tmp/engram-sdk-'); roots.push(root);
  const calls: any[] = [], stored = new Map<string, string[]>(), reports = new Map<string, any>();
  const modes = { loseSave: false, loseReport: false, deny: false, denyWrites: false, denyMcpWrites: false, denyReads: false, huge: false, invalid: false, delay: 0 };
  const probe = 'emp_' + 'a'.repeat(32);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as any, name = body.params.name, args = body.params.arguments, meta = body.params._meta['com.engram/context'];
    const credential = request.headers.get('authorization') || '';
    calls.push({ body, credential, url: request.url });
    if (modes.deny) return new Response('denied', { status: 401 });
    if (modes.denyWrites && ['record_action', 'remember'].includes(name) || modes.denyReads && READ_TOOLS.includes(name)) return new Response('denied', { status: 403 });
    if (modes.denyMcpWrites && ['record_action', 'remember'].includes(name)) return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: `denied: ${name} is not allowed for this token` }] } });
    if (modes.delay) await Bun.sleep(modes.delay);
    let value: any;
    if (name === 'record_action') {
      reports.set(args.eventId, args);
      if (modes.loseReport) { modes.loseReport = false; return new Response('uncertain', { status: 503 }); }
      value = { ok: true, id: args.eventId.slice(0, 60), status: args.status, evidence: 'reported' };
    } else if (name === 'remember') {
      stored.set(credential, [...(stored.get(credential) || []), args.text]);
      if (modes.loseSave) { modes.loseSave = false; return new Response('uncertain', { status: 503 }); }
      value = { ok: true, slug: 'projects/conformance' };
    } else if (name === 'whoami') value = { token: 'fixture', verification: { probeId: probe, status: meta.verification === 'begin' ? 'pending' : 'passed', startedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), checkedAt: meta.verification === 'begin' ? null : new Date().toISOString(), recallVerified: meta.verification !== 'begin', saveVerified: meta.verification !== 'begin', automaticWorkflowVerified: null } };
    else if (name === 'recall') value = { results: (stored.get(credential) || [fixture.unicodeDecision]).map((snippet, index) => ({ slug: `notes/${index}`, snippet })), full: null };
    else if (name === 'get_page') value = { slug: 'notes/0', compiled_truth: fixture.unicodeDecision, content_hash: 'a'.repeat(64) };
    else if (name === 'list_actions') value = { actions: [], more: false, next_offset: null };
    else value = [{ slug: 'notes/0', snippet: fixture.unicodeDecision }];
    if (modes.huge) value = { results: [{ snippet: '🌿'.repeat(5000) }] };
    if (modes.invalid) value = { notAReceipt: true };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
  } });
  servers.push(server);
  const client = (token = 'fixture-token', suffix = '', options = {}) => new EngramMemory({ host: `http://127.0.0.1:${server.port}`, token, project: 'conformance', stateDirectory: path.join(root, `state${suffix}`), ...options });
  const task = (memory = client(), id = 'task-1', runtime = 'generic') => memory.task({ runtime, sessionId: 'session-1', taskId: id, title: 'Retry policy' });
  return { root, calls, modes, client, task, stored, reports, host: `http://127.0.0.1:${server.port}` };
}

describe('owned-runtime JavaScript memory SDK', () => {
  test('URL controls, embedded spaces and ambiguous international hostnames are rejected before transport', () => {
    for (const host of ['https://exa\nmple.com', 'https://exa\tmple.com', 'https://example.com/path with space', 'https://faß.example', 'https://éxample.com', 'https://%65xample.com', 'https://example.com\\evil', 'https://user:password@example.com', 'http://remote.example']) expect(() => new EngramMemory({ host, token: 'fixture', project: 'test' })).toThrow();
    expect(new EngramMemory({ host: ' https://example.com/%E8%A8%98%E6%86%B6 ', token: 'fixture', project: 'test' }).endpoint).toBe('https://example.com/%E8%A8%98%E6%86%B6/mcp');
    expect(new EngramMemory({ host: 'https://xn--bcher-kva.example/記憶', token: 'fixture', project: 'test' }).endpoint).toBe('https://xn--bcher-kva.example/%E8%A8%98%E6%86%B6/mcp');
    expect(new EngramMemory({ host: 'https://example.com/mcp/shared/', token: 'fixture', project: 'test' }).endpoint).toBe('https://example.com/mcp/shared');
  });
  test('shared conformance fixture performs a cross-agent handoff and sends task metadata on every read', async () => {
    const env = await gateway(), first = env.task(env.client(), 'save', 'claude-code');
    await first.start({ query: fixture.query });
    expect((await first.decision('retry-policy', fixture.decision, { topic: fixture.topic })).ok).toBe(true);
    const second = env.task(env.client(), 'read', 'langgraph');
    const start = await second.start({ query: fixture.query });
    expect(start.context).toContain(fixture.decision);
    for (const name of fixture.readTools.filter(name => name !== 'recall')) expect((await second.callMcp(name, name === 'get_page' ? { slug: 'notes/0' } : {})).status).not.toBe('read_tool_required');
    for (const call of env.calls.filter(call => READ_TOOLS.includes(call.body.params.name))) {
      const meta = call.body.params._meta['com.engram/context'];
      expect(meta.runId).toStartWith('es_'); expect(meta.maxBytes).toBe(fixture.defaultBudgetBytes);
      expect(meta.integration).toEqual({ id: 'engram-sdk-js', version: '0.1.0', runtime: call.body.params.name === 'recall' && meta.runId === first.runId ? 'claude-code' : 'langgraph', capabilities: ['task-context', 'lifecycle-events', 'explicit-deltas'] });
    }
    expect(Buffer.byteLength(start.context!)).toBeLessThanOrEqual(fixture.defaultBudgetBytes);
  });
  test('stable IDs and private state suppress resume/compaction context without persisting credentials or recalled text', async () => {
    const env = await gateway(), first = env.task();
    const start = await first.start({ query: fixture.query });
    expect(start.status).toBe('retrieved');
    const resumed = env.task(env.client()); expect(resumed.runId).toBe(first.runId);
    expect((await resumed.start({ query: fixture.query })).context).toBe('');
    expect(env.calls.filter(call => call.body.params.name === 'recall')).toHaveLength(1);
    const file = path.join(env.root, 'state', `${first.runId}.json`), text = await readFile(file, 'utf8');
    expect(text).not.toContain('fixture-token'); expect(text).not.toContain(fixture.unicodeDecision);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  test('all read methods retain the original run ceiling and cannot inject excess Unicode context', async () => {
    const env = await gateway(), task = env.task(env.client('fixture-token', '', { budgetBytes: 1024 }));
    await task.start({ query: fixture.query });
    for (const name of fixture.readTools) await task.callMcp(name, { q: name });
    const status = await task.status(); expect(status.contextBytes).toBeLessThanOrEqual(1024);
    for (const call of env.calls.filter(call => READ_TOOLS.includes(call.body.params.name))) expect(call.body.params._meta['com.engram/context'].maxBytes).toBe(1024);
    env.modes.huge = true;
    const huge = await env.task(env.client(), 'huge').start({ query: fixture.query });
    expect(huge.context).toBe(''); expect(huge.ok).toBe(false);
  });
  test('an uncertain remember is never replayed while a factual report retries its identical event at most once', async () => {
    const env = await gateway(), task = env.task(); await task.start({ query: fixture.query });
    env.modes.loseSave = true;
    expect((await task.decision('save-1', fixture.decision)).ok).toBe(false);
    await env.task(env.client()).decision('save-1', fixture.decision);
    expect(env.calls.filter(call => call.body.params.name === 'remember')).toHaveLength(1);
    env.modes.loseReport = true;
    await task.progress('validate', 'Validating the request ID');
    await task.progress('validate', 'Validating the request ID');
    await task.progress('validate', 'Validating the request ID');
    const progress = env.calls.filter(call => call.body.params.arguments.currentStep);
    expect(progress).toHaveLength(2); expect(progress[0].body.params.arguments).toEqual(progress[1].body.params.arguments);
    expect((await task.progress('validate', 'Different payload')).status).toBe('event_conflict');
  });
  test('credentials/workspaces and task IDs isolate state and cancellation never implies completion', async () => {
    const env = await gateway(), first = env.task(); await first.start({ query: fixture.query }); await first.decision('only-a', 'Private A decision.');
    const other = env.task(env.client('other-token'), 'other'); const result = await other.start({ query: fixture.query });
    expect(result.context).not.toContain('Private A decision.'); expect(other.runId).not.toBe(first.runId);
    expect((await first.status()).ended).toBe(false);
    expect(() => first.end('cancelled' as any, 'Stream stopped')).toThrow();
    expect(env.calls.filter(call => ['completed', 'failed'].includes(call.body.params.arguments.status))).toHaveLength(0);
    await first.end('completed', 'The relevant checks passed.');
    expect((await first.status()).ended).toBe(true);
  });
  test('explicit verification carries server nonce and never claims automatic behavior from a declaration', async () => {
    const env = await gateway(), task = env.task();
    const began = await task.beginVerification(); expect(began.status).toBe('pending');
    await task.start({ query: fixture.query }); await task.decision('probe-decision', fixture.decision);
    const status = await task.verificationStatus(); expect(status.status).toBe('passed');
    expect(status.verification.automaticWorkflowVerified).toBeNull();
    for (const call of env.calls.slice(1)) expect(call.body.params._meta['com.engram/context'].probeId).toBe('emp_' + 'a'.repeat(32));
  });
  test('operational failures are bounded and revoked credentials stop additional calls', async () => {
    const env = await gateway(), task = env.task(); env.modes.deny = true;
    expect((await task.start({ query: fixture.query })).status).toBe('authorization_required');
    const before = env.calls.length; await task.callMcp('get_page', { slug: 'a' }); expect(env.calls.length).toBe(before);
    env.modes.deny = false; env.modes.delay = 500;
    const fast = env.task(env.client('second-token', '-fast', { timeoutMs: 50 }), 'slow');
    const started = performance.now(); expect((await fast.start({ query: fixture.query })).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(400);
  });
  test('write permission denial preserves recall, suppresses later writes and read denial still blocks', async () => {
    for (const denial of ['denyWrites', 'denyMcpWrites'] as const) {
      const env = await gateway(), task = env.task(); env.modes[denial] = true;
      expect((await task.start({ query: fixture.query })).status).toBe('retrieved');
      expect((await task.progress('inspect', 'Inspecting the retry policy')).status).toBe('permission_denied');
      expect((await task.decision('decision', fixture.decision)).status).toBe('permission_denied');
      expect((await task.end('completed', 'Known result')).status).toBe('permission_denied');
      expect((await task.status()).ended).toBe(false);
      expect((await env.task(env.client()).callMcp('get_page', { slug: 'notes/0' })).ok).toBe(true);
      expect(env.calls.filter(call => ['record_action', 'remember'].includes(call.body.params.name))).toHaveLength(1);
      env.modes.denyReads = true;
      expect((await task.callMcp('search', { query: 'new query' })).status).toBe('authorization_required');
      const before = env.calls.length; await task.callMcp('list_pages'); await task.decision('next', 'No new calls.');
      expect(env.calls).toHaveLength(before);
    }
  });
  test('explicit read-only and scoped endpoints send reads without reporting or writing', async () => {
    const env = await gateway();
    for (const options of [{ canWrite: false }, { host: env.host + '/mcp/shared/' }]) {
      const task = env.task(env.client('read-token', '', options), options.canWrite === false ? 'readonly' : 'scoped');
      expect((await task.start({ query: fixture.query })).status).toBe('retrieved');
      expect((await task.decision('decision', fixture.decision)).status).toBe('permission_denied');
      expect((await task.progress('step', 'Known step')).status).toBe('permission_denied');
      expect((await task.end('completed', 'Known result')).status).toBe('permission_denied');
      expect((await task.status()).canWrite).toBe(false);
    }
    expect(env.calls.map(call => call.body.params.name)).toEqual(['recall', 'recall']);
    expect(new URL(env.calls[1].url).pathname).toBe('/mcp/shared');
    expect(env.calls[1].body.params._meta['com.engram/context'].integration.capabilities).toEqual(['task-context']);
    const quiet = env.task(env.client('write-token', '', { reporting: false }), 'quiet');
    await quiet.start({ query: fixture.query }); await quiet.decision('decision', fixture.decision);
    expect((await quiet.progress('step', 'Known step')).status).toBe('permission_denied');
    expect(env.calls.slice(2).map(call => call.body.params.name)).toEqual(['recall', 'remember']);
  });
  test('state symlinks are rejected and simultaneous same-run calls do not duplicate retrieval', async () => {
    const env = await gateway(), external = path.join(env.root, 'external');
    await Bun.write(path.join(external, 'keep'), 'unchanged'); await symlink(external, path.join(env.root, 'link'));
    const unsafe = env.task(env.client('token', '', { stateDirectory: path.join(env.root, 'link') }));
    expect((await unsafe.start()).status).toBe('unsafe_state_path');
    const task = env.task(); await Promise.all([task.start({ query: fixture.query }), task.start({ query: fixture.query })]);
    expect(env.calls.filter(call => call.body.params.name === 'recall')).toHaveLength(1);
  });
  test('existing shared directory permissions and malformed oversized lock files are never changed or read unbounded', async () => {
    const env = await gateway(), shared = path.join(env.root, 'existing-shared');
    await mkdir(shared); await chmod(shared, 0o755);
    const unsafe = env.task(env.client('token', '', { stateDirectory: shared }));
    expect((await unsafe.start()).status).toBe('state_permissions');
    expect((await stat(shared)).mode & 0o777).toBe(0o755);
    const privateDirectory = path.join(env.root, 'private'); await mkdir(privateDirectory, { mode: 0o700 });
    const locked = env.task(env.client('token', '', { stateDirectory: privateDirectory }));
    await writeFile(path.join(privateDirectory, `${locked.runId}.json.lock`), 'x'.repeat(1024), { mode: 0o600 });
    expect((await locked.start()).status).toBe('unsafe_state_path');
    expect(env.calls).toHaveLength(0);
  });
});

describe('optional framework SDK adapters', () => {
  test('LangGraph injects bounded context and reports selected node progress without inferring completion', async () => {
    const env = await gateway(), inputs: any[] = [];
    const adapter = new LangGraphMemoryAdapter(env.client(), { injectContext: (input, context) => ({ ...input, engram_context: context }), progressLabels: { validate: 'Validating request IDs' } });
    const graph = { async *stream(input: any) { inputs.push(input); yield ['updates', { validate: { arbitraryPrivateState: 'must not be reported' } }]; yield ['updates', { validate: {} }]; } };
    const stream = adapter.stream(graph, { messages: [] }, { identity: { sessionId: 'session', taskId: 'graph', title: 'Retry checks' }, query: fixture.query });
    const events = []; for await (const event of stream) events.push(event);
    expect(inputs[0].engram_context).toContain('untrusted reference data'); expect(events).toHaveLength(2);
    expect(env.calls.filter(call => call.body.params.arguments.currentStep)).toHaveLength(1);
    expect(JSON.stringify(env.calls)).not.toContain('must not be reported');
    expect(env.calls.filter(call => call.body.params.arguments.status === 'completed')).toHaveLength(0);
  });
  test('ADK factory imports no framework unless requested and returns no short-circuit result', async () => {
    const env = await gateway(), injected: string[] = [];
    class BasePlugin { constructor(public name: string) {} }
    const plugin: any = await createAdkMemoryPlugin(env.client(), { BasePlugin, identify: () => ({ sessionId: 'session', taskId: 'adk', title: 'ADK task', query: fixture.query }), injectContext: (_ctx: any, text: string) => { injected.push(text); } });
    const invocationContext = { invocationId: 'invocation-1' };
    expect(await plugin.beforeRunCallback({ invocationContext })).toBeUndefined();
    await plugin.afterRunCallback({ invocationContext });
    expect(injected).toHaveLength(1);
    expect(env.calls.filter(call => call.body.params.arguments.status === 'completed')).toHaveLength(0);
  });
  test('generic runtime wrapper ends only with a supplied known-outcome selector', async () => {
    const env = await gateway();
    const result = await runWithMemory(env.client(), { identity: { runtime: 'custom-agent', sessionId: 'session', taskId: 'custom', title: 'Custom task' }, query: fixture.query, input: {}, injectContext: (input: any, context: string) => ({ ...input, context }), invoke: async (input: any) => ({ verified: input.context.includes('untrusted reference data') }), outcome: (result: any) => result.verified ? { status: 'completed', outcome: 'Application validation passed.' } : null });
    expect(result.result.verified).toBe(true);
    expect(env.calls.filter(call => call.body.params.arguments.status === 'completed')).toHaveLength(1);
  });
});
