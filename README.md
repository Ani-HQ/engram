# engram

A portable personal context layer. One brain, every agent.

engram gives all of your agents — Claude Code, Cursor, an OpenClaw/Hermes fleet,
Telegram/Discord bots, ChatGPT, Grok, whatever comes next — shared access to the
same memory over MCP, with real scoping: private stays private, shared is fleet-wide,
products get their own namespaces. Adding a new agent is minting a token, not
rebuilding context.

## Architecture

```
client ──HTTPS/MCP, bearer token──▶ engram gateway (Bun, stateless /mcp)
                                       │  auth → scopes → allowlisted proxy
                                       ▼
                          one `gbrain serve` stdio child per scope
                                       ▼
                one Postgres instance, one DATABASE per scope
                (brain_shared, brain_private, brain_product_*, engram_gateway)
```

- **Engine:** [gbrain](https://github.com/garrytan/gbrain), pinned from our mirror
  (`Ani-HQ/gbrain`) — plain Postgres, no vendor lock-in.
- **Privacy boundary:** database-per-scope, enforced structurally by routing, not
  by filtering. A token without a scope simply has nowhere to send the request.
- **Tool surface:** 9 curated gbrain tools (search/get/list/recall + put/remember/
  tag/link/timeline) + `whoami`. Destructive gbrain ops are unreachable.
- **Audit:** every tool call and denial is a row in `audit_log`.

## Run it

Self-hosted (any box): `docker compose up` → MCP at `http://localhost:8080/mcp`.

GCP (Cloud SQL + Cloud Run): `deploy/setup-gcp.sh`, then
`gcloud builds submit --config cloudbuild.yaml --project ani-hq`.

Mint a token: `bun cli/engram-admin.ts token issue --name mac-claude --scopes shared:rw`

Wire a client: see `docs/WIRING.md`.

## Status

v0: shared scope, token auth, audit, GCP deploy. Planned: per-scope tokens with
private/product scopes (v1), Secret Manager-backed secrets vault (v1), promote
flow + context seeding + nightly pg_dump backups (v2).
