# Sharing a slice of memory

Connect capture and personal agents to your personal workspace. A team workspace is separate; everyone authorized there can read its memory. Connecting an agent directly to a team makes its writes available to that team.

## Describe, review, approve

Open **Sharing** in your personal workspace. Describe the topics and exclusions in ordinary language, for example: “Share our API architecture decisions and deployment discussions; exclude customer details and my personal plans.” Choose an authorized team or name an isolated agent connection.

Engram proposes up to 12 bounded excerpts from a bounded scan of saved memory entries and captured trails. When Jev is configured, separately consented and available under the workspace's applicable access/budget rules, it can judge which candidate excerpts fit the instruction. Otherwise the screen labels its text-match fallback explicitly. Text matching does not understand exclusions or intent. Model judgments can also be wrong; neither mode is a privacy filter or an access grant.

Every excerpt starts unselected. Review the actual text and shorten it to an exact substring to remove private material. Choose the excerpts and acknowledge the recipient before approving. Engram rejects changed or removed sources, expired previews, and changed recipient memberships. A preview expires after 15 minutes; used preview text is cleared immediately, and expired previews for that owner are cleaned when another preview is requested. This is not a scheduled deletion guarantee.

Approval stores only those exact excerpts as separate snapshots. Source titles, source paths, transcripts, and other source metadata are not exposed alongside them. New or edited source material is never added automatically: review a fresh preview to share more. Removing the source later does not revoke an approved snapshot; revoke its share in **Sharing**.

### Team recipient

You must own the personal source workspace and currently belong to the receiving team. The team must accept shares. Approved excerpts appear as read-only `shared-context/<share-id>/<item-id>` pages in the team's memory tools and console, including search and exports. These snapshots are stored in central sharing records and projected into the authorized team; this flow does not copy a whole source page into the team's engine database. Current source ownership, exact memberships and the team's acceptance policy are checked on reads.

Everyone authorized in the receiving team can read those excerpts. This does not create private compartments between teammates. Other memory already in that team retains its existing permissions.

### Isolated agent recipient

Approval produces a separate bearer credential and the endpoint `https://<engram-url>/mcp/shared`. Configure a client that supports HTTP MCP with a bearer header. Copy the masked credential from the result; Engram stores its hash and cannot show it again later. The owner can explicitly replace it or revoke the share.

This connection exposes only `recall`, `search`, `list_pages`, `get_page`, and `whoami` over the approved snapshots. It has no activity, original workspace, writing, or administration access. It cannot authenticate to ordinary `/mcp` or console APIs. Its `egs_` credential is distinct from a workspace key and is not the normal Connections setup/OAuth flow. Clients requiring OAuth-only authentication cannot use this credential directly.

An agent's existing workspace connection keeps its prior access. To give an agent only the approved slice, use this isolated connection and disconnect or revoke its broader connection. Naming a recipient does not bind a bearer credential to a particular person or agent: anyone holding it can read its approved excerpts.

Revocation stops future service reads through that share. It cannot recall text another person or agent already read or exported. Previously exported snapshots and provider handling remain outside this control.

### Authenticated API

The console uses `GET /api/sharing`, `POST /api/sharing/preview`, `POST /api/sharing/commit`, `DELETE /api/sharing/:id`, and `POST /api/sharing/:id/agent-token`. These require an authenticated owner email session, `X-Engram-Console: 1`, and the pinned personal workspace. Preview accepts `{instruction, recipient: {kind: "team", orgId}}` or `{instruction, recipient: {kind: "agent", name}}`; commit accepts `{previewId, selections: [{id, text}], acknowledged: true}`. Creation and extension require applicable hosted access; reading and revocation remain available.

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

## Legacy standing share rules

The structured sharing API remains available for existing integrations. It is separate from the reviewed snapshot flow above and can automatically copy matching future content. It has no semantic natural-language permission engine.

A rule has a match and a level. Match fields are repositories, topics, source harnesses, an optional date range, and trail IDs. Topics match labels by substring, not meaning. Unknown fields and malformed match values are rejected. New unfiltered rules require explicit `matchAll: true`; existing stored unfiltered rules retain their prior behavior. A one-off trail share names one conversation.

Level:

- `digest` — the trail digest. The default.
- `digest_transcript` — the digest, plus the redacted transcript.
- `transcript` — the redacted transcript only.

These levels control captured trails. Matching saved memory entries copy their whole `rawText`, including under `digest`; use reviewed snapshots when only an excerpt should cross the boundary.

The team owner sets `maxShareLevel`. The rule's level is lowered to that cap, never raised. The team can also turn `acceptShares` off.

Unsharing soft-deletes the copies. The console says so: teammates' agents may already have read them.

## Legacy API setup

Standing rules use `GET/POST /api/share/rules`, `POST /api/share/preview`, and the rule-specific update, pause, resume and delete routes. An individual trail can be shared or unshared through `POST /api/trails/:id/share` and `POST /api/trails/:id/unshare`. The console's new **Sharing** view manages reviewed snapshots, not this standing-rule editor.

On hosted Engram, these console routes require an authenticated email session, the `X-Engram-Console: 1` header and the correct workspace. Membership and the receiving team's sharing policy still apply. See `gateway/src/org-api.ts` for request shapes and `gateway/src/sharing.ts` for exact legacy matching behavior.
