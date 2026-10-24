# Worker isolation and writes

Hosted mode rejects ordinary child-process isolation. On Cloud Run, enable the
sandbox launcher for the service and dream job. The gateway checks containment
before opening its HTTP listener: a sandbox cannot read sibling workspace homes,
inherit provisioning credentials, inspect the parent process environment, or
retrieve the parent metadata identity. An unsupported runtime fails startup.
Cloud Run sandboxes are a Google Cloud preview feature; production rollout must
verify the actual deployed sandbox rather than infer isolation from a build.

Cloud Run's launcher needs UID 0 in the outer container to create its network
interface. Cloud Run does not permit changing the guest UID in this configuration.
Every engine command uses a capability-clearing wrapper before execution:
inheritable, permitted, effective and ambient capabilities become zero, with
`no-new-privs` enabled. The guest retains UID 0; it must not be described as a
non-root process. The provider's bounding set remains, and the deployed probe
checks that execution of the engine and another child cannot regain capabilities.
The container entrypoint drops to the
unprivileged app user for ordinary self-hosted modes and provisioner jobs.
The Linux user change does not expand the service account's IAM permissions or
give the HTTP runtime an administrative PostgreSQL credential.

Each sandbox sees its workspace home at `/gbrain-work`; the parent home tree,
gateway source, `/root`, `/home`, `/run` and parent `/tmp` are masked. Temporary
files use that workspace's private `.tmp` directory. The rest of the image's
filesystem remains readable; do not mount parent secrets into unmasked paths.
Its database password is derived for one
restricted PostgreSQL role and database. Cloud SQL tunnels use a short-lived,
SQL-scoped token for `engram-db-connector`, which has Cloud SQL Client access and
no Secret Manager or provisioning access. The web identity can mint tokens only
for that connector identity. Workers retire within 45 minutes of their one-hour
token lifetime. No service-account key files are created.

The launcher records command arguments. Scoped worker credentials therefore use
a unique 0600 file inside that workspace's 0700 home, never argument values.
The bootstrap validates and deletes that file before starting the engine while
preserving MCP stdin. Cleanup removes an unconsumed file only after confirming
runtime deletion. Parent provisioning and tenant-master credentials never enter
the file or sandbox. Cloud Run workers enable outbound networking for the SQL
tunnel; this setting is not an outbound destination allowlist. Application
consent checks govern configured model requests, and do not establish a network
firewall against a compromised engine.

The gateway has two resident/starting engine slots by default, at most sixteen
startup requests, two active calls per workspace, and sixteen pending calls per
workspace. Idle workers close after ten minutes. Startup is asynchronous. Failed
workers restart lazily with the requesting workspace's current policy. A health
probe reports process state without executing a randomly selected tenant's tool.

The Docker backend requires a dedicated **internal** network containing a
database or scoped proxy. Containers have a read-only root filesystem, bounded
memory/CPU/PIDs, no capabilities, no privilege escalation, a limited tmpfs, and
one workspace home. They never receive the host Docker socket. External provider
analysis runs in the gateway; Docker workers do not receive embedding keys.
The gateway's Docker access is privileged infrastructure and belongs on a trusted
host. Compose's default native-process backend is for a trusted self-hosted
installation; it does not claim container isolation between local users.

All gateway engine mutations share a PostgreSQL advisory transaction per
workspace, across instances and revisions. Read/modify/write operations keep the
lock across reads, writes, rollover, and receipt checks; heartbeats keep the
transaction alive. Cross-workspace mirroring starts after releasing the source
lock. The lock is cooperative coordination, not a fencing token.

`remember` and rollover additionally use atomic `expected_hash` guards in the
pinned GBrain importer. Null means create only if absent; a SHA-256 value means
replace that exact existing version. PostgreSQL rejects stale/missing versions
before importer side effects. Conflicts retry from a new read. A partial archive
copy is deduplicated on retry. An engine missing version support fails explicitly.
Public MCP `put_page` now requires an explicit `expected_hash`: null creates only
if absent and cannot overwrite a page; use the current `content_hash` returned by
`get_page` for an atomic versioned update. The gateway rejects omitted or mistyped
guards before forwarding. This intentionally changes the older public contract:
clients that omitted the guard must now supply one. Browser Add memory uses null
for create-only behavior. The upstream engine retains its legacy unconditional
mode for internal direct callers; this gateway check does not change that engine
compatibility or the existing `remember`/rollover guards.

The custom MCP transport bounds responses and supplies an exact environment. On
mutation timeout or cancellation it confirms child exit and named container or
sandbox deletion before the caller releases its write lock. Diagnostic output is
drained without putting private page text or credential URLs in shared logs.

Tests cover real MCP child processes, two independent PostgreSQL lock holders,
actual guarded PostgreSQL statements, and restricted-role provisioning. The
Docker importer and deployed Cloud Run checks are separate release gates.

Primary runtime references:

- [Cloud Run sandbox code execution](https://docs.cloud.google.com/run/docs/code-execution)
- [Cloud Run sandbox CLI](https://docs.cloud.google.com/run/docs/reference/sandbox-cli)
- [Google's launcher permissions and argument logging guidance](https://google.github.io/skill-reach/guides/sandboxing/)
- [Cloud SQL proxy authentication](https://docs.cloud.google.com/sql/docs/postgres/connect-auth-proxy)
