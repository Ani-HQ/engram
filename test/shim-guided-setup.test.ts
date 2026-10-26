import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const cli = path.resolve(import.meta.dir, '../shim/index.js');
const memory = require('../shim/memory.js');
const setupFiles = require('../shim/setup-files.js');
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'engram-guided-setup-')));
const secret = 'eng_synthetic-guided-setup-never-real';
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const home = mkdtempSync(path.join(root, 'home-'));
  const project = path.join(home, 'project'); mkdirSync(project);
  const env = { ...process.env, HOME: home, ENGRAM_TOKEN: '', ENGRAM_HOST: '', XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
  return { home, project, env };
}
async function run(args: string[], f: ReturnType<typeof fixture>, extra = {}, input = '') {
  const child = Bun.spawn(['node', cli, ...args], { cwd: f.project, env: { ...f.env, ...extra }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(input); child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stdout + stderr).not.toContain(secret);
  return { code, stdout, stderr };
}
function server(status = 200) {
  const calls: any[] = [];
  const service = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: any = await request.json(); calls.push(body);
    expect(request.headers.get('Authorization')).toBe(`Bearer ${secret}`);
    if (status !== 200) return new Response('private diagnostics', { status });
    const value = body.params?.name === 'recall' ? { results: [{ text: 'Use stable request IDs when retrying background jobs. '.repeat(16) }] }
      : body.params?.name === 'remember' ? { ok: true, slug: 'fixture/retry-decision' }
      : body.params?.name === 'record_action' ? { ok: true, id: 'fixture-' + calls.length }
      : { token: 'synthetic-agent' };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: ['whoami', 'recall', 'remember', 'record_action'].map(name => ({ name, inputSchema: { type: 'object' } })) } : { content: [{ type: 'text', text: JSON.stringify(value) }] } });
  } });
  return { service, calls, host: service.url.origin };
}
function configFile(harness: string, f: ReturnType<typeof fixture>) {
  const paths: Record<string, string> = { claude: '.claude.json', codex: '.codex/config.toml', cursor: '.cursor/mcp.json', gemini: '.gemini/settings.json', copilot: '.copilot/mcp-config.json', opencode: '.config/opencode/opencode.json', openclaw: '.openclaw/openclaw.json', windsurf: '.codeium/windsurf/mcp_config.json' };
  return path.join(f.home, paths[harness]);
}

describe('one-command project onboarding', () => {
  test('each supported local target installs MCP and memory together without config or Markdown edits', async () => {
    const upstream = server();
    try {
      for (const harness of ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'opencode', 'openclaw', 'windsurf']) {
        const f = fixture();
        const result = await run(['setup', harness, '--host', upstream.host, '--project', '.', '--token-stdin'], f, {}, secret);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('Project memory workflow installed');
        expect(result.stdout).toContain('No memories or task reports were created');
        expect(result.stdout).not.toContain('paste this into your agent');
        const config = readFileSync(configFile(harness, f), 'utf8');
        expect(config).toContain(upstream.host + '/mcp');
        expect(config).toContain(secret);
        const binding = JSON.parse(readFileSync(path.join(f.home, '.config/engram/memory.json'), 'utf8')).bindings[0];
        expect(binding.project).toBe(f.project); expect(binding.topic).toBe('project'); expect(binding.budget).toBe(4096);
        expect(statSync(path.join(f.home, '.config/engram/memory.json')).mode & 0o777).toBe(0o600);
        const runtimes = readdirSync(path.join(f.home, '.local/share/engram-mcp/runtimes'));
        expect(runtimes).toHaveLength(1);
        const payload = path.join(f.home, '.local/share/engram-mcp/runtimes', runtimes[0]);
        expect(existsSync(path.join(payload, 'index.js'))).toBe(true);
        expect(existsSync(path.join(payload, 'setup-files.js'))).toBe(true);
        const hooks = harness === 'claude' ? readFileSync(path.join(f.home, '.claude/settings.json'), 'utf8') : harness === 'codex' ? readFileSync(path.join(f.home, '.codex/hooks.json'), 'utf8') : '';
        if (hooks) { expect(hooks).toContain(payload); expect(hooks).not.toContain(path.dirname(cli)); }
        if (harness === 'windsurf') {
          expect(existsSync(path.join(f.project, '.devin/skills/engram-memory/SKILL.md'))).toBe(true);
          expect(result.stdout).toContain('no hard cumulative task budget');
          expect(result.stdout).not.toContain('4096 bytes per task through this adapter');
        }
      }
      expect(upstream.calls).toHaveLength(16);
      expect(upstream.calls.every(call => call.method === 'tools/list' || call.params?.name === 'whoami')).toBe(true);
    } finally { upstream.service.stop(true); }
  });

  test('upgrade reuses only the same endpoint key and is idempotent with unrelated settings preserved', async () => {
    const upstream = server(), other = server(), f = fixture();
    const file = configFile('gemini', f); mkdirSync(path.dirname(file));
    writeFileSync(file, JSON.stringify({ theme: 'keep', mcpServers: { unrelated: { command: 'keep' } }, hooks: { BeforeAgent: [{ hooks: [{ command: 'keep-hook' }] }] } }), { mode: 0o600 });
    try {
      const args = ['setup', 'gemini', '--host', upstream.host, '--project', '.'];
      expect((await run(args, f, { ENGRAM_TOKEN: secret })).code).toBe(0);
      const initial = readFileSync(file, 'utf8'), backups = readdirSync(path.dirname(file)).filter(name => name.includes('engram-backup'));
      const upgraded = await run(['upgrade', 'gemini', '--project', '.'], f);
      expect(upgraded.code, upgraded.stderr).toBe(0); expect(upgraded.stdout).toContain('0 files updated');
      expect(readFileSync(file, 'utf8')).toBe(initial);
      expect(readdirSync(path.dirname(file)).filter(name => name.includes('engram-backup'))).toEqual(backups);
      const config = JSON.parse(initial); expect(config.theme).toBe('keep'); expect(config.mcpServers.unrelated.command).toBe('keep'); expect(config.hooks.BeforeAgent[0].hooks[0].command).toBe('keep-hook');
      const different = await run(['upgrade', 'gemini', '--host', other.host, '--project', '.'], f);
      expect(different.code).toBe(1); expect(other.calls).toEqual([]); expect(readFileSync(file, 'utf8')).toBe(initial);
    } finally { upstream.service.stop(true); other.service.stop(true); }
  });

  test('runtime-managed OAuth is preserved byte-for-byte and receives a project skill without token extraction', async () => {
    const f = fixture(), file = configFile('codex', f); mkdirSync(path.dirname(file));
    const original = '[mcp_servers.engram]\nurl = "https://engram.ani.computer/mcp"\ntools = ["recall", "remember"]\n';
    writeFileSync(file, original, { mode: 0o600 });
    const result = await run(['upgrade', 'codex', '--project', '.'], f);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(result.stdout).toContain('Existing runtime-managed connection preserved');
    expect(result.stdout).toContain('was not tested by this CLI');
    expect(result.stdout).toContain('no cumulative task budget');
    expect(existsSync(path.join(f.project, '.agents/skills/engram-memory/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(f.home, '.config/engram/memory.json'))).toBe(false);
    expect(existsSync(path.join(f.home, '.codex/hooks.json'))).toBe(false);
  });

  test('Codex OAuth user scope installs one managed personal skill while leaving the project and authentication unchanged', async () => {
    const f = fixture(), file = configFile('codex', f); mkdirSync(path.dirname(file));
    const original = '[mcp_servers.engram]\nurl = "https://engram.ani.computer/mcp"\ntools = ["recall", "remember"]\n';
    writeFileSync(file, original, { mode: 0o600 });
    const result = await run(['upgrade', 'codex', '--project', '.', '--skill-scope', 'user'], f);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('User memory skill installed');
    expect(result.stdout).toContain('model-chosen');
    expect(result.stdout).toContain('was not tested by this CLI');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(f.project)).toEqual([]);
    const skillFile = path.join(f.home, '.agents/skills/engram-memory/SKILL.md');
    const skill = readFileSync(skillFile, 'utf8');
    expect(skill).toContain('Engram managed portable workflow');
    expect(skill).toContain('Target runtime: Codex');
    expect(skill).not.toContain(secret);
    expect(statSync(skillFile).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(f.home, '.config/engram/memory.json'))).toBe(false);
    expect(existsSync(path.join(f.home, '.codex/hooks.json'))).toBe(false);
    const rerun = await run(['upgrade', 'codex', '--project', '.', '--skill-scope', 'user'], f);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(readdirSync(path.dirname(skillFile))).toEqual(['SKILL.md']);
  });

  test('personal skill setup preserves an existing unmanaged skill and rejects unsupported or invalid scopes without mutation', async () => {
    const f = fixture(), file = configFile('codex', f); mkdirSync(path.dirname(file));
    const config = '[mcp_servers.engram]\nurl = "https://engram.ani.computer/mcp"\n';
    writeFileSync(file, config, { mode: 0o600 });
    const skillFile = path.join(f.home, '.agents/skills/engram-memory/SKILL.md'); mkdirSync(path.dirname(skillFile), { recursive: true });
    const userSkill = '---\nname: engram-memory\n---\nMy own workflow.\n'; writeFileSync(skillFile, userSkill, { mode: 0o600 });
    const conflict = await run(['upgrade', 'codex', '--project', '.', '--skill-scope', 'user'], f);
    expect(conflict.code).toBe(1); expect(conflict.stderr).toContain('was preserved');
    expect(readFileSync(skillFile, 'utf8')).toBe(userSkill); expect(readFileSync(file, 'utf8')).toBe(config); expect(readdirSync(f.project)).toEqual([]);
    const untouched = fixture();
    for (const args of [['setup', 'claude', '--project', '.', '--skill-scope', 'user'], ['setup', 'codex', '--project', '.', '--skill-scope', 'team']]) {
      expect((await run(args, untouched)).code).toBe(1);
      expect(readdirSync(untouched.home)).toEqual(['project']);
    }
  });

  test('portable installation is labeled model-chosen and does not claim a task cap or enable hooks', async () => {
    const f = fixture(), upstream = server();
    try {
      const result = await run(['setup', 'cursor', '--portable', '--project', '.', '--host', upstream.host], f, { ENGRAM_TOKEN: secret });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain('skill installed'); expect(result.stdout).toContain('no hard cumulative task budget');
      expect(existsSync(path.join(f.project, '.cursor/skills/engram-memory/SKILL.md'))).toBe(true);
      expect(existsSync(path.join(f.home, '.cursor/hooks.json'))).toBe(false);
    } finally { upstream.service.stop(true); }
  });

  test('explicit full mode requires a project and cloud-only runtime targets never claim local repair', async () => {
    const f = fixture();
    for (const args of [['setup', 'claude', '--memory'], ['upgrade', 'claude'], ['setup', 'grokbot', '--project', '.'], ['setup', 'generic', '--project', '.']]) expect((await run(args, f)).code).toBe(1);
    expect(readdirSync(f.home)).toEqual(['project']);
  });

  test('disabled hooks, malformed config, symlinks, and denied keys fail before any setup file is committed', async () => {
    const upstream = server(), denied = server(401);
    try {
      for (const failure of ['disabled', 'malformed', 'linked', 'denied']) {
        const f = fixture(), file = configFile('claude', f);
        if (failure === 'disabled') { mkdirSync(path.join(f.home, '.claude')); writeFileSync(path.join(f.home, '.claude/settings.json'), '{"disableAllHooks":true}'); }
        if (failure === 'malformed') writeFileSync(file, '{bad config');
        if (failure === 'linked') { writeFileSync(path.join(f.home, 'keep.json'), '{}'); symlinkSync(path.join(f.home, 'keep.json'), file); }
        const result = await run(['setup', 'claude', '--project', '.', '--host', failure === 'denied' ? denied.host : upstream.host], f, { ENGRAM_TOKEN: secret });
        expect(result.code).toBe(1); expect(result.stdout).not.toContain('workflow installed');
        expect(existsSync(path.join(f.home, '.config/engram/memory.json'))).toBe(false);
        expect(existsSync(path.join(f.home, '.local/share/engram-mcp'))).toBe(false);
        if (failure === 'linked') expect(readFileSync(path.join(f.home, 'keep.json'), 'utf8')).toBe('{}');
      }
    } finally { upstream.service.stop(true); denied.service.stop(true); }
  });
});

describe('setup transaction recovery', () => {
  test('npx-only hook guidance executes decisions, no-change and known task outcomes after cache eviction without a global connector binary', async () => {
    const f = fixture(), upstream = server(), node = Bun.which('node')!;
    let longHome = f.home;
    while (longHome.length < 300) {
      const length = Math.min(48, 300 - longHome.length - 1);
      if (length < 1) throw new Error('Fixture home needs another path component');
      const part = (longHome === f.home ? "memory home's long path " : 'memory home long path ').padEnd(48, 'x').slice(0, length);
      longHome = path.join(longHome, part); mkdirSync(longHome);
    }
    f.home = longHome;
    f.project = path.join(longHome, 'project'); mkdirSync(f.project);
    Object.assign(f.env, { HOME: longHome, XDG_CONFIG_HOME: path.join(longHome, '.config'), XDG_STATE_HOME: path.join(longHome, '.local/state'), XDG_CACHE_HOME: path.join(longHome, '.cache') });
    const source = path.join(f.home, "npm's temporary source"); mkdirSync(source);
    f.env.XDG_DATA_HOME = path.join(f.home, "private data's runtime home");
    const packageRoot = path.resolve(import.meta.dir, '../shim');
    const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    for (const file of ['package.json', ...metadata.files.filter((file: string) => file.endsWith('.js') || file.endsWith('/SKILL.md'))]) {
      mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      writeFileSync(path.join(source, file), readFileSync(path.join(packageRoot, file)));
    }
    const env = { ...f.env, PATH: '' };
    const execute = async (argv: string[], input: object | undefined = undefined, extra = {}) => {
      const child = Bun.spawn(argv, { cwd: f.project, env: { ...env, ...extra }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      if (input) child.stdin.write(JSON.stringify(input)); child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stdout + stderr).not.toContain(secret); expect(code, stderr).toBe(0);
      return stdout;
    };
    try {
      const setup = [node, path.join(source, 'index.js'), 'setup', 'claude', '--project', '.', '--budget', '1024', '--host', upstream.host];
      await execute(setup, undefined, { ENGRAM_TOKEN: secret });
      expect(await execute(setup, undefined, { ENGRAM_TOKEN: secret })).toContain('0 files updated');
      const settings = JSON.parse(readFileSync(path.join(f.home, '.claude/settings.json'), 'utf8'));
      const hook = (event: string) => settings.hooks[event][0].hooks[0].command;
      rmSync(source, { recursive: true });
      const session = { session_id: 'evicted-npx-fixture', cwd: f.project };
      const invoke = async (event: string, extra = {}) => JSON.parse(await execute(['/bin/sh', '-c', hook(event)], { ...session, hook_event_name: event, ...extra }));
      const startup = (await invoke('SessionStart')).hookSpecificOutput.additionalContext;
      const bridge = /Installed bridge command:\n([^\n]+)/.exec(startup)![1];
      expect(bridge).toContain('private data'); expect(bridge).toContain('runtime home');
      expect(bridge).not.toContain(source);
      expect(startup).not.toContain('engram-mcp memory ');
      for (const action of ['decision', 'no-change', 'task-end']) expect(startup).toContain(action + ' --run <run-id>');
      const prompt = { prompt: 'Engram task: Validate the installed bridge after npm cache eviction' };
      const context = (await invoke('UserPromptSubmit', prompt)).hookSpecificOutput.additionalContext;
      expect(context).toContain('Use stable request IDs'); expect(context).toContain(bridge);
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1024);
      const memoryStart = context.indexOf('\n') + 1;
      const memoryEnd = context.indexOf('\nEnd. Lifecycle run:');
      expect(memoryEnd).toBeGreaterThan(memoryStart);
      expect(Buffer.byteLength(context.slice(memoryStart, memoryEnd))).toBeGreaterThanOrEqual(128);
      expect(await invoke('UserPromptSubmit', prompt)).toEqual({});
      const runId = /Lifecycle run: (em_[a-f0-9]{64})/.exec(context)![1];
      const stop = await invoke('Stop'); expect(stop.decision).toBe('block'); expect(stop.reason).toContain(bridge); expect(stop.reason).not.toContain('engram-mcp memory ');
      const decisionExample = /decision --run <run-id>, JSON stdin (\{[^\n;]+\})/.exec(context)![1];
      const decision = JSON.parse(await execute(['/bin/sh', '-c', bridge + ' decision --run ' + runId], JSON.parse(decisionExample)));
      expect(decision.status).toBe('saved');
      const outcomeExample = /task-end --run <run-id>, JSON stdin (\{[^\n]+?\})/.exec(context)![1];
      const ended = JSON.parse(await execute(['/bin/sh', '-c', bridge + ' task-end --run ' + runId], JSON.parse(outcomeExample)));
      expect(ended.status).toBe('recorded');
      expect(await invoke('Stop')).toEqual({});
      const followup = (await invoke('UserPromptSubmit', { prompt: 'Engram task: Validate an explicit no change outcome after cache eviction' })).hookSpecificOutput.additionalContext;
      const nextId = /Lifecycle run: (em_[a-f0-9]{64})/.exec(followup)![1];
      expect(nextId).not.toBe(runId);
      const noChange = JSON.parse(await execute(['/bin/sh', '-c', bridge + ' no-change --run ' + nextId]));
      expect(noChange.status).toBe('no-change');
      expect(await invoke('Stop')).toEqual({});
      expect(upstream.calls.filter(call => call.params?.name === 'remember')).toHaveLength(1);
      expect(upstream.calls.filter(call => call.params?.name === 'recall')).toHaveLength(2);
      expect(upstream.calls.filter(call => call.params?.arguments?.status === 'completed')).toHaveLength(1);
      expect(existsSync(path.join(f.home, '.claude/settings.json'))).toBe(true);
    } finally { upstream.service.stop(true); }
  });
  test('installed hooks remain executable after the temporary npm package source is removed', async () => {
    const f = fixture(), source = path.join(f.home, 'temporary-npx-source'); mkdirSync(source);
    const packageRoot = path.resolve(import.meta.dir, '../shim');
    const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    for (const file of ['package.json', ...metadata.files.filter((file: string) => file.endsWith('.js') || file.endsWith('/SKILL.md'))]) {
      mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      writeFileSync(path.join(source, file), readFileSync(path.join(packageRoot, file)));
    }
    const payload = setupFiles.runtimePayload({ source, home: f.home }, memory.internals);
    setupFiles.commitWrites(setupFiles.planWrites(payload.writes, memory.internals), memory.internals);
    rmSync(source, { recursive: true });
    const child = Bun.spawn(['node', payload.entrypoint, 'memory', 'hook', 'claude'], { cwd: f.project, env: f.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'synthetic-session', cwd: f.project })); child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual({});
    // Loading the complete capability registry also exercises the copied module
    // dependencies, without requiring proxy-only npm dependencies.
    const capabilities = Bun.spawn(['node', payload.entrypoint, 'memory', 'capabilities', 'claude'], { cwd: f.project, env: f.env, stdout: 'pipe', stderr: 'pipe' });
    expect(await capabilities.exited).toBe(0);
    expect(JSON.parse(await new Response(capabilities.stdout).text()).id).toBe('claude');
  });
  test('failed writes restore exact original content and permissions while preserving private backups', () => {
    const dir = mkdtempSync(path.join(root, 'recovery-')), first = path.join(dir, 'first.json'), second = path.join(dir, 'second.json');
    writeFileSync(first, '{"original": true}\n', { mode: 0o640 });
    const plan = setupFiles.planWrites([{ file: first, kind: 'json', value: { updated: true } }, { file: second, kind: 'json', value: {} }], memory.internals);
    expect(() => setupFiles.commitWrites(plan, memory.internals, { beforeWrite(_item: any, changed: number) { if (changed === 1) throw new Error('synthetic disk failure'); } })).toThrow('were restored');
    expect(readFileSync(first, 'utf8')).toBe('{"original": true}\n'); expect(statSync(first).mode & 0o777).toBe(0o640); expect(existsSync(second)).toBe(false);
    const backups = readdirSync(dir).filter(name => name.includes('engram-backup')); expect(backups).toHaveLength(1); expect(statSync(path.join(dir, backups[0])).mode & 0o777).toBe(0o600);
  });
  test('preflight notices concurrent configuration changes and never overwrites them', () => {
    const dir = mkdtempSync(path.join(root, 'changed-')), file = path.join(dir, 'config.json'); writeFileSync(file, '{}');
    const plan = setupFiles.planWrites([{ file, kind: 'json', value: { updated: true } }], memory.internals);
    writeFileSync(file, '{"userEdit":true}');
    expect(() => setupFiles.commitWrites(plan, memory.internals)).toThrow('Configuration changed');
    expect(readFileSync(file, 'utf8')).toBe('{"userEdit":true}');
  });
});
