'use strict';

// Token counts for the owner's profile. This module reads only token-count
// numbers (and the model name) from an agent's local session log. It never
// keeps, logs or sends prompts, responses, tool inputs or outputs, or file
// contents: each line is parsed, the numeric usage fields are copied out, and
// the rest is dropped. Only the cumulative counts are sent to Engram.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const HARNESSES = new Set(['claude-code', 'codex']);
const LIMIT = 1e12;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,79}$/;
// Claude Code writes one JSONL line per content block, each repeating the
// message's usage. Recent message IDs are kept (hashed) so repeats count once;
// older ones are folded into a settled total to keep the state file small.
const RECENT_IDS = 64;
// Work per hook call. A long session catches up over several calls.
const READ_BYTES = { tool: 2 * 1024 * 1024, stop: 8 * 1024 * 1024 };
const THROTTLE_MS = 20000;
const TIMEOUT_MS = { tool: 3000, stop: 5000 };
const BODY_KEYS = ['harness', 'session', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'occurredAt'];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value > 0 ? Math.min(value, LIMIT) : 0;
const add = (a, b) => a.map((value, index) => Math.min(value + b[index], LIMIT));
const zero = () => [0, 0, 0, 0];
const modelName = value => {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return MODEL.test(lower) ? lower : null;
};

function homeDir() { return fs.realpathSync(process.env.HOME || os.homedir()); }

/** A session log we are willing to open: a .jsonl regular file under home, reached without symbolic links. */
function openLog(file, home = homeDir()) {
  if (typeof file !== 'string' || !file || file.length > 4096 || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return null;
  const resolved = path.resolve(file);
  if (resolved !== file || !resolved.startsWith(`${home}${path.sep}`)) return null;
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) return null; }
    catch { return null; }
  }
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) { fs.closeSync(descriptor); return null; }
    return { descriptor, stat };
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    return null;
  }
}

function freshFile(file, ino) { return { path: file, ino, head: null, offset: 0, skip: false, base: zero(), recent: [], model: null }; }

// A one-way hash of a log's first bytes, kept only locally. Some filesystems
// reuse the inode of a deleted file, so a replaced log can keep its inode and
// outgrow the old offset; a changed head shows it is a different file.
const HEAD_BYTES = 128;
function headHash(descriptor, size) {
  const length = Math.min(size, HEAD_BYTES);
  if (length < HEAD_BYTES) return null;
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) { const got = fs.readSync(descriptor, buffer, read, length - read, read); if (!got) break; read += got; }
  return read === length ? createHash('sha256').update(buffer).digest('hex').slice(0, 32) : null;
}

function normalizeState(value) {
  const numbers = list => Array.isArray(list) && list.length === 4 ? list.map(count) : zero();
  const state = { carried: numbers(value?.carried), model: modelName(value?.model), file: null };
  const file = value?.file;
  if (file && typeof file.path === 'string') {
    state.file = {
      path: file.path, ino: Number.isSafeInteger(file.ino) ? file.ino : null, head: typeof file.head === 'string' && /^[a-f0-9]{32}$/.test(file.head) ? file.head : null,
      offset: Number.isSafeInteger(file.offset) && file.offset >= 0 ? file.offset : 0, skip: file.skip === true,
      base: numbers(file.base), model: modelName(file.model),
      recent: Array.isArray(file.recent) ? file.recent.filter(item => Array.isArray(item) && typeof item[0] === 'string' && /^[a-f0-9]{16}$/.test(item[0])).slice(-RECENT_IDS).map(item => [item[0], ...numbers(item.slice(1))]) : [],
    };
  }
  return state;
}

function fileTotals(file) {
  if (!file) return zero();
  return file.recent.reduce((sum, item) => add(sum, item.slice(1)), file.base);
}

/** Cumulative totals for a session: earlier log files plus the current one. */
function totalsOf(value) {
  const state = normalizeState(value);
  const [input, output, cacheRead, cacheWrite] = add(state.carried, fileTotals(state.file));
  return { input, output, cacheRead, cacheWrite, model: state.file?.model || state.model || null };
}

function claudeLine(file, line) {
  if (!line.includes('"usage"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const message = entry?.type === 'assistant' ? entry.message : null;
  const usage = message && typeof message === 'object' ? message.usage : null;
  if (!usage || typeof usage !== 'object') return;
  const numbers = [count(usage.input_tokens), count(usage.output_tokens), count(usage.cache_read_input_tokens), count(usage.cache_creation_input_tokens)];
  const model = modelName(message.model);
  if (model) file.model = model;
  if (typeof message.id !== 'string' || !message.id || message.id.length > 200) { file.base = add(file.base, numbers); return; }
  const id = sha256(message.id).slice(0, 16);
  const index = file.recent.findIndex(item => item[0] === id);
  // The last usage written for a message wins.
  if (index >= 0) { file.recent[index] = [id, ...numbers]; return; }
  file.recent.push([id, ...numbers]);
  while (file.recent.length > RECENT_IDS) file.base = add(file.base, file.recent.shift().slice(1));
}

function codexLine(file, line) {
  if (line.includes('"turn_context"')) {
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    if (entry?.type === 'turn_context') { const model = modelName(entry.payload?.model); if (model) file.model = model; }
    return;
  }
  if (!line.includes('"token_count"')) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const total = entry?.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info?.total_token_usage : null;
  if (!total || typeof total !== 'object') return;
  // Codex totals are already cumulative. input_tokens includes cached (and any
  // cache-write) input, so those are subtracted to avoid counting them twice.
  // output_tokens already includes reasoning_output_tokens
  // (total_tokens = input_tokens + output_tokens), so reasoning is not added.
  const cacheRead = count(total.cached_input_tokens);
  const cacheWrite = count(total.cache_write_input_tokens);
  const input = Math.max(0, count(total.input_tokens) - cacheRead - cacheWrite);
  const latest = [input, count(total.output_tokens), cacheRead, cacheWrite];
  // Never move backwards, whatever order lines arrive in.
  file.base = file.base.map((value, index) => Math.max(value, latest[index]));
}

/**
 * Reads new bytes from a session log and returns the updated usage state.
 * Partial last lines wait for the next call; a rotated or truncated file starts
 * over; malformed lines are skipped; one call reads at most maxBytes.
 */
function readUsage(harness, file, prior, options = {}) {
  const state = normalizeState(prior);
  const opened = openLog(file, options.home);
  if (!opened) return state;
  const { descriptor, stat } = opened;
  try {
    if (!state.file || state.file.path !== file) {
      // A session that moved to another log keeps what it already counted.
      if (state.file) { state.carried = add(state.carried, fileTotals(state.file)); state.model = state.file.model || state.model; }
      state.file = freshFile(file, stat.ino);
    } else if (stat.ino !== state.file.ino || stat.size < state.file.offset) state.file = freshFile(file, stat.ino);
    else if (state.file.head && headHash(descriptor, stat.size) !== state.file.head) state.file = freshFile(file, stat.ino);
    const current = state.file;
    if (!current.head) current.head = headHash(descriptor, stat.size);
    const maxBytes = Math.max(1024, options.maxBytes || READ_BYTES.stop);
    const length = Math.min(stat.size - current.offset, maxBytes);
    if (length <= 0) return state;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const got = fs.readSync(descriptor, buffer, read, length - read, current.offset + read);
      if (!got) break;
      read += got;
    }
    const chunk = buffer.subarray(0, read);
    let start = 0;
    if (current.skip) {
      const newline = chunk.indexOf(10);
      if (newline < 0) { current.offset += read; return state; }
      start = newline + 1;
      current.skip = false;
    }
    const last = chunk.lastIndexOf(10);
    if (last < start) {
      // A line longer than one call's budget cannot hold usage worth the
      // memory; skip it. Otherwise it is a partial line still being written.
      if (start > 0) current.offset += start;
      else if (read === maxBytes) { current.offset += read; current.skip = true; }
      return state;
    }
    const parse = harness === 'codex' ? codexLine : claudeLine;
    for (const line of chunk.subarray(start, last + 1).toString('utf8').split('\n')) if (line) parse(current, line);
    current.offset += last + 1;
    return state;
  } finally { fs.closeSync(descriptor); }
}

/** The exact request body, built only from numbers, a validated model and a hash. */
function usageBody(harness, sessionId, totals, occurredAt) {
  const body = { harness, session: sha256(`${harness}:${sessionId}`) };
  if (totals.model) body.model = totals.model;
  Object.assign(body, { input: count(totals.input), output: count(totals.output), cacheRead: count(totals.cacheRead), cacheWrite: count(totals.cacheWrite), occurredAt: new Date(occurredAt).toISOString() });
  return body;
}

function usageUrl(endpoint) { return `${new URL(endpoint).origin}/api/usage`; }

function lock(file) {
  const target = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      fs.closeSync(descriptor);
      return () => { try { fs.unlinkSync(target); } catch { /* Already gone. */ } };
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt) return null;
      // Another hook holds it. A lock older than any request is stale.
      try { const stat = fs.lstatSync(target); if (stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 30000) return null; fs.unlinkSync(target); }
      catch { return null; }
    }
  }
  return null;
}

/**
 * Reports a session's cumulative token counts when they changed. Silent on
 * every failure: no output, no retry beyond the next natural hook call.
 * trigger "tool" is the liveness path, throttled per session.
 */
async function reportUsage(options, dependencies = {}) {
  const { binding, harness, sessionId, transcriptPath, runId } = options;
  const trigger = options.trigger === 'tool' ? 'tool' : 'stop';
  try {
    if (!binding?.scope || !binding.endpoint || !binding.token || binding.reportAvailable === false) return { status: 'skipped' };
    if (!HARNESSES.has(harness) || typeof sessionId !== 'string' || !sessionId || typeof transcriptPath !== 'string') return { status: 'skipped' };
    const memory = require('./memory');
    const { readPrivate, writePrivate, privateDirectory, hash } = memory.internals;
    const dir = path.join(memory.stateRoot(), binding.scope);
    const file = path.join(dir, `usage-${hash(`${harness}\n${sessionId}`)}.json`);
    const now = dependencies.now ? dependencies.now() : Date.now();
    const due = state => !(state.blocked || state.writeDenied) && (trigger === 'stop' || !(now - (state.lastCheckedAt || 0) < THROTTLE_MS));
    if (!due(readPrivate(file, null) || {})) return { status: 'throttled' };
    if (typeof runId === 'string' && /^em_[a-f0-9]{64}$/.test(runId)) {
      const run = readPrivate(path.join(dir, `${runId}.json`), null);
      if (run?.blocked || run?.writeDenied) return { status: 'skipped' };
    }
    privateDirectory(dir);
    const release = lock(file);
    if (!release) return { status: 'busy' };
    try {
      const state = readPrivate(file, null) || { version: 1 };
      if (state.version !== 1 || !due(state)) return { status: 'throttled' };
      state.log = readUsage(harness, transcriptPath, state.log, { maxBytes: READ_BYTES[trigger] });
      state.lastCheckedAt = now;
      const totals = totalsOf(state.log);
      const sent = state.sent || {};
      const changed = ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => totals[key] !== (sent[key] || 0));
      writePrivate(file, state);
      if (!changed) return { status: 'unchanged' };
      const body = usageBody(harness, sessionId, totals, now);
      const fetchImpl = dependencies.fetchImpl || fetch;
      let response;
      try {
        response = await fetchImpl(usageUrl(binding.endpoint), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS[trigger]),
          headers: { Authorization: `Bearer ${binding.token}`, 'Content-Type': 'application/json', 'User-Agent': 'engram-memory-lifecycle/1' },
          body: JSON.stringify(body),
        });
      } catch { return { status: 'unavailable' }; }
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) state.blocked = true;
      if (response.status === 403) state.writeDenied = true;
      if (response.ok) { state.sent = { input: body.input, output: body.output, cacheRead: body.cacheRead, cacheWrite: body.cacheWrite }; state.lastSentAt = now; }
      writePrivate(file, state);
      return { status: response.ok ? 'sent' : 'rejected' };
    } finally { release(); }
  } catch { return { status: 'error' }; }
}

module.exports = { reportUsage, readUsage, totalsOf, usageBody, usageUrl, openLog, BODY_KEYS, THROTTLE_MS, RECENT_IDS };
