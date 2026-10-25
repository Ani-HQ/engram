import { icon } from "./icons.js";
import { agentVisual, providerVisual, visualIcon } from "./tooling.js";
import { highlightArt, resourceChip, statusBadge } from "./design-system.js";

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
const categories = { code: ["Code", "code"], files: ["Files", "file-text"], email: ["Email", "mail"], calendar: ["Calendar", "calendar"], cloud: ["Cloud", "cloud"], browser: ["Browser", "globe"], data: ["Data", "database"], memory: ["Memory", "brain"], other: ["Other tools", "plug"] };

export function contributionGrid(daily = [], { headingTag = "h3" } = {}) {
  const maximum = Math.max(1, ...daily.map(day => day.count));
  const count = daily.reduce((sum, day) => sum + day.count, 0);
  const live = h("span", { class: "contribution-caption", "aria-live": "polite" }, `${number(count)} actions in the last 12 weeks`);
  const cells = daily.map((day, index) => {
    const label = `${number(day.count)} ${day.count === 1 ? "action" : "actions"} on ${new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`))}`;
    const showDay = event => {
      cells.forEach(cell => { cell.tabIndex = cell === event.currentTarget ? 0 : -1; });
      grid.dataset.selectedDate = day.date;
      live.textContent = event.currentTarget.getAttribute("aria-label");
    };
    return h("button", { type: "button", class: `contribution-cell level-${day.count ? Math.max(1, Math.ceil(day.count / maximum * 4)) : 0}`, "data-date": day.date, tabindex: index === daily.length - 1 ? "0" : "-1", title: label, "aria-label": label, onclick: showDay, onfocus: showDay });
  });
  const grid = h("div", { class: "contribution-grid", role: "group", "aria-label": "Daily activity for the last 12 weeks. Use arrow keys to explore.", onkeydown: event => {
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
  return h("section", { class: "contributions" },
    h("div", { class: "profile-section-heading" }, h(headingTag, {}, "The work adds up."), h("span", {}, "Last 12 weeks")),
    h("div", { class: "contribution-viewport", role: "region", "aria-label": "Daily activity chart. Swipe or use arrow keys to explore dates." },
      h("div", { class: "contribution-chart" },
        h("div", { class: "contribution-months", "aria-hidden": "true" }, months),
        h("div", { class: "contribution-layout" }, h("div", { class: "contribution-weekdays", "aria-hidden": "true" }, weekLabels), grid))),
    h("p", { class: "contribution-explore" }, "Swipe or use arrow keys to explore dates."),
    h("div", { class: "contribution-footer" }, live, h("div", { class: "contribution-legend", "aria-hidden": "true" }, "Less", [0, 1, 2, 3, 4].map(level => h("span", { class: `contribution-cell level-${level}` })), "More")));
}

const eventStates = {
  running: ["In progress", "info"], completed: ["Completed", "success"],
  failed: ["Needs attention", "danger"], stale: ["Update overdue", "warning"],
};
const eventSignatures = new WeakMap();
const privacyText = (enabled, hasHighlights = false) => enabled
  ? "Activity uses safe action labels; task text, prompts, resource details and agent aliases are excluded from the stream. Highlights are chosen by the owner."
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
  const agent = agentVisual("", { harness: event.agent?.product || "other", publicSafe: true });
  const agentLabel = event.agent?.label || agent.label;
  const service = providerVisual(event.service);
  const [label, tone] = eventStates[event.status] || eventStates.stale;
  return h("li", { class: "public-event ds-card", "data-public-event": event.id, "data-event-status": event.status },
    h("span", { class: "public-event-mark ds-product-logo-frame", "aria-hidden": "true" }, visualIcon(agent, { size: 24 })),
    h("div", { class: "public-event-content" },
      h("div", { class: "public-event-heading" }, h("strong", {}, agentLabel), statusBadge(label, { tone })),
      h("h3", {}, event.action || "Agent activity"),
      h("div", { class: "public-event-meta" }, resourceChip(service.label, { visual: visualIcon(service, { size: 16 }), title: `Service: ${service.label}` }),
        h("span", { class: "public-event-evidence" }, event.evidence === "observed" ? "Observed by Engram" : "Agent reported"),
        h("time", { datetime: event.updatedAt, title: exactTime(event.updatedAt), "data-public-time": event.updatedAt }, relativeTime(event.updatedAt)))));
}
function streamEvents(activity) {
  if (activity?.enabled !== true || !Array.isArray(activity.events)) return [];
  const seen = new Set();
  return activity.events.filter(event => event && typeof event.id === "string" && !seen.has(event.id) && seen.add(event.id)).slice(0, 20);
}
function activityStream(activity, { headingTag = "h2" } = {}) {
  const section = h("section", { class: "public-stream", "aria-label": "Public activity stream" },
    h("div", { class: "profile-section-heading public-stream-heading" }, h(headingTag, {}, "The live thread."), statusBadge("Safe labels only", { tone: "neutral" })),
    h("p", { class: "public-stream-intro" }, "Which agents are working, and the kind of work they share."),
    h("div", { class: "public-stream-state ds-notice" }),
    h("section", { class: "public-stream-active", "aria-label": "Work in progress" }, h("p", { class: "ds-eyebrow" }, "IN PROGRESS"), h("ol", { class: "public-event-list", role: "list", "data-public-events": "running" })),
    h("section", { class: "public-stream-recent", "aria-label": "Recent activity" }, h("p", { class: "ds-eyebrow" }, "RECENT ACTIVITY"), h("ol", { class: "public-event-list", role: "list", "data-public-events": "recent" })));
  updateActivityStream(section, activity);
  return section;
}
function updateActivityStream(section, activity) {
  if (!section) return;
  const enabled = activity?.enabled === true, events = streamEvents(activity);
  section.dataset.enabled = String(enabled);
  const state = section.querySelector(".public-stream-state");
  state.hidden = enabled && events.length > 0;
  const stateText = !enabled ? "Activity streaming is off for this profile. Aggregate counts remain available in the history." : "A quiet moment. New activity will appear when an agent reports work or uses Engram.";
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
      eventSignatures.set(row, signature);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      rows.delete(event.id);
    });
  }
  for (const row of rows.values()) row.remove();
}
export function updateProfileTimes(card, now = Date.now()) {
  card.querySelectorAll("[data-public-time]").forEach(node => {
    const label = relativeTime(node.dataset.publicTime, now);
    if (node.textContent !== label) node.textContent = label;
  });
}

export function profileCard(data, { compact = false } = {}) {
  const { profile, stats, tools = [], daily = [] } = data;
  const headingTag = compact ? "h3" : "h2";
  const card = h("article", { class: `public-profile${compact ? " compact" : ""}`, "data-tools": JSON.stringify(tools) },
    h("header", { class: "profile-identity ds-heading-group" }, h("span", { class: "ds-eyebrow profile-layout-label" }),
      h(compact ? "h2" : "h1", {}, profile.displayName || "Your public profile"), h("p", {}, profile.bio || "A small window into the work across my agents.")),
    h("div", { class: "profile-main" },
      h("section", { class: "profile-desk", "aria-label": "The public desk" },
        h("div", { class: "profile-section-heading" }, h(headingTag, {}, "On the desk."), h("span", {}, "Fresh signals")),
        liveActivity(data.live, { headingTag }),
        h("div", { class: "profile-desk-state ds-notice" }),
        h("ol", { class: "profile-stage-list", role: "list", "aria-label": "Fresh running actions" })),
      weekPulse(daily, headingTag),
      h("section", { class: "profile-highlights", "aria-label": "Owner-selected highlights" },
        h("div", { class: "profile-section-heading" }, h(headingTag, { tabindex: "-1" }, "Selected work."), h("span", {}, "Chosen by the owner")),
        h("div", { class: "profile-highlight-list" }),
        h("div", { class: "profile-highlight-empty ds-notice" }, h("strong", {}, "Nothing pinned here yet."), h("p", {}, "This space is ready for the notes and links the owner chooses to share."))),
      categorySummary(tools, headingTag)),
    h("details", { class: "profile-receipts" }, h("summary", {}, "Peek at the recent receipts", h("span", { class: "profile-receipt-count" })), activityStream(data.activity, { headingTag })),
    h("details", { class: "profile-history" }, h("summary", {}, "The bigger picture", h("span", {}, "Activity totals & history")),
      h("div", { class: "profile-statistics", "aria-label": "All-time activity totals" }, [["totalActions", stats.totalActions === 1 ? "Action" : "Actions", stats.totalActions], ["activeAgents", stats.activeAgents === 1 ? "Agent" : "Agents", stats.activeAgents], ["activeDays", stats.activeDays === 1 ? "Active day" : "Active days", stats.activeDays]].map(([key, label, value]) => h("div", {}, h("strong", { "data-public-stat": key }, number(value)), h("span", { "data-public-label": key }, label)))),
      contributionGrid(daily, { headingTag }), profileTools(tools, headingTag)),
    h("footer", { class: "profile-footnote" }, icon("shield-check", { size: 16 }), h("p", {}, privacyText(data.activity?.enabled === true, profileHighlights(profile).length > 0))));
  updatePresentation(card, data);
  return card;
}

const dateLabel = day => `${number(day.count)} ${day.count === 1 ? "action" : "actions"} on ${new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`))}`;
function weekPulse(daily, headingTag) {
  const section = h("section", { class: "profile-weekly ds-card", "aria-label": "Seven-day activity pulse" },
    h("div", { class: "profile-section-heading" }, h(headingTag, {}, "A little momentum."), h("span", {}, "Last 7 days · UTC")),
    h("p", { class: "profile-week-total" }),
    h("div", { class: "profile-week-viewport", role: "region", "aria-label": "Daily counts. Use left and right arrow keys to explore dates." }, h("ol", { class: "ds-week-pulse", role: "list", onkeydown: event => {
      const buttons = [...section.querySelectorAll("[data-week-date]")];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
      buttons[next].focus();
    } })),
    h("p", { class: "profile-week-caption", "aria-live": "polite" }));
  updateWeekPulse(section, daily);
  return section;
}
function updateWeekPulse(section, daily) {
  const days = daily.slice(-7), list = section.querySelector(".ds-week-pulse");
  const selectedDate = section.dataset.selectedDate;
  const focusedDate = section.contains(document.activeElement) ? document.activeElement?.dataset?.weekDate : null;
  const rows = new Map([...list.children].map(row => [row.querySelector("[data-week-date]")?.dataset.weekDate, row]));
  const maximum = Math.max(1, ...days.map(day => day.count));
  const selected = days.find(day => day.date === selectedDate) || days.at(-1);
  if (selected) section.dataset.selectedDate = selected.date;
  days.forEach((day, index) => {
    let row = rows.get(day.date);
    if (!row) {
      const choose = event => {
        section.dataset.selectedDate = day.date;
        section.querySelectorAll("[data-week-date]").forEach(button => {
          const current = button === event.currentTarget;
          button.tabIndex = current ? 0 : -1;
          button.setAttribute("aria-pressed", String(current));
        });
        section.querySelector(".profile-week-caption").textContent = event.currentTarget.getAttribute("aria-label");
        event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      };
      row = h("li", { class: "ds-week-day" }, h("button", { type: "button", class: "ds-week-button", "data-week-date": day.date, onclick: choose, onfocus: choose },
        h("span", { class: "ds-week-bar", "aria-hidden": "true" }, h("span", { class: "ds-week-bar-fill" })), h("span", { class: "ds-week-label" }), h("span", { class: "ds-week-count" })));
    }
    const button = row.querySelector("[data-week-date]");
    button.setAttribute("aria-label", `${dateLabel(day)} UTC`); button.title = `${dateLabel(day)} UTC`;
    button.tabIndex = selected?.date === day.date ? 0 : -1; button.setAttribute("aria-pressed", String(button.tabIndex === 0));
    button.style.setProperty("--ds-pulse-ratio", String(day.count / maximum));
    setText(row.querySelector(".ds-week-count"), number(day.count));
    setText(row.querySelector(".ds-week-label"), new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`)));
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    rows.delete(day.date);
  });
  for (const row of rows.values()) row.remove();
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const totalNode = section.querySelector(".profile-week-total");
  if (!totalNode.children.length) totalNode.append(h("strong"), h("span"));
  setText(totalNode.querySelector("strong"), number(total)); setText(totalNode.querySelector("span"), `${total === 1 ? "action" : "actions"} recorded`);
  setText(section.querySelector(".profile-week-caption"), selected ? `${dateLabel(selected)} UTC` : "No daily counts to show yet.");
  if (focusedDate && !section.contains(document.activeElement)) (section.querySelector(`[data-week-date="${focusedDate}"]`) || section.querySelector(`[data-week-date="${selected?.date}"]`))?.focus({ preventScroll: true });
}
function categorySummary(tools, headingTag) {
  const section = h("section", { class: "profile-category-summary" },
    h("div", { class: "profile-section-heading" }, h(headingTag, { tabindex: "-1" }, "A feel for the work."), h("span", {}, "Top categories · all time")),
    h("div", { class: "profile-category-list" }));
  updateCategories(section, tools);
  return section;
}
function updateCategories(section, tools) {
  const top = [...tools].filter(tool => tool.count > 0).sort((a, b) => b.count - a.count || String(a.category).localeCompare(String(b.category))).slice(0, 3);
  section.querySelector(".profile-category-list").replaceChildren(...(top.length ? top.map(tool => {
    const [label, name] = categories[tool.category] || categories.other;
    return h("div", { class: "profile-category ds-card" }, icon(name, { size: 20 }), h("strong", {}, number(tool.count)), h("span", {}, `${label} ${tool.count === 1 ? "action" : "actions"}`));
  }) : [h("p", { class: "ds-notice" }, "No action counts yet.")]));
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
  return h("article", { class: "ds-card ds-highlight-card profile-highlight", "data-profile-highlight": index },
    h("div", { class: "ds-highlight-visual" }, highlightArt({ variant: ["orbit", "grid", "layers"][index] })),
    h("div", { class: "ds-highlight-content" },
      h("p", { class: "ds-highlight-meta" }, `Highlight ${String(index + 1).padStart(2, "0")}`),
      h("h3", { class: "ds-highlight-title" }, item.title),
      h("p", { class: "ds-highlight-description profile-highlight-preview", hidden: !item.body }, notePreview(item.body)),
      h("details", { class: "ds-highlight-disclosure", hidden: item.body.length <= 160 }, h("summary", {}, "Read full note", icon("chevron-down", { size: 14, className: "ds-disclosure-indicator" })), h("p", { class: "ds-highlight-description profile-highlight-body" }, item.body)),
      h("div", { class: "ds-highlight-actions", hidden: !item.url }, h("a", { class: "profile-highlight-link", href: item.url || undefined, target: "_blank", rel: "noopener noreferrer" }, "Open link", icon("arrow-up-right", { size: 15 })))));
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
      const agent = agentVisual("", { harness: event.agent?.product || "other", publicSafe: true });
      const content = h("li", { class: "ds-focus-row profile-stage-event", "data-stage-event": event.id },
        h("span", { class: "ds-focus-mark ds-product-logo-frame", "aria-hidden": "true" }, visualIcon(agent, { size: 24 })),
        h("div", { class: "ds-focus-content" }, h("div", { class: "ds-focus-label" }, h("strong", {}, event.agent?.label || agent.label), statusBadge("In progress", { tone: "info" })),
          h("h3", { class: "ds-focus-title" }, event.action || "Agent activity"),
          h("div", { class: "ds-focus-meta" }, h("span", {}, event.evidence === "observed" ? "Observed by Engram" : "Agent reported"), h("time", { datetime: event.updatedAt, title: exactTime(event.updatedAt), "data-public-time": event.updatedAt }, relativeTime(event.updatedAt)))));
      if (row) row.replaceChildren(...content.childNodes); else row = content;
      eventSignatures.set(row, signature);
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    rows.delete(event.id);
  });
  for (const row of rows.values()) row.remove();
}
function updatePresentation(card, data) {
  const layout = data.profile.layout === "field-notes" ? "field-notes" : "studio";
  const main = card.querySelector(".profile-main");
  const highlights = card.querySelector(".profile-highlights");
  updateHighlights(highlights, data.profile);
  updateDesk(card.querySelector(".profile-desk"), data);
  setText(card.querySelector(".profile-layout-label"), layout === "field-notes" ? "FIELD NOTES" : "A LIVING STUDIO");
  setText(card.querySelector(".profile-receipt-count"), data.activity?.enabled === true ? `${number(streamEvents(data.activity).length)} recent events` : "Activity labels are private");
  if (card.dataset.profileLayout !== layout) {
    const focus = card.contains(document.activeElement) ? document.activeElement : null;
    const desk = card.querySelector(".profile-desk"), weekly = card.querySelector(".profile-weekly"), categories = card.querySelector(".profile-category-summary");
    main.append(...(layout === "field-notes" ? [highlights, weekly, desk, categories] : [desk, weekly, highlights, categories]));
    card.dataset.profileLayout = layout;
    if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
  }
}

function profileTools(tools = [], headingTag = "h2") {
  const totalTools = tools.reduce((sum, tool) => sum + tool.count, 0);
  return h("section", { class: "profile-tools" }, h("div", { class: "profile-section-heading" }, h(headingTag, {}, "Across the tools"), h("span", {}, `${tools.length} categories`)),
    tools.length ? tools.map(tool => {
      const [label, name] = categories[tool.category] || categories.other;
      return h("div", { class: "profile-tool" }, h("span", { class: "tool-label" }, icon(name, { size: 15 }), label), h("div", { class: "tool-meter", "aria-hidden": "true" }, h("div", { style: `width:${Math.max(2, totalTools ? tool.count / totalTools * 100 : 0)}%` })), h("span", { class: "tool-count" }, number(tool.count)));
    }) : h("p", { class: "muted" }, "No activity counts to show yet."));
}

export function liveActivity(live = {}, { headingTag = "h3" } = {}) {
  const stale = Number(live.staleActions || 0);
  return h("section", { class: "profile-live", "aria-label": "Live agent activity" },
    h("div", { class: "live-metrics" }, [["workingAgents", "Working now", "Agents with a fresh running action"], ["recentlyActiveAgents", "Recently active", "Agents that reported or used Engram in the last 15 minutes"]].map(([key, label, title]) => h("div", { title }, h("strong", { "data-public-live": key }, number(live[key])), h("span", {}, label)))),
    h("p", { class: "live-explanation" }, "Signals received in the last 15 minutes."),
    h("p", { class: "live-stale", hidden: !stale }, staleText(stale)));
}

const staleText = count => `${number(count)} running ${count === 1 ? "action has" : "actions have"} no recent update and ${count === 1 ? "is" : "are"} excluded from working now.`;

// Update numbers in place so live snapshots never steal keyboard focus or reset
// the date a visitor is exploring on the contribution chart.
export function updateProfileCard(card, data) {
  const { stats, profile, daily = [] } = data;
  updateActivityStream(card.querySelector(".public-stream"), data.activity);
  updatePresentation(card, data);
  updateWeekPulse(card.querySelector(".profile-weekly"), daily);
  updateProfileTimes(card);
  card.querySelector(".profile-footnote p").textContent = privacyText(data.activity?.enabled === true, profileHighlights(profile).length > 0);
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  card.querySelectorAll("[data-public-stat]").forEach(node => text(node, number(stats[node.dataset.publicStat])));
  const labels = { totalActions: stats.totalActions === 1 ? "Action" : "Actions", activeAgents: stats.activeAgents === 1 ? "Agent" : "Agents", activeDays: stats.activeDays === 1 ? "Active day" : "Active days" };
  card.querySelectorAll("[data-public-label]").forEach(node => text(node, labels[node.dataset.publicLabel]));
  card.querySelectorAll("[data-public-live]").forEach(node => text(node, number(data.live?.[node.dataset.publicLive])));
  const stale = card.querySelector(".live-stale");
  if (stale) { stale.hidden = !data.live?.staleActions; stale.textContent = staleText(data.live?.staleActions || 0); }
  const identity = card.querySelector(".profile-identity");
  text(identity.querySelector("h1, h2"), profile.displayName || "Your public profile");
  text(identity.querySelector("p"), profile.bio || "A small window into the work across my agents.");
  let grid = card.querySelector(".contribution-grid");
  if ([...grid.children].some((node, index) => node.dataset.date !== daily[index]?.date) || grid.children.length !== daily.length) {
    const focusedDate = grid.contains(document.activeElement) ? document.activeElement?.dataset?.date : null;
    const selectedDate = grid.dataset.selectedDate;
    const scrollLeft = grid.closest(".contribution-viewport").scrollLeft;
    const replacement = contributionGrid(daily, { headingTag: card.classList.contains("compact") ? "h3" : "h2" }); grid.closest(".contributions").replaceWith(replacement); grid = replacement.querySelector(".contribution-grid");
    if (selectedDate && [...grid.children].some(node => node.dataset.date === selectedDate)) {
      grid.dataset.selectedDate = selectedDate;
      [...grid.children].forEach(node => { node.tabIndex = node.dataset.date === selectedDate ? 0 : -1; });
    }
    if (focusedDate) ([...grid.children].find(node => node.dataset.date === focusedDate) || [...grid.children].at(-1))?.focus({ preventScroll: true });
    grid.closest(".contribution-viewport").scrollLeft = scrollLeft;
  }
  const maximum = Math.max(1, ...daily.map(day => day.count));
  const total = daily.reduce((sum, day) => sum + day.count, 0);
  for (const [index, cell] of [...grid.children].entries()) {
    const day = daily[index]; if (!day) continue;
    const label = `${number(day.count)} ${day.count === 1 ? "action" : "actions"} on ${new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`))}`;
    cell.className = `contribution-cell level-${day.count ? Math.max(1, Math.ceil(day.count / maximum * 4)) : 0}`;
    cell.title = label; cell.setAttribute("aria-label", label);
  }
  const selected = [...grid.children].find(node => node.dataset.date === grid.dataset.selectedDate);
  text(card.querySelector(".contribution-caption"), selected ? selected.getAttribute("aria-label") : `${number(total)} actions in the last 12 weeks`);
  const tools = JSON.stringify(data.tools || []);
  if (card.dataset.tools !== tools) {
    const updatedTools = profileTools(data.tools || [], card.classList.contains("compact") ? "h3" : "h2");
    card.querySelector(".profile-tools").replaceWith(updatedTools); card.dataset.tools = tools;
    updateCategories(card.querySelector(".profile-category-summary"), data.tools || []);
  }
}

export function profileSkeleton() {
  return h("div", { class: "profile-skeleton", role: "status", "aria-busy": "true", "aria-label": "Loading activity profile" },
    h("div", { class: "ds-skeleton", "data-size": "short" }), h("div", { class: "ds-skeleton", "data-size": "heading" }), h("div", { class: "ds-skeleton" }),
    h("div", { class: "skeleton-stats" }, [1, 2, 3].map(() => h("div", { class: "ds-skeleton", "data-size": "heading" }))),
    h("div", { class: "skeleton-chart" }, Array.from({ length: 84 }, () => h("span", { class: "ds-skeleton" }))));
}
