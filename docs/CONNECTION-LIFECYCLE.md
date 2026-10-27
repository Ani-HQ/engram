# Connection lifecycle and credential revocation

The console inventory keeps lifecycle metadata separately from credentials and
activity. Only a current workspace owner with an email session may archive,
restore or delete a connection. Mutations require the console CSRF header and
the exact workspace pin; an explicit Origin must match the public origin.
Authority is checked again against a locked live membership in the transaction.

Archiving revokes access and places the connection in Archived. Restoring only
returns the row to the current inventory: it never re-enables an old credential.
Deleting revokes access and tombstones the inventory row. Tokens, OAuth grants,
memories, audit receipts and task reports remain stored; deletion does not erase
the work previously recorded by that connection. Deleted rows are excluded
before the inventory limit, and current rows sort ahead of archived rows.

An access key is identified by its immutable token ID. OAuth connections group
all grants for the exact workspace, email and client. Lifecycle changes revoke
all of those refresh credentials and outstanding authorization codes together.
They also increment a connection generation checked on every OAuth access JWT.
Legacy JWTs without the claim are generation zero, and remain usable only until
the first lifecycle revocation. Restore never resets a generation. A fresh
authorization code binds the current generation; a successful exchange can make
an archived or deleted OAuth identity visible again without reviving its old
JWTs, codes or refresh credentials.

OAuth code creation, token minting and lifecycle mutations acquire the same
transaction advisory lock even when no lifecycle row exists yet. Refresh token
validity is checked again while that lock is held. This prevents an in-flight
refresh or code exchange from re-creating access after a committed revocation.
Requests already authenticated before revocation may finish; subsequent requests
check the current generation.

The additive migration adds `connection_lifecycle`, authorization-code generation
binding and a separate `connections_version` readiness marker. It preserves
predecessor schema markers, but **traffic rollback to a pre-feature image is not
safe after lifecycle revocation**: older code does not inspect the generation
and can accept previously issued access JWTs until their expiry. Use a forward
fix or another image that includes generation enforcement. Merely retaining the
new table does not make an older runtime enforce it.
This also applies to directly reachable tagged revision URLs: remove or disable
tags for pre-feature revisions before exposing lifecycle controls, rather than
leaving an older authentication path reachable beside the new production URL.

## Console connection flow

The Connections page owns the current/archived inventory and connection access.
Its primary **Connect an agent** action shows the shared MCP endpoint and a
**Copy setup prompt** action. The prompt includes the endpoint and intended
workspace as JSON data, uses the client's native setup, preserves other
connections, and asks for a successful `whoami` check of the intended workspace.
It guides the user when the agent cannot configure itself or needs secure
credential entry. A collapsed preview and endpoint-only copy remain available.
Bearer-token guidance is highlighted with the existing neutral notice.
Clients start their own OAuth sign-in where supported. A named
access-key form and agent-specific setup help are optional disclosures. Viewing
help or choosing a configuration format never labels a new credential or changes
its permission. Replacing an existing key can preserve its explicit manual
source; leaving that flow for the generic Connect action clears that source
context. Existing rows open their own management actions and reconnect details.

Getting started, save/recall checks and memory-workflow installation are separate
from this flow. The workspace onboarding panel is not shown on Connections.
Key requests stay pinned to the current workspace and dialog. Closing or
replacing a dialog does not reopen it when a key request finishes; secret fields
are cleared when the result closes, and a later connection refresh shows any
successfully issued authorization without recovering its one-time key.

## Client names received after connection

OAuth connections use their registered client name. For access keys, the MCP
gateway accepts a bounded client name from legacy `initialize.clientInfo` or
per-request `io.modelcontextprotocol/clientInfo` metadata after authentication
and workspace checks. Observation matches the authenticated bearer digest and
workspace, checks revocation and current membership again, and stores at most
four distinct normalized names on that exact token row. Reissuing a key starts
with an empty list even if its human-readable name is reused. Optional metadata
uses a short transaction-local lock/statement timeout and cannot fail the MCP
operation. No model, client version, capability payload or credential is copied
into the name list.

The inventory exposes `client: {state, label, harness}` separately from manual
source labels and credential identity. A useful single declaration identifies
the reported client; absent, generic bridge or unsafe names produce **Unknown
client**. Distinct client names on a shared key produce **Multiple clients**,
rather than replacing the displayed identity on every request. These names do
not authenticate an application, identify an individual bot/model, change
authorization, or rewrite historical activity. Connections refreshes when the
page returns to the foreground and retains its explicit Refresh action.

Existing keys remain valid and do not need replacement. Clients that send names
on requests are detected on their next authenticated request. Clients that only
identify during initialization need a fresh handshake if they connected before
the update; restart the agent or reconnect with the same key. Existing OAuth
connections use the stored registration immediately. Refresh reveals recorded
names; it does not probe clients or infer missing identities.

The additive migration adds bounded `tokens.client_names` and the separate
`client_identity_version` readiness marker. Existing schema-version contracts
and credential source fields remain intact. The provisioner applies this schema
before the new restricted runtime can start.
