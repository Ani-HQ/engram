# Resolve config paths from process.env.HOME, and make home-writing tests refuse a real home

**Problem shape:** a test sets `process.env.HOME` to a temp folder, calls code
that writes user config (`~/.claude.json`, `~/.cursor/mcp.json`,
`~/.codex/config.toml`), and the expected file is missing from the temp folder.
The write happened, just somewhere else.

**The procedure:**
1. In shared code, never call `os.homedir()` directly for config paths. Use one
   helper: `process.env.HOME || os.homedir()` (see `homeDir()` in `shim/index.js`).
2. In any test that writes under a fake home, add a `beforeEach` guard that
   computes every config path the code under test will write (for example
   `shim.configPathForList(harness)`) and throws unless each starts with the
   temp root. The guard must run before the code under test.
3. If a run already leaked: list `~/<file>.engram-backup-*` with the leak's
   timestamp, diff the earliest one against the live file with secrets masked
   (`sed -E 's/eng_[A-Za-z0-9_-]+/<KEY>/g'`), and restore only the changed entry.
   `~/.claude.json` is rewritten by Claude Code constantly, so restore the one
   key surgically rather than copying the whole backup.

**Why this works / the trap it avoids:** Bun's `os.homedir()` ignores a `HOME`
changed at runtime (Node honours it), so code that mixes `process.env.HOME`
(memory bridge) and `os.homedir()` (connection writer) splits between the temp
home and the developer's real home. The test failed only after the real configs
were overwritten with a fake server URL and key.

**Evidence:** `test/shim-connect-computer.test.ts`, 28 October 2026; real
Engram entries restored from the first `engram-backup` of each file.
