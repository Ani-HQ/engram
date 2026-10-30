import { h } from "./profile.js";
import { pill, progressBar } from "./design-system.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const decimal = value => typeof value === "string" && /^\d+(?:\.\d{1,18})?$/.test(value) ? value : null;
export function jevUsd(value) {
  const raw = decimal(value); if (raw === null) return "Unavailable";
  const [whole, fraction = ""] = raw.split("."), trimmed = fraction.replace(/0+$/, "");
  return `US$${new Intl.NumberFormat("en-US").format(BigInt(whole))}.${trimmed.padEnd(2, "0")}`;
}
const tokens = value => typeof value === "string" && /^\d+$/.test(value) ? new Intl.NumberFormat().format(BigInt(value)) : "—";
const count = value => Number.isSafeInteger(value) && value >= 0 ? new Intl.NumberFormat().format(value) : "—";
const period = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value)) : "—";
const priced = data => data?.pricing?.currency === "usd" && decimal(data.pricing.inputPerMillionUsd) !== null && decimal(data.pricing.outputPerMillionUsd) !== null && typeof data.pricing.rateVersion === "string" && data.pricing.rateVersion.length > 0;
const rateText = data => `${jevUsd(data.pricing.inputPerMillionUsd)} per 1M input tokens and ${jevUsd(data.pricing.outputPerMillionUsd)} per 1M output tokens`;

function stateLabel(data) {
  if (!data.enabled) return "Off";
  if (data.available) return "Enabled";
  return data.unavailableReason === "budget-reached" ? "Budget reached" : "Paused";
}
function explanation(data) {
  if (!data.configured) return "TypeSafe is not fully configured for this workspace. Jev will not make external calls until configuration is ready.";
  if (data.eligibility === "subscription-required") return "Billable Jev needs a paid Cloud subscription. Complimentary access does not authorize usage charges.";
  if (data.unavailableReason === "budget-reached") return "The monthly soft budget has been reached. New Jev calls stop; calls already in flight may still complete.";
  if (data.enabled) return "Jev can help with routing, ranking, and review suggestions when access, configuration, and budget allow.";
  return "Jev is optional. Core memory, keyword search, and activity remain available with it off.";
}

const card = (title, description, side, ...body) => h("section", { class: "ds-settings-card account-jev", "aria-label": title === "Jev usage" ? "Jev usage and cost" : "Optional Jev processing" },
  h("header", { class: "ds-settings-head" }, h("div", {}, h("h2", {}, title), description && h("p", {}, description)), side), body);
const row = (label, help, control, { forId = null, helpId = null, hidden = false } = {}) => {
  const node = h("div", { class: "ds-settings-row" }, h("div", { class: "ds-settings-label" }, forId ? h("label", { for: forId }, label) : h("span", {}, label), help && h("p", { class: "ds-settings-help", id: helpId }, help)), h("div", { class: "ds-settings-control" }, control));
  if (hidden) node.hidden = true;
  return node;
};
const full = (...children) => h("div", { class: "ds-settings-row-full ds-stack" }, children);
const ratio = (spent, budget) => { const used = Number(decimal(spent)), max = Number(decimal(budget)); return Number.isFinite(used) && Number.isFinite(max) && max > 0 ? { used, max } : null; };

export function jevUsageSummary(data, { error = "", refresh } = {}) {
  if (!data) return card("Jev usage", "", null, full(h("div", { class: "ds-notice", role: "status" }, "Jev details are unavailable. The workspace’s existing setting has not changed. ", refresh && action("Try again", refresh, { class: "text small" }))));
  const selfHosted = data.eligibility === "self-hosted", funded = data.eligibility === "operator-funded";
  const meter = !selfHosted && ratio(data.budget?.spentUsd, data.budget?.monthlyUsd);
  return card("Jev usage", "Optional assistance, with a separate permission and budget.", h("span", { class: "status-label account-jev-state" }, `${stateLabel(data)} · TypeSafe`),
    row("Billing", "", h("p", { class: "ds-settings-value" }, selfHosted ? "Your TypeSafe account pays the provider directly. Engram does not invoice this usage or meter provider spend here." : funded ? "Operator-funded usage. No Jev usage is added to your bill." : priced(data) ? `Jev rates: ${rateText(data)}. Enabled usage is added to your Cloud bill.` : "Billable Jev is unavailable on this installation. When available, review and accept the displayed rate before enabling it.")),
    !selfHosted && row("Current period", `${period(data.budget?.periodStartsAt)}–${period(data.budget?.periodEndsAt)} UTC`, h("div", { class: "ds-usage" },
      h("div", { class: "ds-usage-line" }, h("span", {}, h("strong", {}, jevUsd(data.budget?.spentUsd)), funded ? " provider cost tracked this month" : " settled Jev usage cost this month"), h("span", {}, `of ${jevUsd(data.budget?.monthlyUsd)} soft budget`)),
      meter && progressBar({ label: "Settled Jev spend against the monthly soft budget", value: meter.used, max: meter.max, valueText: `${jevUsd(data.budget?.spentUsd)} of ${jevUsd(data.budget?.monthlyUsd)}` }),
      h("p", { class: "ds-hint" }, `Monthly soft budget: ${jevUsd(data.budget?.monthlyUsd)}. Remaining against settled spend: ${jevUsd(data.budget?.remainingUsd)}.`))),
    !selfHosted && row("Usage", "", h("p", { class: "ds-settings-value" }, `${count(data.usage?.calls)} calls · ${tokens(data.usage?.inputTokens)} input tokens · ${tokens(data.usage?.outputTokens)} output tokens · ${count(data.usage?.pendingCalls)} pending calls.`)),
    !selfHosted && data.usage?.unknownCalls > 0 && full(h("p", { class: "ds-notice" }, `${count(data.usage.unknownCalls)} calls have unavailable usage cost. Unknown usage is excluded from customer billing.`)),
    h("div", { class: "ds-settings-foot" }, !selfHosted && h("p", { class: "ds-settings-note" }, "This is a soft stop, not a guaranteed maximum charge. Calls already in flight can complete and take the total over budget. Pending calls are not included in settled spend."), h("a", { href: "#workspace", class: "button-link small" }, "Manage Jev in Workspace settings")));
}

export function createJevSettingsPanel({ data, error = "", api, saved, fail, refresh, isCurrent = () => true }) {
  let active = true, pending = false;
  if (!data) return { element: jevUsageSummary(null, { error, refresh }), dispose() { active = false; } };
  const selfHosted = data.eligibility === "self-hosted", funded = data.eligibility === "operator-funded", billed = data.eligibility === "subscription";
  const canManage = data.canManage === true;
  const canEnable = data.configured === true && data.eligibility !== "subscription-required" && (!billed || priced(data));
  const initialBudget = decimal(data.budget?.monthlyUsd) || "0";
  const enabled = h("input", { type: "checkbox", class: "ds-switch", role: "switch", id: "jev-processing", name: "jev-processing", checked: data.enabled === true, disabled: !canManage || (!data.enabled && !canEnable), "aria-describedby": "jev-processing-help jev-data-note jev-billing-note jev-settings-feedback" });
  const budget = h("input", { type: "number", id: "jev-monthly-budget", name: "jev-monthly-budget", inputmode: "decimal", autocomplete: "off", min: selfHosted ? "0" : "0.01", max: "10000", step: "0.01", value: initialBudget, disabled: !canManage, "aria-describedby": "jev-budget-note jev-settings-feedback" });
  const acknowledgement = h("input", { type: "checkbox", name: "jev-rate-acknowledgement", "aria-describedby": "jev-settings-feedback" });
  const ack = h("label", { class: "ds-option" }, acknowledgement, h("span", {}, h("strong", {}, "Accept the displayed Jev usage rates"), h("small", {}, priced(data) ? `${rateText(data)}. These are the customer rates, including Engram’s markup, and enabled usage is added to this workspace’s Cloud bill.` : "An approved customer rate is required before billable Jev can be enabled.")));
  const ackRow = full(ack);
  const feedback = h("p", { class: "ds-settings-note form-feedback", id: "jev-settings-feedback", tabindex: -1, role: "status", "aria-live": "polite" });
  const save = h("button", { type: "submit", class: "primary small", disabled: !canManage, "data-account-focus": "jev-save" }, "Save Jev settings");
  const cancel = action("Cancel", () => { enabled.checked = data.enabled === true; budget.value = initialBudget; acknowledgement.checked = false; for (const control of [enabled, budget, acknowledgement]) control.setAttribute("aria-invalid", "false"); feedback.textContent = ""; update(); }, { class: "small", disabled: true });
  const validationError = (control, message) => { feedback.setAttribute("role", "alert"); feedback.textContent = message; control.setAttribute("aria-invalid", "true"); control.focus?.(); };
  for (const control of [enabled, budget, acknowledgement]) control.addEventListener("input", () => control.setAttribute("aria-invalid", "false"));
  const dirty = () => enabled.checked !== (data.enabled === true) || (!selfHosted && String(budget.value).trim() !== initialBudget);
  const update = () => {
    ack.hidden = ackRow.hidden = !billed || !enabled.checked;
    acknowledgement.required = billed && enabled.checked;
    acknowledgement.disabled = pending || !canManage || !enabled.checked;
    budget.min = selfHosted || !enabled.checked ? "0" : "0.01";
    save.disabled = pending || !canManage || (enabled.checked && !canEnable) || !dirty();
    cancel.disabled = pending || !dirty();
    save.textContent = pending ? "" : !enabled.checked ? data.enabled ? "Turn Jev off" : "Save Jev settings" : billed ? "Save Jev · accept usage charges" : funded ? "Save operator-funded Jev" : "Save Jev settings";
    save.setAttribute("aria-busy", String(pending));
    if (pending) save.append(h("span", { class: "ds-spinner", "aria-hidden": "true" }), h("span", {}, "Saving…"));
  };
  enabled.addEventListener("change", update);
  budget.addEventListener("input", update);
  const form = h("form", { class: "account-jev-form", onsubmit: async event => {
    event.preventDefault(); if (!active || pending || !canManage || !isCurrent()) return;
    const amount = selfHosted ? "0" : String(budget.value).trim();
    if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(amount) || Number(amount) > 10000 || (enabled.checked && !selfHosted && Number(amount) < .01)) { validationError(budget, selfHosted ? "Use a monthly budget from 0 to 10,000 USD with up to two decimal places." : "Use a monthly budget from 0 to 10,000 USD, or at least 0.01 USD when Jev is enabled."); return; }
    if (enabled.checked && (!canEnable || (billed && !acknowledgement.checked))) { validationError(billed && canEnable ? acknowledgement : enabled, billed && canEnable ? "Review and accept the displayed usage rates before enabling or saving billable Jev." : "Jev is not ready to enable. Check the configuration and access shown above."); return; }
    for (const control of [enabled, budget, acknowledgement]) control.setAttribute("aria-invalid", "false");
    pending = true; form.setAttribute("aria-busy", "true"); feedback.setAttribute("role", "status"); feedback.textContent = ""; enabled.disabled = true; budget.disabled = true; update();
    try {
      const payload = { enabled: enabled.checked, monthlyBudgetUsd: amount, ...(enabled.checked && billed ? { acceptedRateVersion: data.pricing.rateVersion } : {}) };
      const result = await api.saveJev(payload);
      if (!active || !isCurrent()) return;
      saved(result, { restoreFocus: [save, document.body].includes(document.activeElement), focusKey: "jev-save" });
    } catch (error) { if (active && isCurrent()) { fail?.(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "Jev settings could not be saved. Your changes are still here."; if ([save, document.body].includes(document.activeElement)) feedback.focus?.(); } }
    finally { pending = false; if (active && isCurrent()) { form.setAttribute("aria-busy", "false"); enabled.disabled = !canManage || (!data.enabled && !canEnable); budget.disabled = !canManage; update(); } }
  } },
    row("Allow Jev processing for this workspace", "Jev uses TypeSafe for optional routing, ranking, and review suggestions. It has its own permission; this does not enable Voyage embeddings or OpenAI briefs.", [enabled, h("p", { class: "ds-hint", id: "jev-data-note" }, "When allowed, relevant query text, bounded memory context, and activity context can be sent to TypeSafe. Provider terms and retention apply. Turning Jev off stops new calls; it cannot recall data already sent.")], { forId: "jev-processing", helpId: "jev-processing-help" }),
    row("Usage charges", "", h("p", { class: "ds-settings-value", id: "jev-billing-note" }, selfHosted ? "Your operator supplies a TypeSafe key on the server. Your provider account is billed directly; Engram adds no usage charge." : funded ? "The operator funds this workspace’s Jev usage. No usage charge is added to your bill." : priced(data) ? `Customer rates: ${rateText(data)}.` : "Billable Jev is unavailable on this installation. Enabling it requires an available rate and your explicit acceptance.")),
    selfHosted ? row("Budget", "", h("p", { class: "ds-settings-value", id: "jev-budget-note" }, "Engram does not enforce a monetary budget for self-hosted Jev. Your TypeSafe account’s limits and Engram’s configured daily call cap apply."))
      : row(funded ? "Monthly operator-funded budget in USD" : "Monthly Jev soft budget in USD", h("span", { id: "jev-budget-note" }, "New calls stop when settled monthly spend reaches this amount. In-flight calls may complete and exceed it. No amount is preselected for a new opt-in."), budget, { forId: "jev-monthly-budget" }),
    ackRow,
    h("div", { class: "ds-settings-foot" }, feedback, canManage && cancel, canManage && save));
  update();
  const element = card([ "Jev", pill("Optional") ], "A separate choice for model-assisted routing, ranking, and review.", h("span", { class: "status-label account-jev-state" }, `${stateLabel(data)} · TypeSafe · ${data.configured ? "Server configured" : "Not configured"}`),
    full(h("p", { class: "ds-hint" }, explanation(data)),
      !canManage && h("p", { class: "ds-notice" }, "Only a workspace owner signed in with email can change Jev settings."),
      data.eligibility === "subscription-required" && h("a", { href: "#billing" }, "Review your Cloud subscription"),
      selfHosted && h("p", { class: "ds-hint" }, "Configure the provider key in the server environment or Compose settings. Keys are never entered or returned in this browser."),
      h("a", { href: "#billing", class: "account-jev-usage-link" }, "View current Jev usage and cost")),
    form);
  return { element, dispose() { active = false; } };
}
