# Sharing a slice of memory

Conversations and notes land in a personal brain first. Share rules copy matching slices into a team brain. The team cannot read what you have not shared.

This is not a label on a shared page. An org boundary is a different database. Copies remember where they came from, so editing or deleting a rule removes them again.

## Personal brain

The first time you create an org or accept an invite, engram also creates a personal brain. It has one owner. Agents you mint there write only to you.

Capture and `remember` should use a token from that personal brain. Team tokens still write straight to the team, which skips the share step.

## Capture

Hooks watch Claude Code, Cursor, and Codex on your machine:

```bash
ENGRAM_HOST='https://<engram-url>' \
ENGRAM_TOKEN='<personal-token>' \
npx @ani-hq/engram-mcp hooks install claude

npx @ani-hq/engram-mcp hooks install cursor
npx @ani-hq/engram-mcp hooks install codex
```

Each install writes `~/.config/engram/capture.json` and a hook in the harness config. A conversation that keeps going updates the same trail.

`npx @ani-hq/engram-mcp capture --sweep` walks the local transcript folders and uploads anything the hooks missed. Run it on a schedule if you want a safety net.

Before upload:

- Secrets are redacted (keys, bearer tokens, private keys, `.env` lines, connection strings).
- Repos and paths in `neverRepos` / `neverPaths` in `capture.json` are skipped.
- An oversized transcript is cut in the middle.

Claude.ai, ChatGPT, and Grok web chats have no local transcript. They still contribute through `remember`, and those notes can be shared by rule.

## Share rules

A rule has a match and a level.

Match: repos, topics, harnesses, and an optional date range. Empty means all. A one-off share is a rule that names one conversation.

Level:

- `digest` — a short summary. The default.
- `digest_transcript` — the digest, plus the redacted transcript.
- `transcript` — the redacted transcript only.

The team owner sets `maxShareLevel`. The rule's level is lowered to that cap, never raised. The team can also turn `acceptShares` off.

Unsharing soft-deletes the copies. The console says so: teammates' agents may already have read them.

## Console

On a personal brain: Sharing lists rules, previews a match, and lets you share or unshare one conversation.

On a team brain: Trails lists what people have shared, filtered by teammate, repo, and harness. `recall` returns those digests with the author and harness attached.
