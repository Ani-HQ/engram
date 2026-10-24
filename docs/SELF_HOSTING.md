# Self-host Engram

Self-hosting includes the web app, MCP gateway, activity history, and optional
public activity profiles. There is no licence server or subscription check in
`self-hosted` mode. You operate the infrastructure and choose which providers,
if any, can receive workspace data.

## Start locally

Install Docker with Compose v2 or later. The image builds for Linux amd64 and
arm64; the Bun version and gbrain commit are pinned in the Dockerfile. Builds
download their base images, packages, and the pinned memory engine.

1. Copy `.env.example` to `.env`, then restrict its permissions:

   ```sh
   cp .env.example .env
   chmod 600 .env
   openssl rand -hex 32
   ```

   Put the generated value in `POSTGRES_PASSWORD`, replacing the placeholder.
   Hex avoids URL-encoding problems in the database connection string. Never
   commit `.env` or share its contents. Compose rejects a missing or empty
   password; it cannot determine whether a password you supply is strong.

2. Build and start the installation:

   ```sh
   docker compose up --build -d
   docker compose logs --tail=50 engram
   ```

   The gateway listens at `http://localhost:8080`. PostgreSQL has no published
   host port. The gateway binds to `127.0.0.1` by default. Compose forces
   `ENGRAM_DEPLOYMENT_MODE=self-hosted`, so Stripe is never required or contacted
   by the billing service.

3. Create an owner from the trusted admin terminal:

   ```sh
   docker compose exec engram bun cli/engram-admin.ts workspace create \
     --name "My workspace" --email me@example.com
   ```

   This creates a team workspace and a separate personal workspace. It prints the
   team ID and an owner access token once. Open `/app`, choose **Use an access
   token**, and paste it. The token expires after 14 days; treat it as an owner
   credential and keep it out of logs and screenshots. An email provider is not
   needed for this bootstrap.

   To renew access later without email, mint a session for an existing owner:

   ```sh
   docker compose exec engram bun cli/engram-admin.ts workspace login \
     --org WORKSPACE_ID --email me@example.com
   ```

   This requires an existing owner membership and prints another temporary
   credential to the trusted admin terminal.

4. Create one credential per agent from **Connections**. Connect the agent to
   `http://localhost:8080/mcp` with its bearer token. Use a distinct name for each
   agent and turn off write access when it only needs to read.

The `.env.example` HTTP setup explicitly sets `ENGRAM_INSECURE_COOKIE=1` for
local use. The variable is singular. Set it to `0` before serving over HTTPS.
The Compose default is `0` when the variable is absent.

## Email and chat connectors

Configure `RESEND_API_KEY` and a verified `ENGRAM_MAIL_FROM` address to enable
email sign-in and emailed invitations. A missing mail provider makes public
email login unavailable; it does not reveal a login URL to the requester.
Owners may still copy invitation links from the authenticated workspace.

`ENGRAM_DEV_LOGIN_LINKS=1` is an explicit escape hatch for an isolated development
installation. It returns email-login links to whoever requests them when mail
is disabled. Keep it `0` on a shared or public installation. Hosted mode ignores
the escape hatch.

Bearer-token MCP works without OAuth. To use chat clients that require OAuth,
configure an RSA `ENGRAM_OAUTH_PRIVATE_KEY`, set `ENGRAM_PUBLIC_URL` to the
installation's canonical HTTPS origin, and set `ENGRAM_OAUTH_AUDIENCE` to that
origin followed by `/mcp`. Keep the signing key private. See [OAUTH.md](OAUTH.md).

## External processing is opt-in

Every new workspace starts with `externalAiProcessing: false`. Supplying a
provider key on the server does not enable it for any workspace.

An owner can explicitly enable external AI in workspace settings. With consent
and the corresponding configured keys, `VOYAGE_API_KEY` enables external
embeddings and `REFLEX_API_KEY` (or the legacy `TYPESAFE_API_KEY`) enables the
reflex provider. Memory search and capture retain local fallback behavior when
those providers are disabled.

The memory-engine child receives an explicit environment allowlist. It receives
no AI provider key without workspace consent; gateway database credentials,
email credentials, Stripe secrets, and OAuth signing keys are not inherited.
It receives `DO_NOT_TRACK=1`. These controls govern Engram's integrations;
connected agents, optional email delivery, and infrastructure operators have
their own access and data-handling responsibilities.

Public profiles are off by default. Publishing exposes aggregate counts and the
profile text the owner supplies. Review that preview before publishing.

## Serve it beyond your machine

Terminate HTTPS at a reverse proxy. Keep PostgreSQL private and proxy the gateway
from its loopback port. Set:

```dotenv
ENGRAM_PUBLIC_URL=https://engram.example.com
ENGRAM_INSECURE_COOKIE=0
ENGRAM_DEV_LOGIN_LINKS=0
```

Use `docker compose up -d` after changing environment settings. Do not expose
the local HTTP quickstart directly to the internet. If the proxy runs in a
separate container, connect it to the Compose network rather than publishing
the database. Configure proxy timeouts for MCP requests and set request/body
limits appropriate to your deployment.

Protect the host, Docker access, administrative shell, environment files, and
backups. The Compose installation uses a database administrator capable of
creating tenant databases. Anyone with that credential or host access can read
stored data. Tenant separation does not provide end-to-end encryption from the
operator. See [SECURITY.md](../SECURITY.md) for the trust boundary.

## Persistence and backups

`engram-pg` stores all PostgreSQL databases, including central identities,
memberships, audit history, activities, and tenant memory. `engram-homes` stores
the memory engine's per-workspace configuration. Both are named Docker volumes
and survive ordinary container recreation.

Back up all databases, rather than only `engram_gateway` or `brain_shared`. New
workspaces use `brain_org_<id>`. For example, a logical cluster backup can be
created from the database container:

```sh
docker compose exec -T db pg_dumpall -U postgres --no-role-passwords > engram-backup.sql
```

The dump still contains private data and credential hashes. Encrypt it, limit
access, back up the home volume, and keep required configuration/secrets in a
separate protected recovery store. Regularly restore into an isolated test
installation and verify representative workspace data and login. A backup that
has not been restored is not a verified recovery process.

`docker compose down` preserves the named volumes. Adding `-v` deletes them.
Changing `POSTGRES_PASSWORD` in `.env` alone does not rotate the password inside
an already initialized PostgreSQL volume; rotate the database role password and
application configuration together.

The container now runs as the unprivileged `bun` user. If upgrading an older
installation whose home volume was created by root, stop Engram and adjust the
home volume ownership using the same image before restarting:

```sh
docker compose stop engram
docker compose run --rm --user root --entrypoint sh engram \
  -c 'chown -R bun:bun /gbrain-homes'
docker compose up -d engram
```

Back up before upgrades. Review changes to the database migrations, pinned Bun
image, and gbrain commit; retain a known working image and a tested backup for
recovery.
