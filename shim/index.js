#!/usr/bin/env node

/**
 * @ani-hq/engram-mcp — stdio MCP proxy to engram's HTTP /mcp surface.
 *
 * Env:
 *   ENGRAM_HOST   — base URL (required)
 *   ENGRAM_TOKEN  — bearer token (required)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { SERVER_INSTRUCTIONS } = require('./instructions');
const { connectorBranding } = require('./branding');

// HOME wins over the OS account lookup, matching the memory bridge, so a
// caller (or a test) that sets HOME never writes another home's config.
function homeDir() { return process.env.HOME || os.homedir(); }

const SUPPORTED_HARNESSES = ['claude', 'codex', 'cursor', 'vscode', 'windsurf'];

function dispatch() {
  const [subcommand, ...args] = process.argv.slice(2);

  if (subcommand === 'memory') {
    require('./memory').runMemoryCli(args).then(code => { process.exitCode = code; }).catch(() => {
      console.error('Memory lifecycle setup failed. Check the project binding, credentials, and file permissions. No transcript was captured.');
      process.exitCode = 1;
    });
    return;
  }

  // In a terminal, `engram-mcp` or `engram-mcp setup` with no agent named
  // connects the whole computer. Agents start the proxy without a terminal.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const computerSetup = interactive && ((!subcommand && !process.env.ENGRAM_TOKEN) || (subcommand === 'setup' && args.every((arg, i) => arg === '--host' || arg.startsWith('--host=') || args[i - 1] === '--host')));
  if (computerSetup) {
    require('./connect-computer').connectComputer(subcommand ? args : [], { planConnection: planHarnessConnection, cacheTools: writeToolCache }).then(code => { process.exitCode = code; }).catch(error => {
      console.error(error.message || 'Engram setup failed.');
      process.exitCode = 1;
    });
    return;
  }

  if (subcommand === 'setup' || subcommand === 'upgrade' || subcommand === 'doctor' || subcommand === 'verify') {
    const { runOnboarding } = require('./onboarding');
    runOnboarding(['setup', 'upgrade'].includes(subcommand) ? subcommand : 'doctor', args, {
      configure: configureHarness,
      configPath: configPathForList,
      readConnection: readHarnessConnection,
      planConnection: planHarnessConnection,
      cacheTools: writeToolCache,
    }).then(code => { process.exitCode = code; }).catch(error => {
      console.error(error.message || 'Engram connection check failed.');
      process.exitCode = 1;
    });
    return;
  }

  if (subcommand === 'hooks') {
    const [action, harness, ...rest] = args;
    if (action !== 'install' || !harness) {
      console.error('Usage: engram-mcp hooks install <claude|cursor|codex>');
      process.exit(1);
    }
    try {
      const capture = require('./capture');
      const parsed = parseConnectArgs(rest);
      const file = capture.installHooks(harness, {
        host: parsed.host ?? process.env.ENGRAM_HOST,
        token: parsed.token ?? process.env.ENGRAM_TOKEN,
      });
      console.log(`Installed ${harness} capture hooks in ${file}`);
      process.exit(0);
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }
  }

  if (subcommand === 'capture') {
    const capture = require('./capture');
    capture.runCaptureCli(args).then(code => process.exit(code ?? 0)).catch(err => {
      console.error(err.message || err);
      process.exit(1);
    });
    return;
  }

  if (subcommand === 'connect') {
    let code;
    try {
      code = runConnect(args);
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }
    // Seeding is the last step of connect and never its verdict: the config is
    // already written and correct whether or not the server answers right now.
    seedToolCache(lastConnectTarget).finally(() => process.exit(code));
    return;
  }

  if (subcommand === '--help' || subcommand === '-h') {
    printRootHelp();
    process.exit(0);
  }

  if (subcommand) {
    console.error(`Unknown subcommand: ${subcommand}`);
    printRootHelp();
    process.exit(1);
  }

  runProxy().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

function printRootHelp() {
  console.log(`Connect this computer (run in a terminal; approve in your browser):
  npx @ani-hq/engram-mcp@latest

Usage:
  engram-mcp                      in a terminal: connect this computer; otherwise the stdio MCP proxy
  engram-mcp setup [--host <url>]  connect every Claude Code, Codex and Cursor install on this computer
  engram-mcp setup [harness] [--project <directory>] [--skill-scope project|user] [--host <url>] [--token-stdin]
  engram-mcp upgrade [harness] [--project <directory>] [--skill-scope project|user] [--host <url>]
  engram-mcp doctor [harness] [--host <url>] [--token-stdin]
  engram-mcp memory --help
  engram-mcp connect [harness] [--host <url>] [--token <token>]
  engram-mcp connect --list
  engram-mcp hooks install <claude|cursor|codex>
  engram-mcp capture --hook <claude|cursor|codex>
  engram-mcp capture --sweep`);
}

function runConnect(args) {
  const parsed = parseConnectArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    printConnectList();
    return 1;
  }

  if (parsed.list || !parsed.harness) {
    printConnectList();
    return 0;
  }

  const harness = parsed.harness.toLowerCase();
  if (!SUPPORTED_HARNESSES.includes(harness)) {
    console.error(`Unsupported harness: ${parsed.harness}`);
    printConnectList();
    return 1;
  }

  const host = normalizeRequiredValue(parsed.host ?? process.env.ENGRAM_HOST);
  const token = normalizeRequiredValue(parsed.token ?? process.env.ENGRAM_TOKEN);
  const missing = [];

  if (!host) missing.push('host (--host or ENGRAM_HOST)');
  if (!token) missing.push('token (--token or ENGRAM_TOKEN)');

  if (missing.length) {
    console.error(`Missing ${missing.join(' and ')}.`);
    return 1;
  }

  const target = require('./onboarding').endpointForHost(host);
  const endpoint = target.endpoint;
  lastConnectTarget = { host: target.host, token };

  if (harness === 'claude') {
    return connectClaude(endpoint, token);
  }

  if (harness === 'codex') {
    return connectCodex(endpoint, token);
  }

  if (harness === 'cursor') {
    return connectJsonHarness('cursor', cursorConfigPath(), 'mcpServers', cursorServer(endpoint, token));
  }

  if (harness === 'vscode') {
    return connectJsonHarness('vscode', vscodeConfigPath(), 'servers', vscodeServer(endpoint, token));
  }

  if (harness === 'windsurf') {
    return connectJsonHarness(
      'windsurf',
      windsurfConfigPath(),
      'mcpServers',
      cursorServer(endpoint, token)
    );
  }

  return 1;
}

function parseConnectArgs(args) {
  const parsed = {
    harness: '',
    host: undefined,
    token: undefined,
    list: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--list') {
      parsed.list = true;
      continue;
    }

    if (arg === '--host' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { error: `${arg} requires a value` };
      }
      parsed[arg.slice(2)] = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('--host=')) {
      parsed.host = arg.slice('--host='.length);
      continue;
    }

    if (arg.startsWith('--token=')) {
      parsed.token = arg.slice('--token='.length);
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `Unknown option: ${arg}` };
    }

    if (parsed.harness) {
      return { error: `Unexpected argument: ${arg}` };
    }
    parsed.harness = arg;
  }

  return parsed;
}

function printConnectList() {
  console.log('Supported harnesses:');
  for (const harness of SUPPORTED_HARNESSES) {
    console.log(`  ${harness.padEnd(9)} ${configPathForList(harness)}`);
  }
}

function configPathForList(harness) {
  if (harness === 'claude') return path.join(homeDir(), '.claude.json');
  if (harness === 'codex') return codexConfigPath();
  if (harness === 'cursor') return cursorConfigPath();
  if (harness === 'vscode') return vscodeConfigPath();
  if (harness === 'windsurf') return windsurfConfigPath();
  if (harness === 'gemini') return path.join(homeDir(), '.gemini', 'settings.json');
  if (harness === 'copilot') return path.join(homeDir(), '.copilot', 'mcp-config.json');
  if (harness === 'opencode') return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config'), 'opencode', 'opencode.json');
  if (harness === 'openclaw') return path.join(homeDir(), '.openclaw', 'openclaw.json');
  return '';
}

// Guided setup writes native HTTP entries directly: a secret never needs to be
// passed through a child process's argv, including when Claude Code is absent.
function configureHarness(harness, endpoint, token) {
  if (['gemini', 'copilot', 'opencode', 'openclaw'].includes(harness)) {
    const plan = planHarnessConnection(harness, endpoint, token);
    backupAndWrite(plan.file, plan.kind === 'json' ? JSON.stringify(plan.value, null, 2) + '\n' : plan.value);
    console.log(`Configured engram for ${harness} at ${plan.file}`);
    return 0;
  }
  if (harness === 'codex') return connectCodex(endpoint, token);
  if (harness === 'claude') return connectJsonHarness('claude', configPathForList('claude'), 'mcpServers', vscodeServer(endpoint, token));
  if (harness === 'vscode') return connectJsonHarness('vscode', vscodeConfigPath(), 'servers', vscodeServer(endpoint, token));
  return connectJsonHarness(harness, configPathForList(harness), 'mcpServers', cursorServer(endpoint, token));
}

function planHarnessConnection(harness, endpoint, token, priorWrites = []) {
  let file = configPathForList(harness);
  if (!file) throw new Error('This runtime has no supported local MCP configuration. Use its app connection controls.');
  assertSafeConfigPath(file);
  // Resolve only platform aliases above the already checked user config path
  // (such as macOS /var); links beneath the home boundary were rejected above.
  let ancestor = path.dirname(file), suffix = [path.basename(file)];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  file = path.join(fs.realpathSync(ancestor), ...suffix);
  const prior = priorWrites.find(write => path.resolve(write.file) === path.resolve(file));
  const raw = readTextIfExists(file);
  if (harness === 'codex') return { file, kind: 'text', value: replaceTomlTable(raw, 'mcp_servers.engram', codexTomlEntry(endpoint, token)) };
  if (harness === 'opencode' && !raw && fs.existsSync(file + 'c')) throw new Error('OpenCode already uses a JSONC configuration. Setup preserved it; use the native OpenCode connection controls for this configuration format.');
  const config = prior?.kind === 'json' ? structuredClone(prior.value) : readJsonObject(file);
  const object = (value, label) => { if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object. Existing configuration was preserved.`); return value; };
  let root;
  if (harness === 'openclaw') {
    config.mcp = object(config.mcp || {}, 'OpenClaw MCP settings');
    root = config.mcp;
  } else root = config;
  const key = ['vscode', 'openclaw'].includes(harness) ? 'servers' : harness === 'opencode' ? 'mcp' : 'mcpServers';
  root[key] = object(root[key] || {}, 'MCP servers');
  if (root[key].engram?.enabled === false || root[key].engram?.disabled === true) throw new Error('This Engram connection is explicitly disabled. Setup preserved that choice; enable it through the runtime controls before trying again.');
  if (harness === 'gemini' && (config.mcp?.enabled === false || (Array.isArray(config.mcp?.allowed) && !config.mcp.allowed.includes('engram')) || config.mcp?.excluded?.includes('engram'))) throw new Error('Gemini MCP policy does not allow Engram. Setup preserved that policy.');
  root[key].engram = harness === 'gemini' ? { httpUrl: endpoint, headers: { Authorization: `Bearer ${token}` } }
    : harness === 'opencode' ? { type: 'remote', url: endpoint, headers: { Authorization: `Bearer ${token}` } }
    : harness === 'openclaw' ? { url: endpoint, transport: 'streamable-http', headers: { Authorization: `Bearer ${token}` } }
    : ['claude', 'vscode', 'copilot'].includes(harness) ? vscodeServer(endpoint, token) : cursorServer(endpoint, token);
  return { file, kind: 'json', value: config };
}

function readHarnessConnection(harness) {
  const file = configPathForList(harness);
  assertSafeConfigPath(file);
  if (!fs.existsSync(file)) throw new Error(`No ${harness} config at ${file}. Run engram-mcp setup ${harness}.`);
  if (harness !== 'codex') {
    const config = readJsonObject(file);
    const entry = harness === 'openclaw' ? config.mcp?.servers?.engram : config[harness === 'vscode' ? 'servers' : harness === 'opencode' ? 'mcp' : 'mcpServers']?.engram;
    const host = harness === 'gemini' ? entry?.httpUrl : entry?.url;
    if (!entry || typeof host !== 'string') throw new Error(`No native Engram connection in ${file}. Run engram-mcp setup ${harness}, or use doctor --host with ENGRAM_TOKEN.`);
    const token = /^Bearer (.+)$/i.exec(entry.headers?.Authorization || '')?.[1];
    return { host, token, authentication: token ? 'bearer' : 'runtime-managed' };
  }
  const lines = readTextIfExists(file).split(/\r?\n/);
  const headers = tomlHeaders(lines);
  let inside = false, block = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = headers[i];
    if (header) inside = header.path.join('.') === 'mcp_servers.engram';
    else if (inside) block.push(line);
  }
  const text = block.join('\n');
  // These are the JSON-compatible TOML strings generated by setup. Other valid
  // TOML layouts can still be checked using --host and a prompted/env token.
  const quoted = '"(?:[^"\\\\]|\\\\.)*"';
  const decode = raw => {
    try { return JSON.parse(raw); }
    catch { throw new Error(`Could not read the native Engram strings in ${file}. Use doctor --host with ENGRAM_TOKEN, or run engram-mcp setup codex.`); }
  };
  const value = key => {
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(${quoted})`, 'm'));
    return match ? decode(match[1]) : undefined;
  };
  const host = value('url');
  const authorization = text.match(new RegExp(`\\bAuthorization\\s*=\\s*(${quoted})`));
  const token = authorization ? /^Bearer (.+)$/i.exec(decode(authorization[1]))?.[1] : process.env[value('bearer_token_env_var') || ''];
  if (!host) throw new Error(`No supported native Engram URL in ${file}. Use doctor --host with ENGRAM_TOKEN, or run engram-mcp setup codex.`);
  return { host, token, authentication: token ? 'bearer' : 'runtime-managed' };
}

function normalizeRequiredValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function connectClaude(endpoint, token) {
  if (!hasExecutable('claude')) {
    console.error('Missing claude binary. Run engram-mcp setup claude to configure its native HTTP connection directly.');
    return 1;
  }

  backupExistingFile(configPathForList('claude'), 'claude will create or update it');

  const args = [
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'http',
    'engram',
    endpoint,
    '--header',
    `Authorization: Bearer ${token}`,
  ];
  const result = spawnSync('claude', args, { stdio: 'inherit' });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 0;
}

function hasExecutable(name) {
  const pathValue = process.env.PATH || '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return false;
}

function connectCodex(endpoint, token) {
  const file = codexConfigPath();
  const raw = readTextIfExists(file);
  const next = replaceTomlTable(raw, 'mcp_servers.engram', codexTomlEntry(endpoint, token));

  backupAndWrite(file, next);
  console.log(`Configured engram for codex at ${file}`);
  return 0;
}

function codexConfigPath() {
  return path.join(homeDir(), '.codex', 'config.toml');
}

function codexTomlEntry(endpoint, token) {
  return [
    '[mcp_servers.engram]',
    `url = ${tomlString(endpoint)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }`,
    '',
  ].join('\n');
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function replaceTomlTable(raw, tablePath, replacement) {
  const lines = splitLines(raw);
  const headers = tomlHeaders(lines.map(line => line.text));
  const target = tablePath.split('.');
  const remove = new Array(lines.length).fill(false);
  let firstRemoved = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const header = headers[i];
    if (!header || !isSameOrChildPath(header.path, target)) continue;

    if (firstRemoved === -1) firstRemoved = i;

    let end = i + 1;
    while (end < lines.length && !headers[end]) {
      end += 1;
    }

    for (let j = i; j < end; j += 1) {
      remove[j] = true;
    }
    i = end - 1;
  }

  const replacementLines = splitLines(ensureSingleTrailingNewline(replacement));

  if (firstRemoved !== -1) {
    const out = [];
    let inserted = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (i === firstRemoved) {
        out.push(...replacementLines);
        inserted = true;
      }
      if (!remove[i]) out.push(lines[i]);
    }
    if (!inserted) out.push(...replacementLines);
    return joinLines(out);
  }

  if (!raw) return ensureSingleTrailingNewline(replacement);
  const separator = raw.endsWith('\n') ? (raw.endsWith('\n\n') ? '' : '\n') : '\n\n';
  return `${raw}${separator}${ensureSingleTrailingNewline(replacement)}`;
}

function splitLines(raw) {
  if (!raw) return [];
  const matches = raw.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
  return matches
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(.*?)(\r\n|\n|\r)?$/);
      return { text: match[1], eol: match[2] || '' };
    });
}

function joinLines(lines) {
  return lines.map((line) => `${line.text}${line.eol}`).join('');
}

function ensureSingleTrailingNewline(raw) {
  return `${raw.replace(/\s*$/, '')}\n`;
}

function parseTomlHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return null;
  const match = trimmed.match(/^\[\[(.+?)\]\]\s*(?:#.*)?$/) || trimmed.match(/^\[(?!\[)(.+?)\]\s*(?:#.*)?$/);
  if (!match) return null;
  const pathParts = parseTomlPath(match[1].trim());
  return pathParts.length ? { path: pathParts } : null;
}

// Header-looking text inside a multiline instruction is content, not a table.
// Track only enough TOML string state to preserve unrelated config verbatim.
function tomlHeaders(lines) {
  let multiline = '';
  return lines.map(line => {
    const header = multiline ? null : parseTomlHeader(line);
    if (header) return header;
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (multiline === '"""' && line[i] === '\\') { i++; continue; }
        if (line.startsWith(multiline, i)) { i += 2; multiline = ''; }
        continue;
      }
      if (line[i] === '#') break;
      if (line[i] !== '"' && line[i] !== "'") continue;
      const quote = line[i];
      if (line.startsWith(quote.repeat(3), i)) { multiline = quote.repeat(3); i += 2; continue; }
      while (++i < line.length) {
        if (quote === '"' && line[i] === '\\') { i++; continue; }
        if (line[i] === quote) break;
      }
    }
    return null;
  });
}

function parseTomlPath(raw) {
  const parts = [];
  let current = '';
  let quote = '';
  let escaping = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (quote) {
      if (escaping) {
        current += char;
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts.filter(Boolean);
}

function isSameOrChildPath(pathParts, targetParts) {
  if (pathParts.length < targetParts.length) return false;
  for (let i = 0; i < targetParts.length; i += 1) {
    if (pathParts[i] !== targetParts[i]) return false;
  }
  return true;
}

function connectJsonHarness(name, file, serverRootKey, serverConfig) {
  const config = readJsonObject(file);
  const servers = config[serverRootKey];

  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new Error(`${file}: ${serverRootKey} must be an object. Fix it before adding Engram; no configuration was changed.`);
  }
  if (!servers) {
    config[serverRootKey] = {};
  }

  config[serverRootKey].engram = serverConfig;
  backupAndWrite(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Configured engram for ${name} at ${file}`);
  return 0;
}

function readJsonObject(file) {
  const raw = readTextIfExists(file);
  if (!raw.trim()) return {};

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`${file} is not valid JSON. Fix the config before adding Engram; no configuration was changed.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed;
}

function cursorServer(endpoint, token) {
  return {
    url: endpoint,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

function vscodeServer(endpoint, token) {
  return {
    type: 'http',
    url: endpoint,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

function cursorConfigPath() {
  return path.join(homeDir(), '.cursor', 'mcp.json');
}

function vscodeConfigPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config'), 'Code', 'User', 'mcp.json');
}

function windsurfConfigPath() {
  return path.join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json');
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function backupAndWrite(file, content) {
  assertSafeConfigPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  let mode = 0o600;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o700;
    backupExistingFile(file);
  } else {
    console.log(`No existing ${file}; creating new file`);
  }

  const temp = `${file}.engram-${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function backupExistingFile(file, missingMessage) {
  assertSafeConfigPath(file);
  if (!fs.existsSync(file)) {
    if (missingMessage) console.log(`No existing ${file}; ${missingMessage}`);
    return;
  }

  const base = `${file}.engram-backup`;
  const backup = fs.existsSync(base) ? `${base}-${Date.now()}-${randomBytes(3).toString('hex')}` : base;
  assertSafeConfigPath(backup);
  fs.writeFileSync(backup, fs.readFileSync(file), { flag: 'wx', mode: 0o600 });
  console.log(`Backed up ${file} to ${backup}`);
}

function assertSafeConfigPath(file) {
  const target = path.resolve(file);
  const home = path.resolve(homeDir());
  const contains = root => { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  // Treat the resolved home as the trust boundary. Its own platform aliases
  // (notably /var -> /private/var on macOS) are legitimate; links beneath it
  // would redirect newly saved credentials into another tree.
  const configuredRoot = [process.env.XDG_CONFIG_HOME, process.env.APPDATA].filter(Boolean).map(root => path.resolve(root)).find(contains);
  const root = contains(home) ? home : configuredRoot || path.dirname(target);
  let current = root;
  // Explicit config roots outside home may themselves be symlinks. Do not
  // silently follow them, but allow aliases in the system path above the root.
  if (root !== home) rejectLink(current);
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!rejectLink(current)) break;
  }
  function rejectLink(candidate) {
    let stat;
    try { stat = fs.lstatSync(candidate); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`${candidate} is a symbolic link. Use a regular user config path to keep the token out of a linked dotfiles repository.`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Cold-start tolerance.
//
// engram runs on Cloud Run with min-instances=0, so an idle service is asleep and
// the first request pays a full container start: cloud-sql-proxy, gateway
// migrations, a synchronous `gbrain init`, then the gbrain child's own MCP
// handshake. That is far longer than a harness allows an MCP server to come up,
// and the harness reports it as a server that failed to connect.
//
// The MCP SDK answers `initialize` from local data, so tools/list is the only
// network call in the handshake. Serving it from a cache makes a sleeping engram
// invisible at startup: the client connects instantly, and the wake-up happens
// underneath the first real tool call, which is far more patient.
const REQUEST_TIMEOUT_MS = Number(process.env.ENGRAM_TIMEOUT_MS) || 90_000;
const WARMUP_TIMEOUT_MS = 2_000;
// connect can afford a full cold start; a proxy handshake cannot.
const SEED_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
const TOOL_CACHE_VERSION = 2;
const MAX_TOOL_CACHE_BYTES = 1_000_000;
const FRESH_TOOL_WAIT_MS = 750;

// A gateway status cannot prove whether a write was already applied. Retry these
// transient statuses only when the caller explicitly marks the operation safe.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function shouldRetry(status, err, idempotent) {
  // No status means no response came back. Repeating an idempotent call is always
  // safe. Repeating a write is not: the request may have been applied and only the
  // reply lost, and a second `remember` would duplicate the entry.
  if (idempotent !== true) return false;
  if (err) return true;
  return RETRYABLE_STATUS.has(status);
}

// Set by runConnect so the seeding step below knows where to look without
// re-deriving it from argv and the environment a second time.
let lastConnectTarget = null;

// The first proxy run has no cache, which is the one handshake a sleeping engram
// can still lose. connect is the right moment to fill it: credentials are in hand
// and a person is watching, so a slow wake-up here costs nothing.
async function seedToolCache(target) {
  if (!target || !target.host || !target.token) return false;
  try {
    const res = await fetch(`${target.host.replace(/\/$/, '')}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.token}`,
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(SEED_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) removeToolCache(target.host, target.token);
      await res.body?.cancel().catch(() => {});
      throw new Error(`engram MCP HTTP ${res.status}`);
    }
    const json = await res.json();
    const tools = normalizeTools(json && json.result);
    if (!tools.length) throw new Error(`no tools returned (HTTP ${res.status})`);
    writeToolCache(target.host, target.token, tools);
    console.log(`Cached ${tools.length} tools for offline startup.`);
    return true;
  } catch (err) {
    console.error(
      'Could not reach engram to cache its tool list. ' +
      'This is not fatal: the config is written, and the list will be cached on ' +
      'the first successful call.'
    );
    return false;
  }
}

function cacheKeyForHost(host) {
  return String(host).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_') || 'engram';
}

function toolCachePath(host, token) {
  if (typeof token !== 'string' || !token) return null;
  const base = process.env.XDG_CACHE_HOME || path.join(homeDir(), '.cache');
  const key = createHash('sha256').update(JSON.stringify([String(host).replace(/\/+$/, ''), token])).digest('hex');
  return path.join(base, 'engram-mcp', `tools-v${TOOL_CACHE_VERSION}-${key}.json`);
}

// A miss is the normal first run and a failure is never fatal. The worst outcome
// of either is the slow path this code already had.
function readToolCache(host, token) {
  try {
    const file = toolCachePath(host, token);
    if (!file || fs.statSync(file).size > MAX_TOOL_CACHE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== TOOL_CACHE_VERSION) return null;
    const tools = normalizeTools(parsed);
    return tools.length ? tools : null;
  } catch {
    return null;
  }
}

function writeToolCache(host, token, tools) {
  let temporary;
  try {
    const file = toolCachePath(host, token);
    if (!file) return false;
    const payload = JSON.stringify({ version: TOOL_CACHE_VERSION, tools: normalizeTools({ tools }) });
    if (Buffer.byteLength(payload) > MAX_TOOL_CACHE_BYTES) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
  }
}

function removeToolCache(host, token) {
  const file = toolCachePath(host, token);
  if (file) { try { fs.unlinkSync(file); } catch {} }
}

function normalizeTools(result) {
  return (Array.isArray(result?.tools) ? result.tools : []).slice(0, 100).filter(t => t && typeof t.name === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(t.name)).map((t) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description.slice(0, 4000) : '',
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) ? t.inputSchema : { type: 'object', properties: {} },
  }));
}

async function runProxy() {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = require('@modelcontextprotocol/sdk/types.js');

  const HOST = (process.env.ENGRAM_HOST || '').replace(/\/$/, '');
  const TOKEN = process.env.ENGRAM_TOKEN || '';

  if (!HOST || !TOKEN) {
    console.error(
      '@ani-hq/engram-mcp requires ENGRAM_HOST and ENGRAM_TOKEN environment variables'
    );
    process.exit(1);
  }

  let rpcId = 1;

  async function engramRpc(method, params, idempotent, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < (options.attempts || MAX_ATTEMPTS); attempt += 1) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
      }

      const body = {
        jsonrpc: '2.0',
        id: rpcId++,
        method,
      };
      if (params !== undefined) body.params = params;

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        'Mcp-Method': method,
      };
      if (params && typeof params.name === 'string') {
        headers['Mcp-Name'] = params.name;
      }

      let res;
      try {
        res = await fetch(`${HOST}/mcp`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        lastError = e;
        if (!shouldRetry(null, e, idempotent)) throw e;
        continue;
      }

      if (!res.ok && shouldRetry(res.status, null, idempotent)) {
        // Drain the body so the socket is released before the next attempt.
        await res.text().catch(() => {});
        lastError = new Error(`engram MCP HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        const error = new Error(`engram MCP HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      const json = await res.json();
      if (json.error) {
        throw new Error(json.error.message || `engram MCP error ${json.error.code}`);
      }
      return json.result;
    }
    throw lastError || new Error('engram MCP request failed');
  }

  // Start the wake-up the moment the session opens, so the container is booting
  // while the user is still typing rather than under their first question.
  // Nothing waits on this and a failure changes nothing.
  fetch(`${HOST}/health`, { signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS) }).catch(() => {});

  const server = new Server(
    connectorBranding(HOST),
    { capabilities: { tools: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS }
  );

  let liveTools = null, advertisedTools = null, refresh = null;
  let catalogAuthError = null;
  let clearDeniedCatalog = false;
  const sameTools = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function refreshTools() {
    if (refresh) return refresh;
    refresh = engramRpc('tools/list', undefined, true, { attempts: 1 })
      .then(result => {
        const tools = normalizeTools(result);
        if (!tools.length) throw new Error('engram returned an empty tool catalog');
        liveTools = tools; catalogAuthError = null; clearDeniedCatalog = false;
        writeToolCache(HOST, TOKEN, tools);
        if (advertisedTools && !sameTools(advertisedTools, tools)) {
          server.sendToolListChanged().catch(() => {});
        }
        return { tools };
      })
      .catch(error => {
        if (error.status === 401 || error.status === 403) {
          catalogAuthError = error; liveTools = null;
          removeToolCache(HOST, TOKEN);
          const previouslyAdvertised = advertisedTools; advertisedTools = null;
          clearDeniedCatalog ||= Boolean(previouslyAdvertised);
          if (previouslyAdvertised) server.sendToolListChanged().catch(() => {});
        }
        return { error };
      })
      .finally(() => { refresh = null; });
    return refresh;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The one notification following a late authorization rejection must clear
    // tools already advertised to the client. No refetch/notification loop: a
    // repaired credential starts a new connection, and its own scoped cache.
    if (catalogAuthError && clearDeniedCatalog) return { tools: [], _meta: { 'engram/discoveryError': 'authorization_required' } };
    const cached = liveTools || readToolCache(HOST, TOKEN);
    const pending = refreshTools();
    let timer;
    const result = cached ? await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), FRESH_TOOL_WAIT_MS); })]).finally(() => clearTimeout(timer)) : await pending;
    if (catalogAuthError) throw catalogAuthError;
    const tools = liveTools || result?.tools || cached;
    if (!tools) throw result?.error || new Error('engram tool catalog is unavailable; retry tools/list');
    advertisedTools = tools;
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = { ...(request.params.arguments || {}) };
    if (request.params.name === 'remember') {
      const capture = require('./capture');
      const extra = capture.rememberContext();
      if (!args.repo && extra.repo) args.repo = extra.repo;
      if (!args.harness && extra.harness) args.harness = extra.harness;
      if (!args.session_id && extra.session_id) args.session_id = extra.session_id;
    }
    const metadata = require('./runtime-adapters').augmentProxyMeta(request.params._meta, { host: HOST, token: TOKEN, project: process.env.ENGRAM_MEMORY_PROJECT, runId: process.env.ENGRAM_MEMORY_RUN_ID, sessionId: process.env.ENGRAM_MEMORY_SESSION_ID });
    const result = await engramRpc('tools/call', {
      name: request.params.name,
      arguments: args,
      ...(metadata ? { _meta: metadata } : {}),
    });
    // A successful real call can wake a sleeping service after a catalog fetch
    // failed. Refresh discovery then; never create a task or replay a write.
    if (!liveTools && !refresh) refreshTools();

    if (result?.content) {
      return { content: result.content, ...(result.isError ? { isError: true } : {}), ...(result._meta ? { _meta: result._meta } : {}), ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) };
    }
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = {
  SERVER_INSTRUCTIONS,
  cacheKeyForHost,
  seedToolCache,
  normalizeTools,
  readToolCache,
  shouldRetry,
  toolCachePath,
  writeToolCache,
  configureHarness,
  planHarnessConnection,
  configPathForList,
  readHarnessConnection,
  backupAndWrite,
};

// Only run the CLI when invoked as one, so the helpers above can be required by
// tests without the process trying to dispatch a subcommand.
if (require.main === module) dispatch();
