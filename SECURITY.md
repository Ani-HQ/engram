# Security and privacy

Engram aims to keep workspaces private by default and make data sharing
explicit. No software can truthfully guarantee 100% security or privacy. This
repository does not claim a completed independent security audit, SOC 2, ISO
27001 certification, end-to-end encryption, or immunity from breaches.

## Trust boundaries

Each newly provisioned workspace has a separate memory database and engine
home. Central gateway tables contain organization-scoped identity, membership,
audit, activity, sharing, and billing records. Authenticated credentials bind to
one workspace. Sessions and OAuth credentials check current membership;
workspace switching requires a human session and membership of the destination.

In strict database mode, each memory engine has a different PostgreSQL login
with permission to connect to its own managed memory database. It owns that
database's application schema so it can run engine migrations, but cannot create
roles/databases, assume gateway/provisioner roles, or connect to another managed
workspace database or the gateway database. The parent provisions `vector` and
`pg_trgm` and `pgcrypto` extensions. It never gives an engine the credential-derivation key or
provisioner credential.

The public gateway runtime receives no provisioner database credential. A
separately credentialed provisioning job creates storage from durable pending
workspace records. Runtime startup checks schema readiness without DDL, and
pending workspaces cannot enter a memory context. The runtime may execute that
one provisioning job; deployment IAM must deny it the job's secrets and update
permissions.

The gateway runtime has central metadata DML access and no schema ownership,
`CREATEDB`, `CREATEROLE`, superuser, or `BYPASSRLS`. Central tables use forced RLS
with explicit trusted gateway and migration-role policies. Authentication,
signup, billing callbacks, background jobs, and published aggregates need
cross-workspace metadata access: this trusted gateway policy is deliberately
global. Central request isolation still depends on application authorization
and organization filters; it is not a database policy scoped to each HTTP
request. A compromised gateway/provisioner remains a cross-tenant threat.

An owner controls membership and policy. People and agents inside a team share
that team's memory; a workspace is the isolation boundary, not each member or
agent. Personal workspaces provide a separate store. Explicit share rules copy
selected material into another workspace after checking membership at both ends.

The service operator and anyone with host/database administration privileges
can access stored data. Self-hosting puts those responsibilities under your
control. The application does not encrypt memory with a user-held key that
excludes the operator. TLS termination, database/disk encryption, access to
backups, network restrictions, monitoring, and key rotation are operational
controls to configure and verify in the deployment.

## Implemented application controls

- Opaque bearer credentials and browser sessions are stored as SHA-256 hashes.
  Session cookies are HttpOnly, SameSite=Strict, and Secure unless an operator
  explicitly enables the local HTTP cookie option.
- Tenant resolution and data access fail closed when a workspace context is
  absent or a storage binding is invalid. Client-supplied organization IDs do
  not select the tenant for ordinary memory/activity requests.
- Sessions use the current membership role. Member removal revokes that
  workspace's sessions, member-issued agent credentials, refresh credentials,
  and pending invitations. Agent credentials issued in the console link to the
  exact issuing membership; removing and re-adding the same email cannot revive
  old credentials. Explicit operator-issued service tokens have a separate
  revocation lifecycle. OAuth remains bound to its
  signed organization and exact membership and cannot administer console credentials or silently
  authorize a broader connector.
- Email-login links and OAuth authorization codes are single use. Missing email
  configuration does not disclose login URLs, except for an explicit development
  option that is disabled in hosted mode.
- Browser API requests use a same-origin console header for CSRF protection.
  MCP/tool operations enforce role, write permission, and applicable OAuth scopes.
- External AI processing is off by default per workspace. Provider credentials
  alone do not constitute consent. Memory-engine subprocesses use an environment
  allowlist rather than inheriting server secrets.
- Database pools have a bounded tenant count, idle eviction, active-request
  leases, and query timeouts. Memory writes use workspace-specific PostgreSQL
  advisory locks shared by gateway processes. These controls limit ordinary
  concurrency conflicts; they are not a proof against every process crash or
  database-connection failure during an external engine call.
- Public activity profiles require owner publication and expose aggregate
  activity counts and chosen profile text, not memory contents, action details,
  resource URLs, or agent names. Unpublishing removes subsequent service access;
  it cannot erase copies already downloaded by other sites.

These controls reduce risk; their existence is not evidence that every code
path, dependency, infrastructure component, or deployment has been independently
audited. Redaction is best effort and cannot make arbitrary input safe to share.
External action records are reports from connected agents unless marked as
Engram-observed service activity; they are not proof that a provider executed
the reported action.

## Deployment guidance

Use HTTPS for shared/public installations, keep PostgreSQL off public interfaces,
generate strong credentials, and protect administrator access. Keep development
login links disabled. Grant agents only the access they need, use one credential
per agent, and revoke unused credentials. Review third-party provider terms
before enabling external processing. Encrypt and test backups, and keep runtime
dependencies and pinned images current through reviewed updates.

Hosted runtime uses `ENGRAM_DATABASE_AUTHORITY=runtime` and refuses any
provisioner URL. The separate job uses `ENGRAM_DATABASE_AUTHORITY=provisioner`
and distinct provisioner/runtime database configuration. Both need the same
strong tenant credential key; hosted mode refuses shared legacy credentials. A
self-hosted operator may explicitly set `ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS=1`
for compatibility. That option uses shared database authority and does **not**
provide the restricted-role isolation described above. Do not use it as a
hosted tenant-security claim. See the migration, rollback, and key-rotation
notes in [Organizations](docs/ORGS.md#database-credentials-and-upgrades).

See [Self-hosting](docs/SELF_HOSTING.md) for the local Compose setup and recovery
considerations. A self-hosted installation's security depends on its operator's
configuration and maintenance.

## Reporting a vulnerability

Use the repository's private vulnerability reporting facility when available,
or email [ani@odstdio.com](mailto:ani@odstdio.com?subject=Engram%20security%20report)
to arrange a secure report. Outcome Driven Holdings LLC operates the hosted
service at `https://engram.ani.computer`; the same address handles hosted support
and privacy requests. We aim to acknowledge reports within two business days;
this is a response target, not an incident-resolution guarantee. Do not
post tokens, memory contents, other users' data, or a working exploit against a
live deployment in a public issue. Include the affected revision, reproduction
steps using test data, expected behavior, and the impact you observed. An issue
in the open-source project and an incident on a particular hosted installation
may require different responses from the relevant operator.

Hosted data-retention and manual erasure procedures are documented in
[Data retention](docs/DATA_RETENTION.md). In-app page deletion is recoverable;
it is not whole-workspace erasure or deletion from backups.
