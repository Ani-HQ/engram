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
