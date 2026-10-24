import { icon } from "./icons.js";
import { h } from "./profile.js";
import { planCards } from "./account.js";

document.querySelectorAll("[data-icon]").forEach(node => node.replaceChildren(icon(node.dataset.icon, { size: 16 })));
const target = document.querySelector("#pricing-plans");
if (document.querySelector('meta[name="engram-demo"]')) document.body.prepend(h("div", { class: "demo" }, "LOCAL PREVIEW", h("span", {}, "Sample data · Payments are disabled")));
async function loadPlans() {
  try {
    const response = await fetch("/api/plans", { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error("Plans are temporarily unavailable.");
    const catalog = await response.json();
    target.replaceChildren(planCards(catalog));
  } catch {
    target.replaceChildren(h("div", { class: "public-message", role: "alert" }, "Plans could not be loaded. ", h("button", { type: "button", class: "text small", onclick: loadPlans }, "Try again")));
  }
}
if (target) loadPlans();
