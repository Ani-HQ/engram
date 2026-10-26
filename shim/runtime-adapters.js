'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { endpointForHost } = require('./onboarding');
const { runtimeCapabilities, normalizeRuntimeEvent } = require('./runtime-contracts');
const memory = require('./memory');
const { hash, readPrivate, writePrivate, sessionFile } = memory.internals;
const ACTIVE_AGE = 15 * 60 * 1000;
const pendingFile = (binding, runtime, session) => path.join(memory.stateRoot(), binding.scope, `pending-${hash(`${runtime}\n${session}`)}.json`);
const activeFile = (binding, runId) => path.join(memory.stateRoot(), binding.scope, `active-${runId}.json`);

function publishActiveRun(binding, runId, runtime, sessionId) {
  writePrivate(activeFile(binding, runId), { runId, runtime, sessionId, updatedAt: Date.now() });
}
function removeFile(file) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
function outputFor(normalized, context) {
  if (!context || !normalized.canInject) return {};
  if (normalized.outputShape === 'hookSpecificOutput') return { hookSpecificOutput: { hookEventName: normalized.hookEventName, additionalContext: context } };
  return { [normalized.outputShape]: context };
}

async function nativeHook(runtime, input, eventName, dependencies = {}) {
  const normalized = normalizeRuntimeEvent(runtime, input, eventName);
  if (!normalized) return {};
  // A desktop configuration is not an implicit install on a cloud agent host.
  if (normalized.runtime === 'cursor' && input.is_background_agent === true) return {};
  const contract = runtimeCapabilities(normalized.runtime);
  let binding;
  try { binding = dependencies.binding || memory.bindingFor(normalized.cwd, normalized.runtime); } catch { return {}; }
  const file = sessionFile(binding, normalized.sessionId, normalized.runtime);
  const active = readPrivate(file, {});
  if (normalized.event === 'stop') return {};
  if (normalized.event === 'session-end') {
    if (active.runId) removeFile(activeFile(binding, active.runId));
    removeFile(pendingFile(binding, normalized.runtime, normalized.sessionId));
    return {};
  }
  if (normalized.event === 'tool-result') {
    const file = pendingFile(binding, normalized.runtime, normalized.sessionId);
    const pending = readPrivate(file, null);
    if (!pending) return {};
    removeFile(file);
    if (pending.expiresAt <= Date.now()) return {};
    const state = readPrivate(path.join(memory.stateRoot(), binding.scope, `${pending.runId}.json`), null);
    if (!state?.started || state.ended || state.blocked) return {};
    const result = await memory.lifecycle('task-context', { runId: pending.runId, query: state.title || binding.topic }, { ...dependencies, binding });
    return outputFor(normalized, result.context);
  }
  if (normalized.event === 'startup') {
    if (['cursor', 'copilot'].includes(normalized.runtime) && !active.runId) {
      // Explicit topic binding allows initial context, but opening a session
      // must not manufacture a running task. Its budget is carried into the
      // first actual task rather than replenished by the later prompt.
      const prefetched = await memory.lifecycle('task-context', { runtime: normalized.runtime, sessionId: normalized.sessionId, taskId: 'bound-project-task:0', query: binding.topic }, { ...dependencies, binding });
      if (prefetched.runId) writePrivate(file, { runId: prefetched.runId, tasks: { 'bound-project-task': { generation: 0, runId: prefetched.runId } }, sequence: 1 });
      if (prefetched.context) return outputFor(normalized, prefetched.context);
    }
    const guide = await memory.claudeHook({ session_id: normalized.sessionId, cwd: normalized.cwd, hook_event_name: 'SessionStart' }, { ...dependencies, binding, runtime: normalized.runtime });
    return outputFor(normalized, guide.hookSpecificOutput?.additionalContext);
  }
  if (normalized.admissionId) {
    const admissionsFile = path.join(memory.stateRoot(), binding.scope, `admissions-${hash(`${normalized.runtime}\n${normalized.sessionId}`)}.json`);
    const seen = readPrivate(admissionsFile, { ids: [] });
    const key = hash(normalized.admissionId);
    if (seen.ids.includes(key)) return {};
    writePrivate(admissionsFile, { ids: [...seen.ids, key].slice(-64) });
  }
  const result = await memory.claudeHook({ session_id: normalized.sessionId, cwd: normalized.cwd, hook_event_name: 'UserPromptSubmit', prompt: normalized.prompt }, { ...dependencies, binding, runtime: normalized.runtime, reportingOnly: contract.reportingOnly, deferRecall: !normalized.canInject });
  const current = readPrivate(file, {});
  if (current.runId) {
    const state = readPrivate(path.join(memory.stateRoot(), binding.scope, `${current.runId}.json`), null);
    if (state?.started && !state.ended && !state.blocked) publishActiveRun(binding, current.runId, normalized.runtime, normalized.sessionId);
  }
  const context = result.hookSpecificOutput?.additionalContext;
  if (normalized.canInject) return outputFor(normalized, context);
  if (current.runId && !contract.reportingOnly) writePrivate(pendingFile(binding, normalized.runtime, normalized.sessionId), { runId: current.runId, expiresAt: Date.now() + 120000 });
  return {};
}

function validRun(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value); }

function proxyContext(options) {
  // Explicit opt-in only. Never infer that native HTTP MCP calls pass here.
  if (!options.project) return null;
  let binding;
  try {
    const endpoint = endpointForHost(options.host).endpoint;
    const eligible = memory.internals.bindingCandidates(options.project).filter(item => endpoint === item.endpoint && timingSafeEqual(Buffer.from(hash(options.token || '')), Buffer.from(hash(item.token))));
    const matchingBindings = eligible.filter(item => item.project.length === eligible[0]?.project.length);
    if (!matchingBindings.length) return null;
    if (matchingBindings.length !== 1) return { maxBytes: Math.min(...matchingBindings.map(item => item.budget)) };
    binding = matchingBindings[0];
    if (options.runId) {
      if (!validRun(options.runId)) return null;
      const state = /^em_[a-f0-9]{64}$/.test(options.runId) && readPrivate(path.join(memory.stateRoot(), binding.scope, `${options.runId}.json`), null);
      if (state?.runId === options.runId && !state.blocked) return memory.internals.runContext(state);
      return { runId: options.runId, maxBytes: binding.budget, integration: { id: 'engram-mcp-memory', version: require('./package.json').version, runtime: 'stdio', capabilities: ['task-context'] } };
    }
    const dir = path.join(memory.stateRoot(), binding.scope);
    memory.internals.noLinks(dir);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^active-em_[a-f0-9]{64}\.json$/.test(name)) : [];
    // Too many candidates is ambiguous, not permission to choose a random task.
    if (files.length > 256) return { maxBytes: binding.budget };
    const candidates = files.map(file => readPrivate(path.join(dir, file), null)).filter(item => item && Date.now() - item.updatedAt < ACTIVE_AGE && (!options.sessionId || item.sessionId === options.sessionId)).filter(item => {
      const state = readPrivate(path.join(dir, `${item.runId}.json`), null);
      return state?.started && !state.ended && !state.blocked;
    });
    if (candidates.length !== 1) return { maxBytes: binding.budget };
    const state = readPrivate(path.join(dir, `${candidates[0].runId}.json`), null);
    return memory.internals.runContext(state);
  } catch { return null; }
}

function augmentProxyMeta(meta, options) {
  const automatic = proxyContext(options);
  if (!automatic) return meta;
  const key = 'com.engram/context';
  const original = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const context = original[key];
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    // A caller's explicit task identity is authoritative. Malformed explicit
    // identity is left for the gateway to reject, never silently rebound.
    if (Object.prototype.hasOwnProperty.call(context, 'runId') && context.runId !== automatic.runId) return { ...original, [key]: { maxBytes: automatic.maxBytes, ...context } };
    return { ...original, [key]: { ...automatic, ...context } };
  }
  return { ...original, [key]: automatic };
}

module.exports = { nativeHook, proxyContext, augmentProxyMeta, publishActiveRun, outputFor };
