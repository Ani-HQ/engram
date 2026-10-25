# Sharing a slice of memory

Conversations and notes land in a personal brain first. Share rules copy matching slices into a team brain. The team cannot read what you have not shared.

This is not a label on a shared page. An org boundary is a different database. Copies remember where they came from, so editing or deleting a rule removes them again.

## Personal brain

The first time you create an org or accept an invite, engram also creates a personal brain. It has one owner. Agents you mint there write only to you.

Capture and `remember` should use a token from that personal brain. Team tokens still write straight to the team, which skips the share step.

## Capture

Optional capture hooks support Claude Code, Cursor, and Codex on your machine.
Before installing, securely load your personal workspace key into exported `ENGRAM_TOKEN`
through a hidden terminal prompt or your secret manager. Do not paste a key into
the command line or source it from a checked-in file. The commands below assume
that environment variable is already set:

```bash
export ENGRAM_HOST='https://<engram-url>'
npx @ani-hq/engram-mcp hooks install claude

npx @ani-hq/engram-mcp hooks install cursor
npx @ani-hq/engram-mcp hooks install codex

unset ENGRAM_TOKEN
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

## Current setup and console

The current console presents memory pages and activity. A dedicated visual editor
for sharing rules and trails is not included in this version. Configure selective
sharing through the authenticated API: `GET/POST /api/share/rules`,
`POST /api/share/preview`, and the rule-specific update, pause, resume and delete
routes. An individual trail can be shared or unshared through
`POST /api/trails/:id/share` and `POST /api/trails/:id/unshare`.

On hosted Engram, these console API routes require an authenticated email session, the
`X-Engram-Console: 1` header and the correct workspace selection. Membership and
the receiving team's sharing policy still apply. Rules copy supported matching
context into a separate team workspace; they do not give the team access to all
personal memory. Everyone authorized in the team workspace can read its shared
memory. See the handlers in `gateway/src/org-api.ts` for the current request shapes.
