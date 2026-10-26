// Setup targets only. A matching product name does not attest to installation
// or automatic behavior. The executable adapter registry is tested separately.
const profiles = [
  { target: 'claude', aliases: ['claude', 'claude-code'], note: 'Claude Code command hooks retrieve bounded context and check once for a useful memory update. They do not upload conversations.' },
  { target: 'codex', aliases: ['codex'], note: 'Use a locally orchestrated Codex session. Review and trust the generated hooks before enabling them. Work Cloud sessions do not load local hooks, even with a local executor. Existing agent-managed sign-in is preserved; setup may use a managed memory skill instead, whose use is model-chosen and has no hard cumulative task budget.' },
  { target: 'cursor', aliases: ['cursor'], note: 'Use the desktop adapter. Context is delivered only through supported hook outputs; cloud sessions have a different lifecycle.' },
  { target: 'gemini', aliases: ['gemini', 'gemini-cli'], note: 'Gemini CLI hooks retrieve context before the agent turn. Task completion still needs an explicit known outcome.' },
  { target: 'copilot', aliases: ['copilot', 'github-copilot', 'vscode'], note: 'Use a compatible local Copilot runtime. Hook support varies by session type and version; review the generated configuration.' },
  { target: 'opencode', aliases: ['opencode'], note: 'Review and enable the generated OpenCode plugin. An idle session does not count as a completed task.' },
  { target: 'openclaw', aliases: ['openclaw'], note: 'Install on the OpenClaw Gateway computer. The documented plugin permissions still control context injection and hook access.' },
  { target: 'windsurf', aliases: ['windsurf'], note: 'This adapter reports factual lifecycle events. Retrieved context still needs the portable skill or a runtime with supported context injection.' },
];
export const memoryRuntimeProfiles = Object.freeze(profiles.map(profile => Object.freeze(profile)));
export const memoryRuntimeProfile = harness => profiles.find(profile => profile.aliases.includes(harness)) || null;

// Keep the instance selected by the workspace. Never place credentials in a
// command, and reject URL text that URL() would silently discard.
export function managedSetupCommand(harness, endpoint) {
  const profile = memoryRuntimeProfile(harness);
  if (!profile || typeof endpoint !== 'string' || endpoint.length > 2048 || /[\x00-\x20\x7f-\x9f]/.test(endpoint)) return null;
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    const host = url.href.replace(/\/$/, '').replace(/\/mcp$/, '');
    const target = harness === 'vscode' ? 'vscode' : profile.target;
    return `npx -y @ani-hq/engram-mcp setup ${target} --host '${host.replace(/'/g, `'\\''`)}'`;
  } catch { return null; }
}
