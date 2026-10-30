# engram

A shared drive for agent context. Carry memory across agents and share selected
context with your team.

[![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-black)](https://modelcontextprotocol.io)
[![Engine](https://img.shields.io/badge/engine-gbrain-black)](https://github.com/garrytan/gbrain)

Engram gives MCP-connected agents a common place for memory pages, decisions and
project notes. Keep working in Claude, Cursor, ChatGPT, Codex or another client;
save useful context, then recall it from the next agent. Personal memory stays
separate from a team's shared space. Configured sharing rules copy selected
context into an authorized team workspace, with its own database and access
controls. Activity distinguishes observed Engram calls from work agents report.

Self-host it for free, or request access to the hosted invite-only beta. New invitations include 60 days of unlimited core knowledge transfers after email verification, with no card required. Standard Cloud pricing is **$19 USD/month**. Pricing and privacy pages are at `/pricing` and `/privacy`.

## Quick start

```bash
cp .env.example .env
# Set a strong POSTGRES_PASSWORD in .env first.
docker compose up --build -d
docker compose exec engram bun cli/engram-admin.ts workspace create \
  --name "My workspace" --email you@example.com
```

MCP is at `http://localhost:8080/mcp`. The console is at `http://localhost:8080/app`.

Sign in using the temporary owner access token printed by the CLI. Mint one token per agent so the audit log can tell them apart. Use the workspace ID printed at bootstrap:

```bash
docker compose exec engram bun cli/engram-admin.ts token issue --org <workspace-id> --name mac-claude
```

Connect your agent with guided setup:

```bash
npx @ani-hq/engram-mcp setup --host http://localhost:8080
```

Choose your agent and paste its token at the hidden prompt. Setup checks live
identity and tool discovery before saving the agent's native HTTP config. Restart
or refresh the agent, then use the printed save-and-recall prompt to verify its
actual memory access. The web app's setup guide tracks successful agent calls;
issuing a key or adding a page in the browser does not complete it.

For the hosted service, run `npx @ani-hq/engram-mcp setup`; the default host is
`https://engram.ani.computer`. OAuth chat connectors and manual HTTP setup are
covered in [the wiring guide](docs/WIRING.md). Manual clients use:

```text
POST /mcp
Authorization: Bearer <token>
```

Wiring for Claude Code, Cursor, and stdio-only harnesses is in [docs/WIRING.md](docs/WIRING.md).

## Hosted

The hosted beta requires a single-use invitation and inbox verification. New invitations give 60 days of unlimited core knowledge transfers, with a visible expiry countdown and an extension contact. Operators can issue links without collecting email first, or restrict a code to one mailbox, through the console or [invitation API](docs/BETA_INVITES.md). The implementation also supports independent workspaces, owner-managed Stripe subscriptions, a 14-day trial, and a $19/month Cloud plan. Existing data remains readable and exportable after write access ends; see [docs/BILLING.md](docs/BILLING.md).

Self-hosted mode has no hosted billing calls, trial expiry, or licence check. Setup, owner recovery, TLS, and backups are in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## What it stores

Activity lives in an append-only action ledger alongside the existing memory-call audit. Agents use `record_action` to report work in any external tool and `list_actions` to query it. The web app reads the same history, with search, agent/tool/result filters, and resource/run drilldowns. External reports are labeled unverified; directly observed Engram calls remain distinct.

Memories are pages. `remember` appends a dated line to a topic page. `recall` searches that brain and returns a handful of short snippets. There is no second store hiding beside the pages, so the console shows everything an agent saved.

| | |
| --- | --- |
| `remember` | Append one note to a topic. Pages roll to an archive when they get long. The entry keeps its identity. |
| `recall` | Up to 20 candidates, at most 5 snippets back. Jev can rerank. If Jev is down, search order stands. |
| Pages | Markdown in Postgres. Tags, links, and a timeline. |
| Console | Black-and-white Activity, Memory, Connections, Public profile, Workspace, and Plan & billing views. Hosted sign-in uses email verification. Self-hosted installs also support owner access tokens. |
| Actions | `record_action` and `list_actions`, also available at `/api/actions`. Authenticated identity, resource, run, result, and evidence. |
| Audit | Every call records who, which tool, and which page. |
| Reflex | Jev judges routing, duplicates, and conflicts. A nightly pass proposes clusters. A person resolves them through the review API. Source pages are not rewritten. |

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

Sixteen tools. Seven are gbrain's: `search`, `get_page`, `list_pages`, `put_page`, `add_tag`, `add_link`, `add_timeline_entry`. Nine are engram's: `whoami`, `set_identity`, `remember`, `recall`, `record_action`, `list_actions`, `checkpoint_task`, `find_tasks`, `resume_task`. A custom agent can call `set_identity` to give itself a name and logo in the app ([details](docs/CONNECTION-LIFECYCLE.md#agent-names-and-logos)).

## Run it yourself

Docker Compose is the whole box: Postgres with pgvector, the gateway, and the console.

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, then:
docker compose up --build -d
```

Optional provider processing starts **off**. Keys in `.env` make providers available; a workspace owner must also enable the relevant permission in Workspace settings. Jev has its own opt-in, separate from embeddings and generated briefs. Self-hosted provider usage is paid directly through your provider account. Core storage, keyword search, and activity work without provider keys. See [privacy and data flow](docs/PRIVACY.md) for what leaves the deployment when enabled.

| Env | Role |
| --- | --- |
| `JEV_API_KEY` | Optional Jev routing, review and recall reranking. Legacy `REFLEX_API_KEY` and `TYPESAFE_API_KEY` remain accepted. |
| `VOYAGE_API_KEY` | `voyage-4-large` embeddings for candidate search. |
| `REFLEX_MODEL` | Default `jev-latest`, TypeSafe’s stable alias. Exact versions can be selected when the provider exposes them. |
| `RESEND_API_KEY` | Magic-link and invite email. Login fails closed when mail is unavailable; self-hosted operators can use the owner CLI. |
| `ENGRAM_MAIL_FROM` | Default `engram@updates.ani.computer`. |
| `ENGRAM_OAUTH_PRIVATE_KEY` | RSA key that signs connector JWTs. Without it those clients stay closed. |
| `ENGRAM_PUBLIC_URL` | Canonical host for magic links, OAuth, and the MCP audience. |

Copy [.env.example](.env.example).

For hosted Cloud SQL and Cloud Run, follow [the staged release procedure](docs/RELEASE.md)
and [runtime isolation requirements](docs/RUNTIME.md). Prepare separate runtime,
provisioner and SQL connector identities and their scoped secrets first. Cloud
Build runs the release gates and produces a plan by default; staging, candidate
smoke verification and traffic activation are explicit operations. A merge to
`main` does not automatically activate production traffic.

`deploy/setup-gcp.sh` is a legacy bootstrap that grants the runtime the old
administrative database secret. It does not establish the current hosted
authority split and must not be used to bootstrap or repair this architecture.
The nightly scheduler is a separate operator setup step described in the release
and [Reflex documentation](docs/REFLEX.md).

## What this is not

One team brain is visible to everyone in that team. Private notes and conversations belong in a personal brain, then in a share rule. Tokens identify callers. They do not isolate people inside one team. Do not put two teams in one org.

Jev proposes memory changes. Humans resolve them through the review API; source pages are preserved. External actions appear when an agent or integration reports them. Connecting Engram alone does not capture all of a client’s other tool calls.

## Docs

- [Cloud pricing, subscription setup, and payment verification](docs/BILLING.md)
- [Hosted beta invitations and operator API](docs/BETA_INVITES.md)
- [Self-hosting and owner recovery](docs/SELF_HOSTING.md)
- [Privacy and data flow](docs/PRIVACY.md)
- [Security controls and limits](SECURITY.md)
- [Action history, public profiles, and the web app](docs/ACTIONS.md)
- [Live public activity API and website embeds](docs/PUBLIC_ACTIVITY.md)
- [Design references and interface details](docs/DESIGN.md)
- [Wiring a client](docs/WIRING.md)
- [Organizations](docs/ORGS.md)
- [OAuth for chat connectors](docs/OAUTH.md)
- [Sharing a slice](docs/SHARING.md)
- [Reflex, dream cycle, review](docs/REFLEX.md)
- [Handoff notes](docs/HANDOFF.md)

Console development, against fixtures, without the gateway:

```bash
bun web/dev-server.ts
```

That serves an explicitly labeled, local-only sample-data preview on port 8099. Set `PORT` to choose another port. Production uses the authenticated gateway API and has no sample actions.

Run the unit suite with `bun test`. Real PostgreSQL tenant and billing checks are in `test/integration-postgres.ts`; they require an explicitly named disposable local test cluster and reject production-style targets. CI runs those checks against PostgreSQL as well.

## Credits

The memory engine is [gbrain](https://github.com/garrytan/gbrain) by Garry Tan (MIT). engram builds a pinned fork, [`Ani-HQ/gbrain`](https://github.com/Ani-HQ/gbrain). The pin and the Cloud SQL patches are in the `Dockerfile` and `deploy/patch-gbrain.py`.

As Engram earns revenue, we’ll use a portion to sponsor open-source projects. Engram depends on gbrain and other open-source tools; this commitment is broader than any one project.

## License

[MIT](LICENSE).
