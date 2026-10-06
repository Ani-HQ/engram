export function hashAction() {
  const raw = location.hash.replace(/^#/, "");
  if (raw.startsWith("join=")) return { kind: "join", token: raw.slice(5) };
  if (raw === "start") return { kind: "start" };
  if (raw === "enter") return { kind: "enter" };
  return { kind: "" };
}

export function needsOnboarding(session) {
  const step = session?.onboarding?.step;
  return step === "connect" || step === "remember";
}

export function copyText(value) {
  if (!value) return Promise.resolve();
  return navigator.clipboard?.writeText(value).catch(() => {});
}

export function wiringBlocks(wiring, token) {
  const mcp = wiring?.mcp || "";
  const shown = token || "<token>";
  return {
    mcp,
    cursor: JSON.stringify(wiring?.cursor ?? {
      mcpServers: { engram: { url: mcp, headers: { Authorization: `Bearer ${shown}` } } },
    }, null, 2),
    claudeCode: wiring?.claudeCode || `claude mcp add --scope user --transport http engram ${mcp} --header "Authorization: Bearer ${shown}"`,
    chat: wiring?.chatConnectors || "Claude, ChatGPT, and Grok connectors cannot connect yet.",
  };
}
