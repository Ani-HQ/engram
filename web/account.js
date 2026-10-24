import { h } from "./profile.js";
import { icon } from "./icons.js";
import { billingPresentation } from "./billing-model.js";

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
    h("a", { class: "wordmark", href: "/" }, h("span", { class: "brand-mark" }, icon("activity", { size: 17 })), "engram"),
    h("div", { role: "status", "aria-live": "polite" }, icon(failed ? "circle-alert" : "loader-circle", { size: 22, class: failed ? "" : "spin" }),
      h("h1", { id: "provisioning-title" }, failed ? "Setup needs another try." : "Preparing your workspace."),
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
  return h("div", { class: "plan-grid" }, catalog.plans.map(plan => h("section", { class: `plan-card ${plan.id === "cloud" ? "cloud-plan" : ""}` },
    h("div", { class: "plan-label" }, icon(plan.id === "cloud" ? "cloud" : "terminal", { size: 18 }), plan.name),
    h("p", { class: "plan-description" }, plan.description),
    h("div", { class: "plan-price" }, h("strong", {}, `$${beta && plan.id === "cloud" ? 0 : plan.monthlyPrice}`), h("span", {}, plan.id === "cloud" ? beta ? "/ invited early access" : "/ workspace / month" : "/ Engram licence")),
    h("p", { class: "field-hint" }, plan.id === "cloud" ? beta ? "Closed beta · free until access is revoked" : "USD · launch pricing · taxes may apply" : "You cover your infrastructure costs."),
    h("ul", { class: "plan-features" }, plan.features.map(feature => h("li", {}, icon("check", { size: 14 }), beta && plan.id === "cloud" && feature === "Cancel any time" ? "Email-bound invitation and verification" : feature))),
    link(plan.id === "cloud" ? cloudLabel : "Self-host Engram", plan.id === "cloud" ? cloudHref : "/self-host", plan.id === "cloud" ? "button primary" : "button"),
    h("p", { class: "field-hint" }, plan.id === "cloud" ? beta ? "Invite code required. Verify your email. No card needed." : "No card needed to try it. Subscribe when you're ready." : "Open source · MIT licence"),
  )));
}

export function billingPanel({ billing, catalog, api, notify, fail, refresh }) {
  const feedback = h("p", { class: "form-feedback", role: "status" });
  const plan = billingPresentation(billing);
  const { hosted, complimentary } = plan;
  const redirect = async (button, operation) => {
    const original = button.textContent;
    button.disabled = true; button.replaceChildren(icon("loader-circle", { size: 14, class: "spin" }), "Opening…"); feedback.textContent = "";
    try { const result = await operation(); window.location.assign(result.url); }
    catch (error) { fail(error); feedback.textContent = error.message || "Please try again."; button.disabled = false; button.textContent = original; }
  };
  const subscribe = action("Subscribe to Cloud · $19 / month", event => redirect(event.currentTarget, () => api.checkout("cloud")), { class: "primary", disabled: !billing.checkoutAvailable });
  const manage = action([icon("external-link", { size: 14 }), "Manage subscription"], event => redirect(event.currentTarget, api.billingPortal), { disabled: !billing.portalAvailable });
  const returnState = new URLSearchParams(location.search).get("billing");
  return h("div", { class: "account-content" },
    returnState === "success" && h("div", { class: "notice", role: "status" }, "Checkout returned successfully. Your plan updates after payment confirmation.", action("Refresh plan", refresh, { class: "text small" })),
    returnState === "canceled" && h("div", { class: "notice", role: "status" }, "Checkout was canceled. Your plan has not changed."),
    h("section", { class: "billing-summary" }, h("div", {}, h("span", { class: "eyebrow" }, "CURRENT PLAN"), h("h2", {}, plan.title), h("p", { class: "detail-note" }, plan.description)), h("span", { class: "plan-status" }, icon("circle-check", { size: 14 }), plan.label),
      hosted && h("dl", { class: "billing-dates" }, h("dt", {}, plan.dateLabel), h("dd", {}, plan.noExpiry ? "No expiry" : date(plan.dateValue))),
      plan.subscriptionLabel && h("p", { class: "detail-note" }, `Existing Stripe subscription: ${plan.subscriptionLabel}. Complimentary access does not cancel a subscription. Manage it below.`),
      hosted && h("div", { class: "form-actions" }, plan.showSubscribe && subscribe, billing.portalAvailable && manage),
      hosted && !billing.canWrite && h("p", { class: "detail-note" }, "You can still read and export existing memory and activity, revoke access, and unpublish your profile. A subscription restores writes."),
      hosted && !complimentary && !billing.checkoutAvailable && h("p", { class: "detail-note" }, "The operator has not connected hosted billing on this installation yet."), feedback),
    complimentary ? h("p", { class: "detail-note" }, link("Compare hosting options", "/pricing", "text small")) : planCards(catalog, "/pricing", "View pricing"),
    section("Private on every plan", "Privacy protections are part of the product, including self-hosted installs.", h("div", { class: "trust-list" },
      h("p", {}, icon("shield-check", { size: 16 }), "Workspace-scoped access and agent credentials."),
      h("p", {}, icon("eye-off", { size: 16 }), "External AI processing is off unless your workspace owner enables it."),
      h("p", {}, icon("globe", { size: 16 }), "Your activity profile stays private until you publish it."), link("Read how privacy works", "/privacy"))),
  );
}

export function workspacePanel({ session, members, invites, api, saved, notify, fail }) {
  const owner = session.role === "owner";
  const feedback = h("p", { role: "status", class: "form-feedback" });
  const policies = session.org.policies;
  const ai = h("input", { type: "checkbox", name: "external-ai", checked: policies.externalAiProcessing === true });
  const writes = h("input", { type: "checkbox", name: "agent-writes", checked: policies.agentsMayWrite !== false });
  const save = h("button", { type: "submit", class: "primary small" }, "Save privacy settings");
  const settings = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); save.disabled = true; feedback.textContent = "";
    try { const result = await api.savePolicies({ externalAiProcessing: ai.checked, agentsMayWrite: writes.checked }); saved(result.policies); notify("Workspace settings saved"); }
    catch (error) { fail(error); feedback.textContent = error.message || "Please try again."; }
    finally { save.disabled = false; }
  } }, h("label", { class: "setting-toggle" }, writes, h("span", {}, h("strong", {}, "Allow agents to write"), h("small", {}, "Individual connection permissions also apply."))),
    h("label", { class: "setting-toggle" }, ai, h("span", {}, h("strong", {}, "Allow external AI processing"), h("small", {}, "Allows configured analysis, embedding, and optional brief providers to process bounded action context, relevant memory text, and queries. Provider keys stay on the server. Processing remains local when providers are unavailable."))), feedback, owner && save);
  ai.disabled = !owner; writes.disabled = !owner;
  const email = h("input", { type: "email", required: true, placeholder: "teammate@example.com", "aria-label": "Teammate email" });
  const send = h("button", { type: "submit", class: "small" }, "Invite member");
  const inviteFeedback = h("p", { role: "status", class: "detail-note" });
  const invite = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); send.disabled = true; inviteFeedback.textContent = "";
    try { const result = await api.invite(email.value.trim()); email.value = ""; inviteFeedback.replaceChildren(result.url ? h("span", {}, "Invite created. ", link("Open invitation", result.url)) : "Invitation emailed. The link expires in seven days."); }
    catch (error) { fail(error); inviteFeedback.textContent = error.message || "Please try again."; }
    finally { send.disabled = false; }
  } }, h("div", { class: "inline-form" }, email, send), inviteFeedback);
  return h("div", { class: "account-content" },
    section("Privacy & access", "These settings apply to this workspace. Only an owner can change them.", settings),
    section("People", session.org.kind === "personal" ? "A personal workspace has one owner. Shared work belongs in a team workspace." : "Everyone in this workspace can read its shared memory and activity.", h("div", {}, members.map(member => h("div", { class: "token-row" }, h("div", {}, h("span", {}, member.email), h("small", {}, member.role)), owner && member.role !== "owner" && action("Remove", async event => {
      const button = event.currentTarget;
      if (button.dataset.confirm !== "yes") { button.dataset.confirm = "yes"; button.textContent = "Confirm removal"; return; }
      button.disabled = true;
      try { await api.removeMember(member.email); button.closest(".token-row").remove(); notify("Member access removed"); }
      catch (error) { fail(error); notify(error.message); button.disabled = false; }
    }, { class: "text small" }))), owner && session.org.kind !== "personal" && invite, invites?.length > 0 && h("p", { class: "field-hint" }, `${invites.length} pending invitation${invites.length === 1 ? "" : "s"}.`))),
    section("Take a copy", "Download the memory pages and activity you can read in this workspace. The file may contain sensitive data.", action([icon("file-text", { size: 14 }), "Export memory & activity"], event => exportWorkspace(event.currentTarget, session, api, fail, notify))),
    h("p", { class: "detail-note" }, "Public sharing is managed separately in Public profile. ", link("Privacy details", "/privacy")),
  );
}

async function exportWorkspace(button, session, api, fail, notify) {
  const original = button.textContent; button.disabled = true;
  const memories = [], actions = [];
  try {
    let more = true, offset = 0;
    while (more) {
      button.textContent = `Reading memory… ${memories.length}`;
      const page = await api.pages({ limit: 100, offset }, session.org.id);
      for (const item of page.pages || []) memories.push(await api.page(item.slug, session.org.id));
      more = page.more === true; offset += (page.pages || []).length;
      if (more && !page.pages?.length) throw new Error("The export could not finish. Please retry.");
    }
    more = true; offset = 0;
    while (more) {
      button.textContent = `Reading activity… ${actions.length}`;
      const page = await api.actions({ limit: 100, offset }, session.org.id); actions.push(...page.actions);
      more = page.more === true; offset += page.actions.length;
      if (more && !page.actions.length) throw new Error("The export could not finish. Please retry.");
    }
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), workspace: { id: session.org.id, name: session.org.name }, memories, actions }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), download = h("a", { href: url, download: `engram-${session.org.slug}.json` });
    download.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify("Export downloaded");
  } catch (error) { fail(error); notify(error.message || "Export failed. Please retry."); }
  finally { button.disabled = false; button.textContent = original; }
}
