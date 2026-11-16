import { agentVisual, providerVisual, visualIcon } from "./tooling.js";
import { formatCount, identityMark, markStack, profileAvatar, slidingIndicator, statHero, statusText, updateStatHero } from "./design-system.js";
import { icon } from "./icons.js";
import { statusLabel } from "./status-label.js";

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  children.flat(Infinity).forEach(child => { if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child))); });
  return node;
}
const number = value => new Intl.NumberFormat().format(value || 0);
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const dayLabel = date => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
// Derived only from the public 12-week daily counts (UTC days). Today may still
// be in progress, so a streak that ended yesterday is still current.
export function activityRhythm(daily = []) {
  let longest = 0, run = 0, best = null;
  for (const day of daily) {
    run = day.count > 0 ? run + 1 : 0; longest = Math.max(longest, run);
    if (day.count > 0 && (!best || day.count > best.count)) best = day;
  }
  let current = 0, index = daily.length - 1;
  if (index >= 0 && !(daily[index].count > 0)) index--;
  while (index >= 0 && daily[index].count > 0) { current++; index--; }
  return { current, longest, best };
}
const dayCount = value => `${number(value)} ${value === 1 ? "day" : "days"}`;
const metricUnits = { actions: ["action", "actions"], tokens: ["token", "tokens"] };
const unitCount = (value, metric = "actions", format = "exact") => `${metric === "tokens" ? formatCount(value, format) : number(value)} ${metricUnits[metric][value === 1 ? 0 : 1]}`;
function rhythmFacts(daily, metric = "actions") {
  const { current, longest, best } = activityRhythm(daily);
  return [
    ["current", "flame", "Current streak", dayCount(current), current > 0],
    ["longest", "zap", "Longest streak", dayCount(longest), false],
    ["best", "trophy", best ? `Best day · ${dayLabel(best.date)}` : "Best day", best ? unitCount(best.count, metric, "compact") : "None yet", false],
  ];
}
function updateRhythm(section, daily, metric = "actions") {
  for (const [key, , label, value, hot] of rhythmFacts(daily, metric)) {
    const fact = section.querySelector(`[data-rhythm="${key}"]`);
    if (!fact) continue;
    setText(fact.querySelector(".profile-rhythm-value"), value);
    setText(fact.querySelector(".profile-rhythm-label"), label);
    fact.dataset.hot = String(hot);
  }
}
const categories = { code: ["Code"], files: ["Files"], email: ["Email"], calendar: ["Calendar"], cloud: ["Cloud"], browser: ["Browser"], data: ["Data"], memory: ["Memory"], other: ["Other tools"] };

// Square-root scaling keeps ordinary days visible next to one very busy day.
const cellLevel = (count, maximum) => count > 0 ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count / maximum) * 4))) : 0;
const cellLabel = (day, metric) => `${unitCount(day.count, metric)} on ${new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`))}`;
const chartCaption = (daily, metric) => `${unitCount(daily.reduce((sum, day) => sum + day.count, 0), metric, "compact")} in the last 12 weeks`;
// metric switches the same grid between agent actions and reported tokens.
// onMetric renders the toggle only when token counts are available.
export function contributionGrid(daily = [], { headingTag = "h3", metric = "actions", onMetric = null } = {}) {
  const maximum = Math.max(1, ...daily.map(day => day.count));
  const live = h("span", { class: "contribution-caption", "aria-live": "polite" }, chartCaption(daily, metric));
  const cells = daily.map((day, index) => {
    const label = cellLabel(day, metric);
    const showDay = event => {
      cells.forEach(cell => { cell.tabIndex = cell === event.currentTarget ? 0 : -1; });
      grid.dataset.selectedDate = day.date;
      live.textContent = event.currentTarget.getAttribute("aria-label");
    };
    return h("button", { type: "button", class: `contribution-cell level-${cellLevel(day.count, maximum)}`, "data-date": day.date, tabindex: index === daily.length - 1 ? "0" : "-1", title: label, "aria-label": label, onclick: showDay, onfocus: showDay });
  });
  const grid = h("div", { class: "contribution-grid", role: "group", "aria-label": `Daily ${metric === "tokens" ? "token usage" : "activity"} for the last 12 weeks. Use arrow keys to explore.`, onkeydown: event => {
    const current = cells.indexOf(document.activeElement);
    const offset = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (current < 0 || (offset === undefined && !["Home", "End"].includes(event.key))) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? cells.length - 1 : Math.min(cells.length - 1, Math.max(0, current + offset));
    cells[current].tabIndex = -1; cells[next].tabIndex = 0; cells[next].focus();
  } }, cells);
  const firstWeekday = daily[0] ? new Date(`${daily[0].date}T12:00:00Z`).getUTCDay() : 0;
  const weekLabels = Array.from({ length: 7 }, (_, index) => {
    const day = (firstWeekday + index) % 7;
    return h("span", {}, [1, 3, 5].includes(day) ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day] : "");
  });
  const months = Array.from({ length: Math.ceil(daily.length / 7) }, (_, index) => {
    const date = daily[index * 7]?.date;
    const previous = daily[(index - 1) * 7]?.date;
    return h("span", {}, date && (index === 0 || date.slice(0, 7) !== previous?.slice(0, 7)) ? new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)) : "");
  });
  const toggle = onMetric && h("div", { class: "ds-segmented profile-rhythm-metric", role: "group", "aria-label": "Chart shows" }, [["actions", "Actions"], ["tokens", "Tokens"]].map(([value, text]) =>
    h("button", { type: "button", "data-metric": value, "aria-pressed": String(metric === value), onclick: () => { if (metric !== value) onMetric(value); } }, text)));
  const section = h("section", { class: "contributions", "data-metric": metric, "data-metrics": String(Boolean(onMetric)) },
    h("div", { class: "profile-section-heading" }, h(headingTag, {}, "Shipping rhythm"), toggle || h("span", {}, "Last 12 weeks")),
    h("ul", { class: "profile-rhythm", role: "list", "aria-label": "Streaks in the last 12 weeks, UTC days" }, rhythmFacts(daily, metric).map(([key, glyph, label, value, hot]) =>
      h("li", { class: "profile-rhythm-fact", "data-rhythm": key, "data-hot": String(hot) }, h("span", { class: "profile-rhythm-icon", "aria-hidden": "true" }, icon(glyph, { size: 16 })),
        h("span", { class: "profile-rhythm-copy" }, h("strong", { class: "profile-rhythm-value" }, value), h("span", { class: "profile-rhythm-label" }, label))))),
    h("div", { class: "contribution-viewport", role: "region", "aria-label": "Daily activity chart. Tap a day or use arrow keys to explore dates." },
      h("div", { class: "contribution-chart" },
        h("div", { class: "contribution-months", "aria-hidden": "true" }, months),
        h("div", { class: "contribution-layout" }, h("div", { class: "contribution-weekdays", "aria-hidden": "true" }, weekLabels), grid))),
    h("p", { class: "contribution-explore" }, "Tap a day or use arrow keys to explore dates."),
    h("div", { class: "contribution-footer" }, live, h("div", { class: "contribution-legend", "aria-hidden": "true" }, h("span", {}, "Less"), [0, 1, 2, 3, 4].map(level => h("span", { class: `contribution-cell level-${level}` })), h("span", {}, "More"))));
  if (toggle) slidingIndicator(toggle, { variant: "pill", key: "profile-rhythm-metric" });
  return section;
}

const eventStates = {
  running: ["In progress", "neutral"], completed: ["Completed", "neutral"],
  failed: ["Needs attention", "danger"], stale: ["Update overdue", "neutral"],
};
const eventSignatures = new WeakMap();
const profileClocks = new WeakMap();
const profilePhotoSources = new WeakMap();
function updateProfilePhoto(card, profile) {
  const source = Object.hasOwn(profile, "photo") ? profile.photo ?? "" : profile.photoUrl ?? "";
  const slot = card.querySelector(".profile-identity-photo");
  const label = profile.displayName ? `${profile.displayName}'s avatar` : "Profile avatar";
  if (profilePhotoSources.get(card) !== source || !slot.children.length) {
    slot.replaceChildren(profileAvatar({ src: source, label, size: card.classList.contains("compact") ? "md" : "lg" }));
    profilePhotoSources.set(card, source);
  } else slot.children[0].setAttribute("aria-label", label);
}
const eventTiming = data => ({ now: Date.parse(data.live?.checkedAt) || Date.now(), freshness: Math.max(0, Number(data.live?.freshnessSeconds) || 900) * 1000 });
const eventEvidence = event => event.evidence === "observed" ? "Observed by Engram" : "Agent-reported activity; external work is not independently verified.";
function eventMark(event, className) {
  const agent = agentVisual("", { harness: event.agent?.product || "other", publicSafe: true });
  return h("span", { class: className, role: "img", "aria-label": agent.label, title: agent.label }, visualIcon(agent, { size: 24 }));
}
function updateEventMotion(row, event, timing) {
  const text = row.querySelector(".ds-status-text");
  if (!text) return;
  const updated = Date.parse(event.updatedAt), expires = updated + timing.freshness;
  text.setAttribute("data-active", String(event.status === "running" && Number.isFinite(updated) && updated <= timing.now && timing.now < expires));
  if (event.status === "running" && Number.isFinite(expires)) text.setAttribute("data-active-until", String(expires));
  else text.removeAttribute("data-active-until");
}
const privacyText = (enabled, hasHighlights = false) => enabled
  ? "Public activity. Private details left out."
  : hasHighlights ? "Activity streaming is off. Highlights are chosen by the owner; activity is shared as aggregate counts."
    : "Activity streaming is off. This profile shares aggregate activity counts.";
const exactTime = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC" : "Time unavailable";
};
function relativeTime(value, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(age)) return "Time unavailable";
  if (age < 60_000) return "Just now";
  const [duration, unit] = age < 3_600_000 ? [60_000, "minute"] : age < 86_400_000 ? [3_600_000, "hour"] : [86_400_000, "day"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-Math.floor(age / duration), unit);
}
function publicEvent(event) {
  const service = providerVisual(event.service);
  const [label, tone] = eventStates[event.status] || eventStates.stale;
  return h("li", { class: "public-event", "data-public-event": event.id, "data-event-status": event.status, title: eventEvidence(event), "aria-description": eventEvidence(event) },
    eventMark(event, "public-event-mark"),
    h("div", { class: "public-event-content" },
      h("div", { class: "public-event-heading" }, h("h3", {}, statusText(event.action || "Agent activity")), statusLabel(label, { tone })),
      h("div", { class: "public-event-meta" }, h("span", { class: "public-event-service", title: `Service: ${service.label}` }, service.label),
        h("time", { datetime: event.updatedAt, title: exactTime(event.updatedAt), "data-public-time": event.updatedAt }, relativeTime(event.updatedAt)))));
}
function streamEvents(activity) {
  if (activity?.enabled !== true || !Array.isArray(activity.events)) return [];
  const seen = new Set();
  return activity.events.filter(event => event && typeof event.id === "string" && !seen.has(event.id) && seen.add(event.id)).slice(0, 20);
}
function activityStream(activity, { headingTag = "h2" } = {}) {
  const section = h("section", { class: "public-stream", "aria-label": "Public activity stream" },
    h("div", { class: "profile-section-heading public-stream-heading" }, h(headingTag, {}, "The live thread."), h("span", {}, "Safe labels only")),
    h("p", { class: "public-stream-intro" }, "Which agents are working, and the kind of work they share."),
    h("p", { class: "public-stream-state" }),
    h("section", { class: "public-stream-active", "aria-label": "Work in progress" }, h("p", { class: "public-stream-label" }, "In progress"), h("ol", { class: "public-event-list", role: "list", "data-public-events": "running" })),
    h("section", { class: "public-stream-recent", "aria-label": "Recent activity" }, h("p", { class: "public-stream-label" }, "Recent activity"), h("ol", { class: "public-event-list", role: "list", "data-public-events": "recent" })));
  updateActivityStream(section, activity);
  return section;
}
function updateActivityStream(section, activity, timing = { now: Date.now(), freshness: 900_000 }) {
  if (!section) return;
  const enabled = activity?.enabled === true, events = streamEvents(activity);
  section.dataset.enabled = String(enabled);
  const state = section.querySelector(".public-stream-state");
  state.hidden = enabled && events.length > 0;
  const stateText = !enabled ? "Activity streaming is off for this profile. Aggregate counts remain visible." : "A quiet moment. New activity will appear when an agent reports work or uses Engram.";
  if (state.textContent !== stateText) state.textContent = stateText;
  const rows = new Map([...section.querySelectorAll("[data-public-event]")].map(row => [row.dataset.publicEvent, row]));
  for (const group of ["running", "recent"]) {
    const list = section.querySelector(`[data-public-events="${group}"]`);
    const selected = events.filter(event => (event.status === "running") === (group === "running"));
    list.parentElement.hidden = !selected.length;
    selected.forEach((event, index) => {
      const signature = JSON.stringify([event.agent?.product, event.agent?.label, event.service, event.action, event.status, event.evidence, event.updatedAt]);
      let row = rows.get(event.id);
      if (!row) row = publicEvent(event);
      else if (eventSignatures.get(row) !== signature) {
        const replacement = publicEvent(event);
        row.replaceChildren(...replacement.childNodes);
        row.dataset.eventStatus = event.status;
      }
      row.setAttribute("title", eventEvidence(event)); row.setAttribute("aria-description", eventEvidence(event));
      updateEventMotion(row, event, timing);
      eventSignatures.set(row, signature);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      rows.delete(event.id);
    });
  }
  for (const row of rows.values()) row.remove();
}
export function updateProfileTimes(card, now = Date.now()) {
  card.querySelectorAll("[data-public-time]").forEach(node => {
    const relative = relativeTime(node.dataset.publicTime, now);
    const label = node.closest(".profile-presence") ? relative.toLowerCase() : relative;
    if (node.textContent !== label) node.textContent = label;
  });
  const clock = profileClocks.get(card);
  const freshnessNow = clock ? clock.serverNow + Math.max(0, now - clock.receivedAt) : now;
  card.querySelectorAll("[data-active-until]").forEach(node => {
    if (freshnessNow >= Number(node.getAttribute("data-active-until"))) node.setAttribute("data-active", "false");
  });
}

export function profileCard(data, { compact = false } = {}) {
  const { profile, tools = [] } = data;
  const headingTag = compact ? "h3" : "h2";
  const card = h("article", { class: `public-profile${compact ? " compact" : ""}`, "data-tools": JSON.stringify(tools) },
    h("header", { class: `profile-identity ds-heading-group${compact ? "" : " ds-dotgrid"}` },
      h("div", { class: "profile-identity-top" }, h("div", { class: "profile-identity-photo" }),
        h("div", { class: "profile-identity-copy ds-heading-group" },
          h(compact ? "h2" : "h1", {}, profile.displayName || "Your public profile"),
          h("div", { class: "profile-handle" }, h("span", { class: "profile-slug" }), h("span", { class: "profile-presence", "data-state": "quiet" })))),
      h("p", {}, profile.bio || "A small window into the work across my agents."),
      h("div", { class: "profile-crew", hidden: true }, h("span", { class: "profile-crew-label" }, "Recently building with"), h("span", { class: "profile-crew-marks" })),
      h("div", { class: "profile-actions" })),
    h("div", { class: "profile-main" },
      profileFlex(data),
      h("section", { class: "profile-desk", "aria-label": "The public desk" },
        h("div", { class: "profile-section-heading" }, h(headingTag, {}, "Right now"), h("span", {}, "Last 15 minutes")),
        liveActivity(data.live, { headingTag }),
        h("div", { class: "profile-desk-state" }),
        h("ol", { class: "profile-stage-list", role: "list", "aria-label": "Fresh running actions" })),
      h("section", { class: "profile-overview", "aria-label": "Activity overview" }, chartFor(null, data, headingTag)),
      h("section", { class: "profile-highlights", "aria-label": "Owner-selected highlights" },
        h("div", { class: "profile-section-heading" }, h(headingTag, { tabindex: "-1" }, "Pinned work"), h("span", {}, "Chosen by the owner")),
        h("div", { class: "profile-highlight-list" }),
        h("div", { class: "profile-highlight-empty" }, h("strong", {}, "Nothing pinned here yet."), h("p", {}, "This space is ready for the notes and links the owner chooses to share."))),
      categorySummary(tools, headingTag),
      tokenSummary(data, headingTag),
      agentRoster(data.agents, headingTag)),
    h("details", { class: "profile-receipts" }, h("summary", {}, h("span", { class: "profile-summary-title" }, "Recent activity"), h("span", { class: "profile-receipt-count" })), activityStream(data.activity, { headingTag })),
    h("details", { class: "profile-history" }, h("summary", {}, h("span", { class: "profile-summary-title" }, "Every tool category"), h("span", {}, "All time")), profileTools(tools, headingTag)),
    h("footer", { class: "profile-footnote" }, h("p", {}, privacyText(data.activity?.enabled === true, profileHighlights(profile).length > 0))));
  const checkedAt = Date.parse(data.live?.checkedAt);
  if (Number.isFinite(checkedAt)) profileClocks.set(card, { serverNow: checkedAt, receivedAt: Date.now() });
  cardData.set(card, data);
  updateProfilePhoto(card, profile);
  updateActivityStream(card.querySelector(".public-stream"), data.activity, eventTiming(data));
  updatePresentation(card, data);
  updateIdentityExtras(card, data);
  return card;
}

// Token counts: present only when the owner shares them and the server sends
// them. Older servers omit the field, so every token surface stays hidden.
const cardData = new WeakMap();
export function publicTokens(data) {
  const tokens = data?.tokens;
  return tokens && typeof tokens === "object" && tokens.enabled === true ? tokens : null;
}
const count = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
const completedTasks = stats => Number.isFinite(stats?.completedTasks) && stats.completedTasks >= 0 ? stats.completedTasks : null;
const plural = (value, one, many) => value === 1 ? one : many;
// lastHour is the current plus the previous UTC clock hour, so the copy says
// "past 2 hours": every counted token falls inside that window.
const RECENT_WINDOW = "past 2 hours";
function tokenSublabel(tokens) {
  const recent = count(tokens.lastHour), today = count(tokens.today), parts = [];
  if (recent) parts.push(h("strong", {}, `+${formatCount(recent, "compact")}`), ` in the ${RECENT_WINDOW}`);
  if (today) parts.push(recent ? " · " : "", `${formatCount(today, "compact")} today`);
  return parts.length ? parts.filter(Boolean).map(part => part instanceof Node ? part : document.createTextNode(part)) : "";
}
function tokenLive(data, tokens) {
  const working = count(data.live?.workingAgents);
  if (working) return { active: true, text: `${number(working)} working now`, title: "Agents with a fresh running report" };
  if (tokens && count(tokens.lastHour)) return { active: true, text: "Live", title: "Tokens were reported in the current or previous UTC hour" };
  return { active: false, text: "" };
}
const flexStats = [
  ["completedTasks", stats => completedTasks(stats), value => plural(value, "Task completed", "Tasks completed")],
  ["totalActions", stats => count(stats?.totalActions), value => plural(value, "Agent action", "Agent actions")],
  ["activeAgents", stats => count(stats?.activeAgents), value => plural(value, "Agent", "Agents")],
  ["activeDays", stats => count(stats?.activeDays), value => plural(value, "Active day", "Active days")],
];
// The flex band: the token total is the hero, with the all-time counts beside it.
function profileFlex(data) {
  const tokens = publicTokens(data);
  const hero = statHero({ label: "Tokens burned", value: tokens ? count(tokens.total) : 0, format: "exact", unit: "tokens", emphasis: "primary", live: tokenLive(data, tokens), sublabel: tokens ? tokenSublabel(tokens) : "", className: "profile-flex-hero" });
  const list = h("div", { class: "profile-flex-stats", role: "list", "aria-label": "All-time activity totals" }, flexStats.map(([key, read, label]) => {
    const value = read(data.stats);
    const stat = statHero({ label: label(value ?? 0), value: value ?? 0, format: "compact", className: "profile-flex-stat" });
    stat.setAttribute("role", "listitem"); stat.setAttribute("data-public-stat", key); stat.hidden = value === null;
    return stat;
  }));
  hero.hidden = !tokens;
  return h("section", { class: "profile-flex", "aria-label": "Agent totals", "data-tokens": String(Boolean(tokens)) }, hero, list);
}
function updateFlex(section, data) {
  if (!section) return;
  const tokens = publicTokens(data), hero = section.querySelector(".profile-flex-hero");
  section.dataset.tokens = String(Boolean(tokens));
  const wasHidden = hero.hidden;
  hero.hidden = !tokens;
  // A hero that just appeared starts at its real value; it never counts up from a placeholder.
  updateStatHero(hero, { value: tokens ? count(tokens.total) : 0, sublabel: tokens ? tokenSublabel(tokens) : "", live: tokenLive(data, tokens), animate: !wasHidden });
  for (const [key, read, label] of flexStats) {
    const stat = section.querySelector(`[data-public-stat="${key}"]`); if (!stat) continue;
    const value = read(data.stats), appeared = stat.hidden && value !== null;
    stat.hidden = value === null;
    updateStatHero(stat, { value: value ?? 0, label: label(value ?? 0), animate: !appeared });
  }
}

const tokenParts = [["input", "Input"], ["output", "Output"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"]];
function tokenSummary(data, headingTag) {
  const moments = [["today", "Today (UTC)"], ["lastHour", `In the ${RECENT_WINDOW}`]].map(([key, label]) => {
    const stat = statHero({ label, value: 0, format: "compact", unit: "tokens", className: "profile-token-moment" });
    stat.setAttribute("data-token-moment", key);
    return stat;
  });
  const section = h("section", { class: "profile-tokens", "aria-label": "Token usage" },
    h("div", { class: "profile-section-heading" }, h(headingTag, {}, "Token burn"), h("span", {}, "All time · from agents’ local session logs")),
    h("div", { class: "profile-token-body" },
      h("div", { class: "profile-token-mix" },
        h("div", { class: "profile-token-moments" }, moments),
        h("div", { class: "profile-token-bar", role: "img" }, tokenParts.map(([key]) => h("span", { class: "profile-token-segment", "data-part": key }))),
        h("ul", { class: "profile-token-legend", role: "list" }, tokenParts.map(([key, label]) => h("li", { "data-part": key }, h("span", { class: "profile-token-swatch", "aria-hidden": "true" }), h("span", { class: "profile-token-part" }, label), h("strong", { class: "profile-token-value" }), h("span", { class: "profile-token-share" }))))),
      h("div", { class: "profile-token-board" },
        h("p", { class: "profile-token-board-title" }, "By agent"),
        h("ol", { class: "profile-token-agents", role: "list", "aria-label": "Tokens by agent product" }),
        h("p", { class: "profile-empty-note profile-token-agents-empty", hidden: true }, "No per-agent counts yet."))),
    h("p", { class: "profile-token-note" }, "Token counts are read from each agent’s local session log and sent by the Engram connector. Engram does not observe them directly. Counts only."));
  updateTokens(section, data, { animate: false });
  return section;
}
function updateTokens(section, data, { animate = true } = {}) {
  if (!section) return;
  const tokens = publicTokens(data);
  const wasHidden = section.hidden;
  section.hidden = !tokens;
  if (!tokens) return;
  const motion = animate && !wasHidden;
  for (const key of ["today", "lastHour"]) updateStatHero(section.querySelector(`[data-token-moment="${key}"]`), { value: count(tokens[key]), animate: motion });
  const parts = tokenParts.map(([key, label]) => [key, label, count(tokens[key])]);
  const total = parts.reduce((sum, [, , value]) => sum + value, 0);
  const share = value => total ? value / total * 100 : 0;
  const shareText = value => { const percent = share(value); return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`; };
  section.querySelector(".profile-token-bar").setAttribute("aria-label", total ? `Token mix: ${parts.map(([, label, value]) => `${label} ${shareText(value)}`).join(", ")}` : "No token counts yet");
  for (const [key, label, value] of parts) {
    section.querySelector(`.profile-token-segment[data-part="${key}"]`)?.style?.setProperty?.("--share", `${share(value)}%`);
    const row = section.querySelector(`.profile-token-legend [data-part="${key}"]`);
    const strong = row.querySelector(".profile-token-value");
    setText(strong, formatCount(value, "compact")); strong.setAttribute("title", `${number(value)} ${label.toLowerCase()} tokens`);
    setText(row.querySelector(".profile-token-share"), shareText(value));
  }
  const agents = (Array.isArray(tokens.agents) ? tokens.agents : []).filter(item => item && typeof item.product === "string" && count(item.tokens) > 0)
    .sort((a, b) => count(b.tokens) - count(a.tokens) || a.product.localeCompare(b.product)).slice(0, 6);
  const key = JSON.stringify(agents.map(item => [item.product, count(item.tokens)]));
  const list = section.querySelector(".profile-token-agents");
  section.querySelector(".profile-token-agents-empty").hidden = agents.length > 0;
  if (list.dataset.agents === key) return;
  list.dataset.agents = key;
  const top = Math.max(1, ...agents.map(item => count(item.tokens)));
  list.replaceChildren(...agents.map((item, index) => {
    const visual = agentVisual("", { harness: item.product, publicSafe: true });
    const label = item.product === "other" ? "Other agents" : visual.label;
    const fill = h("span", { class: "profile-token-agent-fill" });
    fill.style?.setProperty?.("--share", `${Math.max(2, count(item.tokens) / top * 100)}%`);
    return h("li", { class: "profile-token-agent", "data-rank": index + 1 },
      identityMark(visualIcon(visual, { size: 20 }), { size: "md" }),
      h("span", { class: "profile-token-agent-copy" }, h("strong", {}, label), h("span", { class: "profile-token-agent-bar", "aria-hidden": "true" }, fill)),
      h("span", { class: "profile-token-agent-count", title: `${number(count(item.tokens))} tokens` }, formatCount(item.tokens, "compact"), h("span", { class: "ds-sr-only" }, " tokens")));
  }));
}

// The 12-week chart for the selected metric. Tokens are offered only while
// the snapshot carries them; otherwise the chart shows actions.
function chartMetric(card, data) { return card?.dataset?.rhythmMetric === "tokens" && publicTokens(data) ? "tokens" : "actions"; }
function chartSeries(data, metric) {
  const series = metric === "tokens" ? publicTokens(data)?.daily : data.daily;
  return (Array.isArray(series) ? series : []).filter(day => day && typeof day.date === "string").map(day => ({ date: day.date, count: count(day.count) }));
}
function chartFor(card, data, headingTag) {
  const metric = chartMetric(card, data);
  let section;
  const onMetric = publicTokens(data) ? value => {
    const owner = section.closest(".public-profile"); if (!owner) return;
    owner.dataset.rhythmMetric = value;
    updateChart(owner, cardData.get(owner) || data);
    owner.querySelector(`.profile-rhythm-metric [data-metric="${value}"]`)?.focus({ preventScroll: true });
  } : null;
  section = contributionGrid(chartSeries(data, metric), { headingTag, metric, onMetric });
  return section;
}

function categorySummary(tools, headingTag) {
  const section = h("section", { class: "profile-category-summary" },
    h("div", { class: "profile-section-heading" }, h(headingTag, { tabindex: "-1" }, "Where the work goes"), h("span", {}, "Top categories · all time")),
    h("div", { class: "profile-category-list" }));
  updateCategories(section, tools);
  return section;
}
function updateCategories(section, tools) {
  const top = [...tools].filter(tool => tool.count > 0).sort((a, b) => b.count - a.count || String(a.category).localeCompare(String(b.category))).slice(0, 3);
  const total = tools.reduce((sum, tool) => sum + (tool.count > 0 ? tool.count : 0), 0);
  section.querySelector(".profile-category-list").replaceChildren(...(top.length ? top.map(tool => {
    const [label] = categories[tool.category] || categories.other;
    const share = total ? Math.round(tool.count / total * 100) : 0;
    const fill = h("span", { class: "profile-category-fill" });
    fill.style?.setProperty?.("--share", `${Math.max(share, 2)}%`);
    return h("div", { class: "profile-category" }, h("strong", {}, number(tool.count)), h("span", {}, `${label} ${tool.count === 1 ? "action" : "actions"}`),
      h("span", { class: "profile-category-bar", role: "img", "aria-label": `${share}% of all actions` }, fill), h("span", { class: "profile-category-share", "aria-hidden": "true" }, `${share}%`));
  }) : [h("p", { class: "profile-empty-note" }, "No action counts yet.")]));
}
// Products only: agent names are private, so each product shows how many agents use it.
function agentRoster(agents, headingTag) {
  const section = h("section", { class: "profile-agents", "aria-label": "Connected agents" },
    h("div", { class: "profile-section-heading" }, h(headingTag, {}, "The agent crew"), h("span", { class: "profile-agents-total" })),
    h("ul", { class: "profile-agent-list", role: "list" }));
  updateAgents(section, agents);
  return section;
}
function updateAgents(section, agents) {
  const list = (Array.isArray(agents) ? agents : []).filter(item => item && typeof item.product === "string" && item.agents > 0);
  const key = JSON.stringify(list);
  if (section.dataset.agents === key) return;
  section.dataset.agents = key;
  section.hidden = !list.length;
  const total = list.reduce((sum, item) => sum + item.agents, 0);
  setText(section.querySelector(".profile-agents-total"), `${number(total)} connected · all time`);
  section.querySelector(".profile-agent-list").replaceChildren(...list.map(item => {
    const visual = agentVisual("", { harness: item.product, publicSafe: true });
    const label = item.product === "other" ? "Other agents" : visual.label;
    return h("li", { class: "profile-agent" },
      identityMark(visualIcon(visual, { size: 22 }), { size: "lg" }),
      h("span", { class: "profile-agent-copy" }, h("strong", {}, label), h("span", {}, `${number(item.actions)} ${item.actions === 1 ? "action" : "actions"}`)),
      h("span", { class: "profile-agent-count" }, h("strong", {}, number(item.agents)), h("span", {}, item.agents === 1 ? "agent" : "agents")));
  }));
}
function profileHighlights(profile = {}) {
  return (Array.isArray(profile.highlights) ? profile.highlights : []).filter(item => item && typeof item.title === "string" && item.title.trim()).slice(0, 3).map(item => ({ title: item.title.slice(0, 80), body: typeof item.body === "string" ? item.body.slice(0, 600) : "", url: publicLink(item.url) }));
}
function publicLink(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return "";
  try { const parsed = new URL(value); return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ""; } catch { return ""; }
}
const notePreview = body => body.length > 160 ? `${body.slice(0, 157).trimEnd()}…` : body;
function highlightCard(item, index) {
  return h("article", { class: "profile-highlight", "data-profile-highlight": index },
    h("div", { class: "ds-highlight-content" },
      h("h3", { class: "ds-highlight-title" }, item.title),
      h("p", { class: "ds-highlight-description profile-highlight-preview", hidden: !item.body }, notePreview(item.body)),
      h("details", { class: "ds-highlight-disclosure", hidden: item.body.length <= 160 }, h("summary", {}, "Read full note"), h("p", { class: "ds-highlight-description profile-highlight-body" }, item.body)),
      h("div", { class: "ds-highlight-actions", hidden: !item.url }, h("a", { class: "profile-highlight-link", href: item.url || undefined, target: "_blank", rel: "noopener noreferrer" }, "Open link"))));
}
function updateHighlights(section, profile) {
  const items = profileHighlights(profile), list = section.querySelector(".profile-highlight-list");
  const focus = section.contains(document.activeElement) ? document.activeElement : null;
  section.dataset.empty = String(!items.length);
  section.querySelector(".profile-highlight-empty").hidden = !!items.length;
  items.forEach((item, index) => {
    let card = list.children[index];
    if (!card) { card = highlightCard(item, index); list.append(card); }
    else {
      setText(card.querySelector(".ds-highlight-title"), item.title);
      const preview = card.querySelector(".profile-highlight-preview");
      setText(preview, notePreview(item.body)); preview.hidden = !item.body;
      setText(card.querySelector(".profile-highlight-body"), item.body);
      card.querySelector(".ds-highlight-disclosure").hidden = item.body.length <= 160;
      card.querySelector(".ds-highlight-actions").hidden = !item.url;
      const link = card.querySelector(".profile-highlight-link");
      if (item.url) link.setAttribute("href", item.url); else link.removeAttribute("href");
    }
  });
  while (list.children.length > items.length) list.children[list.children.length - 1].remove();
  if (focus && (!section.contains(focus) || focus.closest(".ds-highlight-disclosure")?.hidden || focus.closest(".ds-highlight-actions")?.hidden)) {
    const target = !items.length && profile.layout !== "field-notes" ? section.parentElement.querySelector(".profile-category-summary") : section;
    const heading = target.querySelector(".profile-section-heading").querySelector("h2, h3");
    if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
  }
}
function updateDesk(section, data) {
  const enabled = data.activity?.enabled === true;
  const checkedAt = Date.parse(data.live?.checkedAt) || Date.now();
  const freshness = Math.max(0, Number(data.live?.freshnessSeconds) || 900) * 1000;
  const events = streamEvents(data.activity).filter(event => {
    const age = checkedAt - Date.parse(event.updatedAt);
    return event.status === "running" && Number.isFinite(age) && age >= 0 && age <= freshness;
  }).slice(0, 2);
  const state = section.querySelector(".profile-desk-state");
  state.hidden = !!events.length;
  if (state.dataset.enabled !== String(enabled)) {
    state.replaceChildren(h("strong", {}, enabled ? "A quiet moment." : "Some work stays behind the scenes."),
      h("p", {}, enabled ? "No fresh running actions to share right now. The recorded work is still here to explore." : "Activity streaming is off. You can still explore the counts and anything the owner has chosen to pin."));
    state.dataset.enabled = String(enabled);
  }
  const list = section.querySelector(".profile-stage-list");
  const rows = new Map([...list.children].map(row => [row.dataset.stageEvent, row]));
  events.forEach((event, index) => {
    const signature = JSON.stringify([event.agent?.product, event.agent?.label, event.service, event.action, event.status, event.evidence, event.updatedAt]);
    let row = rows.get(event.id);
    if (!row || eventSignatures.get(row) !== signature) {
      const content = h("li", { class: "ds-focus-row profile-stage-event", "data-stage-event": event.id, title: eventEvidence(event), "aria-description": eventEvidence(event) },
        eventMark(event, "ds-focus-mark"),
        h("div", { class: "ds-focus-content" }, h("div", { class: "profile-event-line" },
          h("h3", { class: "ds-focus-title" }, statusText(event.action || "Agent activity")), statusLabel("In progress")),
          h("div", { class: "ds-focus-meta" }, h("time", { datetime: event.updatedAt, title: exactTime(event.updatedAt), "data-public-time": event.updatedAt }, relativeTime(event.updatedAt)))));
      if (row) row.replaceChildren(...content.childNodes); else row = content;
      eventSignatures.set(row, signature);
    }
    row.setAttribute("title", eventEvidence(event)); row.setAttribute("aria-description", eventEvidence(event));
    updateEventMotion(row, event, { now: checkedAt, freshness });
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    rows.delete(event.id);
  });
  for (const row of rows.values()) row.remove();
}
// The crew shows product marks from the public event stream only, so it stays
// empty when the owner has not shared activity. Marks are labels, not proof.
function updateIdentityExtras(card, data) {
  const slug = card.querySelector(".profile-slug");
  setText(slug, data.profile?.slug ? `@${data.profile.slug}` : "");
  slug.hidden = !data.profile?.slug;
  const presence = card.querySelector(".profile-presence"), live = data.live || {};
  const state = live.workingAgents > 0 ? "working" : live.recentlyActiveAgents > 0 ? "recent" : live.lastActivityAt ? "quiet" : "none";
  const signature = `${state}:${live.workingAgents}:${live.lastActivityAt}`;
  if (presence.dataset.signature !== signature) {
    presence.dataset.state = state; presence.dataset.signature = signature; presence.hidden = state === "none";
    const dot = h("span", { class: "profile-presence-dot", "aria-hidden": "true" });
    const words = value => document.createTextNode(value);
    if (state === "working") presence.replaceChildren(dot, words(`${number(live.workingAgents)} ${live.workingAgents === 1 ? "agent" : "agents"} working now`));
    else if (state === "recent") presence.replaceChildren(dot, words("Active in the last 15 minutes"));
    else if (state === "quiet") presence.replaceChildren(dot, words("Last active "), h("time", { datetime: live.lastActivityAt, title: exactTime(live.lastActivityAt), "data-public-time": live.lastActivityAt }, relativeTime(live.lastActivityAt, Date.parse(live.checkedAt) || Date.now()).toLowerCase()));
    else presence.replaceChildren();
  }
  const products = [];
  for (const event of streamEvents(data.activity)) {
    const product = event.agent?.product;
    if (product && product !== "other" && !products.includes(product)) products.push(product);
  }
  const crew = card.querySelector(".profile-crew"), marks = crew.querySelector(".profile-crew-marks");
  if (marks.dataset.products !== products.join(",")) {
    marks.dataset.products = products.join(",");
    const visuals = products.map(product => agentVisual("", { harness: product, publicSafe: true }));
    marks.replaceChildren(...(visuals.length ? [markStack(visuals.map(visual => identityMark(visualIcon(visual, { size: 20 }), { size: "md", label: visual.label })), { max: 6, label: `Recently active agents: ${visuals.map(visual => visual.label).join(", ")}` })] : []));
  }
  crew.hidden = !products.length;
}
function updatePresentation(card, data) {
  const layout = data.profile.layout === "field-notes" ? "field-notes" : "studio";
  const main = card.querySelector(".profile-main");
  const highlights = card.querySelector(".profile-highlights");
  updateHighlights(highlights, data.profile);
  updateDesk(card.querySelector(".profile-desk"), data);
  setText(card.querySelector(".profile-receipt-count"), data.activity?.enabled === true ? `${number(streamEvents(data.activity).length)} recent events` : "Activity labels are private");
  if (card.dataset.profileLayout !== layout) {
    const focus = card.contains(document.activeElement) ? document.activeElement : null;
    const desk = card.querySelector(".profile-desk"), overview = card.querySelector(".profile-overview"), categories = card.querySelector(".profile-category-summary"), agents = card.querySelector(".profile-agents");
    const flex = card.querySelector(".profile-flex"), tokens = card.querySelector(".profile-tokens");
    main.append(...(layout === "field-notes" ? [highlights, flex, overview, desk, categories, tokens, agents] : [flex, desk, overview, categories, tokens, agents, highlights]));
    card.dataset.profileLayout = layout;
    if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
  }
}

function profileTools(tools = [], headingTag = "h2") {
  const totalTools = tools.reduce((sum, tool) => sum + tool.count, 0);
  return h("section", { class: "profile-tools" }, h("div", { class: "profile-section-heading" }, h(headingTag, {}, "Across the tools"), h("span", {}, `${tools.length} categories`)),
    tools.length ? tools.map(tool => {
      const [label] = categories[tool.category] || categories.other;
      return h("div", { class: "profile-tool" }, h("span", { class: "tool-label" }, label), h("span", { class: "tool-count" }, number(tool.count), totalTools ? ` · ${Math.round(tool.count / totalTools * 100)}%` : ""));
    }) : h("p", { class: "muted" }, "No activity counts to show yet."));
}

export function liveActivity(live = {}, { headingTag = "h3" } = {}) {
  const stale = Number(live.staleActions || 0);
  return h("section", { class: "profile-live", "aria-label": "Live agent activity" },
    h("div", { class: "live-metrics" }, [["workingAgents", "Working now", "Agents with a fresh running action"], ["recentlyActiveAgents", "Recently active", "Agents that reported or used Engram in the last 15 minutes"]].map(([key, label, title]) => h("div", { title }, h("strong", { "data-public-live": key }, number(live[key])), h("span", {}, label)))),
    h("p", { class: "live-explanation" }, "Signals received in the last 15 minutes."),
    h("p", { class: "live-stale", hidden: !stale }, staleText(stale)));
}

const staleText = count => `${number(count)} older running ${count === 1 ? "report has" : "reports have"} gone quiet and ${count === 1 ? "isn’t" : "aren’t"} counted as working.`;

// Update numbers in place so live snapshots never steal keyboard focus or reset
// the date a visitor is exploring on the contribution chart.
export function updateProfileCard(card, data) {
  const { profile } = data;
  cardData.set(card, data);
  const checkedAt = Date.parse(data.live?.checkedAt);
  if (Number.isFinite(checkedAt)) {
    if (profileClocks.get(card)?.serverNow !== checkedAt) profileClocks.set(card, { serverNow: checkedAt, receivedAt: Date.now() });
  } else profileClocks.delete(card);
  updateActivityStream(card.querySelector(".public-stream"), data.activity, eventTiming(data));
  updatePresentation(card, data);
  updateIdentityExtras(card, data);
  updateProfileTimes(card);
  card.querySelector(".profile-footnote p").textContent = privacyText(data.activity?.enabled === true, profileHighlights(profile).length > 0);
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  updateFlex(card.querySelector(".profile-flex"), data);
  updateTokens(card.querySelector(".profile-tokens"), data);
  card.querySelectorAll("[data-public-live]").forEach(node => text(node, number(data.live?.[node.dataset.publicLive])));
  const stale = card.querySelector(".live-stale");
  if (stale) { stale.hidden = !data.live?.staleActions; stale.textContent = staleText(data.live?.staleActions || 0); }
  const identity = card.querySelector(".profile-identity");
  updateProfilePhoto(card, profile);
  text(identity.querySelector("h1, h2"), profile.displayName || "Your public profile");
  text(identity.querySelector("p"), profile.bio || "A small window into the work across my agents.");
  updateChart(card, data);
  updateAgents(card.querySelector(".profile-agents"), data.agents);
  const tools = JSON.stringify(data.tools || []);
  if (card.dataset.tools !== tools) {
    const updatedTools = profileTools(data.tools || [], card.classList.contains("compact") ? "h3" : "h2");
    card.querySelector(".profile-tools").replaceWith(updatedTools); card.dataset.tools = tools;
    updateCategories(card.querySelector(".profile-category-summary"), data.tools || []);
  }
}

function updateChart(card, data) {
  const metric = chartMetric(card, data), daily = chartSeries(data, metric);
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  let grid = card.querySelector(".contribution-grid");
  const chart = grid.closest(".contributions");
  if (chart.dataset.metric !== metric || chart.dataset.metrics !== String(Boolean(publicTokens(data))) || [...grid.children].some((node, index) => node.dataset.date !== daily[index]?.date) || grid.children.length !== daily.length) {
    const focusedDate = grid.contains(document.activeElement) ? document.activeElement?.dataset?.date : null;
    const selectedDate = grid.dataset.selectedDate;
    const scrollLeft = grid.closest(".contribution-viewport").scrollLeft;
    const replacement = chartFor(card, data, card.classList.contains("compact") ? "h3" : "h2"); chart.replaceWith(replacement); grid = replacement.querySelector(".contribution-grid");
    if (selectedDate && [...grid.children].some(node => node.dataset.date === selectedDate)) {
      grid.dataset.selectedDate = selectedDate;
      [...grid.children].forEach(node => { node.tabIndex = node.dataset.date === selectedDate ? 0 : -1; });
    }
    if (focusedDate) ([...grid.children].find(node => node.dataset.date === focusedDate) || [...grid.children].at(-1))?.focus({ preventScroll: true });
    grid.closest(".contribution-viewport").scrollLeft = scrollLeft;
  }
  const maximum = Math.max(1, ...daily.map(day => day.count));
  for (const [index, cell] of [...grid.children].entries()) {
    const day = daily[index]; if (!day) continue;
    const label = cellLabel(day, metric);
    cell.className = `contribution-cell level-${cellLevel(day.count, maximum)}`;
    cell.title = label; cell.setAttribute("aria-label", label);
  }
  updateRhythm(grid.closest(".contributions"), daily, metric);
  const selected = [...grid.children].find(node => node.dataset.date === grid.dataset.selectedDate);
  text(card.querySelector(".contribution-caption"), selected ? selected.getAttribute("aria-label") : chartCaption(daily, metric));
}

export function profileSkeleton() {
  return h("div", { class: "profile-skeleton", role: "status", "aria-busy": "true", "aria-label": "Loading activity profile" },
    h("div", { class: "ds-skeleton", "data-size": "short" }), h("div", { class: "ds-skeleton", "data-size": "heading" }), h("div", { class: "ds-skeleton" }),
    h("div", { class: "skeleton-stats" }, [1, 2, 3].map(() => h("div", { class: "ds-skeleton", "data-size": "heading" }))),
    h("div", { class: "skeleton-chart" }, Array.from({ length: 84 }, () => h("span", { class: "ds-skeleton" }))));
}
