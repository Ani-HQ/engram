# OAuth for the chat surfaces

Claude, ChatGPT, and Grok connectors have no bearer-token field. They speak
OAuth 2.1. Cursor, Claude Code, Codex, the fleet, and the console cookie keep
using `eng_` tokens. Auth is dual-path: a JWT we issued is checked first;
everything else is the existing sha256 lookup.

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
5. `GET /oauth/authorize` with PKCE S256. A signed-in console session
   finishes immediately. Otherwise we email a link to `/oauth/continue`.
6. `POST /oauth/token` exchanges the code (or a refresh token) for a JWT.
7. A JWT is accepted on `/mcp` only when its email matches an org member.
   Audience must be `https://<host>/mcp`.

Redirects are allowlisted to Claude, ChatGPT, Grok, and localhost.

## Turn it on

Set a persistent RSA private key. Cloud Run instances must share one key or
tokens issued on one box fail on another.

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048
```

```text
ENGRAM_PUBLIC_URL=https://engram.ani.computer
ENGRAM_OAUTH_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
ENGRAM_OAUTH_AUDIENCE=https://engram.ani.computer/mcp
```

Hosted: the key is `engram-oauth-private-key`, mounted as
`ENGRAM_OAUTH_PRIVATE_KEY`. Without it, connectors stay closed. Bearer tokens
are unchanged.

A person must already be an org member. The magic link proves the email.

## Prove one surface

Add a Claude custom connector pointed at `https://engram.ani.computer/mcp`.
Use Claude's published identity or let it register. After the email link,
`whoami` should return `oauth:<email>`. Then ChatGPT and Grok.

## What must not break

Five surfaces stay on bearer tokens. Do not require OAuth for Cursor, Claude
Code, Codex, the fleet VM, or the console cookie.
