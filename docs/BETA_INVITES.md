# Hosted beta invitations

Hosted signup is invite-only. Self-hosted installations remain open by default.
The public policy is available at `GET /api/signup-policy`; public signup must
never fall back to open access when that policy cannot be loaded.

The hosted console uses email sign-in. Its policy returns
`tokenSignInAllowed: false`; token exchange through `POST /api/session` is
disabled, and API keys cannot be used as hosted console cookies. Agent bearer
credentials continue to authenticate MCP and supported APIs. Self-hosted
installations retain token sign-in for owner bootstrap and recovery.

## Invite a friend

Sign in with the existing installation administrator account, select **Ani HQ**,
and open **Workspace → Early access invitations**. Enter the friend's exact email address and
create a code. Copy the code and send it with `https://engram.ani.computer/app#invite`.
Creating a code does not send an email to the friend.

The friend enters that email and code. Engram sends a verification link to the
assigned inbox. Only accepting that email link consumes the code and admits the
account. A code by itself does not authenticate its holder.

The invite page asks only for email and code. After verification, workspace owners
can set the workspace's display name in the getting-started guide before connecting
an agent. Naming is optional, and the saved name remains available for editing in
that guide. Renaming keeps the workspace identity, storage, policies and billing
unchanged.

Unused codes expire after seven days by default and can be revoked. Raw codes
are returned only at creation; the database stores their hashes. Generate a
replacement if the code was lost. Verification emails have their own short
expiry and resend limits. Revocation and expiry are checked again when the email
link is accepted.

The admitted personal workspace receives complimentary access with no scheduled
expiry, applied by the separate provisioner. No card is required. Existing
trials and subscriptions retain their independent state. An existing owned
personal workspace can use an invitation when it does not have a Stripe
subscription; this does not create a duplicate workspace.

## Operator API

The endpoint uses an authenticated human console session for an explicitly
allowed administrator. Workspace ownership elsewhere, agent keys, and OAuth
memory scopes do not authorize invite issuance. The normal console CSRF header
is required. A supplied workspace pin must match the administrator workspace.
The admin screen supplies both headers automatically.

```http
POST /api/admin/signup-invites
Content-Type: application/json
X-Engram-Console: 1
X-Engram-Workspace: 1

{"email":"friend@example.com"}
```

The response contains `inviteCode` once, plus invitation metadata under `invite`.
An optional `expiresAt` chooses a future expiry within thirty days. The response's
`accessExpiresAt: null` describes the complimentary grant, not the code's expiry.

`GET /api/admin/signup-invites` lists recipient email, expiry, redemption, and
revocation metadata without returning codes or hashes.

```http
POST /api/admin/signup-invites/INVITATION_ID/revoke
Content-Type: application/json
X-Engram-Console: 1
X-Engram-Workspace: 1

{}
```

Unused admission is revoked immediately. For a redeemed invitation, the
provisioner also revokes the corresponding complimentary grant; the response
reports whether that work is pending. Normal trial/subscription rules then
apply. Existing data remains subject to the normal account and retention policy.

## Admission and billing boundaries

The public `POST /api/orgs` accepts `email` and `inviteCode` for an invited signup;
an optional `name` can name the workspace. It sends verification rather than
creating a session or workspace. Existing members can still request their normal
email login. Hosted legacy signup links without approved admission cannot create
accounts, and team invitations cannot bypass first-time admission.

The verified claim is atomic: only one request can consume a valid code, create
or select its authorized personal workspace, and bind the owner. A failed claim
does not leave a partially admitted account. The runtime cannot write the
complimentary billing or audit tables; the provisioner applies the exact grant
and records it once. Reprovisioning must not restore a revoked grant.

The operator allowlist is provisioner-owned and read-only to the runtime. Initial
setup recognizes the sole existing owner of the installation workspace; it
fails closed if that owner cannot be identified unambiguously. Adding an owner
later does not automatically authorize platform invite management.

`ENGRAM_SIGNUP_MODE=invite-only` is explicit in the hosted release configuration.
Self-hosted installs default to `open`; their operators can choose their policy
independently.
