# Before wiring a new agent's hooks, check which other agents' config it already imports

**Problem shape:** adding an agent to Engram's setup (MCP entry plus lifecycle
hooks). Everything works in tests, but in real use events fire twice, or work
is attributed to the wrong agent, because the new agent quietly runs another
agent's hooks or MCP servers too.

**The procedure:**
1. Fetch the raw docs, not a summary: many doc sites serve `<page>.md`
   (`curl -sL https://docs.devin.ai/<path>.md`); for HTML-only sites strip tags
   and grep. Grep for `read_config_from`, `import`, `.claude`, `claude.json`,
   `compat`, `precedence`, `XDG`, `timeout`, `cwd`.
2. If the agent imports another agent's hooks (Devin CLI runs `~/.claude`
   hooks by default), find an env var only that agent sets for hooks
   (`DEVIN_PROJECT_DIR`) and make the other agent's hook stand aside when the
   new agent has its own binding (`devinRunsOwnHooks` in `shim/memory.js`).
   Test it by spawning the real hook command with and without that variable.
3. Note what the docs do NOT say (which duplicate MCP server wins, stdin `cwd`)
   and fall back to a documented source (`DEVIN_PROJECT_DIR`, `process.cwd()`).
4. Use the docs' literal paths: Amp plugins honour `XDG_CONFIG_HOME`, Amp and
   Devin settings are documented as `~/.config/...` only.
5. Detect by config folder, not command, when the command name is generic
   (`hermes`, `amp` collide with unrelated programs).
6. A server-side allowlist means an older server rejects the whole device
   request; the client retries with the agents the old server knows.
7. For YAML with no dependency (`shim/yaml-block.js`): replace only your own
   block or list item, and refuse flow style, anchors, tabs and duplicate keys
   instead of rewriting. Parse the output with `Bun.YAML.parse` in a check.

**Why this works / the trap it avoids:** per-agent tests run each agent alone
in a temp home, so cross-agent imports never show up there. A real computer
has both agents set up at once.

**Evidence:** PR feat/one-step-more-agents, 28 October 2026 (OpenClaw, Hermes
Agent, Amp, Devin CLI).
