import { h, profileCard, profileSkeleton, updateProfileCard } from "./profile.js";
import { icon } from "./icons.js";
import { watchPublicActivity } from "./live-activity.js";

const root = document.querySelector("#public-showcase");
const slug = root?.dataset.slug;
const jsonUrl = `/api/public/activity/${encodeURIComponent(slug || "")}`;
const streamUrl = `${jsonUrl}/stream`;
let watcher, loading, version = 0;
const toast = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
document.body.append(toast);

async function copyValue(button, value, label, confirmation) {
  try {
    await navigator.clipboard.writeText(value); button.replaceChildren(icon("check", { size: 15 }), "Copied"); toast.textContent = confirmation;
    setTimeout(() => { if (button.isConnected) button.replaceChildren(icon("link", { size: 15 }), label); }, 2200);
  } catch { toast.textContent = "Could not copy. Select and copy the URL instead."; }
}

function unavailable(reason) {
  watcher?.stop();
  const unpublished = reason === "unpublished";
  root.replaceChildren(h("main", { class: "public-unavailable" }, icon(unpublished ? "eye-off" : "plug", { size: 28 }),
    h("h1", {}, unpublished ? "This live view has ended." : "Couldn’t connect to activity."),
    h("p", {}, unpublished ? "The profile may have changed or been unpublished. Try again to check its current public view." : "Please try again in a moment."),
    h("button", { type: "button", onclick: load }, icon("refresh-cw", { size: 15 }), "Try again"), h("a", { href: "/" }, "Back to engram")));
}

function render(data) {
  document.title = `${data.profile.displayName} · Live agent activity · engram`;
  const share = h("button", { type: "button", class: "small", onclick: () => copyValue(share, `${location.origin}/u/${encodeURIComponent(slug)}`, "Copy link", "Profile link copied") }, icon("link", { size: 15 }), "Copy link");
  const streamCopy = h("button", { type: "button", class: "text small", onclick: () => copyValue(streamCopy, `${location.origin}${streamUrl}`, "Copy live API", "Live stream URL copied") }, icon("code", { size: 14 }), "Copy live API");
  const label = h("span", { role: "status", "aria-live": "polite" }, "Connecting…");
  const connection = h("div", { class: "live-connection", "data-state": "connecting" }, h("span", { class: "live-connection-status" }, h("span", { class: "live-dot", "aria-hidden": "true" }), label), h("span", {}, "Updates every 5s"));
  const card = profileCard(data);
  const view = [document.querySelector('meta[name="engram-demo"]') && h("div", { class: "demo" }, "LOCAL PREVIEW", h("span", {}, "Sample public profile · No real account data")),
    h("header", { class: "public-header" }, h("a", { class: "wordmark", href: "/" }, h("span", { class: "brand-mark" }, icon("activity", { size: 17 })), "engram"), share),
    h("main", { class: "public-page" }, connection, card,
      h("div", { class: "public-links" }, h("span", {}, "One history. Every agent."), streamCopy, h("a", { href: jsonUrl }, icon("code", { size: 14 }), "JSON"), h("a", { href: `${jsonUrl}/card.svg`, target: "_blank", rel: "noopener" }, icon("external-link", { size: 14 }), "Share card"))),
    h("footer", { class: "public-bottom" }, "Working now requires a running report in the last 15 minutes. External activity must be reported by an agent or integration. Times are counted in UTC.")].filter(Boolean);
  root.replaceChildren(...view);
  watcher = watchPublicActivity(streamUrl, {
    snapshot: snapshot => {
      if (snapshot.profile.slug !== slug) return;
      if (!card.isConnected) root.replaceChildren(...view);
      updateProfileCard(card, snapshot);
      document.title = `${snapshot.profile.displayName} · Live agent activity · engram`;
    },
    state: state => {
      connection.dataset.state = state;
      label.textContent = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", paused: "Paused while this page is hidden", unsupported: "Live updates aren’t supported in this browser", closed: "Disconnected" }[state] || "Connecting…";
    },
    interrupted: () => {
      document.title = "Reconnecting · engram";
      root.replaceChildren(h("main", { class: "public-unavailable" }, icon("refresh-cw", { size: 28 }),
        h("h1", {}, "Reconnecting to activity…"), h("p", {}, "The live view will return when a fresh public snapshot is available."),
        h("button", { type: "button", onclick: load }, "Try again")));
    },
    closed: unavailable,
  });
  if (document.hidden) watcher.pause();
}

async function load() {
  const current = ++version;
  watcher?.stop(); loading?.abort(); loading = new AbortController();
  const request = loading;
  const timeout = setTimeout(() => request.abort(), 8000);
  root.replaceChildren(h("main", { class: "public-page" }, profileSkeleton()));
  try {
    const response = await fetch(jsonUrl, { credentials: "omit", cache: "no-store", signal: request.signal });
    if (current !== version) return;
    if (!response.ok) { unavailable(response.status === 404 ? "unpublished" : "unavailable"); return; }
    const data = await response.json();
    if (current === version) render(data);
  } catch { if (current === version) unavailable("unavailable"); }
  finally { clearTimeout(timeout); }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) watcher?.pause(); else watcher?.resume(); });
window.addEventListener("pagehide", () => { ++version; loading?.abort(); watcher?.pause(); });
window.addEventListener("pageshow", event => { if (event.persisted) load(); });
if (root) load();
