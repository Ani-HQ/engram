import { managedSetupCommand } from './memory-runtime-options.js';

// Progress comes only from successful server receipts. UI actions never complete a check.
export const onboardingAgents = [
  { id: "claude-code", label: "Claude Code", harness: "claude" },
  { id: "codex", label: "Codex", harness: "codex" },
  { id: "cursor", label: "Cursor", harness: "cursor" },
  { id: "gemini-cli", label: "Gemini CLI", harness: "gemini" },
  { id: "github-copilot", label: "GitHub Copilot CLI", harness: "copilot" },
  { id: "opencode", label: "OpenCode", harness: "opencode" },
  { id: "openclaw", label: "OpenClaw Gateway", harness: "openclaw" },
  { id: "windsurf", label: "Windsurf", harness: "windsurf" },
  { id: "claude", label: "Claude", oauth: true },
  { id: "chatgpt", label: "ChatGPT", oauth: true },
  { id: "grok", label: "Grok", oauth: true },
  { id: "grok-bot", label: "Grok Bot", providerManaged: true },
  { id: "vscode", label: "VS Code", harness: "vscode" },
  { id: "other", label: "Another MCP client" },
];
const coreChecks = ["agentConnected", "memorySaved", "memoryRecalled"];

export function onboardingProgress(data) {
  const available = data?.checks && [...coreChecks, "taskReported"].every(key => typeof data.checks[key] === "boolean");
  const checks = Object.fromEntries([...coreChecks, "taskReported"].map(key => [key, Boolean(available) && data.checks[key] === true]));
  const completed = coreChecks.filter(key => checks[key]).length;
  const step = !checks.agentConnected ? "connect" : !checks.memorySaved ? "remember" : !checks.memoryRecalled ? "recall" : "done";
  return { available: Boolean(available), checks, completed, step, done: Boolean(available) && completed === 3 };
}

export function shouldOfferOnboarding(data) {
  const progress = onboardingProgress(data);
  // Legacy flags avoid interrupting established workspaces, but never prove success.
  return progress.available && !data.provisioning && data.hasToken === false && data.hasPage === false && progress.completed === 0;
}

export function onboardingWriteGuidance({ policies, agentId, inventory } = {}) {
  if (policies?.agentsMayWrite === false) return {
    state: "policy-blocked", href: "#workspace", link: "Review workspace settings",
    message: "Agent writes are turned off for this workspace. A workspace owner can enable Allow agents to write. The agent's connection also needs read and write access.",
  };
  const source = onboardingAgents.find(agent => agent.id === agentId);
  const listed = source && Array.isArray(inventory?.connections)
    ? inventory.connections.filter(connection => connection?.status === "authorized" && connection.harness === source.id) : [];
  if (listed.length && listed.every(connection => connection.canWrite === false)) return {
    state: "listed-read-only", href: "#connect", link: "Review connections",
    message: `The listed ${source.label} connections are read-only. Choose a connection with read and write access, or ask your workspace owner to update its permission.`,
  };
  // A product choice or a human session does not identify the agent credential,
  // and connection metadata does not establish workspace policy or plan access.
  return { state: "check-permissions", href: "#connect", link: "Review connection permissions",
    message: "Saving needs an agent connection with read and write access. Workspace settings and hosted plan access also apply. If the save is denied, check the agent's connection permissions.",
  };
}

export function agentConnectionGuide(agentId, mcp) {
  const agent = onboardingAgents.find(item => item.id === agentId);
  if (!agent) return null;
  let endpoint;
  try {
    if (typeof mcp !== "string" || mcp.length > 2048 || /[\x00-\x20\x7f-\x9f]/.test(mcp)) return null;
    const parsed = new URL(mcp);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return null;
    endpoint = parsed.href.replace(/\/$/, "");
  } catch { return null; }
  const host = endpoint.replace(/\/mcp$/, "");
  return { ...agent, endpoint, host,
    command: agent.harness ? managedSetupCommand(agent.harness, endpoint) : null,
  };
}

export const connectionCheckPrompt = "Call Engram's whoami tool to check this connection. Tell me whether the call succeeded. Do not read or write memory for this connection check, and do not claim success if the tool is unavailable or returns an error.";
export const firstMemoryPrompt = "Use Engram to remember one useful decision or preference from our current work. If there is nothing suitable yet, ask me what I want to save. Keep credentials and private transcripts out. Save only what we agreed to remember, and confirm success only after Engram accepts the save. If access is read-only or the save fails, explain what needs attention.";
export const recallMemoryPrompt = "Use Engram's recall tool to find the decision or preference we just saved. Show me what Engram returned and its source. If it cannot be found or the call fails, say so; do not invent a saved memory.";

export function accessKeyConfiguration(agentId, mcp, token = "<access-token>") {
  if (agentId === "codex") return `[mcp_servers.engram]\nurl = ${JSON.stringify(mcp)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`;
  const connection = { url: mcp, headers: { Authorization: `Bearer ${token}` } };
  return JSON.stringify(agentId === "vscode" ? { servers: { engram: { type: "http", ...connection } } } : { mcpServers: { engram: connection } }, null, 2);
}

// Invalidating on session changes protects even a leave-and-return to the same org.
export function createOnboardingReader(read, currentWorkspace) {
  let revision = 0;
  return {
    invalidate() { revision += 1; },
    async read(workspaceId) {
      const request = ++revision;
      const current = () => request === revision && currentWorkspace() === workspaceId;
      try {
        const data = await read(workspaceId);
        return current() ? { data } : { stale: true };
      } catch (error) {
        if (!current()) return { stale: true };
        throw error;
      }
    },
  };
}
