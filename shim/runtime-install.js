'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runtimeCapabilities } = require('./runtime-contracts');
const yaml = require('./yaml-block');

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object. Export the portable skill for a runtime using another config format.`);
  return value;
}
function managedCommand(entry, runtime) {
  return [entry?.command, entry?.bash, ...(entry?.hooks || []).map(hook => hook.command)].some(command => typeof command === 'string' && command.includes(` memory hook ${runtime}`));
}

// Shown by runtimes that display a hook's status, so a person reviewing or
// watching hooks can tell what each Engram hook does.
const HOOK_LABELS = {
  SessionStart: 'Engram: loading project context', UserPromptSubmit: 'Engram: checking shared memory',
  Stop: 'Engram: checking for a handoff save', SessionEnd: 'Engram: closing the session record',
};
function hookLabel(event) { return HOOK_LABELS[event] || 'Engram'; }

// Amp loads plugins as JavaScript modules in its own runtime. The plugin runs
// the installed bridge as a separate process, so Engram's code never depends on
// that runtime, and sends only the current prompt and thread identity.
function ampPlugin(node, entrypoint) {
  return `// Engram managed native adapter. Sends only the current prompt; no transcript capture or credentials.
const NODE = ${JSON.stringify(node)};
const ENTRYPOINT = ${JSON.stringify(entrypoint)};

async function bridge(input) {
  try {
    const { spawn } = await import('node:child_process');
    return await new Promise(resolve => {
      let output = '';
      const child = spawn(NODE, [ENTRYPOINT, 'memory', 'hook', 'amp', 'agent.start'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => { child.kill(); resolve({}); }, 8000);
      child.on('error', () => { clearTimeout(timer); resolve({}); });
      child.stdout.on('data', chunk => { if (output.length < 65536) output += chunk; });
      child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(output) || {}); } catch { resolve({}); } });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
  } catch { return {}; }
}

export default function (amp) {
  const started = new Set();
  amp.on('agent.start', async event => {
    try {
      const root = amp.system?.workspaceRoot;
      const cwd = root ? await amp.helpers.filePathFromURI(root) : null;
      const thread = event?.thread?.id;
      if (typeof cwd !== 'string' || !cwd || typeof thread !== 'string' || typeof event.message !== 'string') return {};
      const firstTurn = !started.has(thread);
      started.add(thread);
      while (started.size > 128) started.delete(started.values().next().value);
      const result = await bridge({ hook_event_name: 'agent.start', sessionId: thread, cwd, prompt: event.message, messageID: event.id, firstTurn });
      return typeof result?.context === 'string' && result.context ? { message: { content: result.context, display: false } } : {};
    } catch { return {}; }
  });
}
`;
}

function planInstall(runtime, options, helpers) {
  const contract = runtimeCapabilities(runtime);
  if (!contract?.installable || contract.kind === 'guidance') throw new Error('This runtime uses portable guidance or the generic bridge; no native installer is certified.');
  if (!contract.platforms.includes(options.platform || process.platform)) throw new Error('Native installers currently support macOS and Linux. Export the portable skill on this platform.');
  const { readPrivate, readTextPrivate, noLinks, shellQuote } = helpers;
  const home = options.home;
  const command = event => `${shellQuote(process.execPath)} ${shellQuote(options.entrypoint || path.join(__dirname, 'index.js'))} memory hook ${runtime}${event ? ` ${event}` : ''}`;
  const writes = [];
  let settings;
  const hookFile = (file, style, events, extra = {}) => {
    const value = object(readPrivate(file, {}), 'Runtime settings');
    if (extra.version && value.version !== undefined && value.version !== extra.version) throw new Error('Unsupported existing hook configuration version. Existing settings were preserved.');
    if (value.disableAllHooks === true) throw new Error('Hooks are explicitly disabled in this file. Review that policy before opting in.');
    value.hooks = object(value.hooks || {}, 'Runtime hooks');
    for (const event of events) {
      const existing = value.hooks[event] || [];
      if (!Array.isArray(existing)) throw new Error('Runtime event hooks must be arrays. Existing settings were preserved.');
      const retained = existing.filter(entry => !managedCommand(entry, runtime));
      let entry;
      if (style === 'nested') entry = { hooks: [{ type: 'command', command: command(event), timeout: runtime === 'gemini' ? 6000 : 6, ...(runtime === 'codex' ? { additionalContextLimit: 1400, statusMessage: hookLabel(event) } : {}) }] };
      else if (style === 'copilot') entry = { type: 'command', bash: command(event), timeoutSec: 6 };
      else entry = { command: command(event), ...(runtime === 'cursor' ? { timeout: 6 } : {}) };
      value.hooks[event] = [...retained, entry];
    }
    Object.assign(value, extra);
    writes.push({ file, kind: 'json', value });
    settings = file;
  };
  const textFile = (file, content) => {
    noLinks(file);
    const prior = readTextPrivate(file, null);
    if (prior !== null && !prior.includes('Engram managed native adapter')) throw new Error('An unrelated plugin already uses the Engram adapter filename. Choose portable guidance or rename it before installing.');
    writes.push({ file, kind: 'text', value: content });
  };
  if (runtime === 'codex') hookFile(path.join(home, '.codex', 'hooks.json'), 'nested', contract.events);
  if (runtime === 'cursor') hookFile(path.join(home, '.cursor', 'hooks.json'), 'flat', contract.events, { version: 1 });
  if (runtime === 'gemini') hookFile(path.join(home, '.gemini', 'settings.json'), 'nested', contract.events);
  if (runtime === 'copilot') hookFile(path.join(options.project, '.github', 'hooks', 'engram-memory.json'), 'copilot', contract.events, { version: 1 });
  if (runtime === 'windsurf') hookFile(path.join(home, '.codeium', 'windsurf', 'hooks.json'), 'flat', contract.events);
  // Devin CLI's user config, a documented literal path (no XDG override is documented).
  if (runtime === 'devin') hookFile(path.join(home, '.config', 'devin', 'config.json'), 'nested', contract.events);
  if (runtime === 'hermes') {
    // Hermes shell hooks live in config.yaml beside its MCP servers. Only our
    // own list items are replaced; every other line is kept as written.
    const file = path.join(home, '.hermes', 'config.yaml');
    noLinks(file);
    let text = readTextPrivate(file, '');
    for (const event of contract.events) text = yaml.setSequenceItem(text, 'hooks', event, item => item.includes(' memory hook hermes'), [`- command: ${yaml.quote(command(event))}`, '  timeout: 10']);
    writes.push({ file, kind: 'text', value: text });
    settings = file;
  }
  if (runtime === 'amp') {
    // A system plugin, where Amp's documentation says to put one.
    const file = path.join(options.configHome || path.join(home, '.config'), 'amp', 'plugins', 'engram-memory.js');
    textFile(file, ampPlugin(options.nodePath || process.execPath, options.entrypoint || path.join(__dirname, 'index.js')));
    settings = file;
  }
  if (runtime === 'opencode') {
    const file = path.join(options.configHome || path.join(home, '.config'), 'opencode', 'plugins', 'engram-memory.js');
    textFile(file, `// Engram managed native adapter. No credentials or transcript capture.\nimport { createRequire } from 'node:module';\nconst { openCodePlugin } = createRequire(import.meta.url)(${JSON.stringify(options.pluginModule || path.join(__dirname, 'runtime-plugins.js'))});\nexport const EngramMemory = openCodePlugin;\n`);
    settings = file;
  }
  if (runtime === 'openclaw') {
    const dir = path.join(options.configHome || path.join(home, '.config'), 'engram', 'runtime-plugins', 'openclaw');
    textFile(path.join(dir, 'index.js'), `// Engram managed native adapter. Reads only the explicit current request.\nimport { createRequire } from 'node:module';\nconst { openClawPlugin } = createRequire(import.meta.url)(${JSON.stringify(options.pluginModule || path.join(__dirname, 'runtime-plugins.js'))});\nexport default openClawPlugin;\n`);
    writes.push({ file: path.join(dir, 'package.json'), kind: 'json', value: { name: 'engram-memory-local', version: require('./package.json').version, private: true, type: 'module', openclaw: { extensions: ['./index.js'] } } });
    writes.push({ file: path.join(dir, 'openclaw.plugin.json'), kind: 'json', value: { id: 'engram-memory', name: 'Engram shared memory', description: 'Bounded project memory with explicit durable deltas.', activation: { onCapabilities: ['hook'] }, configSchema: { type: 'object', additionalProperties: false, properties: {} } } });
    const file = path.join(home, '.openclaw', 'openclaw.json');
    const config = object(readPrivate(file, {}), 'OpenClaw settings');
    config.plugins = object(config.plugins || {}, 'OpenClaw plugins');
    if (config.plugins.enabled === false) throw new Error('OpenClaw plugins are explicitly disabled. Review that policy before opting in.');
    config.plugins.load = object(config.plugins.load || {}, 'OpenClaw plugin loading');
    const paths = config.plugins.load.paths || [];
    if (!Array.isArray(paths) || paths.some(item => typeof item !== 'string')) throw new Error('OpenClaw plugin paths must be an array. Existing settings were preserved.');
    config.plugins.load.paths = [...new Set([...paths, dir])];
    if (Array.isArray(config.plugins.deny) && config.plugins.deny.includes('engram-memory')) throw new Error('Engram is explicitly denied in OpenClaw. Remove that deny yourself before opting in.');
    if (config.plugins.allow !== undefined) {
      if (!Array.isArray(config.plugins.allow)) throw new Error('OpenClaw plugin allowlist must be an array.');
      config.plugins.allow = [...new Set([...config.plugins.allow, 'engram-memory'])];
    }
    config.plugins.entries = object(config.plugins.entries || {}, 'OpenClaw plugin entries');
    const entry = object(config.plugins.entries['engram-memory'] || {}, 'Engram OpenClaw entry');
    const hooks = object(entry.hooks || {}, 'Engram OpenClaw hook policy');
    config.plugins.entries['engram-memory'] = { ...entry, enabled: true, hooks: { ...hooks, allowPromptInjection: true, allowConversationAccess: true } };
    writes.push({ file, kind: 'json', value: config }); settings = file;
  }
  // Preflight every target before committing a private binding or plugin file.
  for (const write of writes) { noLinks(write.file); if (write.kind === 'json' && fs.existsSync(write.file)) object(readPrivate(write.file, {}), 'Runtime configuration'); }
  return { writes, settings, contract };
}

function planSkill(runtime, options, helpers) {
  const folders = { claude: '.claude', codex: '.agents', cursor: '.cursor', gemini: '.gemini', copilot: '.github', opencode: '.opencode', windsurf: '.devin' };
  if (!folders[runtime]) throw new Error('This runtime has no documented automatic skill-directory installation. Use its supported app skill controls.');
  const scope = options.skillScope || 'project';
  if (!['user', 'project'].includes(scope)) throw new Error('Skill scope must be user or project.');
  if (scope === 'user' && runtime !== 'codex') throw new Error('User-scoped automatic skill installation is currently supported only for Codex.');
  if (scope === 'user' && !options.home) throw new Error('User skill installation requires a known home directory.');
  const file = path.join(scope === 'user' ? options.home : options.project, folders[runtime], 'skills', 'engram-memory', 'SKILL.md');
  helpers.noLinks(file);
  const marker = '<!-- Engram managed portable workflow -->';
  const prior = helpers.readTextPrivate(file, null);
  if (prior !== null && !prior.includes(marker)) throw new Error('An existing user skill has the Engram name. It was preserved; choose another scope or move that skill using your runtime controls.');
  const content = fs.readFileSync(path.join(__dirname, 'skills', 'engram-portable', 'SKILL.md'), 'utf8').replace('{{RUNTIME_LABEL}}', runtimeCapabilities(runtime)?.label || runtime);
  return { settings: file, writes: [{ file, kind: 'text', value: content + '\n' + marker + '\n' }] };
}

module.exports = { planInstall, planSkill, hookLabel, ampPlugin };
