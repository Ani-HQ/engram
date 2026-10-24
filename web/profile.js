import { icon } from "./icons.js";

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
const categories = { code: ["Code", "code"], files: ["Files", "file-text"], email: ["Email", "mail"], calendar: ["Calendar", "calendar"], cloud: ["Cloud", "cloud"], browser: ["Browser", "globe"], data: ["Data", "database"], memory: ["Memory", "brain"], other: ["Other tools", "plug"] };

export function contributionGrid(daily = []) {
  const maximum = Math.max(1, ...daily.map(day => day.count));
  const count = daily.reduce((sum, day) => sum + day.count, 0);
  const live = h("span", { class: "contribution-caption", "aria-live": "polite" }, `${number(count)} actions in the last 12 weeks`);
  const cells = daily.map((day, index) => {
    const label = `${number(day.count)} ${day.count === 1 ? "action" : "actions"} on ${new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`))}`;
    const showDay = event => { grid.dataset.selectedDate = day.date; live.textContent = event.currentTarget.getAttribute("aria-label"); };
    return h("button", { type: "button", class: `contribution-cell level-${day.count ? Math.max(1, Math.ceil(day.count / maximum * 4)) : 0}`, "data-date": day.date, tabindex: index === daily.length - 1 ? "0" : "-1", title: label, "aria-label": label, onclick: showDay, onfocus: showDay });
  });
  const grid = h("div", { class: "contribution-grid", role: "group", "aria-label": "Daily activity for the last 12 weeks. Use arrow keys to explore.", onkeydown: event => {
    const current = cells.indexOf(document.activeElement);
    const offset = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (current < 0 || offset === undefined) return;
    event.preventDefault(); const next = Math.min(cells.length - 1, Math.max(0, current + offset));
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
    h("div", { class: "profile-section-heading" }, h("h3", {}, "The work adds up."), h("span", {}, "Last 12 weeks")),
    h("div", { class: "contribution-months", "aria-hidden": "true" }, months),
    h("div", { class: "contribution-layout" }, h("div", { class: "contribution-weekdays", "aria-hidden": "true" }, weekLabels), grid),
    h("div", { class: "contribution-footer" }, live, h("div", { class: "contribution-legend", "aria-hidden": "true" }, "Less", [0, 1, 2, 3, 4].map(level => h("span", { class: `contribution-cell level-${level}` })), "More")));
}

export function profileCard(data, { compact = false } = {}) {
  const { profile, stats, tools = [], daily = [] } = data;
  const totalTools = tools.reduce((sum, tool) => sum + tool.count, 0);
  return h("article", { class: `public-profile${compact ? " compact" : ""}`, "data-tools": JSON.stringify(tools) },
    h("div", { class: "profile-eyebrow" }, icon("activity", { size: 14 }), "AGENT ACTIVITY"),
    h("header", { class: "profile-identity" }, h("div", { class: "profile-avatar", "aria-hidden": "true" }, Array.from(profile.displayName || "A")[0].toUpperCase()),
      h("div", {}, h(compact ? "h2" : "h1", {}, profile.displayName || "Your public profile"), h("p", {}, profile.bio || "A shared history of the work my agents do."))),
    liveActivity(data.live),
    h("div", { class: "profile-statistics", "aria-label": "All-time activity totals" }, [["totalActions", stats.totalActions === 1 ? "Action" : "Actions", stats.totalActions], ["activeAgents", stats.activeAgents === 1 ? "Agent" : "Agents", stats.activeAgents], ["activeDays", stats.activeDays === 1 ? "Active day" : "Active days", stats.activeDays]].map(([key, label, value]) => h("div", {}, h("strong", { "data-public-stat": key }, number(value)), h("span", { "data-public-label": key }, label)))),
    contributionGrid(daily),
    h("section", { class: "profile-tools" }, h("div", { class: "profile-section-heading" }, h("h3", {}, "Across my tools"), h("span", {}, `${tools.length} categories`)),
      tools.length ? tools.map(tool => {
        const [label, name] = categories[tool.category] || categories.other;
        return h("div", { class: "profile-tool" }, h("span", { class: "tool-label" }, icon(name, { size: 15 }), label), h("div", { class: "tool-meter", "aria-hidden": "true" }, h("div", { style: `width:${Math.max(2, totalTools ? tool.count / totalTools * 100 : 0)}%` })), h("span", { class: "tool-count" }, number(tool.count)));
      }) : h("p", { class: "muted" }, "Activity will appear as agents start working.")),
    h("footer", { class: "profile-footnote" }, icon("shield-check", { size: 14 }), "Only activity counts are public. Task content stays private."));
}

export function liveActivity(live = {}) {
  const stale = Number(live.staleActions || 0);
  return h("section", { class: "profile-live", "aria-label": "Live agent activity" },
    h("div", { class: "profile-section-heading" }, h("h3", {}, "Right now"), h("span", {}, "Reported in the last 15 minutes")),
    h("div", { class: "live-metrics" }, [["workingAgents", "Working now", "Agents with a fresh running action"], ["recentlyActiveAgents", "Recently active", "Agents that reported or used Engram in the last 15 minutes"], ["completedAgents", "Completed work", "Agents with at least one completed action, all time"]].map(([key, label, title]) => h("div", { title }, h("strong", { "data-public-live": key }, number(live[key])), h("span", {}, label)))),
    h("p", { class: "live-explanation" }, "Based on reported actions and Engram operations. Completed work counts agents over all time."),
    h("p", { class: "live-stale", hidden: !stale }, staleText(stale)));
}

const staleText = count => `${number(count)} running ${count === 1 ? "action has" : "actions have"} no recent update and ${count === 1 ? "is" : "are"} excluded from working now.`;

// Update numbers in place so live snapshots never steal keyboard focus or reset
// the date a visitor is exploring on the contribution chart.
export function updateProfileCard(card, data) {
  const { stats, profile, daily = [] } = data;
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  card.querySelectorAll("[data-public-stat]").forEach(node => text(node, number(stats[node.dataset.publicStat])));
  const labels = { totalActions: stats.totalActions === 1 ? "Action" : "Actions", activeAgents: stats.activeAgents === 1 ? "Agent" : "Agents", activeDays: stats.activeDays === 1 ? "Active day" : "Active days" };
  card.querySelectorAll("[data-public-label]").forEach(node => text(node, labels[node.dataset.publicLabel]));
  card.querySelectorAll("[data-public-live]").forEach(node => text(node, number(data.live?.[node.dataset.publicLive])));
  const stale = card.querySelector(".live-stale");
  if (stale) { stale.hidden = !data.live?.staleActions; stale.textContent = staleText(data.live?.staleActions || 0); }
  const identity = card.querySelector(".profile-identity");
  text(identity.querySelector("h1, h2"), profile.displayName || "Your public profile");
  text(identity.querySelector("p"), profile.bio || "A shared history of the work my agents do.");
  text(identity.querySelector(".profile-avatar"), Array.from(profile.displayName || "A")[0].toUpperCase());
  let grid = card.querySelector(".contribution-grid");
  if ([...grid.children].some((node, index) => node.dataset.date !== daily[index]?.date) || grid.children.length !== daily.length) {
    const focusedDate = document.activeElement?.dataset?.date;
    const replacement = contributionGrid(daily); grid.closest(".contributions").replaceWith(replacement); grid = replacement.querySelector(".contribution-grid");
    if (focusedDate) [...grid.children].find(node => node.dataset.date === focusedDate)?.focus();
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
    const updatedTools = profileCard(data, { compact: card.classList.contains("compact") }).querySelector(".profile-tools");
    card.querySelector(".profile-tools").replaceWith(updatedTools); card.dataset.tools = tools;
  }
}

export function profileSkeleton() {
  return h("div", { class: "profile-skeleton", role: "status", "aria-label": "Loading activity profile" },
    h("div", { class: "skeleton-line", style: "width:110px" }), h("div", { class: "skeleton-line tall", style: "width:70%" }), h("div", { class: "skeleton-line", style: "width:90%" }),
    h("div", { class: "skeleton-stats" }, [1, 2, 3].map(() => h("div", { class: "skeleton-line tall" }))),
    h("div", { class: "skeleton-chart" }, Array.from({ length: 84 }, () => h("span", { class: "skeleton-line" }))));
}
