# Organizations

An organization, called a workspace in the app, is the sharing boundary for
people and agents. New workspaces have separate memory databases and engine
homes. The gateway authenticates each request into one workspace and scopes its
central metadata queries to that workspace.

Ani HQ is org 1. Its pages stay in `brain_shared`. Its gateway rows stay in `engram_gateway`. A new org gets `brain_org_<id>` for both pages and reflex rows, and a child that starts on the first request and exits after it goes idle.

This is application and database separation, not cryptographic isolation from
the service operator. The runtime database administrator and host administrator
can access stored data. People and agents inside a team intentionally share
that team's memory. A personal brain is a workspace of one. Explicit share
rules copy selected material into a team after checking current membership at
both ends; shared copies are then visible to that team. See
[SHARING.md](SHARING.md) and [SECURITY.md](../SECURITY.md).

The gateway rejects missing tenant contexts and invalid storage bindings.
Workspace lookup failures do not fall back to Ani HQ. Human sessions recheck
current membership and role, and OAuth credentials stay bound to the workspace
in their signed `org_id` claim. Switching the app workspace requires a human
session and a current membership in the destination; it does not rebind an
existing agent credential.
OAuth grants also bind the exact membership ID, so removing and rejoining the
same email cannot restore an earlier connector grant. Existing connectors
without this binding must sign in again after upgrading.

## Roles

- **Owner.** Creates the workspace, invites/removes members, changes policies,
  manages billing and public publication, and can revoke tokens or change write
  mode. Current owners cannot be removed through the member-removal control;
  ownership transfer is not implemented.
- **Member.** Uses the console. Can remember, recall, mint an agent token for their own harness, and approve review items when the org allows it. Cannot change policy or revoke tokens.
- **Agent.** An MCP token. Read-only, or read and write. The gateway allowlist is still the ceiling.

Existing Ani HQ tokens that predate orgs stay owners, because they were identity for one trusted team. Tokens minted after that are agents.

Connected OAuth clients receive delegated memory access. Even when their human
is an owner, those credentials cannot manage console tokens, invitations,
memberships, billing, or workspace switching.

## Policies

A settings page, not a language:

- Agents may append.
- Only a member may delete or restore a page.
- Jev may propose links, tags, and conflicts. It still cannot apply them.
- Review items can be approved by owners only, or by any member.
- The team may accept shared slices from members' personal brains.
- `maxShareLevel` caps those slices at a digest, a digest plus transcript, or a transcript.
- `externalAiProcessing` is false by default. Only an owner can opt a workspace
  into optional external model and embedding processing. Server-side provider
  keys alone do not enable it.

Topic pages still roll to an archive at the current size.

## Onboarding

`/` is the landing page. The console is `/app`.

1. Name the workspace and confirm the owner email. The session starts only after
   the emailed link is accepted. A self-hosted operator can instead bootstrap
   owner access with the admin CLI; see [SELF_HOSTING.md](SELF_HOSTING.md).
2. Mint one agent token. The screen shows the MCP URL and the Cursor and Claude Code snippets once.
3. Write one memory in the console. The collection opens on that page.
4. Invite a teammate. With a configured mail provider, Engram emails the join
   link. An authenticated owner may copy an invitation link when delivery is
   unavailable. The new member joins that workspace and gets a separate
   personal workspace.

Public email login never reveals a login URL when mail is unconfigured, except
for an explicit self-hosted development option. Hosted mode disables that
option. Login links are single use. Removing a member revokes their workspace
sessions, linked agent tokens, refresh credentials, and pending invitations;
accepting an old login link does not restore
their removed membership or earlier owner role. Standing share rules stop
mirroring when the owner no longer belongs to either end.

Console-issued agent tokens record the issuer's email and exact membership ID.
Authentication checks that membership again. Removing and re-inviting the same
person creates a new membership and does not restore an earlier token. Direct
operator CLI tokens are deliberately marked `operator` and survive member
removal; revoke these service credentials separately when their purpose ends.

Claude, ChatGPT, and Grok connectors stay closed until `ENGRAM_OAUTH_PRIVATE_KEY` is set. See [OAUTH.md](OAUTH.md).

## Hosted access and self-hosting

Hosted workspaces have a 14-day trial anchored to workspace creation. The
configured Cloud plan is $19 USD per workspace per month; billing belongs to
the workspace and only an owner can manage it. Adding content and issuing new
access require a current trial or paid entitlement. Reads, payment recovery,
revocation, privacy controls, deletion, and unpublishing remain available after
the entitlement expires. See [BILLING.md](BILLING.md).

Self-hosted mode includes the core features without an Engram subscription or
billing-service requests. The operator supplies storage, backups, maintenance,
and any optional provider accounts. See [SELF_HOSTING.md](SELF_HOSTING.md).

## Database credentials and upgrades

Strict mode separates three authorities:

| Authority | Configuration | Permissions |
| --- | --- | --- |
| Gateway runtime | `ENGRAM_DB_URL_TEMPLATE` | Central metadata DML; no DDL, role creation, database creation, or RLS bypass. |
| Separate provisioner job | `ENGRAM_PROVISIONER_DB_URL_TEMPLATE` | Creates roles/databases, installs extensions, owns central schema, and applies migrations. Never given to the public runtime or an engine. |
| Workspace engine | Derived `engram_tenant_<id>` role | Connects only to its own managed memory database; owns its application objects and can migrate them within the provisioner-owned public schema. No database CREATE privilege, administrative role attributes or memberships. |

The provisioner job receives both URL templates. They contain `__DB__` and point to the same dedicated PostgreSQL
cluster, with different usernames. Use a strong random runtime password. The
provisioner needs database/role creation, extension installation, and sufficient
ownership to migrate existing Engram objects. A Cloud SQL provisioner must have
the managed service's equivalent permissions. PostgreSQL superuser is not a
requirement for the **runtime** or engine. Provisioning fails closed if an
existing runtime/engine role has administrative attributes or memberships.

Hosted web processes default to `ENGRAM_DATABASE_AUTHORITY=runtime`, receive
only the runtime URL and credential-derivation key, and refuse a provisioner URL
even if accidentally configured. Their `migrate()` checks the required schema
version and restricted role without DDL. A separate job with
`ENGRAM_DATABASE_AUTHORITY=provisioner` runs
`bun gateway/src/jobs/provision.ts`. It applies central migrations, claims
durable pending workspace rows with leases, provisions storage, and marks them
ready. Failures retain a generic status and retry after five minutes. A
scheduled invocation recovers missed triggers and expired job leases.

The web identity may invoke only that configured job through
`ENGRAM_PROVISION_JOB`; it must not update the job or access its provisioner
secret. Signup can establish a human session while setup is pending. The app's
session/provisioning status remains available, while memory APIs return 503
until readiness. A provisioner-owned `engram_control.workspace` marker can be
read, but not changed, by the tenant engine.

Self-hosted `ENGRAM_DATABASE_AUTHORITY=inline` keeps provisioning in the parent
process for installations that choose to trust one local service with both
authorities. Hosted mode rejects inline authority.

`ENGRAM_TENANT_CREDENTIAL_KEY` is an operator secret containing at least 32 bytes
of strong randomness. Generate and store it in a secret manager. The parent
derives stable, different engine passwords from this key and each workspace ID;
the key and passwords do not appear in workspace metadata. Protect it like a
database administrator secret: disclosure can derive all tenant credentials.

Org creation creates `brain_org_<id>`, revokes public database/schema access,
assigns the engine role, installs `vector`, `pg_trgm`, and `pgcrypto`, and creates the tenant
metadata tables. Ani HQ retains `brain_shared` for memory and central legacy
rows in `engram_gateway`. No engine role can connect to the gateway database.
System/maintenance databases outside Engram's managed set remain the PostgreSQL
operator's responsibility. Require password authentication and TLS on network
connections, and keep PostgreSQL off public interfaces.

The central gateway schema enables forced RLS with an explicit global policy
for its trusted runtime and migration roles. Untrusted roles have no policy,
schema access, or database connection grant. The gateway needs global metadata
authority for authentication/bootstrap, background jobs, and public aggregation;
its row filters and authorization still enforce request-level tenancy. This
does not claim per-request database RLS against a compromised gateway. Tenant
engines have a narrower, database-enforced boundary.

If workers use a different network route, set `ENGRAM_WORKER_DB_URL_TEMPLATE`.
It changes the engine endpoint while preserving its derived tenant identity;
it must reach the same PostgreSQL cluster. Never put provisioner credentials
in a worker environment. Tenant request pools are bounded by
`ENGRAM_MAX_TENANT_DB_POOLS` (default 32), with active-request leases and idle
eviction. Provisioning uses temporary pools rather than occupying request slots.
Engine roles also enforce `ENGRAM_TENANT_DB_CONNECTION_LIMIT` (default 12).

### Migrating an existing installation

Before cutover, use an authorized **read-only** database session to verify that
each existing workspace has at least one current human owner, especially org 1:

```sql
SELECT o.id, o.slug, count(m.id) FILTER (WHERE m.role = 'owner') AS owners
FROM orgs o LEFT JOIN org_members m ON m.org_id = o.id
GROUP BY o.id, o.slug ORDER BY o.id;
```

Legacy owner bearer tokens are not evidence of an `org_members` owner row. If
the count is zero, stop before revocation or cutover. An authorized operator
must verify the intended person's explicit email and establish a reviewed
owner-recovery procedure; do not infer identity from an agent/token name or
automatically promote an arbitrary member. The current `workspace login` CLI
requires an existing owner and cannot repair a missing owner record. Preserve
the previous installation until verified human recovery is available.

`bun deploy/check-owners.ts --project ani-hq` prints an offline plan; append
`--run` for the read-only production count. It uses an authenticated local
Cloud SQL Unix socket and keeps database credentials out of arguments, files
and output.

For the verified legacy workspace 1 only, the operator recovery command is
`bun deploy/recover-owner.ts --project ani-hq --org 1 --email VERIFIED_EMAIL`.
It also defaults to an offline plan. Execute with `--run` only after the human
explicitly selects that exact normalized email and authorizes its access.
The transaction checks the workspace storage binding, excludes concurrent
membership writes and inserts one new owner only when there are no owners or
existing membership for that email. It refuses promotion and other targets,
does not migrate or issue credentials, and verifies the inserted owner before
commit. Repeat the read-only count afterward before proceeding with cutover.

1. Stop external writes and workers. Back up **all** gateway/memory databases,
   PostgreSQL roles/grants, and engine homes. Verify restore on a separate
   instance before changing production. Test the new image and migrations
   against that copy, including actual engine initialization and search.
2. Give the former administrative connection only to the separate provisioner,
   configure a
   different least-privilege runtime username/password, and supply a new strong
   credential key. Remove the legacy compatibility flag. The provisioner can
   create the runtime role; an existing runtime role must already be restricted.
3. Run the provisioner job first, then start the public runtime without the
   provisioner URL or secret-access permission. Provisioning/schema migration uses PostgreSQL
   advisory locks; database creation, role changes, and extension installation
   are not one atomic cross-database transaction. An interrupted migration is
   retryable. Invalid workspace bindings or insufficient privileges stop startup.
4. Strict upgrades revoke all old bearer tokens marked `legacy`, because their
   original issuing member cannot be reconstructed safely. Reissue agent tokens
   from current human sessions or the operator CLI. Sessions remain subject to
   current membership. Confirm tenant-to-tenant and engine-to-gateway connection
   denial, then reopen traffic.

The explicit self-hosted compatibility flag
`ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS=1` preserves old shared-role provisioning and
legacy credentials. It is a temporary operator-controlled compatibility path,
with weaker database isolation. Hosted mode ignores this escape hatch and
requires strict configuration.

### Rollback and rotation

Keep the previous image, configuration, database/role backups, and homes together.
Changing a flag does not undo revoked tokens, ownership, RLS, or connection
grants. For a full rollback, close traffic, stop workers, restore the matching
database/role/home backups to an isolated instance, verify the previous image
there, and only then switch traffic. Do not silently return hosted tenants to
shared administrator credentials. Reissuing tokens is safer than clearing
revocation timestamps.

Rotating the derivation key changes every engine password. Stop existing provisioning jobs, workers and
traffic, update the key in both identities, run the provisioner with
`bun gateway/src/jobs/provision.ts --reprovision-all`, terminate old
engine database sessions, and start fresh workers. Changing a password alone
does not invalidate existing PostgreSQL sessions. Keep a tested recovery path;
an inconsistent key between replicas causes failed engine connections.
For installations larger than one job batch, run subsequent provisioner jobs
**without** `--reprovision-all` until the returned pending count is zero before
reopening traffic. Repeating the flag would queue completed work again.
