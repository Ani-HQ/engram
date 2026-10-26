import { expect, test } from 'bun:test';
import { memoryRuntimeProfiles } from '../web/memory-runtime-options.js';
const { RUNTIMES, runtimeCapabilities, normalizeRuntimeEvent } = require('../shim/runtime-contracts.js');

const prompts = [
  ['codex', { hook_event_name: 'UserPromptSubmit', session_id: 'fixture-session', cwd: '/fixture', prompt: 'Implement retries' }],
  ['gemini', { hook_event_name: 'BeforeAgent', session_id: 'fixture-session', cwd: '/fixture', prompt: 'Implement retries' }],
  ['cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'fixture-session', workspace_roots: ['/fixture'], prompt: 'Implement retries' }],
  ['copilot', { sessionId: 'fixture-session', cwd: '/fixture', prompt: 'Implement retries' }, 'userPromptSubmitted'],
  ['opencode', { hook_event_name: 'chat.message', sessionID: 'fixture-session', cwd: '/fixture', prompt: 'Implement retries' }],
  ['openclaw', { hook_event_name: 'before_prompt_build', sessionKey: 'fixture-session', cwd: '/fixture', prompt: 'Implement retries' }],
  ['windsurf', { agent_action_name: 'pre_user_prompt', trajectory_id: 'fixture-session', cwd: '/fixture', tool_info: { user_prompt: 'Implement retries' } }],
] as const;

test('every native setup option maps to an installable executable registry entry', () => {
  for (const profile of memoryRuntimeProfiles) {
    expect(runtimeCapabilities(profile.target)?.installable).toBe(true);
    for (const alias of profile.aliases) expect(runtimeCapabilities(alias)?.id).toBe(profile.target);
  }
  for (const runtime of ['grokbot', 'cline', 'goose', 'generic']) expect(RUNTIMES[runtime].kind).toBe('guidance');
  expect(RUNTIMES.windsurf.reportingOnly).toBe(true);
  expect(RUNTIMES.windsurf.injectionEvents).toEqual([]);
});

test('runtime prompt fixtures agree on task entry without inventing context injection', () => {
  for (const [runtime, input, eventName] of prompts) {
    const normalized = normalizeRuntimeEvent(runtime, { ...input, transcript_path: '/private/not-read', messages: [{ content: 'PRIVATE_HISTORY' }] }, eventName);
    expect(normalized).toMatchObject({ runtime, event: 'prompt', sessionId: 'fixture-session', cwd: '/fixture', prompt: 'Implement retries' });
    expect(JSON.stringify(normalized)).not.toContain('PRIVATE_HISTORY');
    expect(JSON.stringify(normalized)).not.toContain('/private/not-read');
    if (['cursor', 'copilot', 'windsurf'].includes(runtime)) expect(normalized.canInject).toBe(false);
    else expect(normalized.canInject).toBe(true);
  }
});

test('turn, stop, idle and session-end events never normalize into successful task completion', () => {
  for (const [runtime, hook] of [['codex', 'Stop'], ['gemini', 'AfterAgent'], ['cursor', 'stop'], ['copilot', 'agentStop'], ['opencode', 'session.idle'], ['openclaw', 'agent_end'], ['windsurf', 'post_cascade_response']]) {
    const normalized = normalizeRuntimeEvent(runtime, { session_id: 'fixture-session', cwd: '/fixture' }, hook);
    expect(normalized?.event).toBe('stop');
    expect(normalized).not.toHaveProperty('status', 'completed');
    expect(normalized).not.toHaveProperty('outcome');
  }
});
