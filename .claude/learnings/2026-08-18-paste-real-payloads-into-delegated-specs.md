# When delegating code that talks to an external engine, paste the engine's real response payloads into the spec — never let the implementor infer field names

**Problem shape:** you hand a spec to a sub-agent (Codex, a subagent, a
contractor) that must call an API, database, or MCP server you did not write.
The work comes back with passing unit tests, clean scope, and a confident
summary — and every normaliser is keyed on plausible field names that the real
service never emits. Tests pass because they assert against the same guess.

**The procedure:**
1. Before writing the spec, call each engine operation the delegated code will
   use, against the real instance, and capture the raw JSON.
2. Diff the captured payload against the field names your spec implies. Check
   three things specifically: the name of the body/content field, whether
   timestamps exist at all on each operation, and whether a field is the type
   you assumed (a `timeline` that is a string, not an array).
3. Paste the captured payloads verbatim into the spec, labelled per operation,
   and make "unit-test the normalisers against exactly these payloads" an
   acceptance criterion. Guessed-shape tests are worse than no tests.
4. For every write verb, read its required arguments. If a verb's output is
   invisible to the read path the UI uses (a fact that never appears in a page
   list), say so in the spec and name the verb to use instead.
5. Re-run step 1 after the round lands, against the running system, not the
   test suite.

**Why this works / the trap it avoids:** an implementor with no access to the
live service cannot distinguish a plausible field name from a real one, and it
will write tests that lock its guess in. The failure is silent — HTTP 200 with
`snippet: ""` everywhere — so it survives every check that does not involve the
actual service. Capturing payloads costs one round trip and converts an entire
class of silent-empty bugs into a mechanical comparison.

**Evidence:** engram bunko console, PR #3, 2026-08-18. Round 1 guessed
`{text}` for `remember` (real: `{fact, provenance}`, both required),
`snippet`/`updated_at` for search (real: `chunk_text`/`effective_date`), and an
array `timeline` (real: a prose string). All three passed round-1 tests.
