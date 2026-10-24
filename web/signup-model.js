export function parseSignupPolicy(value) {
  if (!value || !["open", "invite-only"].includes(value.mode) || value.verificationRequired !== true || typeof value.inviteCodeRequired !== "boolean" || value.inviteCodeRequired !== (value.mode === "invite-only") || (value.mode === "invite-only" && value.complimentary !== true)) {
    throw new Error("Signup availability could not be checked. You can still sign in.");
  }
  return { mode: value.mode, complimentary: value.complimentary === true, verificationRequired: true, inviteCodeRequired: value.inviteCodeRequired, tokenSignInAllowed: value.tokenSignInAllowed === true };
}

export function signupAuthMode(mode, policy) {
  if (mode === "create") return "create";
  return mode === "token" && policy?.tokenSignInAllowed === true ? "token" : "email";
}

export function signupEntryMode(policy, hash, pathname = "/app") {
  if (hash === "#invite" || hash === "#start") return "create";
  if (hash === "#signin") return "email";
  return pathname === "/" && policy?.mode === "invite-only" ? "create" : "email";
}

export function emailLinkRecovery(raw) {
  return String(raw || "").startsWith("svf_")
    ? { hash: "#invite", message: "This verification link could not be opened. It may have expired or already been used. Enter your email and invite code below to request a new link. If the code has expired or been revoked, ask your inviter for a new one. Already verified? Sign in." }
    : { hash: "#signin", message: "This email link could not be opened. It may have expired or already been used. Request a new sign-in link below. For a workspace membership invitation, ask the owner for a new invitation." };
}

export function signupRequest(policy, { email, name, inviteCode }) {
  if (!policy) throw new Error("Signup availability could not be checked. Please try again.");
  const payload = { email: String(email || "").trim() };
  if (!policy.inviteCodeRequired && String(name || "").trim()) payload.name = String(name).trim();
  if (policy.inviteCodeRequired) {
    const code = String(inviteCode || "").trim();
    if (!code) throw new Error("Enter the invite code shared with your email address.");
    payload.inviteCode = code;
  }
  return payload;
}

export function signupInviteStatus(invite, now = Date.now()) {
  if (invite.revokedAt) return invite.complimentaryAppliedAt && !invite.complimentaryRevokedAt ? "Revocation pending" : "Revoked";
  if (invite.complimentaryErrorCode) return "Access needs attention";
  if (invite.complimentaryAppliedAt && !invite.complimentaryRevokedAt) return "Free access active";
  if (invite.redeemedAt) return "Activating free access";
  const expiry = Date.parse(invite.expiresAt);
  return Number.isFinite(expiry) ? expiry <= now ? "Code expired" : "Code unused" : "Status unavailable";
}
