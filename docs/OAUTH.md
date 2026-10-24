# OAuth for the chat surfaces

Clients that require OAuth use Engram's authorization-code flow with PKCE S256.
Clients that accept an MCP bearer token can continue using an `eng_` credential.
Human console sessions use `ens_` credentials in HttpOnly cookies. Opaque
credentials are checked against stored SHA-256 hashes; issued access JWTs are
verified separately.

engram is both the resource server and the authorization server. Login is the
same Resend magic link as the console. There is no second identity vendor.

## What the gateway does

1. Protected Resource Metadata at `/.well-known/oauth-protected-resource`
   and `/.well-known/oauth-protected-resource/mcp`.
2. Authorization Server Metadata at `/.well-known/oauth-authorization-server`
   (and the OpenID discovery aliases).
3. JWKS at `/.well-known/jwks.json`.
4. Dynamic client registration at `POST /oauth/register`, plus Client ID
   Metadata Documents hosted on Claude / ChatGPT / Grok.
5. `GET /oauth/authorize` with PKCE S256. A genuine human console session uses
   its selected workspace. Otherwise Engram emails a link to `/oauth/continue`.
   A delegated OAuth token copied into a cookie cannot authorize a new connector.
6. `POST /oauth/token` exchanges the code (or a refresh token) for a JWT.
7. A JWT is accepted on `/mcp` only with a valid signature, issuer, expiration,
   expected resource audience, and signed `org_id` that matches a current
   membership for its email. Its role comes from that current membership.
   The canonical audience is `https://<host>/mcp`.

Access JWTs expire after one hour. Authorization codes expire after five
minutes and can be exchanged once. Refresh tokens expire after 30 days and
remain bound to the original client, resource, and workspace; refreshing also
checks that workspace membership still exists. An invitation to another team
or an app workspace switch does not redirect an existing connection there.

Explicit `memory:read` and `memory:write` scopes constrain delegated memory
operations. For connector compatibility, a grant containing only identity
scopes (`openid`, `email`, `offline_access`) retains the human's permitted
memory access. These credentials cannot administer console credentials,
invitations, memberships, billing, or workspace switching.

Redirects are allowlisted to Claude, ChatGPT, Grok, and localhost.

## Turn it on

Set a persistent RSA private key. Cloud Run instances must share one key or
tokens issued on one box fail on another.

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048
```

```text
ENGRAM_PUBLIC_URL=https://engram.example.com
ENGRAM_OAUTH_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
ENGRAM_OAUTH_AUDIENCE=https://engram.example.com/mcp
```

Store the key in the deployment's secret store, exposed to the gateway as
`ENGRAM_OAUTH_PRIVATE_KEY`. The current Cloud Run configuration uses the
`engram-oauth-private-key` secret. Without a signing key, OAuth authorization is
disabled; bearer-token MCP remains available. Replacing the single configured
key invalidates JWTs signed by the old key, so plan rotation and reconnection.

A person must already belong to a workspace. Sign into the intended workspace
in the app before connecting a client. A magic link proves access to the email
address; it does not restore a removed membership or a stale role.

Configure email delivery for public sign-in. If mail is unconfigured, OAuth
email login fails closed and does not display the sign-in link. Only an explicit
`ENGRAM_DEV_LOGIN_LINKS=1` on a self-hosted development installation enables that
fallback. Hosted mode never permits it. See [SELF_HOSTING.md](SELF_HOSTING.md).

Authentication and billing are separate checks. An expired hosted trial or
subscription does not move a connection into another workspace; additional
content writes require the original workspace's entitlement. Reads and the
available privacy/recovery controls remain accessible. See [BILLING.md](BILLING.md).

## Prove one surface

Add a supported custom connector pointed at your canonical `/mcp` endpoint.
Use its published client metadata or dynamic registration. After sign-in,
`whoami` identifies the delegated connection as
`oauth:<encoded-subject>:<encoded-client-id>` when a client ID is present.
Different clients acting for the same person therefore have distinct activity
identities. Verify a read, an allowed write, rejection of a read-only write,
and denial after removing a test member in a separate test workspace.

## What must not break

Do not require OAuth for clients already using workspace-bound bearer tokens.
Do not replace a human session with a delegated token for console administration.
Neither authentication path should choose a tenant from an untrusted request
parameter. Tenant separation is enforced by the gateway and database bindings;
it is not end-to-end encryption from the service operator. See
[SECURITY.md](../SECURITY.md).
