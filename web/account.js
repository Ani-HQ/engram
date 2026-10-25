import { h } from "./profile.js";
import { icon } from "./icons.js";
import { billingPresentation } from "./billing-model.js";
import { jevUsageSummary } from "./jev-settings.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const link = (label, href, className = "text") => h("a", { href, class: className }, label);
const date = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "—";
const section = (title, description, content) => h("section", { class: "account-section" }, h("div", {}, h("h2", {}, title), h("p", { class: "detail-note" }, description)), content);

export function workspacePending(session) {
  return Boolean(session?.org && ((session.org.provisioningStatus && session.org.provisioningStatus !== "ready") || session.onboarding?.provisioning === true));
}

export function provisioningPanel({ session, checking, error, retry, signOut, switchOrg }) {
  const failed = session.org.provisioningStatus === "failed";
  const choices = (session.orgs || []).filter(org => org.id !== session.org.id);
  return h("main", { class: "auth provisioning", "aria-labelledby": "provisioning-title" },
    h("a", { class: "wordmark", href: "/" }, h("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 32, height: 32, alt: "" }), "engram"),
    h("div", { role: "status", "aria-live": "polite" }, failed ? icon("circle-x", { size: 22 }) : h("span", { class: "ds-spinner", "aria-hidden": "true" }),
      h("h1", { id: "provisioning-title" }, failed ? "Setup needs another try." : "Making room for your ideas."),
      h("p", {}, failed ? "We couldn’t finish setting up this workspace. Check again in a moment." : `Your account is ready. We’re setting up ${session.org.name} so your agents have a place to work.`)),
    error && h("p", { class: "notice", role: "alert" }, error),
    h("div", { class: "form-actions" }, action(checking ? "Checking…" : "Check again", retry, { class: "small", disabled: checking }), action("Sign out", signOut, { class: "text small" })),
    !failed && h("p", { class: "field-hint" }, "This page checks for updates automatically. You can leave and return later."),
    choices.length > 0 && h("div", { class: "stack" }, h("p", { class: "detail-note" }, "Or open another workspace:"), choices.map(org => action(org.name, () => switchOrg(org.id), { class: "text small" }))),
  );
}

export function planCards(catalog, cloudHref = "/app#start", cloudLabel = "Start a 14-day trial", signupPolicy = null) {
  const beta = catalog.mode === "hosted" && signupPolicy?.mode === "invite-only";
  if (beta) { cloudHref = "/app#invite"; cloudLabel = "Have an invite?"; }
  if (catalog.mode === "self-hosted" && cloudHref === "/app#start") { cloudHref = "/hosted"; cloudLabel = "Explore Engram Cloud"; }
  return h("div", { class: "plan-grid" }, catalog.plans.map(plan => h("section", { class: `plan-card ds-card ${plan.id === "cloud" ? "cloud-plan" : ""}`, "data-tone": plan.id === "cloud" ? "lilac" : null },
    h("div", { class: "plan-label" }, icon(plan.id === "cloud" ? "cloud" : "terminal", { size: 18 }), plan.name),
    h("p", { class: "plan-description" }, plan.description),
    h("div", { class: "plan-price" }, h("strong", {}, beta && plan.id === "cloud" ? "60 days free" : `$${plan.monthlyPrice}`), h("span", {}, plan.id === "cloud" ? beta ? "with an invite" : "/ workspace / month" : "/ Engram licence")),
    h("p", { class: "field-hint" }, plan.id === "cloud" ? beta ? "Closed beta · invited access" : "USD · launch pricing · taxes may apply" : "You cover your infrastructure costs."),
    h("ul", { class: "plan-features" }, plan.features.map(feature => h("li", {}, icon("check", { size: 14 }), beta && plan.id === "cloud" && feature === "Cancel any time" ? "Single-use invitation and email verification" : feature))),
    link(plan.id === "cloud" ? cloudLabel : "Self-host Engram", plan.id === "cloud" ? cloudHref : "/self-host", plan.id === "cloud" ? "button primary" : "button"),
    h("p", { class: "field-hint" }, plan.id === "cloud" ? beta ? "Starts after email verification. No card needed. Jev is separate." : "No card needed to try it. Subscribe when you're ready." : "Open source · MIT licence"),
  )));
}

export function billingPanel({ billing, catalog, jev, jevError, api, notify, fail, refresh, isCurrent = () => true }) {
  const feedback = h("p", { class: "form-feedback", tabindex: -1, role: "status", "aria-live": "polite" });
  const plan = billingPresentation(billing);
  const { hosted, complimentary } = plan;
  const needsAttention = hosted && (billing.canWrite !== true || (!complimentary && ["past_due", "unpaid", "incomplete", "incomplete_expired", "trial_expired", "canceled", "paused"].includes(billing.status)) || plan.label === "Subscription needs attention");
  const trial = hosted && !complimentary && !needsAttention && ["trial", "trialing"].includes(billing.status);
  const redirect = async (button, operation) => {
    if (button.disabled || !isCurrent()) return;
    const original = [...button.childNodes];
    button.disabled = true; button.setAttribute("aria-busy", "true"); button.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Opening…"); feedback.setAttribute("role", "status"); feedback.textContent = "Opening billing…";
    try { const result = await operation(); if (isCurrent()) window.location.assign(result.url); }
    catch (error) { if (isCurrent()) { fail(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "Billing could not open. Please try again."; button.disabled = false; button.removeAttribute("aria-busy"); button.replaceChildren(...original); if ([button, document.body].includes(document.activeElement)) feedback.focus?.(); } }
  };
  const subscribe = action("Subscribe to Cloud · $19 / month", event => redirect(event.currentTarget, () => api.checkout("cloud")), { class: "primary", disabled: !billing.checkoutAvailable });
  const manage = action([icon("external-link", { size: 14 }), "Manage subscription"], event => redirect(event.currentTarget, api.billingPortal), { disabled: !billing.portalAvailable });
  const returnState = new URLSearchParams(location.search).get("billing");
  return h("div", { class: "account-content" },
    returnState === "success" && h("div", { class: "notice", role: "status" }, "Checkout returned successfully. Your plan updates after payment confirmation.", action("Refresh plan", refresh, { class: "text small" })),
    returnState === "canceled" && h("div", { class: "notice", role: "status" }, "Checkout was canceled. Your plan has not changed."),
    h("section", { class: "billing-summary ds-card" }, h("div", { class: "ds-heading-group" }, h("span", { class: "eyebrow ds-eyebrow" }, "CURRENT PLAN"), h("h2", {}, plan.title), h("p", { class: "detail-note" }, plan.description)), h("span", { class: "plan-status ds-badge", "data-tone": needsAttention ? "warning" : trial ? "info" : "success" }, icon(needsAttention ? "info" : trial ? "clock" : "circle-check", { size: 14 }), plan.label),
      hosted && h("dl", { class: "billing-dates" }, h("dt", {}, plan.dateLabel), h("dd", {}, plan.noExpiry ? "No expiry" : date(plan.dateValue))),
      plan.subscriptionLabel && h("p", { class: "detail-note" }, `Existing Stripe subscription: ${plan.subscriptionLabel}. Complimentary access does not cancel a subscription. Manage it below.`),
      hosted && h("div", { class: "form-actions" }, plan.showSubscribe && subscribe, billing.portalAvailable && manage),
      hosted && !billing.canWrite && h("p", { class: "detail-note" }, "You can still read and export existing memory and activity, revoke access, and unpublish your profile. A subscription restores writes."),
      hosted && !complimentary && !billing.checkoutAvailable && h("p", { class: "detail-note" }, "The operator has not connected hosted billing on this installation yet."), feedback),
    jevUsageSummary(jev, { error: jevError, refresh }),
    complimentary ? h("p", { class: "detail-note" }, link("Compare hosting options", "/pricing", "text small")) : planCards(catalog, "/pricing", "View pricing"),
    section("Built with open source", "As Engram earns revenue, we’ll use a portion to sponsor open-source projects.",
      h("p", { class: "detail-note" }, "Engram’s memory engine is ", link("gbrain", "https://github.com/garrytan/gbrain"), " by Garry Tan. Engram uses a pinned fork and other open-source tools.")),
    section("Your space, your boundaries", "The same access and publishing controls apply on hosted and self-hosted workspaces.", h("div", { class: "trust-list" },
      h("p", {}, icon("shield-check", { size: 16 }), "Workspace-scoped access and agent credentials."),
      h("p", {}, icon("eye-off", { size: 16 }), "Jev and embeddings/generated briefs have separate workspace permissions."),
      h("p", {}, icon("globe", { size: 16 }), "Your activity profile stays private until you publish it."), link("Read how privacy works", "/privacy"))),
  );
}

export function workspacePanel({ session, members, invites, api, saved, notify, fail, isCurrent = () => true }) {
  const owner = session.role === "owner";
  const feedback = h("p", { tabindex: -1, role: "status", "aria-live": "polite", class: "form-feedback" });
  const policies = session.org.policies;
  const ai = h("input", { type: "checkbox", name: "external-ai", checked: policies.externalAiProcessing === true });
  const writes = h("input", { type: "checkbox", name: "agent-writes", checked: policies.agentsMayWrite !== false });
  const save = h("button", { type: "submit", class: "primary small", "data-account-focus": "privacy-save" }, "Save privacy settings");
  const settings = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); if (!owner || save.disabled || !isCurrent()) return;
    save.disabled = true; ai.disabled = true; writes.disabled = true; settings.setAttribute("aria-busy", "true"); save.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Saving…"); feedback.setAttribute("role", "status"); feedback.textContent = "Saving privacy settings…";
    try { const result = await api.savePolicies({ externalAiProcessing: ai.checked, agentsMayWrite: writes.checked }); if (!isCurrent()) return; feedback.textContent = "Privacy settings saved."; saved(result.policies, { restoreFocus: [save, document.body].includes(document.activeElement), focusKey: "privacy-save" }); notify("Workspace settings saved"); }
    catch (error) { if (isCurrent()) { fail(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "Privacy settings could not be saved. Please try again."; if ([save, document.body].includes(document.activeElement)) feedback.focus?.(); } }
    finally { if (isCurrent()) { save.disabled = false; ai.disabled = !owner; writes.disabled = !owner; settings.setAttribute("aria-busy", "false"); save.textContent = "Save privacy settings"; } }
  } }, h("label", { class: "ds-option" }, writes, h("span", {}, h("strong", {}, "Allow agents to write"), h("small", {}, "Individual connection permissions also apply."))),
    h("label", { class: "ds-option" }, ai, h("span", {}, h("strong", {}, "Allow embeddings & generated briefs"), h("small", {}, "Allows configured Voyage embeddings to process relevant memory text and queries, and OpenAI to process bounded activity context for optional generated briefs. This permission does not enable Jev. Provider keys stay on the server; provider terms and retention apply."))), feedback, owner && save);
  ai.disabled = !owner; writes.disabled = !owner;
  const email = h("input", { type: "email", inputmode: "email", name: "teammate-email", required: true, maxlength: 254, autocomplete: "email", spellcheck: "false", autocapitalize: "none", placeholder: "teammate@example.com", "aria-describedby": "workspace-invite-feedback" });
  const send = h("button", { type: "submit", class: "small" }, "Invite member");
  const inviteFeedback = h("p", { id: "workspace-invite-feedback", tabindex: -1, role: "status", "aria-live": "polite", class: "form-feedback detail-note" });
  const invite = h("form", { class: "stack workspace-invite-form", onsubmit: async event => {
    event.preventDefault(); if (!owner || send.disabled || !isCurrent()) return;
    send.disabled = true; email.readOnly = true; invite.setAttribute("aria-busy", "true"); send.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Inviting…"); inviteFeedback.setAttribute("role", "status"); inviteFeedback.textContent = "Creating invitation…";
    try { const result = await api.invite(email.value.trim()); if (!isCurrent()) return; email.value = ""; inviteFeedback.replaceChildren(result.url ? h("span", {}, "Invite created. ", link("Open invitation", result.url)) : "Invitation emailed. The link expires in seven days."); }
    catch (error) { if (isCurrent()) { fail(error); inviteFeedback.setAttribute("role", "alert"); inviteFeedback.textContent = error.message || "The invitation could not be created. Please try again."; if ([send, document.body].includes(document.activeElement)) inviteFeedback.focus?.(); } }
    finally { if (isCurrent()) { send.disabled = false; email.readOnly = false; invite.setAttribute("aria-busy", "false"); send.textContent = "Invite member"; } }
  } }, h("div", { class: "inline-form" }, h("label", { class: "field" }, "Teammate email", email), send), inviteFeedback);
  return h("div", { class: "account-content" },
    section("Privacy & access", "These settings apply to this workspace. Only an owner can change them.", settings),
    section("People", session.org.kind === "personal" ? "A personal workspace has one owner. Shared work belongs in a team workspace." : "Everyone in this workspace can read its shared memory and activity.", h("div", { class: "workspace-people", role: "group", "aria-label": "Workspace members", tabindex: -1 }, members.map(member => h("div", { class: "token-row" }, h("div", {}, h("span", {}, member.email), h("small", {}, member.role)), owner && member.role !== "owner" && action("Remove", async event => {
      const button = event.currentTarget; if (button.disabled || !isCurrent()) return;
      if (button.dataset.confirm !== "yes") { button.dataset.confirm = "yes"; button.textContent = "Confirm removal"; button.setAttribute("aria-label", `Confirm removal of ${member.email}`); return; }
      button.disabled = true; button.setAttribute("aria-busy", "true"); button.setAttribute("aria-label", `Removing ${member.email}…`); button.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Removing…");
      try { await api.removeMember(member.email); if (!isCurrent()) return; const row = button.closest(".token-row"), people = row.parentElement; row.remove(); if ([button, document.body].includes(document.activeElement)) (people.querySelector("button, input") || people).focus(); notify("Member access removed"); }
      catch (error) { if (isCurrent()) { fail(error); notify(error.message || "Member access could not be removed. Please try again."); button.disabled = false; button.removeAttribute("aria-busy"); button.setAttribute("aria-label", `Confirm removal of ${member.email}`); button.textContent = "Confirm removal"; if (document.activeElement === document.body) button.focus(); } }
    }, { class: "text small", "aria-label": `Remove ${member.email}` }))), owner && session.org.kind !== "personal" && invite, invites?.length > 0 && h("p", { class: "field-hint" }, `${invites.length} pending invitation${invites.length === 1 ? "" : "s"}.`))),
    section("Take a copy", "Download the memory pages and activity you can read in this workspace. The file may contain sensitive data.", exportControl(session, api, fail, notify, isCurrent)),
    h("p", { class: "detail-note" }, "Public sharing is managed separately in Public profile. ", link("Privacy details", "/privacy")),
  );
}

function exportControl(session, api, fail, notify, isCurrent) {
  const feedback = h("p", { class: "form-feedback", tabindex: -1, role: "status", "aria-live": "polite" });
  return h("div", { class: "stack" }, action([icon("file-text", { size: 14 }), "Export memory & activity"], event => exportWorkspace(event.currentTarget, feedback, session, api, fail, notify, isCurrent)), feedback);
}

async function exportWorkspace(button, feedback, session, api, fail, notify, isCurrent) {
  if (button.disabled || !isCurrent()) return;
  const original = [...button.childNodes]; button.disabled = true; button.setAttribute("aria-busy", "true");
  const memories = [], actions = [], number = new Intl.NumberFormat();
  const pending = message => { button.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), message); feedback.textContent = message; };
  feedback.setAttribute("role", "status");
  try {
    let more = true, offset = 0;
    while (more) {
      if (!isCurrent()) return;
      pending(`Reading memory… ${number.format(memories.length)} pages collected`);
      const page = await api.pages({ limit: 100, offset }, session.org.id);
      for (const item of page.pages || []) {
        if (!isCurrent()) return;
        memories.push(await api.page(item.slug, session.org.id));
      }
      more = page.more === true; offset += (page.pages || []).length;
      if (more && !page.pages?.length) throw new Error("The export could not finish. Please retry.");
    }
    more = true; offset = 0;
    while (more) {
      if (!isCurrent()) return;
      pending(`Reading activity… ${number.format(actions.length)} actions collected`);
      const page = await api.actions({ limit: 100, offset }, session.org.id); actions.push(...page.actions);
      more = page.more === true; offset += page.actions.length;
      if (more && !page.actions.length) throw new Error("The export could not finish. Please retry.");
    }
    if (!isCurrent()) return;
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), workspace: { id: session.org.id, name: session.org.name }, memories, actions }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), download = h("a", { href: url, download: `engram-${session.org.slug}.json` });
    download.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); feedback.textContent = "Export downloaded."; notify("Export downloaded");
  } catch (error) { if (isCurrent()) { fail(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "Export failed. Please retry."; notify(feedback.textContent); if ([button, document.body].includes(document.activeElement)) feedback.focus?.(); } }
  finally { if (isCurrent()) { button.disabled = false; button.removeAttribute("aria-busy"); button.replaceChildren(...original); } }
}
