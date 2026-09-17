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
const { spawnSync } = require('node:child_process');

const SUPPORTED_HARNESSES = ['claude', 'codex', 'cursor', 'vscode', 'windsurf'];

function dispatch() {
  const [subcommand, ...args] = process.argv.slice(2);

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
  console.log(`Usage:
  engram-mcp
  engram-mcp connect [harness] [--host <url>] [--token <token>]
  engram-mcp connect --list`);
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

  const endpoint = toMcpEndpoint(host);
  lastConnectTarget = { host: host.replace(/\/$/, ''), token };

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
  if (harness === 'claude') return path.join(os.homedir(), '.claude.json');
  if (harness === 'codex') return codexConfigPath();
  if (harness === 'cursor') return cursorConfigPath();
  if (harness === 'vscode') return vscodeConfigPath();
  if (harness === 'windsurf') return windsurfConfigPath();
  return '';
}

function normalizeRequiredValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function toMcpEndpoint(host) {
  const trimmed = host.replace(/\/+$/, '');
  return trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
}

function connectClaude(endpoint, token) {
  if (!hasExecutable('claude')) {
    console.error('Missing claude binary. Run this command by hand after installing Claude Code:');
    console.error(formatClaudeCommand(endpoint, token));
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

function formatClaudeCommand(endpoint, token) {
  const safeHeader = `Authorization: Bearer ${token}`.replace(/(["\\$`])/g, '\\$1');
  return `claude mcp add --scope user --transport http engram ${shellToken(endpoint)} --header "${safeHeader}"`;
}

function shellToken(value) {
  if (/^[A-Za-z0-9_/:@%+=.,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  return path.join(os.homedir(), '.codex', 'config.toml');
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
  const target = tablePath.split('.');
  const remove = new Array(lines.length).fill(false);
  let firstRemoved = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const header = parseTomlHeader(lines[i].text);
    if (!header || !isSameOrChildPath(header.path, target)) continue;

    if (firstRemoved === -1) firstRemoved = i;

    let end = i + 1;
    while (end < lines.length && !parseTomlHeader(lines[end].text)) {
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
  const match = trimmed.match(/^\[(?!\[)(.+)\]\s*(?:#.*)?$/);
  if (!match) return null;
  const pathParts = parseTomlPath(match[1].trim());
  return pathParts.length ? { path: pathParts } : null;
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

  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
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

  const parsed = JSON.parse(raw);
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
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

function vscodeConfigPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Code', 'User', 'mcp.json');
}

function windsurfConfigPath() {
  return path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
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
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (fs.existsSync(file)) {
    backupExistingFile(file);
  } else {
    console.log(`No existing ${file}; creating new file`);
  }

  fs.writeFileSync(file, content);
}

function backupExistingFile(file, missingMessage) {
  if (!fs.existsSync(file)) {
    if (missingMessage) console.log(`No existing ${file}; ${missingMessage}`);
    return;
  }

  const backup = `${file}.engram-backup`;
  fs.copyFileSync(file, backup);
  console.log(`Backed up ${file} to ${backup}`);
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

// Statuses Cloud Run's frontend returns when it never routed the request to the
// container. The gateway itself answers 200 with a JSON-RPC error, or 401, so
// retrying only these can never replay a write that was already applied.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function shouldRetry(status, err, idempotent) {
  // No status means no response came back. Repeating an idempotent call is always
  // safe. Repeating a write is not: the request may have been applied and only the
  // reply lost, and a second `remember` would duplicate the entry.
  if (err) return Boolean(idempotent);
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
    const json = await res.json();
    const tools = normalizeTools(json && json.result);
    if (!res.ok || !tools.length) throw new Error(`no tools returned (HTTP ${res.status})`);
    writeToolCache(target.host, tools);
    console.log(`Cached ${tools.length} tools for offline startup.`);
    return true;
  } catch (err) {
    console.error(
      `Could not reach engram to cache its tool list (${err.message || err}). ` +
      'This is not fatal: the config is written, and the list will be cached on ' +
      'the first successful call.'
    );
    return false;
  }
}

function cacheKeyForHost(host) {
  return String(host).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_') || 'engram';
}

function toolCachePath(host) {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'engram-mcp', `tools-${cacheKeyForHost(host)}.json`);
}

// A miss is the normal first run and a failure is never fatal. The worst outcome
// of either is the slow path this code already had.
function readToolCache(host) {
  try {
    const parsed = JSON.parse(fs.readFileSync(toolCachePath(host), 'utf8'));
    return Array.isArray(parsed && parsed.tools) && parsed.tools.length ? parsed.tools : null;
  } catch {
    return null;
  }
}

function writeToolCache(host, tools) {
  try {
    const file = toolCachePath(host);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ host, savedAt: new Date().toISOString(), tools }, null, 2)
    );
    return true;
  } catch {
    return false;
  }
}

function normalizeTools(result) {
  return ((result && result.tools) || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
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

  async function engramRpc(method, params, idempotent) {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || json.error || `engram MCP HTTP ${res.status}`);
      }
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
    { name: 'engram', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cached = readToolCache(HOST);
    if (cached) {
      // Answer instantly from cache and correct it behind the reply. The tool
      // surface changes on a deploy, not between sessions, so a list one session
      // stale is a far smaller problem than a handshake that times out.
      engramRpc('tools/list', undefined, true)
        .then((result) => {
          const fresh = normalizeTools(result);
          if (fresh.length) writeToolCache(HOST, fresh);
        })
        .catch(() => {});
      return { tools: cached };
    }

    const tools = normalizeTools(await engramRpc('tools/list', undefined, true));
    writeToolCache(HOST, tools);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await engramRpc('tools/call', {
      name: request.params.name,
      arguments: request.params.arguments || {},
    });

    if (result?.content) {
      return result.isError ? { content: result.content, isError: true } : { content: result.content };
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
  cacheKeyForHost,
  seedToolCache,
  normalizeTools,
  readToolCache,
  shouldRetry,
  toolCachePath,
  writeToolCache,
};

// Only run the CLI when invoked as one, so the helpers above can be required by
// tests without the process trying to dispatch a subcommand.
if (require.main === module) dispatch();
