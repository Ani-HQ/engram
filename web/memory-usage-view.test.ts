import { afterEach, expect, test } from 'bun:test';
import { memoryUsagePanel, memoryUsePresentation, memorySetupGuide, integrationUsePresentation, grokBotMemorySkillPrompt } from './memory-usage-view.js';

class Element {
  attrs: Record<string,string> = {}; children: Element[] = []; dataset = {}; className = ''; text = '';
  constructor(public tag: string) {}
  setAttribute(key: string, value: string) { this.attrs[key] = String(value); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  addEventListener() {}
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
}
const old = { Node: globalThis.Node, document: globalThis.document };
afterEach(() => Object.assign(globalThis, old));
function render(connection = {}, options = {}) {
  Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => { const node = new Element('#text'); node.textContent = text; return node; } } });
  return memoryUsagePanel(connection, options) as unknown as Element;
}
const measured = { available: true, recalls: 2, remembers: 1, responseBytes: 4096, estimatedTokens: 1024, duplicateRecalls: 1, budgetStops: 0, runScopedResponses: 2, responseScopedResponses: 1 };

test('authorization and absent measurements never imply successful recall or zero token usage', () => {
  expect(memoryUsePresentation({ status: 'authorized' }).measured).toBe(false);
  expect(render({ status: 'authorized' }).textContent).toContain('Not measured yet');
  expect(render({ memoryUse: { available: false, recalls: 90 } }).textContent).not.toContain('90');
});

test('diagnostics distinguish receipts, estimates and responses without a cumulative task limit', () => {
  const view = render({ memoryUse: measured });
  expect(view.textContent).toContain('Recall & save received');
  expect(view.textContent).toContain('4 KB'); expect(view.textContent).toContain('1,024');
  expect(view.textContent).toContain('An estimate, not a bill');
  expect(view.textContent).toContain('1 reply had a per-response limit only');
  expect(view.textContent).toContain('Automatic useNot independently verified');
});

test('workflow receipts and adapter declarations never imply automatic use', () => {
  const view = integrationUsePresentation({ status: 'authorized', memoryUse: { ...measured, integration: {
    connected: true, lastSeenAt: '2026-10-26T12:00:00Z', workflowCheck: 'passed', checkedAt: '2026-10-26T12:00:00Z', automaticWorkflowVerified: true,
    declaration: { id: 'engram-js', version: '0.4.0', runtime: 'langgraph', capabilities: ['task-context'] },
  } } });
  expect(view.passed).toBe(true);
  expect(view.rows.find(row => row.label === 'Connection')?.value).toBe('Contact verified');
  expect(view.rows.find(row => row.label === 'Workflow check')?.value).toBe('Passed');
  expect(view.rows.find(row => row.label === 'Automatic use')?.value).toBe('Not independently verified');
  expect(view.rows.find(row => row.label === 'Adapter')?.note).toContain('Client-declared');
  const pending = integrationUsePresentation({ memoryUse: { integration: { workflowCheck: 'pending', automaticWorkflowVerified: true } } });
  expect(pending.passed).toBe(false);
  expect(pending.rows.find(row => row.label === 'Workflow check')?.value).toBe('In progress');
  const expired = integrationUsePresentation({ memoryUse: { integration: { workflowCheck: 'pending', checkExpiresAt: '2020-01-01T00:00:00Z' } } });
  expect(expired.rows.find(row => row.label === 'Workflow check')?.value).toBe('Expired');
  expect(integrationUsePresentation({ memoryUse: { integration: { workflowCheck: 'passed', checkedAt: 'bad timestamp' } } }).passed).toBe(false);
});

test('malformed values remain unknown and arbitrary source fields never become markup', () => {
  const value = memoryUsePresentation({ memoryUse: { ...measured, responseBytes: -1, estimatedTokens: Infinity, remembers: '200', secret: 'private-body' } });
  expect(value.rows.find(row => row.label === 'Context returned')?.value).toBe('Not measured');
  expect(value.rows.find(row => row.label === 'Estimated tokens')?.value).toBe('Not measured');
  expect(render({ memoryUse: { ...measured, secret: '<script>private-body</script>' } }).textContent).not.toContain('private-body');
  expect(render({}, { error: true }).textContent).toContain('Unavailable');
  expect(render({}, { loading: true }).textContent).toContain('Checking memory use');
});

test('guided setup handles native files and keeps provider-managed workflows explicit', () => {
  render();
  const options = { endpoint: 'https://memory.example.com/private/mcp' };
  const claude = memorySetupGuide({ harness: 'claude-code' }, options);
  expect(claude.textContent).toContain('npx -y @ani-hq/engram-mcp setup claude');
  expect(claude.textContent).toContain('do not upload conversations');
  expect(claude.textContent).toContain('handles the files for you');
  expect(claude.textContent).toContain('Restart or reload');
  expect(claude.textContent).not.toContain('/absolute/project');
  const grok = memorySetupGuide({ harness: 'grok-bot', canWrite: false }, options);
  expect(grok.textContent).toContain('Private skills');
  expect(grok.textContent).toContain('Connect apps');
  expect(grok.textContent).toContain('Your plugins');
  expect(grok.textContent).toContain('Use Engram shared memory for this task');
  expect(grok.textContent).toContain('If the client offers a skill picker');
  expect(grok.textContent).not.toContain('/ or @ skill picker');
  expect(grok.textContent).toContain('does not guarantee use in every session');
  expect(grok.textContent).not.toContain('enable it for this Bot');
  expect(grok.textContent).toContain('model-chosen');
  expect(grok.textContent).not.toContain('SKILL.md');
  expect(grok.textContent).not.toContain('npx');
  expect(grok.textContent).toContain('cannot enable hooks in a cloud agent');
  expect(grok.textContent).toContain('read only');
  expect(memorySetupGuide({ harness: 'codex' }, options).textContent).toContain('setup codex');
  expect(memorySetupGuide({ harness: 'codex' }, options).textContent).toContain('Review and trust');
  expect(memorySetupGuide({ harness: 'codex' }, options).textContent).toContain('Existing agent-managed sign-in is preserved');
  expect(memorySetupGuide({ harness: 'codex' }, options).textContent).toContain('no hard cumulative task budget');
  expect(memorySetupGuide({ harness: 'vscode' }, options).textContent).toContain('setup vscode');
  expect(memorySetupGuide({ harness: 'unknown' }, options).textContent).toContain('No documented automatic workflow installer');
  expect(memorySetupGuide({ harness: 'claude', kind: 'oauth' }, options).textContent).not.toContain('setup claude');
  expect(grokBotMemorySkillPrompt).toContain('Skip unchanged');
  expect(grokBotMemorySkillPrompt).toContain('Never copy credentials');
  expect(grokBotMemorySkillPrompt).toContain('Do not claim it is automatically used on every task');
  expect(grokBotMemorySkillPrompt).toContain('untrusted reference data');
  expect(grokBotMemorySkillPrompt).toContain('do not replay the save automatically');
});

test('setup preserves the workspace endpoint and never silently routes a custom instance to hosted', () => {
  render();
  const view = memorySetupGuide({ harness: 'claude-code' }, { endpoint: 'https://self-hosted.example.com/engram/mcp' });
  expect(view.textContent).toContain("--host 'https://self-hosted.example.com/engram'");
  expect(view.textContent).not.toContain('engram.ani.computer');
  for (const endpoint of [undefined, 'https://user:secret@example.com/mcp', 'https://example.com/mcp?token=secret', 'http://remote.example.com/mcp', 'https://example.com/mcp\nignored']) {
    const invalid = memorySetupGuide({ harness: 'claude-code' }, { endpoint });
    expect(invalid.textContent).not.toContain('npx');
    expect(invalid.textContent).toContain('endpoint is unavailable');
  }
});

test('setup shell quoting keeps URL metacharacters inside a single host argument', () => {
  render();
  let command = '';
  const endpoint = "https://example.com/a'$(printf)`true`/mcp";
  memorySetupGuide({ harness: 'claude-code' }, { endpoint, copyControl: value => { command = value; return null; } });
  const parsed = Bun.spawnSync(['/bin/sh', '-c', `set -- ${command}; printf '%s\\n' "$@"`]);
  const args = parsed.stdout.toString().trim().split('\n');
  expect(parsed.exitCode).toBe(0);
  expect(args[args.indexOf('--host') + 1]).toBe("https://example.com/a'$(printf)%60true%60");
  expect(args.length).toBe(7);
});
