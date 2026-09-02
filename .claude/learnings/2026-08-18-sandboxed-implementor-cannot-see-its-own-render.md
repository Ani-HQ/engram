# A sandboxed implementor cannot see its own UI render — the orchestrator must load the real page before believing "tests pass"

**Problem shape:** a delegated agent reports green: unit tests pass, syntax
checks pass, static scans clean, scope respected. The deliverable is a UI. Its
sandbox blocks localhost sockets, so it verified handlers by calling exported
functions directly and never loaded a page in a browser.

**The procedure:**
1. Treat "the implementor could not open a browser" as an explicit gap in
   coverage, not a footnote. Everything that only fails at render time is
   unverified: module wiring, dangling symbols left by a late file split, CSS
   overlap, focus, animation end-states.
2. Serve the real thing yourself and load it. Read the console FIRST — before
   screenshotting — because one uncaught ReferenceError renders a blank page
   that looks like a styling problem.
3. Enumerate dangling references statically rather than one error at a time:
   parse the entry module for called identifiers, subtract imports, local
   declarations, and known globals, and print the remainder. Fixing errors one
   reload at a time hides how many there are.
4. Screenshot only after measuring. A screenshot taken mid-transition looks
   exactly like a broken layout; read the element's rect and computed
   `transform` first, and only trust the picture once the rect is settled.
5. Seed data that exercises the range the design encodes — for age-based
   shading, rows spanning hours to years, backdated in the database. A UI with
   one row proves nothing about the mechanic.
6. Fix render-only defects yourself. A round trip to an agent that cannot
   observe the defect is a blind guess with extra latency.

**Why this works / the trap it avoids:** the naive reading of "51 tests pass"
is that the feature works. Unit tests over pure functions cannot see the
module graph, and a file-splitting refactor at the end of a long run is exactly
where a symbol goes missing. The orchestrator holds the only eyes on the
system, so verification is not delegable even when implementation is.

**Evidence:** engram bunko console, PR #3, 2026-08-18. `showLoading` was
dropped during the implementor's own final file split — 51 tests green, blank
page. Also caught: an empty-state condition that hid the user's only page.
