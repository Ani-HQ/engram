# engram

A portable context layer. One brain, every agent on one small trusted team.

engram gives Claude Code, Cursor, ChatGPT, bots, and future agents shared access
to the same memory over MCP. It is deliberately simple: every valid token can use
the same brain and the same tools. A token answers who made the request; it does
not limit what that requester may read or write.

## Architecture

```
client ──HTTPS/MCP, bearer token──▶ engram gateway (Bun, stateless)
                                       │  identity → audit → allowlisted proxy
                                       ▼
                               one `gbrain serve` child
                                       ▼
                      Postgres: brain_shared + engram_gateway
```

- **Engine:** [gbrain](https://github.com/garrytan/gbrain), pinned from our mirror
  (`Ani-HQ/gbrain`) — plain Postgres, no vendor lock-in.
- **Brain database:** one shared database named `brain_shared`. The gateway's own
  database is `engram_gateway`.
- **Auth model:** bearer tokens identify the person or agent. There is no access
  control between tokens; this is built for one small trusted team.
- **Tool surface:** exactly 10 tools. Seven forwarded to gbrain (`search`,
  `get_page`, `list_pages`, `put_page`, `add_tag`, `add_link`,
  `add_timeline_entry`) and three engram synthesizes itself (`whoami`,
  `remember`, `recall`). The allowlist limits blast radius, not token permissions.
- **Memory verbs:** `remember` appends a dated entry to one page per topic;
  `recall` returns at most 5 hits with 280-character snippets. Both write pages,
  so everything an agent stores is visible in the console.
- **Audit:** every tool call is recorded for attribution: who taught or queried
  the brain, when, and with which tool.
- **Routes:** `/health`, `/healthz`, `/mcp` (POST), `/api/*`, and static files.

## Run it

Self-hosted (any box): `docker compose up` -> MCP at `http://localhost:8080/mcp`.

GCP (Cloud SQL + Cloud Run): `deploy/setup-gcp.sh` once, then every merge to
`main` builds and deploys through the `engram-deploy` Cloud Build trigger. That
build runs the test suite before it builds an image, so a red `main` never ships.

To deploy by hand: `gcloud builds submit --config cloudbuild.yaml --project ani-hq`.

A merge is not a deploy until that build finishes. Confirm what is actually serving
by comparing the revision's creation time to the commit, which is the only reliable
way to tell:

```bash
gcloud run services describe engram --region us-central1 \
  --format='value(status.traffic)'
gcloud run revisions list --service engram --region us-central1 --limit 1
```

Mint a token: `bun cli/engram-admin.ts token issue --name mac-claude`

Wire a client: see `docs/WIRING.md`.

## Status

What exists today: one shared brain, bearer-token identity, an audited 8-tool MCP
surface, a browser console, token revocation, and a one-command stdio shim for
clients that cannot send HTTP bearer headers.

What it is not: a multi-tenant or permissioned memory system. Do not deploy it
for users or teams that need separation inside the same instance.

## The Console

`https://<engram-url>/` serves the console, a reading room for the brain. Sign in with any
engram token; the console stores it in an httpOnly cookie and uses the same
audited tool path as MCP clients.

Develop it without the gateway: `bun web/dev-server.ts` serves the console
against fixtures on :8099.

## Credits

The memory engine is [gbrain](https://github.com/garrytan/gbrain) by Garry Tan
(MIT). engram builds it from a pinned fork (`Ani-HQ/gbrain`) so the deployment
is reproducible and survives upstream drift — see `Dockerfile` for the pin and
`deploy/patch-gbrain.py` for the Cloud SQL compatibility patches.

## License

MIT — see [LICENSE](LICENSE).
