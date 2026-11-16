# Verify an agent CLI's hook payload and config fields from its own binary and a real log before coding against them

**Problem shape:** you need a hook input field (`transcript_path`), an event
(`PostToolUse`), a config option (`async`) or a session-log format for a
runtime whose docs are thin or newer than your knowledge, and a wrong guess
would fail silently inside a fail-open hook.

**The procedure:**
1. Find the native binary: resolve the CLI symlink, then look for the large
   vendored executable (for Codex: `node_modules/@openai/codex-*/vendor/*/bin/codex`).
2. `strings -n 4 <binary> > scratch.txt` once, then grep the dump for the
   schema titles (`post-tool-use.command.input`) and read the `required` list.
3. Grep the dump for warnings near the option you plan to use. Codex 0.160 has
   `async` in its hook config but prints "running async hook synchronously", so
   do not rely on it there (Claude Code's `async: true` is real background).
4. For a log format, read only structure: parse lines in a script that prints
   key shapes and numbers, replacing every string with its type, so no
   conversation text reaches your context. Check invariants
   (Codex: `total_tokens == input_tokens + output_tokens`, so reasoning is
   already inside output).
5. Encode what you verified as fixtures in tests that mirror the real shape.

**Why this works / the trap it avoids:** hook runners swallow errors and print
`{}`, so a misnamed field or ignored option looks like success. The binary's
embedded JSON schemas and warning strings are the ground truth for the
installed version; docs and memory are not.

**Evidence:** `shim/token-usage.js` and `test/shim-token-usage.test.ts`,
16 November 2026 (Codex PostToolUse schema and rollout token_count lines).
