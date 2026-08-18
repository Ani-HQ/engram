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

v0: shared scope, token auth, audit, GCP deploy. v1: secrets vault, promote,
path-token route, stdio shim. v2: 文庫 (bunko), the browser console — read,
search and capture over the same token auth and the same audited tool path.
Planned: private/product scopes, context seeding, nightly pg_dump backups.

## The console

`https://<engram-url>/` serves 文庫, a sumi-e reading room for the brain: ink
density carries recency (today is full sumi, three years is a whisper), links
show as kintsugi seams, each token gets a generated hanko seal, and capture is a
tanzaku strip hanging in the margin. Sign in with any engram token — the console
holds it in an httpOnly cookie and calls the same audited `callTool` path every
MCP client uses, so it can never reach a tool your token could not.

Develop it without the gateway: `bun web/dev-server.ts` serves the console
against fixtures on :8099.

## Credits

The memory engine is [gbrain](https://github.com/garrytan/gbrain) by Garry Tan
(MIT). engram builds it from a pinned fork (`Ani-HQ/gbrain`) so the deployment
is reproducible and survives upstream drift — see `Dockerfile` for the pin and
`deploy/patch-gbrain.py` for the Cloud SQL compatibility patches.

## License

MIT — see [LICENSE](LICENSE).
