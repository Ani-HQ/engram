import { icon } from "./icons.js";
import { h } from "./profile.js";
import { planCards } from "./account.js";
import { parseSignupPolicy } from "./signup-model.js";

document.querySelectorAll("[data-icon]").forEach(node => node.replaceChildren(icon(node.dataset.icon, { size: 16 })));
const target = document.querySelector("#pricing-plans");
if (document.querySelector('meta[name="engram-demo"]')) document.body.prepend(h("div", { class: "demo" }, "LOCAL PREVIEW", h("span", {}, "Sample data · Payments are disabled")));
async function loadPlans() {
  try {
    const responses = await Promise.all(["/api/plans", "/api/signup-policy"].map(path => fetch(path, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10000) })));
    if (responses.some(response => !response.ok)) throw new Error("Plans are temporarily unavailable.");
    const [catalog, rawPolicy] = await Promise.all(responses.map(response => response.json()));
    const policy = parseSignupPolicy(rawPolicy), beta = catalog.mode === "hosted" && policy.mode === "invite-only";
    target.replaceChildren(planCards(catalog, undefined, undefined, policy));
    const price = document.querySelector("#cloud-price-faq"), access = document.querySelector("#cloud-access-faq");
    if (price) price.textContent = beta ? "Invited friends get hosted Engram free until access is revoked, with no card required. Cloud includes the core app, shared memory, activity history, and agent connections. Existing paid subscriptions keep their own billing terms." : "Cloud is $19 USD per workspace per month at launch. Taxes may apply. It covers hosting the core app, shared memory, activity history, and agent connections.";
    if (access) access.textContent = beta ? "Hosted Engram is in a closed beta. Enter the email address your invite was issued for and its invite code, then open the verification email. An unused code expires after seven days. Existing users can sign in as usual." : catalog.mode === "self-hosted" ? "This installation is self-hosted. Its operator controls signup. Explore Engram Cloud for current hosted availability." : "New hosted workspaces get a 14-day trial without a card. Existing data stays readable and exportable when the trial ends. A paid subscription restores writes.";
  } catch {
    target.replaceChildren(h("div", { class: "public-message", role: "alert" }, "Plans could not be loaded. ", h("button", { type: "button", class: "text small", onclick: loadPlans }, "Try again")));
  }
}
if (target) loadPlans();
