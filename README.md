# engram

One memory. Every agent. A personal brain first, then the slices you choose to share.

[![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-black)](https://modelcontextprotocol.io)
[![Engine](https://img.shields.io/badge/engine-gbrain-black)](https://github.com/garrytan/gbrain)

engram is shared memory for an organization. Claude, Cursor, ChatGPT, Codex, Grok, and any other MCP client read and write that org's brain. Each person also gets a personal brain. Conversations and notes land there first. Share rules copy matching slices into the team. A second org gets its own database. Inside an org, a token names who called.

Self-host it, or [ask us to run it](https://github.com/Ani-HQ/engram/issues/new).

## Quick start

```bash
docker compose up
```

MCP is at `http://localhost:8080/mcp`. The console is at `http://localhost:8080/`.

Mint one token per agent so the audit log can tell them apart:

```bash
docker compose exec engram bun cli/engram-admin.ts token issue --name mac-claude
```

Point a client at the gateway:

```bash
ENGRAM_HOST='http://localhost:8080' \
ENGRAM_TOKEN='<token>' \
npx @ani-hq/engram-mcp connect <harness>
```

Clients that can send headers skip the shim:

```text
POST /mcp
Authorization: Bearer <token>
```

Wiring for Claude Code, Cursor, and stdio-only harnesses is in [docs/WIRING.md](docs/WIRING.md).

## Hosted

The same gateway runs as a hosted brain. Open [engram.ani.computer](https://engram.ani.computer), start an org, and mint a token in the console. You do not run Postgres.

Self-hosting stays `docker compose up`. Details are in [docs/ORGS.md](docs/ORGS.md).

## What it stores

Memories are pages. `remember` appends a dated line to a topic page. `recall` searches that brain and returns a handful of short snippets. There is no second store hiding beside the pages, so the console shows everything an agent saved.

| | |
| --- | --- |
| `remember` | Append one note to a topic. Pages roll to an archive when they get long. The entry keeps its identity. |
| `recall` | Up to 20 candidates, at most 5 snippets back. Jev can rerank. If Jev is down, search order stands. |
| Pages | Markdown in Postgres. Tags, links, and a timeline. |
| Console | A reading room on the same URL. Sign in with any token. |
| Audit | Every call records who, which tool, and which page. |
| Reflex | Jev judges routing, duplicates, and conflicts. A nightly pass proposes clusters. A person approves them. Source pages are not rewritten. |

Details: [docs/REFLEX.md](docs/REFLEX.md).

## Architecture

```
agent ── HTTPS / MCP, bearer token ──▶  engram gateway
                                          identity → audit → allowlist
                                                │
                                                ▼
                                         gbrain (pinned)
                                                │
                                                ▼
                         Postgres: one brain database per org
```

The gateway is a stateless Bun process. The engine is [gbrain](https://github.com/garrytan/gbrain), built from a pinned fork so a deploy does not drift with upstream. Ani HQ's pages stay in `brain_shared`. A new org gets its own database. Tokens and the audit log stay in `engram_gateway`.

Ten tools. Seven are gbrain's: `search`, `get_page`, `list_pages`, `put_page`, `add_tag`, `add_link`, `add_timeline_entry`. Three are engram's: `whoami`, `remember`, `recall`.

## Run it yourself

Docker Compose is the whole box: Postgres with pgvector, the gateway, and the console.

```bash
docker compose up
```

Optional keys in `.env` turn on semantic search and the reflex layer. Both fail open. `remember` and `recall` keep working without them.

| Env | Role |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev. Topic routing, classification, recall rerank. |
| `VOYAGE_API_KEY` | `voyage-4-large` embeddings for candidate search. |
| `REFLEX_MODEL` | Default `jev-latest`. |

Copy [.env.example](.env.example).

A full GCP install (Cloud SQL, Cloud Run, the nightly dream job) is `deploy/setup-gcp.sh`, then `deploy/setup-scheduler.sh`. Merges to `main` ship through Cloud Build. See [deploy/setup-gcp.sh](deploy/setup-gcp.sh).

## What this is not

One team brain is visible to everyone in that team. Private notes and conversations belong in a personal brain, then in a share rule. Tokens identify callers. They do not isolate people inside one team. Do not put two teams in one org.

Jev proposes. It does not merge, delete, or rewrite source pages. That stays a human action in the console.

## Docs

- [Wiring a client](docs/WIRING.md)
- [Organizations](docs/ORGS.md)
- [Sharing a slice](docs/SHARING.md)
- [Reflex, dream cycle, review](docs/REFLEX.md)
- [Handoff notes](docs/HANDOFF.md)

Console development, against fixtures, without the gateway:

```bash
bun web/dev-server.ts
```

That serves the console on port 8099.

## Credits

The memory engine is [gbrain](https://github.com/garrytan/gbrain) by Garry Tan (MIT). engram builds a pinned fork, [`Ani-HQ/gbrain`](https://github.com/Ani-HQ/gbrain). The pin and the Cloud SQL patches are in the `Dockerfile` and `deploy/patch-gbrain.py`.

## License

[MIT](LICENSE).
