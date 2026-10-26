// Setup targets only. A matching product name does not attest to installation
// or automatic behavior. The executable adapter registry is tested separately.
const profiles = [
  { target: 'claude', aliases: ['claude', 'claude-code'], note: 'Claude Code command hooks retrieve bounded context and check once for a useful memory update. They do not upload conversations.' },
  { target: 'codex', aliases: ['codex'], note: 'Use a locally orchestrated Codex session. Review and trust the generated hooks before enabling them. Work Cloud sessions do not load local hooks, even with a local executor.' },
  { target: 'cursor', aliases: ['cursor'], note: 'Use the desktop adapter. Context is delivered only through supported hook outputs; cloud sessions have a different lifecycle.' },
  { target: 'gemini', aliases: ['gemini', 'gemini-cli'], note: 'Gemini CLI hooks retrieve context before the agent turn. Task completion still needs an explicit known outcome.' },
  { target: 'copilot', aliases: ['copilot', 'github-copilot', 'vscode'], note: 'Use a compatible local Copilot runtime. Hook support varies by session type and version; review the generated configuration.' },
  { target: 'opencode', aliases: ['opencode'], note: 'Review and enable the generated OpenCode plugin. An idle session does not count as a completed task.' },
  { target: 'openclaw', aliases: ['openclaw'], note: 'Install on the OpenClaw Gateway computer. The documented plugin permissions still control context injection and hook access.' },
  { target: 'windsurf', aliases: ['windsurf'], note: 'This adapter reports factual lifecycle events. Retrieved context still needs the portable skill or a runtime with supported context injection.' },
];
export const memoryRuntimeProfiles = Object.freeze(profiles.map(profile => Object.freeze(profile)));
export const memoryRuntimeProfile = harness => profiles.find(profile => profile.aliases.includes(harness)) || null;
