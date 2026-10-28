# Publish to npm from a real terminal when the account has write 2FA

**Problem shape:** `npm publish` (or `npm login`) run through an agent's shell or
a `!` prompt fails with `EOTP ... one-time password from your authenticator`,
even with `--auth-type=web`, and the user has no authenticator app. `npm login`
may instead crash with "Exit handler never called!".

**The procedure:**
1. Run `npm profile get`. If `two-factor auth` is `auth-and-writes`, publishing
   needs a second factor (often a passkey or security key, not an app code).
2. Do not ask for an `--otp` code unless the user confirms they use an
   authenticator app.
3. Ask the user to run `npm publish --access public` from the package folder in
   a regular terminal tab and approve the browser prompt.
4. Verify: the newest `~/.npm/_logs/*-debug-0.log` for `publish` shows
   `PUT 202`; then poll the registry until `dist-tags.latest` is the new version
   (it can lag a minute); then `npm pack <pkg>@<version>` and `cmp` a key file
   against the source.

**Why this works / the trap it avoids:** npm's `otplease` (lib/utils/auth.js)
rethrows the EOTP error immediately when stdin or stdout is not a TTY, so the
browser approval flow never starts and the message wrongly suggests an
authenticator code. A just-accepted publish can also look missing because the
registry view is briefly stale.

**Evidence:** `@ani-hq/engram-mcp@0.6.0` publish, 28 October 2026.
