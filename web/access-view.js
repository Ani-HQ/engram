import { h } from "./profile.js";

const DAY = 86_400_000;
const elapsedNow = () => globalThis.performance?.now?.() ?? Date.now();
export const INVITE_EXTENSION_URL = "https://x.com/anirudh_twt";
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const expiryLabel = value => `${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))} UTC`;

// Advance from the server's clock using elapsed client time. A skewed device
// clock must not decide whether a friend grant still appears active.
export function createAccessClock(access, receivedAt = elapsedNow()) {
  const origin = timestamp(access?.serverNow);
  return (clientNow = elapsedNow()) => origin === null ? null : origin + Math.max(0, clientNow - receivedAt);
}

export function friendAccessPresentation(access, { now = timestamp(access?.serverNow) } = {}) {
  const grant = access?.complimentary, expiry = timestamp(grant?.expiresAt);
  if (grant?.source !== "invite" || expiry === null) return null;
  const knownTime = Number.isFinite(now), remaining = knownTime ? expiry - now : null;
  const active = knownTime && remaining > 0 && grant.active === true && !grant.revokedAt;
  const days = active ? Math.ceil(remaining / DAY) : 0;
  return {
    state: !knownTime ? "unknown" : active ? "active" : "ended",
    label: grant.durationDays === 60 ? "60-day friend access" : "Friend access",
    headline: !knownTime ? "Check access status" : active ? remaining < DAY ? "Less than a day left" : `${days} ${days === 1 ? "day" : "days"} left` : "Friend access ended",
    days, expiresAt: grant.expiresAt, expiryLabel: expiryLabel(expiry),
    unlimited: active && grant.unlimitedKnowledgeTransfers === true,
    hasOtherAccess: access.canWrite === true && access.entitlementSource !== "complimentary",
    nextChangeMs: active ? Math.max(1000, remaining - (days - 1) * DAY) : null,
  };
}

export function friendAccessCard(access, { now, error = "", retry } = {}) {
  const view = friendAccessPresentation(access, { ...(now === undefined ? {} : { now }) });
  if (!view) return null;
  return h("section", { class: "ds-benefit ds-card", "data-tone": view.state === "active" ? "lime" : "apricot", "aria-label": "Friend access" },
    h("div", { class: "ds-stack" },
      h("div", { class: "ds-row" }, h("span", { class: "ds-badge" }, view.label), h("strong", { class: "ds-benefit-count" }, view.headline)),
      h("p", { class: "ds-benefit-description" }, view.state === "active" ? [view.unlimited ? "Unlimited knowledge transfers through " : "Access through ", h("time", { datetime: view.expiresAt }, view.expiryLabel), "."] : view.state === "unknown" ? ["Your recorded access end is ", h("time", { datetime: view.expiresAt }, view.expiryLabel), ". Refresh to check the remaining time."] : ["This invitation’s access is no longer active. Scheduled end: ", h("time", { datetime: view.expiresAt }, view.expiryLabel), ". ", view.hasOtherAccess ? "Your current plan keeps core write access available." : "Your existing memory and activity remain readable and exportable."]),
      h("p", { class: "ds-hint" }, "Core memory transfers only. Jev has separate permission and usage costs."),
      error && h("p", { class: "ds-hint", role: "status" }, "Access status could not refresh. The last recorded expiry is shown. ", retry && h("button", { type: "button", class: "text small", onclick: retry }, "Try again"))),
    h("a", { class: "ds-button small", href: INVITE_EXTENSION_URL }, "Ask for an extension"));
}
