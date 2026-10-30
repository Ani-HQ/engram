import { h } from "./profile.js";
import { icon } from "./icons.js";
import { billingPresentation } from "./billing-model.js";
import { jevUsageSummary } from "./jev-settings.js";
import { banner, pill } from "./design-system.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const link = (label, href, className = "text") => h("a", { href, class: className }, label);
const date = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "—";
const spinner = () => h("span", { class: "ds-spinner", "aria-hidden": "true" });
let sequence = 0;
const uid = name => `account-${name}-${++sequence}`;

/** A bordered settings card: header (title + one-line description), rows, optional footer. */
export function settingsCard({ title, description = "", side = null, tone = null, label = null }, ...body) {
  const id = uid("card");
  return h("section", { class: "ds-settings-card", "data-tone": tone, "aria-labelledby": label ? null : id, "aria-label": label },
    h("header", { class: "ds-settings-head" }, h("div", {}, h("h2", { id }, title), description && h("p", {}, description)), side), body);
}
/** Two columns: label and muted help on the left, the control on the right. */
export function settingsRow(label, help, control, { forId = null, helpId = null, className = "" } = {}) {
  return h("div", { class: ["ds-settings-row", className].filter(Boolean).join(" ") },
    h("div", { class: "ds-settings-label" }, forId ? h("label", { for: forId }, label) : h("span", {}, label), help && h("p", { class: "ds-settings-help", id: helpId }, help)),
    h("div", { class: "ds-settings-control" }, control));
}
const settingsFoot = (...children) => h("div", { class: "ds-settings-foot" }, children);
const note = (attrs = {}) => h("p", { class: "ds-settings-note form-feedback", tabindex: -1, role: "status", "aria-live": "polite", ...attrs });
const toggle = (attrs = {}) => h("input", { type: "checkbox", class: "ds-switch", role: "switch", ...attrs });

/** Skeleton settings cards shown while account data loads. */
export function settingsSkeleton(cards = 2, label = "Loading settings…") {
  return h("div", { class: "ds-settings", role: "status", "aria-live": "polite", "aria-busy": "true", "aria-label": label },
    Array.from({ length: Math.max(1, Math.min(4, cards)) }, (_, index) => h("div", { class: "ds-settings-card", "aria-hidden": "true" },
      h("div", { class: "ds-settings-head" }, h("div", { class: "account-skeleton-title" }, h("span", { class: "ds-skeleton" }), h("span", { class: "ds-skeleton" }))),
      Array.from({ length: index === 0 ? 3 : 2 }, () => h("div", { class: "ds-skeleton-row", "data-variant": "settings" }, h("span"), h("span"))))));
}


export function workspacePending(session) {
  return Boolean(session?.org && ((session.org.provisioningStatus && session.org.provisioningStatus !== "ready") || session.onboarding?.provisioning === true));
}

export function provisioningPanel({ session, checking, error, retry, signOut, switchOrg }) {
  const failed = session.org.provisioningStatus === "failed";
  const choices = (session.orgs || []).filter(org => org.id !== session.org.id);
  return h("main", { class: "auth provisioning", "aria-labelledby": "provisioning-title" },
    h("a", { class: "wordmark", href: "/" }, h("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 32, height: 32, alt: "" }), "engram"),
    h("div", { role: "status", "aria-live": "polite" }, !failed && h("span", { class: "ds-spinner", "aria-hidden": "true" }),
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


const ATTENTION = ["past_due", "unpaid", "incomplete", "incomplete_expired", "trial_expired", "canceled", "paused"];
const cloudPrice = catalog => { const price = catalog?.plans?.find(item => item.id === "cloud")?.monthlyPrice; return Number.isFinite(price) ? price : null; };

/** In-app plan cards. The plan this workspace is on gets the mint ring; prices come from the API catalog. */
function billingPlans(catalog, { hosted, trial }) {
  const plans = Array.isArray(catalog?.plans) ? catalog.plans : [];
  if (!plans.length) return null;
  return h("section", { class: "account-plans", "aria-labelledby": "account-plans-title" },
    h("div", { class: "account-subhead" }, h("h2", { id: "account-plans-title" }, "Plans"), link("Compare plans", "/pricing", "text small")),
    h("div", { class: "ds-plan-grid" }, plans.map(plan => {
      const cloud = plan.id === "cloud", current = cloud ? hosted : !hosted;
      return h("article", { class: "ds-plan-card", "data-current": current ? "true" : null, "aria-label": `${plan.name}${current ? ", current plan" : ""}` },
        h("h3", { class: "ds-plan-name" }, icon(cloud ? "cloud" : "terminal", { size: 16 }), plan.name, current && pill(cloud && trial ? "Current · trial" : "Current plan", { tone: "accent" })),
        h("p", { class: "ds-plan-description" }, plan.description),
        Number.isFinite(plan.monthlyPrice) && h("p", { class: "ds-plan-price" }, h("strong", {}, `$${plan.monthlyPrice}`), h("span", {}, cloud ? "/ workspace / month" : "/ Engram licence")),
        h("p", { class: "ds-plan-note" }, cloud ? "USD · launch pricing · taxes may apply" : "You cover your infrastructure costs."),
        h("ul", { class: "ds-plan-features" }, (plan.features || []).map(feature => h("li", {}, icon("check", { size: 14 }), feature))),
        current ? h("button", { type: "button", class: "small", disabled: true }, "Current plan")
          : cloud ? link("Explore Engram Cloud", "/hosted", "button small") : link("Self-host Engram", "/self-host", "button small"),
        h("p", { class: "ds-plan-note" }, cloud ? "Billed per workspace. Other workspaces are billed separately." : "Open source · MIT licence"));
    })));
}

export function billingPanel({ billing, catalog, jev, jevError, api, notify, fail, refresh, isCurrent = () => true }) {
  const feedback = note();
  const plan = billingPresentation(billing);
  const { hosted, complimentary } = plan;
  const needsAttention = hosted && (billing.canWrite !== true || (!complimentary && ATTENTION.includes(billing.status)) || plan.label === "Subscription needs attention");
  const trial = hosted && !complimentary && !needsAttention && ["trial", "trialing"].includes(billing.status);
  const redirect = async (button, operation) => {
    if (button.disabled || !isCurrent()) return;
    const original = [...button.childNodes];
    button.disabled = true; button.setAttribute("aria-busy", "true"); button.replaceChildren(spinner(), "Opening…"); feedback.setAttribute("role", "status"); feedback.textContent = "Opening billing…";
    try { const result = await operation(); if (isCurrent()) window.location.assign(result.url); }
    catch (error) { if (isCurrent()) { fail(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "Billing could not open. Please try again."; button.disabled = false; button.removeAttribute("aria-busy"); button.replaceChildren(...original); if ([button, document.body].includes(document.activeElement)) feedback.focus?.(); } }
  };
  const price = cloudPrice(catalog);
  const subscribe = action(price === null ? "Subscribe to Cloud" : `Subscribe to Cloud · $${price} / month`, event => redirect(event.currentTarget, () => api.checkout("cloud")), { class: "primary small", disabled: !billing.checkoutAvailable });
  const manage = action("Manage subscription", event => redirect(event.currentTarget, api.billingPortal), { class: "small", disabled: !billing.portalAvailable });
  const returnState = new URLSearchParams(location.search).get("billing");
  const status = h("span", { class: "account-status", "data-tone": needsAttention ? "danger" : "neutral" }, icon(needsAttention ? "triangle-alert" : complimentary || billing.status === "active" ? "circle-check" : hosted ? "clock" : "terminal", { size: 15 }), plan.label);
  const subscription = settingsCard({ title: "Subscription", description: plan.description },
    settingsRow("Current plan", "", h("span", { class: "ds-settings-value account-plan-title" }, plan.title)),
    settingsRow("Status", "", status),
    hosted && settingsRow(plan.dateLabel, "", h("span", { class: "ds-settings-value" }, plan.noExpiry ? "No expiry" : date(plan.dateValue))),
    plan.subscriptionLabel && settingsRow("Stripe subscription", "Complimentary access does not cancel a subscription. Manage it below.", h("span", { class: "ds-settings-value" }, `Existing Stripe subscription: ${plan.subscriptionLabel}`)),
    hosted && !billing.canWrite && h("div", { class: "ds-settings-row-full" }, h("p", { class: "ds-settings-help" }, "You can still read and export existing memory and activity, revoke access, and unpublish your profile. A subscription restores writes.")),
    hosted && !complimentary && !billing.checkoutAvailable && h("div", { class: "ds-settings-row-full" }, h("p", { class: "ds-settings-help" }, "The operator has not connected hosted billing on this installation yet.")),
    hosted ? settingsFoot(feedback, billing.portalAvailable && manage, plan.showSubscribe && subscribe) : feedback);
  return h("div", { class: "account-content ds-settings" },
    returnState === "success" && banner({ glyph: icon("circle-check", { size: 18 }), title: "Checkout returned successfully", description: "Your plan updates after payment confirmation.", action: action("Refresh plan", refresh, { class: "small" }) }),
    returnState === "canceled" && banner({ glyph: icon("info", { size: 18 }), title: "Checkout was canceled", description: "Your plan has not changed." }),
    subscription,
    complimentary ? h("p", { class: "account-footnote" }, link("Compare hosting options", "/pricing", "text small")) : billingPlans(catalog, { hosted, trial }),
    jevUsageSummary(jev, { error: jevError, refresh }),
    settingsCard({ title: "About Engram billing", description: "How revenue and boundaries work across hosted and self-hosted workspaces." },
      settingsRow("Built with open source", "As Engram earns revenue, we’ll use a portion to sponsor open-source projects.",
        h("p", { class: "ds-settings-value" }, "Engram’s memory engine is ", link("gbrain", "https://github.com/garrytan/gbrain"), " by Garry Tan. Engram uses a pinned fork and other open-source tools.")),
      settingsRow("Your space, your boundaries", "The same access and publishing controls apply on hosted and self-hosted workspaces.", h("ul", { class: "account-trust-list" },
        h("li", {}, icon("lock", { size: 14 }), "Workspace-scoped access and agent credentials."),
        h("li", {}, icon("shield-check", { size: 14 }), "Jev and embeddings/generated briefs have separate workspace permissions."),
        h("li", {}, icon("eye-off", { size: 14 }), "Your activity profile stays private until you publish it."),
        h("li", {}, link("Read how privacy works", "/privacy"))))),
  );
}

export function workspacePanel({ session, members, invites, api, saved, notify, fail, renamed = null, isCurrent = () => true }) {
  const owner = session.role === "owner";
  const policies = session.org.policies;
  const cards = [];

  // General: the workspace's name. Renaming needs an owner and an owning callback that applies the confirmed name.
  if (owner && typeof renamed === "function") {
    const nameId = uid("name"), nameNote = note();
    const name = h("input", { id: nameId, name: "workspace-name", value: session.org.name, maxlength: 100, autocomplete: "off", required: true, "aria-describedby": `${nameId}-help` });
    const cancel = action("Cancel", () => { name.value = session.org.name; nameNote.textContent = ""; sync(); }, { class: "small", disabled: true });
    const submit = h("button", { type: "submit", class: "primary small", disabled: true }, "Save changes");
    let pending = false;
    const sync = () => { const dirty = name.value.trim() !== session.org.name; submit.disabled = pending || !dirty; cancel.disabled = pending || !dirty; };
    name.addEventListener("input", () => { nameNote.textContent = ""; name.setAttribute("aria-invalid", "false"); sync(); });
    const form = h("form", { "data-settings": "general", novalidate: true, onsubmit: async event => {
      event.preventDefault(); if (pending || !isCurrent()) return;
      const value = name.value.trim();
      if (!value || value.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) { name.setAttribute("aria-invalid", "true"); nameNote.setAttribute("role", "alert"); nameNote.textContent = "Use a workspace name between 1 and 100 characters without control characters."; name.focus?.(); return; }
      if (value === session.org.name) return;
      pending = true; sync(); name.readOnly = true; submit.setAttribute("aria-busy", "true"); submit.replaceChildren(spinner(), "Saving…"); nameNote.setAttribute("role", "status"); nameNote.textContent = "";
      try { const result = await api.renameWorkspace(value); if (!isCurrent()) return; if (result?.org?.id !== session.org.id || result.org.name !== value) throw new Error("The workspace name could not be confirmed. Please try again."); notify("Settings saved"); renamed(result.org); }
      catch (error) { if (isCurrent()) { fail(error); nameNote.setAttribute("role", "alert"); nameNote.textContent = error.message || "The workspace name could not be saved. Please try again."; } }
      finally { if (isCurrent()) { pending = false; name.readOnly = false; submit.removeAttribute("aria-busy"); submit.textContent = "Save changes"; sync(); } }
    } }, settingsRow("Workspace name", "Shown in the top bar, invitations and exports.", name, { forId: nameId, helpId: `${nameId}-help` }),
      settingsRow("Workspace type", "", h("span", { class: "ds-settings-value" }, session.org.kind === "personal" ? "Personal" : "Team")),
      settingsFoot(nameNote, cancel, submit));
    cards.push(settingsCard({ title: "General", description: "Basic details for this workspace." }, form));
  } else {
    cards.push(settingsCard({ title: "General", description: "Basic details for this workspace." },
      settingsRow("Workspace name", owner ? "" : "Only an owner can rename this workspace.", h("span", { class: "ds-settings-value" }, session.org.name)),
      settingsRow("Workspace type", "", h("span", { class: "ds-settings-value" }, session.org.kind === "personal" ? "Personal" : "Team")),
      settingsRow("Your role", "", h("span", { class: "ds-settings-value" }, owner ? "Owner" : "Member"))));
  }

  // Privacy & access: two switches, saved together.
  const feedback = note();
  const writesId = uid("writes"), aiId = uid("ai");
  const ai = toggle({ id: aiId, name: "external-ai", checked: policies.externalAiProcessing === true, "aria-describedby": `${aiId}-help` });
  const writes = toggle({ id: writesId, name: "agent-writes", checked: policies.agentsMayWrite !== false, "aria-describedby": `${writesId}-help` });
  const initial = { ai: policies.externalAiProcessing === true, writes: policies.agentsMayWrite !== false };
  const save = h("button", { type: "submit", class: "primary small", "data-account-focus": "privacy-save", disabled: true }, "Save changes");
  const cancel = action("Cancel", () => { ai.checked = initial.ai; writes.checked = initial.writes; feedback.textContent = ""; sync(); }, { class: "small", disabled: true });
  let pending = false;
  const sync = () => { const dirty = ai.checked !== initial.ai || writes.checked !== initial.writes; save.disabled = pending || !dirty; cancel.disabled = pending || !dirty; };
  for (const control of [ai, writes]) control.addEventListener("change", () => { feedback.textContent = ""; sync(); });
  const settings = h("form", { "data-settings": "privacy", onsubmit: async event => {
    event.preventDefault(); if (!owner || pending || !isCurrent()) return;
    pending = true; sync(); ai.disabled = true; writes.disabled = true; settings.setAttribute("aria-busy", "true"); save.setAttribute("aria-busy", "true"); save.replaceChildren(spinner(), "Saving…"); feedback.setAttribute("role", "status"); feedback.textContent = "";
    try { const result = await api.savePolicies({ externalAiProcessing: ai.checked, agentsMayWrite: writes.checked }); if (!isCurrent()) return; feedback.textContent = "Settings saved."; saved(result.policies, { restoreFocus: [save, document.body].includes(document.activeElement), focusKey: "privacy-save" }); notify("Settings saved"); }
    catch (error) { if (isCurrent()) { fail(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "Settings could not be saved. Your changes are still here."; if ([save, document.body].includes(document.activeElement)) feedback.focus?.(); } }
    finally { if (isCurrent()) { pending = false; ai.disabled = !owner; writes.disabled = !owner; settings.setAttribute("aria-busy", "false"); save.removeAttribute("aria-busy"); save.textContent = "Save changes"; sync(); } }
  } },
    settingsRow("Allow agents to write", "Individual connection permissions also apply.", writes, { forId: writesId, helpId: `${writesId}-help` }),
    settingsRow("Allow embeddings & generated briefs", "Allows configured Voyage embeddings to process relevant memory text and queries, and OpenAI to process bounded activity context for optional generated briefs. This permission does not enable Jev. Provider keys stay on the server; provider terms and retention apply.", ai, { forId: aiId, helpId: `${aiId}-help` }),
    owner ? settingsFoot(feedback, cancel, save) : settingsFoot(h("p", { class: "ds-settings-note" }, "Only an owner can change these settings.")));
  ai.disabled = !owner; writes.disabled = !owner;
  cards.push(settingsCard({ title: "Privacy & access", description: "These settings apply to this workspace. Only an owner can change them." }, settings));

  // Members: a bordered list with the invite form below.
  const emailId = uid("invite");
  const email = h("input", { id: emailId, type: "email", inputmode: "email", name: "teammate-email", required: true, maxlength: 254, autocomplete: "email", spellcheck: "false", autocapitalize: "none", placeholder: "teammate@example.com", "aria-describedby": "workspace-invite-feedback" });
  const send = h("button", { type: "submit", class: "small" }, icon("user-plus", { size: 14 }), "Send invite");
  const inviteFeedback = h("p", { id: "workspace-invite-feedback", tabindex: -1, role: "status", "aria-live": "polite", class: "form-feedback ds-settings-help" });
  const invite = h("form", { class: "workspace-invite-form", onsubmit: async event => {
    event.preventDefault(); if (!owner || send.disabled || !isCurrent()) return;
    const original = [...send.childNodes];
    send.disabled = true; email.readOnly = true; invite.setAttribute("aria-busy", "true"); send.replaceChildren(spinner(), "Sending…"); inviteFeedback.setAttribute("role", "status"); inviteFeedback.textContent = "Creating invitation…";
    try { const result = await api.invite(email.value.trim()); if (!isCurrent()) return; email.value = ""; inviteFeedback.replaceChildren(result.url ? h("span", {}, "Invite created. ", link("Open invitation", result.url)) : "Invitation emailed. The link expires in seven days."); notify(result.url ? "Invite created" : "Invitation sent"); }
    catch (error) { if (isCurrent()) { fail(error); inviteFeedback.setAttribute("role", "alert"); inviteFeedback.textContent = error.message || "The invitation could not be created. Please try again."; if ([send, document.body].includes(document.activeElement)) inviteFeedback.focus?.(); } }
    finally { if (isCurrent()) { send.disabled = false; email.readOnly = false; invite.setAttribute("aria-busy", "false"); send.replaceChildren(...original); } }
  } }, settingsRow("Invite a teammate", "Invited people join this workspace as members.", h("div", { class: "account-invite-line" }, email, send), { forId: emailId }), h("div", { class: "ds-settings-row-full account-invite-feedback" }, inviteFeedback));
  const people = h("ul", { class: "account-members", role: "list", "aria-label": "Workspace members", tabindex: -1 }, members.map(member => h("li", { class: "account-member ds-row-hover" },
    h("span", { class: "account-member-mark", "aria-hidden": "true" }, icon("circle-user", { size: 18 })),
    h("span", { class: "account-member-email" }, member.email),
    pill(member.role === "owner" ? "Owner" : member.role === "member" ? "Member" : member.role),
    owner && member.role !== "owner" && action("Remove", async event => {
      const button = event.currentTarget; if (button.disabled || !isCurrent()) return;
      if (button.dataset.confirm !== "yes") { button.dataset.confirm = "yes"; button.textContent = "Confirm removal"; button.setAttribute("aria-label", `Confirm removal of ${member.email}`); return; }
      button.disabled = true; button.setAttribute("aria-busy", "true"); button.setAttribute("aria-label", `Removing ${member.email}…`); button.replaceChildren(spinner(), "Removing…");
      try { await api.removeMember(member.email); if (!isCurrent()) return; const row = button.closest(".account-member"), list = row.parentElement; row.remove(); if ([button, document.body].includes(document.activeElement)) (list.querySelector("button, input") || list).focus(); notify("Member removed"); }
      catch (error) { if (isCurrent()) { fail(error); notify(error.message || "Member access could not be removed. Please try again."); button.disabled = false; button.removeAttribute("aria-busy"); button.setAttribute("aria-label", `Confirm removal of ${member.email}`); button.textContent = "Confirm removal"; if (document.activeElement === document.body) button.focus(); } }
    }, { class: "small ds-button", "data-variant": "danger", "aria-label": `Remove ${member.email}` }))));
  const memberCount = `${members.length} ${members.length === 1 ? "member" : "members"}`;
  cards.push(settingsCard({ title: "Members", description: session.org.kind === "personal" ? "A personal workspace has one owner. Shared work belongs in a team workspace." : "Everyone in this workspace can read its shared memory and activity." },
    h("div", { class: "account-members-panel" }, h("div", { class: "ds-panel-head" }, h("span", {}, "Email"), h("span", { class: "account-members-role" }, "Role")), people),
    owner && session.org.kind !== "personal" && invite,
    h("div", { class: "ds-settings-foot account-members-foot" }, h("p", { class: "ds-settings-note" }, invites?.length > 0 ? `${memberCount} · ${invites.length} pending invitation${invites.length === 1 ? "" : "s"}` : memberCount))));

  // Export.
  const exportFeedback = note();
  const exportButton = action([icon("download", { size: 14 }), "Export memory & activity"], event => exportWorkspace(event.currentTarget, exportFeedback, session, api, fail, notify, isCurrent), { class: "small" });
  cards.push(settingsCard({ title: "Export data", description: "Take a copy of what you can read in this workspace." },
    settingsRow("Memory & activity", "Download the memory pages and activity you can read in this workspace. The file may contain sensitive data.", exportButton),
    settingsFoot(exportFeedback)));

  return h("div", { class: "account-content ds-settings" }, cards,
    h("p", { class: "account-footnote" }, "Public sharing is managed separately in Public profile. ", link("Privacy details", "/privacy")));
}

async function exportWorkspace(button, feedback, session, api, fail, notify, isCurrent) {
  if (button.disabled || !isCurrent()) return;
  const original = [...button.childNodes]; button.disabled = true; button.setAttribute("aria-busy", "true");
  const memories = [], actions = [], tasks = [], number = new Intl.NumberFormat();
  let tasksUnavailable = null;
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
    more = true; offset = 0;
    while (more) {
      if (!isCurrent()) return;
      pending(`Reading saved tasks… ${number.format(tasks.length)} tasks collected`);
      let page;
      // A workspace whose storage is not updated yet still exports everything else, and says so.
      try { page = await api.exportTasks({ limit: 50, offset }, session.org.id); }
      catch (error) { if (error.code === "continuation_unavailable") { tasksUnavailable = error.message; break; } throw error; }
      tasks.push(...page.tasks); more = page.more === true; offset += page.tasks.length;
      if (more && !page.tasks.length) throw new Error("The export could not finish. Please retry.");
    }
    if (!isCurrent()) return;
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), workspace: { id: session.org.id, name: session.org.name }, memories, actions, tasks, ...(tasksUnavailable ? { tasksUnavailable } : {}) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), download = h("a", { href: url, download: `engram-${session.org.slug}.json` });
    download.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); feedback.textContent = "Export downloaded."; notify("Export downloaded");
  } catch (error) { if (isCurrent()) { fail(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "Export failed. Please retry."; notify(feedback.textContent); if ([button, document.body].includes(document.activeElement)) feedback.focus?.(); } }
  finally { if (isCurrent()) { button.disabled = false; button.removeAttribute("aria-busy"); button.replaceChildren(...original); } }
}
