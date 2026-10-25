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
and open **Workspace → Early access invitations**. Create a single-use link
without collecting the friend's email first. Copy the link and share it
directly. The invitation list also offers **Copy link** for unused, unexpired
invitations after reopening the page. Creating or copying a link does not send
an email to the friend. An optional
recipient email can instead restrict a code to that exact mailbox.

The friend opens the link and enters their email. Engram sends a verification
link to that inbox. Requesting verification does not bind or consume an unbound
code: the first mailbox that completes verification claims it atomically. Other
verification attempts then fail. A code by itself does not authenticate its
holder. Email-bound codes continue to require their assigned mailbox.

The invitation URL uses `/app#invite=CODE`, keeping the raw code out of HTTP
request paths and query strings. An optional `&email=ENCODED_EMAIL` in that
fragment prefills the editable email field; this suggestion does not bind an
unbound invitation. The URL-supplied code is read-only in the form, and the
fragment is cleared after it is read. The server still validates the actual
code, expiry, revocation and email verification; a read-only input is not an
authorization boundary.

The invite page asks only for email and code. After verification, workspace owners
can set the workspace's display name in the getting-started guide before connecting
an agent. Naming is optional, and the saved name remains available for editing in
that guide. Renaming keeps the workspace identity, storage, policies and billing
unchanged.

Unused codes expire after seven days by default and can be revoked. Raw codes
are returned only at creation; the database stores their hashes. An authorized
operator can copy a signed link to the same unused invitation later. This does
not recover or replace the original code, extend expiry, reset verification
limits, change a mailbox restriction, or create another claim. Both links share
the same single verified redemption and revocation state. Verification emails have their own short
expiry and resend limits. Revocation and expiry are checked again when the email
link is accepted.

New invitations grant **60 days of unlimited knowledge transfers**, starting
when the email verification is accepted, not when the link is created. The
separate provisioner applies the original verified start and end timestamps;
delayed jobs or retries cannot extend the period. No card is required. This
means no transfer quota on core memory reads, writes and authorized sharing
during the grant; ordinary permission and reliability limits still apply.
Optional Jev/provider processing remains a separate permission and billing
decision.

The workspace and billing views show the remaining days and exact expiry date,
with **Ask for an extension** linking to `https://x.com/anirudh_twt`. The link
opens the profile; it does not send a message or extend access automatically.
After expiry, core writes follow the normal entitlement check; reads, exports,
privacy controls and payment recovery remain available. Existing trials and
subscriptions retain their independent state, and earlier invitations keep the
term originally attached to them. An eligible existing owned personal workspace
can claim an invitation without creating a duplicate workspace.

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

{}
```

The response contains `inviteCode` and `inviteUrl` once, plus invitation metadata
under `invite`. To create an email-bound code, supply
`{"email":"friend@example.com"}` instead. An optional `expiresAt` chooses an
unused-code expiry within thirty days; the default is seven days. This is
separate from the 60-day access period.

`invite.accessDurationDays` is `60` for newly issued codes.
`invite.accessExpiresAt` is null before redemption and becomes the exact verified
redemption timestamp plus 1,440 hours. `emailBound` and nullable `email` show
whether a mailbox restriction was set or the invitation has since been claimed.

`GET /api/admin/signup-invites` lists the optional recipient email, code/access
expiry, redemption, and revocation metadata without returning codes, links or
hashes. To copy a usable link to an existing unused invitation:

```http
POST /api/admin/signup-invites/INVITATION_ID/link
Content-Type: application/json
X-Engram-Console: 1
X-Engram-Workspace: 1

{}
```

The response contains only `{ "inviteUrl": "https://…/app#invite=…" }` and uses
`Cache-Control: no-store`. This endpoint requires the live operator session,
console header and matching workspace pin; it accepts no invitation or account
overrides. Expired, revoked, redeemed invitations and invitations from an
inactive issuer return `409` with `invite_unavailable`. Missing invitations
return `404`. Other methods return `405` and do not reveal a link.

Copied links contain an invitation ID and a domain-separated HMAC proof in a
separate `eg_link_v1_` namespace. The proof binds the original server-only code
hash, mailbox restriction, issuer and exact expiry; no code hash or mailbox is
encoded into the link. The database stores no plaintext code or copied link.
The original code remains valid under its existing terms. Server signing-key
rotation can invalidate copied aliases; the operator can request another link
without replacing the original invitation. Older gateways may not recognize
these aliases, while the original invitation codes remain compatible.

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

The finite-access schema uses a separate additive readiness marker, preserving
the older signup marker and legacy writer defaults during staging. Traffic
rollback keeps the current provisioner and database protections; do not restore
an older provisioner that could apply a non-expiring grant to a queued 60-day
invitation. New invitation links may be unavailable on an older gateway, while
legacy invitation terms and existing account access remain intact.

The operator allowlist is provisioner-owned and read-only to the runtime. Initial
setup recognizes the sole existing owner of the installation workspace; it
fails closed if that owner cannot be identified unambiguously. Adding an owner
later does not automatically authorize platform invite management.

`ENGRAM_SIGNUP_MODE=invite-only` is explicit in the hosted release configuration.
Self-hosted installs default to `open`; their operators can choose their policy
independently.
