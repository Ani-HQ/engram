import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicAgentCatalog } from './public-agent-catalog.js';
import { agentSources } from './tooling.js';

test('public ecosystem includes every named console source and all additional diagram/setup products', () => {
  const ids = publicAgentCatalog.map(product => product.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [id] of agentSources) if (id !== 'other') expect(ids).toContain(id);
  for (const id of ['muse', 'devin', 'vscode']) expect(ids).toContain(id);
  // Products with no way to connect to Engram are not shown.
  for (const id of ['instinct', 'aider']) expect(ids).not.toContain(id);
  const page = readFileSync(new URL('./home.html', import.meta.url), 'utf8');
  for (const { id, label, logo } of publicAgentCatalog) {
    expect(page).toContain(`data-agent-product="${id}"`);
    expect(page).toContain(`src="${logo}"`);
    expect(page).toContain(label);
    expect(logo).toMatch(/^\/vendor\/(?:brands|simple-icons)\/[a-z0-9-]+\.(?:svg|png)$/);
    expect(readFileSync(new URL(`.${logo}`, import.meta.url)).length).toBeGreaterThan(100);
  }
  expect(page).toContain('MCP support and setup vary by client.');
  expect(page).not.toContain('aria-label="Compatible MCP clients"');
});

test('additional official product marks retain their recorded original bytes', () => {
  for (const [file, expected] of [
    ['vscode.png', '7ac29e00cd66e549acc2ea6a99a813f92cb23a6d165293be6959845670f0c5a4'],
    ['muse.svg', '6373d89d274258a38432f3c3729cd716498b8ded849b174a7998683dcf4aaba5'],
  ]) {
    const data = readFileSync(new URL(`./vendor/brands/${file}`, import.meta.url));
    expect(createHash('sha256').update(data).digest('hex')).toBe(expected);
  }
});
