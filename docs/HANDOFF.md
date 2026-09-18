# Handing work between agents

The point of engram is that you can stop working in one harness and pick up in
another without re-explaining anything. Claude Code caps out; you open Cursor and
say "pick up the engram project"; it knows what you were doing.

That works only if something gets written down. This is what to write.

## Write intent, never state

The single rule. A handoff note records **what we decided and why**, not what the
files currently look like.

- ✅ "Deleted scopes because this is one trusted team; tokens are identity now"
- ✅ "Deploy is gated on backups — the migration is destructive"
- ✅ "Next: wire Codex, blocked on minting a token"
- ❌ "8 files changed, tests passing, on branch feat/one-brain"

State goes stale the moment anything moves, and a confidently wrong memory is
worse than no memory. The incoming agent re-derives state itself: `git status`,
`git log`, the test suite. Those are always right and cost nothing to check.

## One page per project, appended

Use `remember` with a `topic` matching the project. It appends a dated bullet to
`projects/<topic>` rather than creating a new page each time, so a project has one
continuous thread instead of forty near-duplicate session notes that make every
later search worse.

A topic page cannot grow forever. `get_page` returns a page whole and has no cap, so
an unbounded page charges its entire history to the context of every agent that opens
it, and `recall` could only ever hand back a slice. Once a topic page outgrows its
budget, `remember` moves the oldest entries to `projects/<topic>-archive` and leaves a
link to it. Nothing is lost: an archive is a page like any other, so `search` and
`recall` still reach it. What changes is that the live page stays short enough to be
returned in full, which is the only way a resuming agent reads the *newest* decisions
rather than the oldest.

If you do ask `recall` for a full body and the page is still over the cap, you get its
opening and its most recent entries with the middle elided, never the head alone.

```
remember(topic: "engram", text: "Deferred the Claude Code hook — a shell hook
cannot see the conversation. Testing whether instructed agents write on their own
first.")
```

## Recall before starting, not on every session

`recall` costs context. Call it when there is a named subject with plausible
history — a project, a recurring decision, a repo you have touched before. Do not
call it to answer questions the current conversation already contains.

`recall` returns titles and short snippets. Read those first; pass `full: true`
only when one specific page is clearly the one you need.

## What a good handoff note looks like

```
- 2026-09-15 — Building memory verbs. remember/recall are synthesized in the
  gateway, not gbrain tools, so one storage model (pages) stays true.
- 2026-09-15 — Deferred hooks until we prove an instructed agent writes unprompted.
  Three weeks wired to two harnesses produced zero agent-initiated writes.
- 2026-09-15 — Next: run the cross-harness test. Work in Claude Code, stop, open
  Cursor, ask it to pick up engram. If it cannot, the instruction layer is the
  problem, not the transport.
```

Short, dated, intent-bearing, and enough for a cold agent to resume.
