'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TRANSCRIPT_CHAR_CAP = 200_000;
const HARNESSES = ['claude', 'cursor', 'codex'];

const PATTERNS = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'REDACTED_PRIVATE_KEY' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, label: 'REDACTED_API_KEY' },
  { re: /\bsk-svcacct-[A-Za-z0-9_-]{20,}\b/g, label: 'REDACTED_API_KEY' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: 'REDACTED_API_KEY' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, label: 'REDACTED_TOKEN' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'REDACTED_TOKEN' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: 'REDACTED_TOKEN' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, label: 'REDACTED_TOKEN' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'REDACTED_ACCESS_KEY' },
  { re: /\beng_[A-Za-z0-9_-]{20,}\b/g, label: 'REDACTED_TOKEN' },
  { re: /\bens_[A-Za-z0-9_-]{20,}\b/g, label: 'REDACTED_TOKEN' },
  { re: /\binv_[A-Za-z0-9_-]{20,}\b/g, label: 'REDACTED_TOKEN' },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, label: 'Bearer REDACTED_TOKEN' },
  { re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^\s'"`]+/gi, label: 'REDACTED_CONNECTION' },
  { re: /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*)\s*=\s*.+$/gim, label: '$1=REDACTED' },
];

function redactSecrets(text) {
  let out = String(text ?? '');
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, label);
    re.lastIndex = 0;
  }
  return out;
}

function capTranscript(text, cap = TRANSCRIPT_CHAR_CAP) {
  if (text.length <= cap) return text;
  const keep = Math.floor((cap - 80) / 2);
  return `${text.slice(0, keep)}\n\n[… ${text.length - keep * 2} characters omitted …]\n\n${text.slice(-keep)}`;
}

function normalizeRepo(raw) {
  if (!raw || !String(raw).trim()) return null;
  let value = String(raw).trim().replace(/^git\+/, '');
  const scp = value.match(/^git@([^:]+):(.+)$/);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  value = value.replace(/^https?:\/\//, '').replace(/^ssh:\/\//, '');
  value = value.replace(/\.git$/, '').replace(/\/+$/, '').replace(/^www\./, '');
  return value.toLowerCase() || null;
}

function homeDir() {
  return process.env.HOME || os.homedir();
}

function configPath() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config'), 'engram', 'capture.json');
}

function statePath() {
  const base = process.env.XDG_CACHE_HOME || path.join(homeDir(), '.cache');
  return path.join(base, 'engram-mcp', 'capture-state.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadCaptureConfig() {
  const file = readJson(configPath(), {});
  return {
    host: String(file.host || process.env.ENGRAM_HOST || '').replace(/\/$/, ''),
    token: String(file.token || process.env.ENGRAM_TOKEN || ''),
    neverRepos: Array.isArray(file.neverRepos) ? file.neverRepos.map(String) : [],
    neverPaths: Array.isArray(file.neverPaths) ? file.neverPaths.map(String) : [],
  };
}

function shouldCapture(input, config = loadCaptureConfig()) {
  const repo = normalizeRepo(input.repo);
  const cwd = input.cwd || '';
  if (repo && config.neverRepos.some(item => repo === normalizeRepo(item) || repo.endsWith(`/${String(item).toLowerCase()}`))) {
    return false;
  }
  if (cwd && config.neverPaths.some(prefix => cwd === prefix || cwd.startsWith(`${prefix.replace(/\/$/, '')}/`))) {
    return false;
  }
  return true;
}

function gitContext(cwd) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const remote = runGit(dir, ['remote', 'get-url', 'origin']);
  const branch = runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const email = runGit(dir, ['config', 'user.email']);
  return {
    cwd: dir,
    repo: normalizeRepo(remote),
    branch: branch || null,
    email: email || null,
  };
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function detectHarness() {
  if (process.env.ENGRAM_HARNESS) return process.env.ENGRAM_HARNESS;
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) return 'cursor';
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (process.env.CODEX_HOME || process.env.CODEX_THREAD_ID) return 'codex';
  return null;
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return item.text || item.thinking || item.input_text || item.output_text || '';
    }).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') return extractText(value.text || value.content);
  return '';
}

function parseClaudeTranscript(raw) {
  const turns = [];
  let sessionId = '';
  let cwd = '';
  let branch = '';
  let startedAt = null;
  let endedAt = null;
  for (const line of String(raw).split(/\n+/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId = sessionId || row.sessionId || row.session_id || '';
    cwd = cwd || row.cwd || '';
    branch = branch || row.gitBranch || '';
    const ts = row.timestamp || null;
    if (ts && !startedAt) startedAt = ts;
    if (ts) endedAt = ts;
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const text = extractText(row.message && row.message.content);
    if (!text.trim()) continue;
    turns.push({ role: row.type === 'user' ? 'user' : 'assistant', text: text.trim() });
  }
  return { sessionId, cwd, branch, startedAt, endedAt, turns };
}

function parseCursorTranscript(raw, fallbackId) {
  const turns = [];
  for (const line of String(raw).split(/\n+/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const role = row.role === 'assistant' || row.role === 'user' ? row.role : null;
    const text = extractText(row.message && row.message.content);
    if (!role || !text.trim()) continue;
    const cleaned = text.replace(/<\/?user_query>/g, '').replace(/<\/?timestamp>[\s\S]*?<\/timestamp>/g, '').trim();
    if (cleaned) turns.push({ role, text: cleaned });
  }
  return { sessionId: fallbackId || '', cwd: '', branch: '', startedAt: null, endedAt: null, turns };
}

function parseCodexTranscript(raw) {
  const turns = [];
  let sessionId = '';
  let cwd = '';
  let startedAt = null;
  let endedAt = null;
  for (const line of String(raw).split(/\n+/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = row.timestamp || null;
    if (ts && !startedAt) startedAt = ts;
    if (ts) endedAt = ts;
    const payload = row.payload || {};
    sessionId = sessionId || payload.session_id || payload.id || '';
    cwd = cwd || payload.cwd || '';
    if (row.type === 'session_meta') {
      sessionId = sessionId || payload.session_id || payload.id || '';
      cwd = cwd || payload.cwd || '';
      continue;
    }
    if (row.type === 'turn_context') {
      cwd = cwd || payload.cwd || '';
      continue;
    }
    if (row.type === 'response_item' && payload.type === 'message') {
      const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
      const text = extractText(payload.content);
      if (role && text.trim() && !text.includes('<environment_context>') && !text.includes('<permissions instructions>')) {
        turns.push({ role, text: text.trim() });
      }
    }
  }
  return { sessionId, cwd, branch: '', startedAt, endedAt, turns };
}

function flattenTurns(turns) {
  return turns.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n\n');
}

function buildPayload(harness, parsed, extra = {}) {
  const git = gitContext(extra.cwd || parsed.cwd || process.cwd());
  const transcript = capTranscript(redactSecrets(flattenTurns(parsed.turns)));
  return {
    harness,
    sessionId: extra.sessionId || parsed.sessionId,
    repo: extra.repo || git.repo,
    cwd: extra.cwd || parsed.cwd || git.cwd,
    branch: extra.branch || parsed.branch || git.branch,
    authorEmail: extra.authorEmail || git.email,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt || new Date().toISOString(),
    transcript,
    turns: parsed.turns.map(turn => ({ role: turn.role, text: capTranscript(redactSecrets(turn.text), 8000) })),
  };
}

async function uploadTrail(payload, config = loadCaptureConfig()) {
  if (!shouldCapture(payload, config)) return { skipped: true, reason: 'never-capture' };
  if (!payload.sessionId || !payload.turns.length) return { skipped: true, reason: 'empty' };
  if (!config.host || !config.token) throw new Error('Missing host or token in ~/.config/engram/capture.json');
  const endpoint = `${config.host.replace(/\/$/, '')}/api/trails`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `engram trails HTTP ${res.status}`);
  return json;
}

function rememberContext() {
  const git = gitContext(process.cwd());
  return {
    repo: git.repo,
    harness: detectHarness(),
    session_id: process.env.CLAUDE_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CURSOR_TRACE_ID || '',
  };
}

function selfCommand() {
  return `${process.execPath} ${JSON.stringify(path.join(__dirname, 'index.js'))}`;
}

function installHooks(harness, options = {}) {
  if (!HARNESSES.includes(harness)) throw new Error(`Unsupported harness: ${harness}`);
  const config = loadCaptureConfig();
  if (options.host) config.host = String(options.host).replace(/\/$/, '');
  if (options.token) config.token = String(options.token);
  if (!config.host) config.host = String(process.env.ENGRAM_HOST || '').replace(/\/$/, '');
  if (!config.token) config.token = String(process.env.ENGRAM_TOKEN || '');
  writeJson(configPath(), config);
  if (harness === 'claude') return installClaudeHooks();
  if (harness === 'cursor') return installCursorHooks();
  return installCodexHooks();
}

function installClaudeHooks() {
  const file = path.join(homeDir(), '.claude', 'settings.json');
  const settings = readJson(file, {});
  const command = `${selfCommand()} capture --hook claude`;
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of ['Stop', 'SessionEnd']) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (JSON.stringify(existing).includes('capture --hook claude')) continue;
    hooks[event] = existing.concat([{ hooks: [{ type: 'command', command }] }]);
  }
  settings.hooks = hooks;
  backupAndWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

function installCursorHooks() {
  const file = path.join(homeDir(), '.cursor', 'hooks.json');
  const settings = readJson(file, { version: 1, hooks: {} });
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const command = `${selfCommand()} capture --hook cursor`;
  const existing = Array.isArray(settings.hooks.stop) ? settings.hooks.stop : [];
  if (!JSON.stringify(existing).includes('capture --hook cursor')) {
    settings.hooks.stop = existing.concat([{ command }]);
  }
  settings.version = settings.version || 1;
  backupAndWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

function installCodexHooks() {
  const file = path.join(homeDir(), '.codex', 'config.toml');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const command = `${selfCommand()} capture --hook codex`;
  const line = `notify = [${JSON.stringify(process.execPath)}, ${JSON.stringify(path.join(__dirname, 'index.js'))}, "capture", "--hook", "codex"]`;
  if (raw.includes('capture --hook codex') || raw.includes('capture", "--hook", "codex"')) return file;
  const next = raw && !raw.endsWith('\n') ? `${raw}\n${line}\n` : `${raw}${raw && !raw.endsWith('\n\n') ? '\n' : ''}${line}\n`;
  backupAndWrite(file, next);
  return file;
}

function backupAndWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.engram-backup`);
  fs.writeFileSync(file, content);
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseHookInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const arg = process.argv.find(part => part.startsWith('{'));
    if (!arg) return {};
    try {
      return JSON.parse(arg);
    } catch {
      return {};
    }
  }
}

function resolveCursorTranscript(input) {
  const id = input.conversation_id || input.generation_id || input.session_id || '';
  const roots = [].concat(input.workspace_roots || [], input.cwd || [], process.cwd());
  const projects = path.join(homeDir(), '.cursor', 'projects');
  if (id) {
    const matches = [];
    walkFiles(projects, file => {
      if (file.endsWith(`${id}.jsonl`) || file.includes(`/${id}/`)) matches.push(file);
    });
    if (matches[0]) return { file: matches[0], sessionId: id, cwd: roots[0] || '' };
  }
  const folder = String(roots[0] || process.cwd()).replace(/^\//, '').replace(/[\\/]/g, '-');
  const dir = path.join(projects, folder, 'agent-transcripts');
  const latest = latestFile(dir, '.jsonl');
  return { file: latest, sessionId: id || (latest ? path.basename(latest, '.jsonl') : ''), cwd: roots[0] || process.cwd() };
}

function resolveCodexTranscript(input) {
  const id = input.session_id || input.thread_id || '';
  const root = path.join(homeDir(), '.codex', 'sessions');
  if (id) {
    let found = '';
    walkFiles(root, file => {
      if (file.includes(id) && file.endsWith('.jsonl')) found = file;
    });
    if (found) return { file: found, sessionId: id, cwd: input.cwd || '' };
  }
  return { file: latestFile(root, '.jsonl'), sessionId: id, cwd: input.cwd || '' };
}

function latestFile(dir, suffix) {
  let newest = '';
  let mtime = 0;
  walkFiles(dir, file => {
    if (!file.endsWith(suffix)) return;
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs > mtime) {
        mtime = stat.mtimeMs;
        newest = file;
      }
    } catch {
      // skip
    }
  });
  return newest;
}

function walkFiles(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, visit);
    else visit(full);
  }
}

async function captureHook(harness, rawInput) {
  const input = parseHookInput(rawInput);
  if (harness === 'claude') {
    const file = input.transcript_path;
    if (!file || !fs.existsSync(file)) return { skipped: true, reason: 'no transcript' };
    const parsed = parseClaudeTranscript(fs.readFileSync(file, 'utf8'));
    return uploadTrail(buildPayload('claude', parsed, {
      sessionId: input.session_id || parsed.sessionId,
      cwd: input.cwd || parsed.cwd,
    }));
  }
  if (harness === 'cursor') {
    const resolved = resolveCursorTranscript(input);
    if (!resolved.file || !fs.existsSync(resolved.file)) return { skipped: true, reason: 'no transcript' };
    const parsed = parseCursorTranscript(fs.readFileSync(resolved.file, 'utf8'), resolved.sessionId);
    return uploadTrail(buildPayload('cursor', parsed, { sessionId: resolved.sessionId, cwd: resolved.cwd }));
  }
  const resolved = resolveCodexTranscript(input);
  if (!resolved.file || !fs.existsSync(resolved.file)) return { skipped: true, reason: 'no transcript' };
  const parsed = parseCodexTranscript(fs.readFileSync(resolved.file, 'utf8'));
  return uploadTrail(buildPayload('codex', parsed, {
    sessionId: resolved.sessionId || parsed.sessionId,
    cwd: resolved.cwd || parsed.cwd,
  }));
}

function listSweepCandidates() {
  const home = homeDir();
  const files = [];
  walkFiles(path.join(home, '.claude', 'projects'), file => {
    if (file.endsWith('.jsonl')) files.push({ harness: 'claude', file });
  });
  walkFiles(path.join(home, '.cursor', 'projects'), file => {
    if (file.includes(`${path.sep}agent-transcripts${path.sep}`) && file.endsWith('.jsonl')) {
      files.push({ harness: 'cursor', file });
    }
  });
  walkFiles(path.join(home, '.codex', 'sessions'), file => {
    if (file.endsWith('.jsonl')) files.push({ harness: 'codex', file });
  });
  return files;
}

function parseForSweep(harness, file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (harness === 'claude') return parseClaudeTranscript(raw);
  if (harness === 'cursor') {
    const id = path.basename(file, '.jsonl');
    return parseCursorTranscript(raw, id);
  }
  return parseCodexTranscript(raw);
}

async function sweep() {
  const state = readJson(statePath(), { files: {} });
  const results = [];
  for (const item of listSweepCandidates()) {
    let stat;
    try {
      stat = fs.statSync(item.file);
    } catch {
      continue;
    }
    const prior = state.files[item.file];
    if (prior && prior.mtime === stat.mtimeMs && prior.size === stat.size) continue;
    const parsed = parseForSweep(item.harness, item.file);
    const payload = buildPayload(item.harness, parsed, {
      sessionId: parsed.sessionId || path.basename(item.file, '.jsonl'),
    });
    try {
      const uploaded = await uploadTrail(payload);
      state.files[item.file] = { mtime: stat.mtimeMs, size: stat.size, at: new Date().toISOString() };
      results.push({ file: item.file, ...uploaded });
    } catch (err) {
      results.push({ file: item.file, error: err.message || String(err) });
    }
  }
  writeJson(statePath(), state);
  return results;
}

async function runCaptureCli(args) {
  if (args[0] === '--hook') {
    const harness = args[1];
    if (!HARNESSES.includes(harness)) {
      console.error(`Unknown harness: ${harness}`);
      return 1;
    }
    const result = await captureHook(harness, readStdinSync());
    if (result && result.error) {
      console.error(result.error);
      return 1;
    }
    return 0;
  }
  if (args.includes('--sweep')) {
    const results = await sweep();
    const ok = results.filter(row => !row.error && !row.skipped).length;
    const skipped = results.filter(row => row.skipped).length;
    const failed = results.filter(row => row.error).length;
    console.log(`Captured ${ok}, skipped ${skipped}, failed ${failed}.`);
    return failed ? 1 : 0;
  }
  console.error('Usage: engram-mcp capture --hook <claude|cursor|codex> | --sweep');
  return 1;
}

module.exports = {
  TRANSCRIPT_CHAR_CAP,
  buildPayload,
  capTranscript,
  captureHook,
  configPath,
  detectHarness,
  flattenTurns,
  gitContext,
  installHooks,
  loadCaptureConfig,
  normalizeRepo,
  parseClaudeTranscript,
  parseCodexTranscript,
  parseCursorTranscript,
  parseHookInput,
  redactSecrets,
  rememberContext,
  runCaptureCli,
  shouldCapture,
  statePath,
  sweep,
};
