import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EngramMemory } from '../sdks/javascript/index.mjs';
import contract from './fixtures/memory-conformance.json';

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'engram-sdk-interop-'))); roots.push(root);
  const requests: any[] = [], memories = new Map<string, string[]>(), reports = new Map<string, string>();
  // Synthetic tenant identities, not an alternate production authentication path.
  const tenants = new Map([['fixture-js', 'shared'], ['fixture-python', 'shared'], ['fixture-other', 'other']]);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    const tenant = tenants.get(token);
    if (!tenant) return new Response('denied', { status: 401 });
    const message = await request.json() as any;
    requests.push({ token, tenant, message });
    const name = message.params?.name, args = message.params?.arguments || {};
    const meta = message.params?._meta?.['com.engram/context'];
    if (!meta?.runId || !meta.integration || meta.maxBytes !== contract.defaultBudgetBytes) return new Response('missing task context', { status: 400 });
    let data: any;
    if (name === 'remember') {
      const saved = memories.get(tenant) || []; saved.push(args.text); memories.set(tenant, saved);
      data = { ok: true, appended: true, slug: 'conformance/retries' };
    } else if (name === 'record_action') {
      const identity = `${tenant}:${token}:${args.eventId}`, payload = JSON.stringify(args);
      if (reports.has(identity) && reports.get(identity) !== payload) return new Response('changed retry', { status: 409 });
      reports.set(identity, payload);
      data = { ok: true, id: args.eventId, status: args.status, evidence: 'reported' };
    } else if (name === 'get_page') {
      data = { slug: 'conformance/retries', compiled_truth: (memories.get(tenant) || []).join('\n'), content_hash: 'fixture' };
    } else if (name === 'list_pages') data = { pages: [{ slug: 'conformance/retries' }] };
    else if (name === 'list_actions') data = { actions: [] };
    else data = { results: (memories.get(tenant) || []).map(text => ({ slug: 'conformance/retries', snippet: text })), full: null };
    const result = { content: [{ type: 'text', text: JSON.stringify(data) }], _meta: { engramContext: { scope: 'run', runScoped: true, available: true, duplicate: false, budgetStopped: false } } };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  } });
  servers.push(server);
  const host = server.url.origin;
  const javascript = (token = 'fixture-js') => new EngramMemory({ host, token, project: 'conformance', stateDirectory: path.join(root, `js-${token}`) });
  const python = async (options: Record<string, unknown>) => {
    const child = Bun.spawn(['python3', 'test/fixtures/memory-interop-client.py'], {
      cwd: process.cwd(), env: { ...process.env, PYTHONPATH: path.join(process.cwd(), 'sdks/python'), PYTHONDONTWRITEBYTECODE: '1' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ host, token: 'fixture-python', stateDirectory: path.join(root, 'python'),
      query: contract.query, decision: contract.decision, topic: contract.topic, ...options }));
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  return { javascript, python, requests };
}

test('the JavaScript and Python SDKs exchange an actual memory over HTTP in both directions', async () => {
  const gateway = fixture();
  const writer = gateway.javascript().task({ runtime: 'javascript-interop', sessionId: 'one', taskId: 'write', title: 'Verify shared retry context' });
  await writer.start({ query: contract.query });
  expect((await writer.decision('retry-policy', contract.decision, { topic: contract.topic })).status).toBe('saved');
  const read = await gateway.python({ mode: 'read', sessionId: 'two', taskId: 'read', readTools: contract.readTools });
  expect(read.started.context).toContain(contract.decision);
  expect(read.started.contextBytes).toBeLessThanOrEqual(contract.defaultBudgetBytes);
  const write = await gateway.python({ mode: 'write', sessionId: 'three', taskId: 'write', decision: contract.unicodeDecision });
  expect(write.saved.status).toBe('saved');
  const reader = gateway.javascript().task({ runtime: 'javascript-interop', sessionId: 'four', taskId: 'read', title: 'Verify shared retry context' });
  expect((await reader.start({ query: contract.query })).context).toContain(contract.unicodeDecision);
  const other = gateway.javascript('fixture-other').task({ runtime: 'javascript-interop', sessionId: 'five', taskId: 'read', title: 'Verify shared retry context' });
  expect((await other.start({ query: contract.query })).context).toBe('');
  for (const { message } of gateway.requests) {
    expect(message.params._meta['com.engram/context'].runId).toMatch(/^es_[a-f0-9]{64}$/);
    expect(message.params.arguments).not.toHaveProperty('integration');
  }
  const pythonReads = gateway.requests.filter(row => row.token === 'fixture-python' && contract.readTools.includes(row.message.params.name));
  expect(new Set(pythonReads.map(row => row.message.params.name))).toEqual(new Set(contract.readTools));
  const stableRead = pythonReads.filter(row => row.message.params.name !== 'recall');
  expect(new Set(stableRead.map(row => row.message.params._meta['com.engram/context'].runId)).size).toBe(1);
});
