'use strict';

const POSIX = ['darwin', 'linux'];
const common = { platforms: POSIX, verifiedDocsAt: '2026-10-26', versionConstraint: 'Requires the hook/plugin API in the linked documentation; installed runtime version is not automatically certified.', readPropagation: 'Task metadata covers native bridge reads and explicitly opted-in stdio; direct native HTTP MCP calls remain response-scoped.' };
const RUNTIMES = {
  claude: { ...common, id: 'claude', label: 'Claude Code', kind: 'command-hooks', events: ['SessionStart', 'UserPromptSubmit', 'Stop'], injectionEvents: ['SessionStart', 'UserPromptSubmit'], reportingOnly: false, installable: true, docs: ['https://code.claude.com/docs/en/hooks'], limits: ['First substantive prompt/session heuristic; later tasks need explicit names or known task-end.', 'Stop never proves task completion.'] },
  codex: { ...common, id: 'codex', label: 'Codex desktop / CLI', kind: 'command-hooks', events: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'], injectionEvents: ['SessionStart', 'UserPromptSubmit'], reportingOnly: false, installable: true, docs: ['https://learn.chatgpt.com/docs/hooks'], limits: ['Command hooks require local orchestration and execution; Work Cloud orchestration does not load these local hooks.', 'Review and trust the exact hook definitions through /hooks; disabled features or managed-only policy remain authoritative.', 'Root sessions and subagent sessions need separate stable task identities.'] },
  cursor: { ...common, id: 'cursor', label: 'Cursor desktop', kind: 'command-hooks', events: ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd'], injectionEvents: ['sessionStart', 'postToolUse'], reportingOnly: false, installable: true, docs: ['https://cursor.com/docs/hooks'], limits: ['Desktop adapter only; cloud hooks and local home configuration differ.', 'beforeSubmitPrompt cannot inject context; late task context waits for postToolUse.', 'sessionStart is fire-and-forget; its context is repeated once on the first postToolUse, then forgotten.'] },
  gemini: { ...common, id: 'gemini', label: 'Gemini CLI', kind: 'command-hooks', events: ['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd'], injectionEvents: ['SessionStart', 'BeforeAgent'], reportingOnly: false, installable: true, docs: ['https://geminicli.com/docs/hooks/reference/'], limits: ['Hook-enabled Gemini CLI only.', 'AfterAgent is a turn boundary, never task completion.'] },
  copilot: { ...common, id: 'copilot', label: 'GitHub Copilot / VS Code Copilot runtime', kind: 'command-hooks', events: ['sessionStart', 'userPromptSubmitted', 'postToolUse', 'agentStop', 'sessionEnd'], injectionEvents: ['sessionStart', 'postToolUse'], reportingOnly: false, installable: true, docs: ['https://docs.github.com/en/copilot/reference/hooks-reference', 'https://code.visualstudio.com/docs/agent-customization/hooks'], limits: ['Only the Copilot runtime contract; other VS Code session targets differ.', 'Command userPromptSubmitted output is dropped; later context waits for postToolUse.', 'User hooks do not configure a cloud job; cloud firewall and ephemeral-host rules apply.'] },
  opencode: { ...common, id: 'opencode', label: 'OpenCode', kind: 'plugin', events: ['chat.message', 'session.created', 'session.idle', 'session.deleted'], injectionEvents: ['chat.message'], reportingOnly: false, installable: true, docs: ['https://opencode.ai/docs/plugins/'], limits: ['Plugin contract checked against @opencode-ai/plugin 1.19.4.', 'session.idle never proves task completion.'] },
  openclaw: { ...common, id: 'openclaw', label: 'OpenClaw', kind: 'plugin', events: ['before_prompt_build', 'agent_end', 'session_end'], injectionEvents: ['before_prompt_build'], reportingOnly: false, installable: true, docs: ['https://docs.openclaw.ai/plugins/hooks', 'https://docs.openclaw.ai/plugins/hooks/prompt-and-session'], limits: ['Install on the actual Gateway/worker host.', 'Prompt hook requires explicit plugin conversation-access and prompt-injection grants.', 'agent_end is a turn boundary, never task completion.'] },
  hermes: { ...common, id: 'hermes', label: 'Hermes Agent', kind: 'command-hooks', events: ['pre_llm_call'], injectionEvents: ['pre_llm_call'], startupOnFirstPrompt: true, reportingOnly: false, installable: true, verifiedDocsAt: '2026-10-28', docs: ['https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks', 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp'], limits: ['Shell hooks in ~/.hermes/config.yaml (default profile only).', 'Hermes asks once before running each new hook command; the gateway, cron and CI never prompt and need an accepted hook.', 'on_session_end fires after every turn, so it is not used and never means task completion.'] },
  amp: { ...common, id: 'amp', label: 'Amp', kind: 'plugin', events: ['agent.start'], injectionEvents: ['agent.start'], startupOnFirstPrompt: true, reportingOnly: false, installable: true, verifiedDocsAt: '2026-10-28', docs: ['https://ampcode.com/docs/customize/plugins', 'https://ampcode.com/docs/plugin-api'], limits: ['System plugin in $XDG_CONFIG_HOME/amp/plugins or ~/.config/amp/plugins on this computer.', 'Needs an open workspace; threads without one get no context.', 'agent.end is a turn boundary, never task completion, so it is not used.'] },
  devin: { ...common, id: 'devin', label: 'Devin CLI', kind: 'command-hooks', events: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'], injectionEvents: ['SessionStart', 'UserPromptSubmit'], reportingOnly: false, installable: true, verifiedDocsAt: '2026-10-28', docs: ['https://docs.devin.ai/cli/extensibility/hooks/overview', 'https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks', 'https://docs.devin.ai/cli/reference/configuration/read-config-from'], limits: ['Devin CLI also runs Claude Code hooks from ~/.claude by default; Engram\'s Claude hook stands aside inside Devin when Devin has its own connection.', 'Stop never proves task completion.'] },
  windsurf: { ...common, id: 'windsurf', label: 'Windsurf / Cascade', kind: 'command-hooks', events: ['pre_user_prompt', 'post_cascade_response'], injectionEvents: [], reportingOnly: true, installable: true, docs: ['https://docs.devin.ai/desktop/cascade/hooks'], limits: ['Factual lifecycle reporting only; no documented context-injection return contract is claimed.', 'Never reads transcript hooks or forwards full responses.'] },
  grokbot: { ...common, id: 'grokbot', label: 'Grok Bot', kind: 'guidance', events: [], injectionEvents: [], reportingOnly: false, installable: true, docs: ['https://docs.x.ai/grok-bot/faq', 'https://docs.x.ai/grok-bot/skills-routines-and-automations'], limits: ['Skill/MCP workflow is model-chosen.', 'A local Mac CLI binding does not configure Grok Bot’s persistent cloud computer.'] },
  cline: { ...common, id: 'cline', label: 'Cline', kind: 'guidance', events: [], injectionEvents: [], reportingOnly: false, installable: false, docs: ['https://docs.cline.bot/customization/plugins.md'], limits: ['Use portable MCP guidance or an owned SDK wrapper.', 'Native SDK/CLI plugins exist, but do not apply to all Cline IDE extensions.'] },
  goose: { ...common, id: 'goose', label: 'Goose', kind: 'guidance', events: [], injectionEvents: [], reportingOnly: false, installable: false, docs: ['https://goose-docs.ai/llms.txt'], limits: ['MCP/project instructions supported; native task hooks have not been certified here.'] },
  generic: { ...common, id: 'generic', label: 'Owned runtime / other MCP client', kind: 'guidance', events: [], injectionEvents: [], reportingOnly: false, installable: true, docs: [], limits: ['Portable MCP instructions are best-effort; owned runtime events can call the generic bridge explicitly.'] },
};
const aliases = { 'claude-code': 'claude', 'gemini-cli': 'gemini', vscode: 'copilot', 'github-copilot': 'copilot', 'grok-bot': 'grokbot', 'open-code': 'opencode', 'open-claw': 'openclaw', 'hermes-agent': 'hermes', ampcode: 'amp', 'devin-cli': 'devin' };
function runtimeId(value) { const key = String(value || '').toLowerCase(); return aliases[key] || key; }
function runtimeCapabilities(value) {
  const id = runtimeId(value);
  return RUNTIMES[id] ? JSON.parse(JSON.stringify(RUNTIMES[id])) : null;
}

function normalizeRuntimeEvent(value, input, eventName) {
  const runtime = runtimeId(value), contract = RUNTIMES[runtime];
  if (!contract || !input || typeof input !== 'object') return null;
  const hook = String(eventName || input.hook_event_name || input.agent_action_name || '');
  const maps = {
    codex: { SessionStart: 'startup', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' },
    cursor: { sessionStart: 'startup', beforeSubmitPrompt: 'prompt', postToolUse: 'tool-result', stop: 'stop', sessionEnd: 'session-end' },
    gemini: { SessionStart: 'startup', BeforeAgent: 'prompt', AfterAgent: 'stop', SessionEnd: 'session-end' },
    copilot: { sessionStart: 'startup', userPromptSubmitted: 'prompt', postToolUse: 'tool-result', agentStop: 'stop', sessionEnd: 'session-end', SessionStart: 'startup', UserPromptSubmit: 'prompt', PostToolUse: 'tool-result', Stop: 'stop', SessionEnd: 'session-end' },
    opencode: { 'chat.message': 'prompt', 'session.created': 'startup', 'session.idle': 'stop', 'session.deleted': 'session-end' },
    openclaw: { before_prompt_build: 'prompt', agent_end: 'stop', session_end: 'session-end' },
    windsurf: { pre_user_prompt: 'prompt', post_cascade_response: 'stop' },
    hermes: { pre_llm_call: 'prompt' },
    amp: { 'agent.start': 'prompt' },
    devin: { SessionStart: 'startup', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' },
  };
  const event = maps[runtime]?.[hook];
  if (!event) return null;
  const sessionId = input.session_id || input.sessionId || input.sessionID || input.sessionKey || input.conversation_id || input.trajectory_id;
  // Devin documents DEVIN_PROJECT_DIR for hooks but no cwd field on stdin.
  const cwd = input.cwd || input.workspaceDir || input.directory || input.workspace_roots?.[0] || (runtime === 'devin' ? process.env.DEVIN_PROJECT_DIR || process.cwd() : runtime === 'windsurf' ? process.cwd() : undefined);
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || typeof cwd !== 'string' || !cwd) return null;
  // Hermes shell hooks carry event arguments under `extra`.
  const extra = runtime === 'hermes' && input.extra && typeof input.extra === 'object' ? input.extra : {};
  const prompt = input.prompt || input.initialPrompt || input.initial_prompt || input.tool_info?.user_prompt || extra.user_message || '';
  if (typeof prompt !== 'string') return null;
  const canInject = contract.injectionEvents.includes(hook) || (runtime === 'copilot' && ['SessionStart', 'PostToolUse'].includes(hook));
  const outputShape = !canInject ? 'none' : runtime === 'cursor' ? 'additional_context' : runtime === 'copilot' ? 'additionalContext' : runtime === 'openclaw' ? 'prependContext' : ['hermes', 'amp'].includes(runtime) ? 'context' : runtime === 'opencode' ? 'text-part' : 'hookSpecificOutput';
  const admissionId = input.currentUserMessageId || input.messageID || input.turn_id || extra.turn_id || (runtime === 'cursor' ? input.generation_id : runtime === 'windsurf' ? input.execution_id : runtime === 'devin' ? input.prompt_id : undefined);
  // Runtimes without an injectable session start get the startup guide once, on the first turn.
  const firstTurn = contract.startupOnFirstPrompt === true && (input.firstTurn === true || extra.is_first_turn === true);
  return { runtime, event, hookEventName: hook, sessionId, cwd, prompt: prompt.slice(0, 8000), canInject, outputShape, ...(firstTurn ? { firstTurn } : {}), ...(typeof admissionId === 'string' && admissionId.length <= 200 ? { admissionId } : {}) };
}

module.exports = { RUNTIMES, runtimeId, runtimeCapabilities, normalizeRuntimeEvent };
