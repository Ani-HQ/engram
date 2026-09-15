# Scoping OAuth for the chat surfaces

Claude, ChatGPT and Grok cannot connect to engram today. Their connector UIs accept
OAuth only — there is no field for a bearer token or a custom header. They are also the
surfaces where engram matters most, because they have no filesystem: memory is not a
convenience there, it is the only channel.

## The good news: engram does not become an OAuth server

The June 2025 revision of the MCP authorization spec separates the MCP server from the
authorization server. engram is a **resource server**: it validates tokens that an
external authorization server issued. Consent screens, PKCE verification, refresh
rotation, client registration — none of it is ours.

## What engram MUST implement

1. **Protected Resource Metadata (RFC 9728)** at `/.well-known/oauth-protected-resource`
   — a JSON document whose `authorization_servers` field names our AS. Serve it at the
   root and at the endpoint-suffixed path `/.well-known/oauth-protected-resource/mcp`,
   because clients probe both.
2. **A `WWW-Authenticate` header on 401** pointing at that document, and a `scope` hint:
   `Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource", scope="memory:read"`
3. **Token validation.** Verify the JWT signature against the AS's JWKS, check issuer
   and expiry, and — the security-critical part — **verify the audience is engram**.
   A server that accepts tokens minted for something else is the confused-deputy hole
   the spec spends most of its length warning about.
4. **Canonical resource URI**: `https://<host>/mcp`. Tokens must be bound to it via
   RFC 8707 resource indicators.
5. **403 with `error="insufficient_scope"`** when a token is valid but lacks a scope,
   including the scopes needed so the client can step up.

## What must NOT break

Five surfaces authenticate with `eng_` bearer tokens today: Claude Code, Cursor, Codex,
the fleet VM, and the console's cookie. **Auth becomes dual-path**: if the credential
parses as a JWT from our AS, validate it that way; otherwise fall back to the existing
sha256 token lookup. Breaking five working surfaces to add three is not a trade worth
making.

## The decision that gates everything: which authorization server

Requirements, in order of how badly a wrong choice hurts:

- **OAuth 2.1 with PKCE S256**, and `code_challenge_methods_supported` present in its
  metadata — clients MUST refuse to proceed without it.
- **Discovery** via RFC 8414 or OpenID Connect Discovery.
- **Dynamic Client Registration (RFC 7591)** — the spec now calls this MAY, preferring
  Client ID Metadata Documents, but ChatGPT reportedly *mandates* DCR. **Verify this
  against OpenAI's own connector documentation before choosing**, because picking an AS
  without DCR and discovering that later wastes the entire build.
- **Resource indicators (RFC 8707)** so tokens are audience-bound.
- Free or near-free at one-user scale.

Candidates worth comparing: WorkOS AuthKit (has MCP-specific support), Auth0, Descope,
Stytch, Logto, or self-hosted Keycloak. Self-hosting adds an always-on service to a
project whose current virtue is having very few moving parts.

## Identity mapping

engram's audit log keys on a token *name*. An OAuth token carries a subject and usually
an email. Map one to the other on first sight — `oauth:<sub>`, or resolve to a name via
email — so attribution keeps working and the console keeps showing who taught the brain
what.

## Effort, honestly

The engram-side code is small: two metadata endpoints, one header, and JWT verification.
JWKS-backed RS256 verification is roughly eighty lines with `node:crypto` and no new
dependency, which is worth doing given the project has exactly two.

The long pole is not code. It is that **the only way to test a ChatGPT or Claude
connector is to connect one**, and each failure costs a round trip through someone
else's UI with error messages you do not control. Budget most of the time there, not in
the gateway.

## Suggested order

1. Confirm ChatGPT's actual requirement (DCR vs Client ID Metadata Documents). One
   wrong assumption here invalidates the AS choice.
2. Pick the AS against that answer and stand up a tenant.
3. Build the resource-server side behind a flag, with the bearer path untouched.
4. Prove it with one surface end to end before wiring the other two.
