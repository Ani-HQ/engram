import { h } from "./profile.js";
import { parseInviteEntry, signupInviteStatus } from "./signup-model.js";

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
  const email = h("input", { type: "email", autocomplete: "email", placeholder: "friend@example.com", maxlength: 254 });
  const issue = h("button", { type: "submit", class: "small primary" }, "Generate invite link");
  const clearSecret = () => {
    secret = "";
    if (secretInput) { secretInput.value = ""; secretInput.removeAttribute("value"); }
    secretInput = null; codeRegion.replaceChildren();
  };
  const showSecret = (code, address, rawUrl) => {
    let inviteUrl = "";
    try { const url = new URL(rawUrl); if ((url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) && !url.username && !url.password && url.pathname === "/app" && !url.search && parseInviteEntry(url.hash)?.code === code) inviteUrl = url.href; } catch {}
    const isLink = Boolean(inviteUrl), noun = isLink ? "link" : "code";
    clearSecret(); secret = inviteUrl || code; code = ""; inviteUrl = "";
    secretInput = h("input", { type: "password", readonly: true, autocomplete: "off", "aria-label": `One-time invite ${noun}`, spellcheck: "false" });
    secretInput.value = secret;
    const reveal = action(`Show ${noun}`, () => {
      if (!secret || !secretInput) return;
      const show = secretInput.type === "password";
      secretInput.type = show ? "text" : "password"; reveal.textContent = `${show ? "Hide" : "Show"} ${noun}`;
    }, { class: "small" });
    const copyCode = action(`Copy ${noun}`, async () => {
      if (!current() || !secret) return;
      try { await copy(secret); if (current() && secret) feedback.textContent = `Invite ${noun} copied. Share it privately${address ? ` with ${address}` : "; the first verified email claims it"}.`; }
      catch { if (current()) feedback.textContent = `Could not copy. Show the ${noun}, then select and copy it.`; }
    }, { class: "small" });
    codeRegion.replaceChildren(h("strong", {}, address ? `Bound to ${address}` : "Single-use link · not bound to an email yet"), h("p", {}, `Copy this ${noun} now. It is shown only once. ${address ? "Only this email address may verify and claim it." : "The first person to verify an email address claims it; entering an email alone does not reserve it."} Generating an invitation does not send an email.`), secretInput,
      h("div", { class: "form-actions" }, reveal, copyCode, action(`Done · clear ${noun}`, clearSecret, { class: "text small" })));
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
      return h("div", { class: "token-row signup-invite-row" }, h("div", {}, h("span", {}, invite.email || "Unbound invitation"), h("small", {}, invite.email ? "Bound to this email" : "First verified email claims it"), h("small", {}, signupInviteStatus(invite)), h("small", {}, invite.redeemedAt ? `Redeemed ${date(invite.redeemedAt)}${invite.accessExpiresAt ? ` · Access ends ${date(invite.accessExpiresAt)}` : ""}` : `Unused invitation expires ${date(invite.expiresAt)}`)), (!invite.revokedAt || pending) && revoke);
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
      const address = email.value.trim(), result = await api.issueSignupInvite(address ? { email: address } : {});
      if (!current() || !panel.open || id !== request) return;
      if (typeof result.inviteCode !== "string" || !result.inviteCode) throw new Error("The code was not returned. Refresh the list before trying again.");
      const updated = [result.invite, ...invites.filter(item => item.id !== result.invite.id)];
      hasMore = hasMore || updated.length > 100; invites = updated.slice(0, 100); renderList(hasMore);
      showSecret(result.inviteCode, result.invite.email, result.inviteUrl); email.value = ""; feedback.textContent = result.invite.email ? "Invite created. Only the bound email can verify and claim it. The 60-day access period starts after verification." : "Single-use invitation created. The first verified email claims it and starts 60 days of unlimited knowledge transfers. Jev is separate.";
    } catch (error) { if (current() && panel.open && id === request) { fail(error); feedback.textContent = error.message || "The invite could not be created."; } }
    finally { issue.disabled = false; }
  } }, h("label", { class: "field" }, "Bind to an email (optional)", email), h("p", { class: "field-hint" }, "Leave blank for a single-use link the first verified email can claim. Enter an email to restrict the invitation to that address."), issue);
  const panel = h("details", { class: "account-section signup-admin", ontoggle: () => {
    if (!panel.open) { clearSecret(); ++request; }
    else if (!loaded) refresh();
  } }, h("summary", {}, "Early access invitations"), h("div", { class: "signup-admin-content stack" },
    h("p", { class: "detail-note" }, "Operator access · Friends get 60 days of unlimited knowledge transfers in a personal workspace after email verification, with no card required. Jev has separate permission and usage costs. An unused invitation expires after seven days."), form, codeRegion, feedback,
    h("div", { class: "form-actions" }, action("Refresh invitations", () => { clearSecret(); refresh(); }, { class: "small" })), list));
  return { element: panel, clearSecrets() { ++request; clearSecret(); }, dispose() { active = false; ++request; clearSecret(); email.value = ""; } };
}
