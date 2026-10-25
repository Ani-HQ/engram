import { icon } from "./icons.js";
import { h } from "./profile.js";
import { planCards } from "./account.js";
import { parseSignupPolicy } from "./signup-model.js";
import { jevUsd } from "./jev-settings.js";

document.querySelectorAll("[data-icon]").forEach(node => node.replaceChildren(icon(node.dataset.icon, { size: 16 })));
const target = document.querySelector("#pricing-plans");
if (document.querySelector('meta[name="engram-demo"]')) document.body.prepend(h("div", { class: "demo" }, "LOCAL PREVIEW", h("span", {}, "Sample data · Payments are disabled")));
let plansPending = false, planNotice, planNoticeText, planRetry;
async function loadPlans() {
  if (!target || plansPending) return;
  plansPending = true;
  target.setAttribute("aria-busy", "true");
  if (!planNotice) {
    planNoticeText = h("span");
    planNotice = h("div", { class: "ds-notice public-message", role: "status", "data-tone": "neutral" }, planNoticeText);
    target.replaceChildren(planNotice);
  }
  planNotice.setAttribute("role", "status");
  planNotice.setAttribute("data-tone", "neutral");
  planNoticeText.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), " Loading the current plans…");
  const retryHadFocus = planRetry && document.activeElement === planRetry;
  const canRestoreFocus = () => retryHadFocus && [planRetry, document.body].includes(document.activeElement);
  if (planRetry) { planRetry.disabled = true; planRetry.textContent = "Retrying…"; }
  try {
    const responses = await Promise.all(["/api/plans", "/api/signup-policy"].map(path => fetch(path, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10000) })));
    if (responses.some(response => !response.ok)) throw new Error("Plans are temporarily unavailable.");
    const [catalog, rawPolicy] = await Promise.all(responses.map(response => response.json()));
    const policy = parseSignupPolicy(rawPolicy), beta = catalog.mode === "hosted" && policy.mode === "invite-only";
    const price = document.querySelector("#cloud-price-faq"), access = document.querySelector("#cloud-access-faq");
    const cloud = catalog.plans.find(plan => plan.id === "cloud");
    if (price) price.textContent = beta ? "New friend invitations include 60 days of complimentary personal-workspace access after email verification, without a card. Your workspace shows the exact expiry and an extension contact. Cloud includes the core app, shared memory, activity history, and agent connections. Existing paid subscriptions keep their own billing terms." : cloud ? `Cloud is $${cloud.monthlyPrice} ${String(catalog.currency).toUpperCase()} per workspace per month. Taxes may apply. It covers hosting the core app, shared memory, activity history, and agent connections.` : "Current hosted pricing is shown in the plan catalog above.";
    if (access) access.textContent = beta ? "Open a single-use invite link, enter your email, and verify that inbox to claim it. An email-bound invitation needs its invited address. New friend invitations include 60 days of unlimited knowledge transfers after verification, without a card. Your workspace shows the exact expiry and a link to ask for an extension. Jev is separate. Unused invitations expire after seven days. Existing users can sign in as usual." : catalog.mode === "self-hosted" ? "This installation is self-hosted. Its operator controls signup. Explore Engram Cloud for current hosted availability." : "New hosted workspaces get a 14-day trial without a card. Existing data stays readable and exportable when the trial ends. A paid subscription restores writes.";
    const jev = document.querySelector("#jev-price-faq"), rate = catalog.addons?.jev;
    if (jev) jev.textContent = catalog.mode === "self-hosted" ? "Self-hosted Jev uses your own TypeSafe key. The provider bills your account directly; Engram adds no usage charge." : rate?.rateVersion && jevUsd(rate.inputPerMillionUsd) !== "Unavailable" && jevUsd(rate.outputPerMillionUsd) !== "Unavailable" ? `Current customer rates: ${jevUsd(rate.inputPerMillionUsd)} per 1M input tokens and ${jevUsd(rate.outputPerMillionUsd)} per 1M output tokens, including Engram’s markup. Enabled usage is added to the workspace’s Cloud bill. The owner reviews and accepts the current rates before enabling it.` : "Billable Jev is unavailable on this installation. When available, the workspace owner must review and accept the displayed rates before enabling it. Complimentary beta access does not authorize Jev usage charges.";
    const cards = planCards(catalog, undefined, undefined, policy);
    const restoreFocus = canRestoreFocus();
    target.replaceChildren(cards);
    if (restoreFocus) target.querySelector("a, button")?.focus({ preventScroll: true });
  } catch {
    planNotice.setAttribute("role", "alert");
    planNotice.setAttribute("data-tone", "danger");
    planNoticeText.textContent = "Plans could not be loaded. ";
    if (!planRetry) { planRetry = h("button", { type: "button", class: "text small", onclick: loadPlans }, "Try again"); planNotice.append(planRetry); }
    planRetry.disabled = false; planRetry.textContent = "Try again";
    if (canRestoreFocus()) planRetry.focus({ preventScroll: true });
  } finally {
    plansPending = false;
    target.removeAttribute("aria-busy");
  }
}
if (target) loadPlans();
