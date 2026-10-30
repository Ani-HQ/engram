import { h } from "./profile.js";
import { parseInviteEntry, signupInviteStatus } from "./signup-model.js";
import { icon } from "./icons.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const date = value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed) : "—";
};

// This panel is a server-authorized operator capability, separate from ordinary
// workspace membership invitations. Link credentials are retrieved on demand,
// kept out of the inventory, and cleared when this view closes.
export function signupAdminPanel({ session, api, fail = () => {}, copy, isCurrent = () => true }) {
  if (session?.capabilities?.manageSignupInvites !== true) return null;
  let active = true, secret = "", secretInput = null, request = 0, loaded = false, invites = [], hasMore = false;
  const current = () => active && isCurrent();
  const feedback = h("p", { class: "form-feedback", role: "status", "aria-live": "polite" });
  const codeRegion = h("div", { class: "signup-issued", "aria-live": "polite" });
  const list = h("div", { class: "signup-invite-list" });
  const pendingLinks = new Map();
  const email = h("input", { type: "email", autocomplete: "email", placeholder: "friend@example.com", maxlength: 254 });
  const issue = h("button", { type: "submit", class: "small primary" }, icon("plus", { size: 14 }), "Create invite link");
  const clearSecret = () => {
    secret = "";
    if (secretInput) { secretInput.value = ""; secretInput.removeAttribute("value"); }
    secretInput = null; codeRegion.replaceChildren();
  };
  const validLink = rawUrl => {
    try {
      const url = new URL(rawUrl), entry = parseInviteEntry(url.hash);
      if ((url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) && !url.username && !url.password && url.pathname === "/app" && !url.search && entry) return { url: url.href, code: entry.code };
    } catch {}
    return null;
  };
  const showSecret = (code, address, rawUrl) => {
    const link = validLink(rawUrl);
    let inviteUrl = link?.code === code ? link.url : "";
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
    codeRegion.replaceChildren(h("strong", {}, address ? `Bound to ${address}` : "Single-use link · not bound to an email yet"), h("p", {}, `Copy this ${noun} and share it privately. ${address ? "Only this email address may verify and claim it." : "The first person to verify an email address claims it; entering an email alone does not reserve it."} You can copy an unused invitation's link again from the list below. Generating an invitation does not send an email.`), secretInput,
      h("div", { class: "form-actions" }, reveal, copyCode, action(`Done · clear ${noun}`, clearSecret, { class: "text small" })));
  };
  const copyLabel = () => [icon("link", { size: 14 }), "Copy link"];
  const clearPendingLinks = () => {
    for (const pending of pendingLinks.values()) { pending.button.disabled = false; pending.button.replaceChildren(...copyLabel()); }
    pendingLinks.clear();
  };
  const renderList = more => {
    clearPendingLinks();
    list.replaceChildren(...(invites.length ? invites.map(invite => {
      const pending = signupInviteStatus(invite) === "Revocation pending";
      const usable = !invite.revokedAt && !invite.redeemedAt && Date.parse(invite.expiresAt) > Date.now();
      const copyLink = action(copyLabel(), async event => {
        if (!current() || !panel.open || !usable || pendingLinks.has(invite.id)) return;
        // A newer selection owns the clipboard. A slow earlier row must never
        // overwrite the link the operator chose most recently.
        clearPendingLinks();
        const button = event.currentTarget, version = request, attempt = { button };
        pendingLinks.set(invite.id, attempt); button.disabled = true; button.textContent = "Preparing link…";
        feedback.textContent = "Preparing invitation link…"; clearSecret();
        const stillCurrent = () => current() && panel.open && version === request && pendingLinks.get(invite.id) === attempt;
        try {
          const result = await api.signupInviteLink(invite.id);
          if (!stillCurrent()) return;
          const link = validLink(result.inviteUrl);
          if (!link) throw new Error("The invitation link could not be loaded. Refresh invitations and try again.");
          try {
            if (typeof copy !== "function" || await copy(link.url) === false) throw new Error("clipboard unavailable");
            if (stillCurrent()) feedback.textContent = `Invite link copied. Share it privately${invite.email ? ` with ${invite.email}` : "; the first verified email claims it"}.`;
          } catch {
            if (!stillCurrent()) return;
            showSecret(link.code, invite.email, link.url);
            feedback.textContent = "Could not copy automatically. Use Copy link above, or show the link and select it to copy.";
          }
        } catch (error) { if (stillCurrent()) { fail(error); feedback.textContent = error.message || "The invitation link could not be loaded. Refresh invitations and try again."; } }
        finally { if (pendingLinks.get(invite.id) === attempt) { pendingLinks.delete(invite.id); button.disabled = false; button.replaceChildren(...copyLabel()); } }
      }, { class: "small", disabled: !usable, title: usable ? "Copy this single-use invitation link" : "Only unused, unexpired invitations can be shared" });
      const revoke = action(pending ? "Retry revocation" : "Revoke code and free access", async event => {
        const button = event.currentTarget;
        if (button.dataset.confirm !== "yes") { button.dataset.confirm = "yes"; button.textContent = "Confirm revocation"; return; }
        ++request; clearPendingLinks(); button.disabled = true; feedback.textContent = ""; clearSecret();
        try {
          const result = await api.revokeSignupInvite(invite.id);
          if (!current()) return;
          invites = invites.map(item => item.id === invite.id ? result.invite : item); renderList(more);
          feedback.textContent = result.revocationPending ? "Revocation is pending. The code is revoked; free access removal is still queued. Refresh or retry to check completion." : "Invite code and its free access have been revoked.";
        } catch (error) { if (current()) { fail(error); feedback.textContent = error.message || "Revocation could not be confirmed. Refresh and try again."; button.disabled = false; } }
      }, { class: "text small" });
      return h("div", { class: "token-row signup-invite-row" }, h("div", { class: "signup-invite-info" }, h("span", {}, invite.email || "Unbound invitation"), h("small", {}, invite.email ? "Bound to this email" : "First verified email claims it"), h("small", {}, signupInviteStatus(invite)), h("small", {}, invite.redeemedAt ? `Redeemed ${date(invite.redeemedAt)}${invite.accessExpiresAt ? ` · Access ends ${date(invite.accessExpiresAt)}` : ""}` : `Unused invitation expires ${date(invite.expiresAt)}`)), h("div", { class: "signup-invite-actions" }, copyLink, (!invite.revokedAt || pending) && revoke));
    }) : [h("p", { class: "detail-note" }, "No invitations yet. Create one above to share early access.")]), ...(more ? [h("p", { class: "field-hint" }, "Showing the 100 newest invitations. Older invitations are not shown here.")] : []));
  };
  const refresh = async () => {
    const id = ++request;
    clearPendingLinks();
    list.replaceChildren(h("p", { role: "status", class: "sr-only" }, "Loading invitations…"),
      ...[0, 1, 2].map(() => h("div", { class: "ds-skeleton-row", "aria-hidden": "true" }, h("span", {}), h("span", {}), h("span", {}), h("span", {}))));
    try {
      const result = await api.signupInvites();
      if (!current() || id !== request || !panel.open) return;
      invites = result.invites || []; loaded = true; hasMore = result.more === true; renderList(hasMore);
    } catch (error) { if (current() && id === request && panel.open) { fail(error); list.replaceChildren(h("p", { class: "detail-note" }, error.message || "Invitations could not be loaded.")); } }
  };
  const form = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); if (!current() || issue.disabled) return;
    const id = ++request;
    issue.disabled = true; issue.setAttribute("aria-busy", "true"); issue.replaceChildren(icon("loader-circle", { size: 14, class: "ds-spin" }), "Creating link…"); feedback.textContent = ""; clearSecret();
    try {
      const address = email.value.trim(), result = await api.issueSignupInvite(address ? { email: address } : {});
      if (!current() || !panel.open || id !== request) return;
      if (typeof result.inviteCode !== "string" || !result.inviteCode) throw new Error("The code was not returned. Refresh the list before trying again.");
      const updated = [result.invite, ...invites.filter(item => item.id !== result.invite.id)];
      hasMore = hasMore || updated.length > 100; invites = updated.slice(0, 100); renderList(hasMore);
      showSecret(result.inviteCode, result.invite.email, result.inviteUrl); email.value = ""; feedback.textContent = result.invite.email ? "Invite created. Only the bound email can verify and claim it. The 60-day access period starts after verification." : "Single-use invitation created. The first verified email claims it and starts 60 days of unlimited knowledge transfers. Jev is separate.";
    } catch (error) { if (current() && panel.open && id === request) { fail(error); feedback.textContent = error.message || "The invite could not be created."; } }
    finally { issue.disabled = false; issue.removeAttribute("aria-busy"); issue.replaceChildren(icon("plus", { size: 14 }), "Create invite link"); }
  } }, h("label", { class: "field" }, "Bind to an email (optional)", email), h("p", { class: "field-hint" }, "Leave blank for a single-use link the first verified email can claim. Enter an email to restrict the invitation to that address."), issue);
  const panel = h("details", { class: "account-section signup-admin", ontoggle: () => {
    if (!panel.open) { clearSecret(); clearPendingLinks(); ++request; }
    else if (!loaded) refresh();
  } }, h("summary", {}, "Early access invitations"), h("div", { class: "signup-admin-content stack" },
    h("p", { class: "detail-note" }, "Operator access · Friends get 60 days of unlimited knowledge transfers in a personal workspace after email verification, with no card required. Jev has separate permission and usage costs. An unused invitation expires after seven days."), form, codeRegion, feedback,
    h("div", { class: "form-actions" }, action([icon("refresh-cw", { size: 14 }), "Refresh invitations"], () => { clearSecret(); refresh(); }, { class: "small" })), list));
  return { element: panel, clearSecrets() { ++request; clearPendingLinks(); clearSecret(); }, dispose() { active = false; ++request; clearPendingLinks(); clearSecret(); email.value = ""; } };
}
