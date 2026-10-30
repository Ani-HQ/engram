import { activityRhythm, h, profileCard, profileSkeleton, updateProfileCard, updateProfileTimes } from "./profile.js";
import { watchPublicActivity } from "./live-activity.js";
import { observeLoadingMotion } from "./design-system.js";
import { icon } from "./icons.js";

const root = document.querySelector("#public-showcase");
const slug = root?.dataset.slug;
const jsonUrl = `/api/public/activity/${encodeURIComponent(slug || "")}`;
const streamUrl = `${jsonUrl}/stream`;
let watcher, loading, timeRefresh, version = 0;
let stopMotion = observeLoadingMotion(document.body);
const copyTimers = new WeakMap();
const toast = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
document.body.append(toast);

async function copyValue(button, value, label, confirmation) {
  const restore = () => button.replaceChildren(...(typeof label === "function" ? label() : [label]));
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true"); button.setAttribute("aria-disabled", "true");
  button.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Copying…");
  try {
    await navigator.clipboard.writeText(value); if (!button.isConnected) return; button.replaceChildren("Copied"); toast.textContent = confirmation;
    clearTimeout(copyTimers.get(button));
    copyTimers.set(button, setTimeout(() => { if (button.isConnected) restore(); }, 2200));
  } catch { if (button.isConnected) { restore(); toast.textContent = "Could not copy. Select and copy the URL instead."; } }
  finally { button.removeAttribute("aria-busy"); button.removeAttribute("aria-disabled"); }
}

function unavailable(reason) {
  watcher?.stop();
  clearInterval(timeRefresh);
  const unpublished = reason === "unpublished";
  root.replaceChildren(h("main", { class: "public-unavailable ds-heading-group", id: "main" },
    h("h1", {}, unpublished ? "This live view has ended." : "Couldn’t connect to activity."),
    h("p", {}, unpublished ? "The profile may have changed or been unpublished. Try again to check its current public view." : "Please try again in a moment."),
    h("div", { class: "ds-row" }, h("button", { type: "button", onclick: load }, "Try again"), h("a", { href: "/" }, "Back to engram"))));
}

function render(data) {
  document.title = `${data.profile.displayName || data.profile.slug} · engram`;
  const pageUrl = `${location.origin}/u/${encodeURIComponent(slug)}`;
  const linkLabel = () => [icon("link", { size: 16 }), "Copy link"];
  const share = h("button", { type: "button", class: "ds-button profile-share-copy", onclick: () => copyValue(share, pageUrl, linkLabel, "Profile link copied") }, linkLabel());
  const actions = data.stats?.totalActions || 0, agents = data.stats?.activeAgents || 0;
  const owner = data.profile?.displayName || `@${slug}`;
  const days = data.stats?.activeDays || 0, streak = activityRhythm(data.daily || []).current;
  const postText = `${owner} on engram: ${actions.toLocaleString("en-US")} agent actions across ${agents.toLocaleString("en-US")} ${agents === 1 ? "agent" : "agents"} in ${days.toLocaleString("en-US")} active ${days === 1 ? "day" : "days"}.${streak > 1 ? ` ${streak}-day streak.` : ""}`;
  const post = h("a", { class: "ds-button profile-share-x", "data-variant": "primary", href: `https://x.com/intent/post?text=${encodeURIComponent(postText)}&url=${encodeURIComponent(pageUrl)}`, target: "_blank", rel: "noopener noreferrer" }, icon("share-2", { size: 16 }), "Share on X");
  const streamCopy = h("button", { type: "button", class: "text small", onclick: () => copyValue(streamCopy, `${location.origin}${streamUrl}`, "Copy live API", "Live stream URL copied") }, "Copy live API");
  const label = h("span", { role: "status", "aria-live": "polite" }, "Connecting…");
  const connectionNote = h("span", {}, "Updates automatically");
  const refresh = h("button", { type: "button", class: "text small", hidden: true, onclick: load }, "Refresh activity");
  const connection = h("div", { class: "live-connection", "data-state": "connecting" }, h("span", { class: "live-connection-status" }, label), connectionNote, refresh);
  const card = profileCard(data);
  const view = [document.querySelector('meta[name="engram-demo"]') && h("div", { class: "demo" }, "Local preview", h("span", {}, "Sample public profile. No real account data.")),
    h("a", { class: "ds-button ds-skip-link", href: "#main" }, "Skip to content"),
    h("header", { class: "public-header" }, h("a", { class: "wordmark", href: "/", "aria-label": "Engram home" }, h("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 32, height: 32, alt: "" }), "engram"),
      h("a", { class: "ds-button public-header-cta", href: "/" }, "Make your own", icon("arrow-up-right", { size: 15 }))),
    h("main", { class: "public-page", id: "main", tabindex: "-1" }, connection, card,
      h("section", { class: "public-cta ds-dotgrid", "aria-label": "Make a profile like this" },
        h("img", { class: "public-cta-mark", src: "/brand/engram-mark.svg", width: 40, height: 40, alt: "" }),
        h("h2", {}, "Your agents do the work.", h("span", {}, "Show it off.")),
        h("p", {}, "Engram is a shared drive for agent context. Every connected agent adds to one history, and a profile like this is built from it."),
        h("div", { class: "public-cta-actions" }, h("a", { class: "ds-button", "data-variant": "primary", href: "/" }, "Make your own profile"), h("a", { class: "ds-button", href: "https://x.com/anirudh_twt" }, "Ask for an invite"))),
      h("div", { class: "public-links" }, h("span", {}, "For builders and bots"), streamCopy, h("a", { href: jsonUrl }, "JSON"), h("a", { href: `${jsonUrl}/card.svg`, target: "_blank", rel: "noopener" }, "Share card"))),
    h("footer", { class: "public-bottom" }, "Highlights are chosen by the profile owner. Activity uses broad labels with observed or agent-reported sources. Fresh running reports are from the last 15 minutes; times use UTC.")].filter(Boolean);
  card.querySelector(".profile-actions")?.replaceChildren(post, share);
  root.replaceChildren(...view);
  clearInterval(timeRefresh);
  timeRefresh = setInterval(() => { if (!document.hidden && card.isConnected) updateProfileTimes(card); }, 30_000);
  watcher = watchPublicActivity(streamUrl, {
    snapshot: snapshot => {
      if (snapshot.profile.slug !== slug) return;
      if (!card.isConnected) root.replaceChildren(...view);
      updateProfileCard(card, snapshot);
      document.title = `${snapshot.profile.displayName || snapshot.profile.slug} · engram`;
    },
    state: state => {
      connection.dataset.state = state;
      label.textContent = { connecting: "Connecting…", live: "Live updates connected", reconnecting: "Reconnecting…", paused: "Paused while this page is hidden", unsupported: "Live updates aren’t supported in this browser", closed: "Disconnected" }[state] || "Connecting…";
      connectionNote.textContent = state === "live" ? "Updates automatically" : "Showing the last confirmed snapshot";
      refresh.hidden = !["unsupported", "reconnecting", "closed"].includes(state);
    },
    interrupted: () => {
      document.title = "Reconnecting · engram";
      root.replaceChildren(h("main", { class: "public-unavailable ds-heading-group", id: "main" },
        h("h1", {}, "Reconnecting to activity…"), h("p", {}, "The live view will return when a fresh public snapshot is available."),
        h("div", { class: "ds-row" }, h("button", { type: "button", onclick: load }, "Try again"))));
    },
    closed: unavailable,
  });
  if (document.hidden) watcher.pause();
}

async function load() {
  const current = ++version;
  watcher?.stop(); clearInterval(timeRefresh); loading?.abort(); loading = new AbortController();
  const request = loading;
  const timeout = setTimeout(() => request.abort(), 8000);
  root.replaceChildren(h("main", { class: "public-page", id: "main" }, profileSkeleton()));
  try {
    const response = await fetch(jsonUrl, { credentials: "omit", cache: "no-store", signal: request.signal });
    if (current !== version) return;
    if (!response.ok) { unavailable(response.status === 404 ? "unpublished" : "unavailable"); return; }
    const data = await response.json();
    if (current === version) render(data);
  } catch { if (current === version) unavailable("unavailable"); }
  finally { clearTimeout(timeout); }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) watcher?.pause(); else { root?.querySelectorAll(".public-profile").forEach(card => updateProfileTimes(card)); watcher?.resume(); } });
window.addEventListener("pagehide", () => { ++version; loading?.abort(); clearInterval(timeRefresh); watcher?.pause(); stopMotion(); });
window.addEventListener("pageshow", event => { if (event.persisted) { stopMotion = observeLoadingMotion(document.body); load(); } });
if (root) load();
