# OAuth for the chat surfaces

Claude, ChatGPT, and Grok connectors have no bearer-token field. They speak
OAuth 2.1. Cursor, Claude Code, Codex, the fleet, and the console cookie keep
using `eng_` tokens. Auth is dual-path: a JWT from the authorization server is
checked first; everything else is the existing sha256 lookup.

The resource-server side lives in the gateway. The authorization server is
**WorkOS AuthKit**. engram does not become an OAuth server.

## Why WorkOS

ChatGPT accepts Client ID Metadata Documents, Dynamic Client Registration, or a
pre-registered client. Claude prefers CIMD and falls back to DCR. Grok registers
via DCR. AuthKit does all three, PKCE S256, resource indicators (RFC 8707), and
discovery. One tenant covers the three chat surfaces.

A wrong authorization-server pick wastes the build. This one matches the clients.

## What the gateway already does

1. Protected Resource Metadata (RFC 9728) at
   `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-protected-resource/mcp`.
2. A `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="memory:read"`.
3. JWT verification against the issuer JWKS. Audience must be
   `https://<host>/mcp`. `eng_` tokens still work.
4. A JWT is accepted only when its email matches an org member.
5. A compatibility proxy of AuthKit's
   `/.well-known/oauth-authorization-server` (and OpenID discovery) on the
   engram host, for clients that skip protected-resource metadata.

## Stand up AuthKit

1. Create a [WorkOS](https://workos.com) environment and an AuthKit domain,
   e.g. `https://engram.authkit.app`.
2. Connect → Configuration: enable **Client ID Metadata Document**. Keep
   **Dynamic Client Registration** on for older clients.
3. Add a Resource Indicator: `https://engram.ani.computer/mcp`. Set it as the
   default so clients that omit `resource` still get the right audience.
4. Set on Cloud Run (and in `.env` for local):

   ```text
   ENGRAM_PUBLIC_URL=https://engram.ani.computer
   ENGRAM_OAUTH_ISSUER=https://engram.authkit.app
   ENGRAM_OAUTH_AUDIENCE=https://engram.ani.computer/mcp
   ```

   AuthKit JWKS is `https://<issuer>/oauth2/jwks`. The gateway uses that when
   the issuer host contains `authkit.app`. Override with `ENGRAM_OAUTH_JWKS_URL`
   only if you have to.

5. A person must already be an org member (console signup / invite). AuthKit
   login proves the email; engram maps it to that membership.

## Prove one surface

Add a Claude custom connector pointed at `https://engram.ani.computer/mcp`.
Use Claude's published identity. After sign-in, `whoami` should return
`oauth:<sub>`. Then ChatGPT and Grok.

## What must not break

Five surfaces stay on bearer tokens. Do not require OAuth for Cursor, Claude
Code, Codex, the fleet VM, or the console cookie.
