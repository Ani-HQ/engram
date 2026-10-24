import { h } from "./profile.js";
import { signupInviteStatus } from "./signup-model.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const date = value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed) : "—";
};

// This panel is a server-authorized operator capability, separate from ordinary
// workspace membership invitations. A one-time code lives only in this view.
export function signupAdminPanel({ session, api, fail = () => {}, copy, isCurrent = () => true }) {
  if (session?.capabilities?.manageSignupInvites !== true) return null;
  let active = true, secret = "", secretInput = null, request = 0, loaded = false, invites = [], hasMore = false;
  const current = () => active && isCurrent();
  const feedback = h("p", { class: "form-feedback", role: "status", "aria-live": "polite" });
  const codeRegion = h("div", { class: "signup-issued", "aria-live": "polite" });
  const list = h("div", { class: "signup-invite-list" });
  const email = h("input", { type: "email", required: true, autocomplete: "email", placeholder: "friend@example.com", maxlength: 254 });
  const issue = h("button", { type: "submit", class: "small primary" }, "Generate invite code");
  const clearSecret = () => {
    secret = "";
    if (secretInput) { secretInput.value = ""; secretInput.removeAttribute("value"); }
    secretInput = null; codeRegion.replaceChildren();
  };
  const showSecret = (code, address) => {
    clearSecret(); secret = code; code = "";
    secretInput = h("input", { type: "password", readonly: true, autocomplete: "off", "aria-label": "One-time invite code", spellcheck: "false" });
    secretInput.value = secret;
    const reveal = action("Show code", () => {
      if (!secret || !secretInput) return;
      const show = secretInput.type === "password";
      secretInput.type = show ? "text" : "password"; reveal.textContent = show ? "Hide code" : "Show code";
    }, { class: "small" });
    const copyCode = action("Copy code", async () => {
      if (!current() || !secret) return;
      try { await copy(secret); if (current() && secret) feedback.textContent = "Invite code copied. Share it privately with this email address."; }
      catch { if (current()) feedback.textContent = "Could not copy. Show the code, then select and copy it."; }
    }, { class: "small" });
    codeRegion.replaceChildren(h("strong", {}, `Invite for ${address}`), h("p", {}, "Copy this code now. It is shown only once. Share it privately with the invited person; generating a code does not send an email."), secretInput,
      h("div", { class: "form-actions" }, reveal, copyCode, action("Done · clear code", clearSecret, { class: "text small" })));
  };
  const renderList = more => {
    list.replaceChildren(...(invites.length ? invites.map(invite => {
      const pending = signupInviteStatus(invite) === "Revocation pending";
      const revoke = action(pending ? "Retry revocation" : "Revoke code and free access", async event => {
        const button = event.currentTarget;
        if (button.dataset.confirm !== "yes") { button.dataset.confirm = "yes"; button.textContent = "Confirm revocation"; return; }
        button.disabled = true; feedback.textContent = ""; clearSecret();
        try {
          const result = await api.revokeSignupInvite(invite.id);
          if (!current()) return;
          invites = invites.map(item => item.id === invite.id ? result.invite : item); renderList(more);
          feedback.textContent = result.revocationPending ? "Revocation is pending. The code is revoked; free access removal is still queued. Refresh or retry to check completion." : "Invite code and its free access have been revoked.";
        } catch (error) { if (current()) { fail(error); feedback.textContent = error.message || "Revocation could not be confirmed. Refresh and try again."; button.disabled = false; } }
      }, { class: "text small" });
      return h("div", { class: "token-row signup-invite-row" }, h("div", {}, h("span", {}, invite.email), h("small", {}, signupInviteStatus(invite)), h("small", {}, invite.redeemedAt ? `Redeemed ${date(invite.redeemedAt)}` : `Unused code expires ${date(invite.expiresAt)}`)), (!invite.revokedAt || pending) && revoke);
    }) : [h("p", { class: "detail-note" }, "No early access invitations yet.")]), ...(more ? [h("p", { class: "field-hint" }, "Showing the 100 newest invitations. Older invitations are not shown here.")] : []));
  };
  const refresh = async () => {
    const id = ++request;
    list.replaceChildren(h("p", { role: "status", class: "detail-note" }, "Loading invitations…"));
    try {
      const result = await api.signupInvites();
      if (!current() || id !== request || !panel.open) return;
      invites = result.invites || []; loaded = true; hasMore = result.more === true; renderList(hasMore);
    } catch (error) { if (current() && id === request && panel.open) { fail(error); list.replaceChildren(h("p", { class: "detail-note" }, error.message || "Invitations could not be loaded.")); } }
  };
  const form = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); if (!current() || issue.disabled) return;
    const id = ++request;
    issue.disabled = true; feedback.textContent = ""; clearSecret();
    try {
      const result = await api.issueSignupInvite({ email: email.value.trim() });
      if (!current() || !panel.open || id !== request) return;
      if (typeof result.inviteCode !== "string" || !result.inviteCode) throw new Error("The code was not returned. Refresh the list before trying again.");
      const updated = [result.invite, ...invites.filter(item => item.id !== result.invite.id)];
      hasMore = hasMore || updated.length > 100; invites = updated.slice(0, 100); renderList(hasMore);
      showSecret(result.inviteCode, result.invite.email); email.value = ""; feedback.textContent = "Invite created. The recipient must verify the same email address before access begins.";
    } catch (error) { if (current() && panel.open && id === request) { fail(error); feedback.textContent = error.message || "The invite could not be created."; } }
    finally { issue.disabled = false; }
  } }, h("label", { class: "field" }, "Invited email", email), issue);
  const panel = h("details", { class: "account-section signup-admin", ontoggle: () => {
    if (!panel.open) { clearSecret(); ++request; }
    else if (!loaded) refresh();
  } }, h("summary", {}, "Early access invitations"), h("div", { class: "signup-admin-content stack" },
    h("p", { class: "detail-note" }, "Operator access · Invite one email address at a time. Friends get a personal workspace free until access is revoked, with no card required. An unused code expires after seven days. Email verification is required."), form, codeRegion, feedback,
    h("div", { class: "form-actions" }, action("Refresh invitations", () => { clearSecret(); refresh(); }, { class: "small" })), list));
  return { element: panel, clearSecrets() { ++request; clearSecret(); }, dispose() { active = false; ++request; clearSecret(); email.value = ""; } };
}
