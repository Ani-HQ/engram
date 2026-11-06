import { h } from "./profile.js";
import { barList, columnChart, dataTable, emptyState, loadingState, observeLoadingMotion } from "./design-system.js";
import { icon } from "./icons.js";

// Operator-only site analytics: traffic, sources, the sign-up funnel and the
// people who joined. Counts come from /api/admin/analytics; nothing is invented.

export const ANALYTICS_WINDOWS = [7, 30, 90];
const CTA_LABELS = { "ask-invite": "Ask for an invite", "redeem-invite": "Redeem invite", "sign-in": "Sign in", "self-host": "Self-host", pricing: "Pricing", "how-it-works": "How it works", source: "Source on GitHub", support: "Support" };
const number = value => new Intl.NumberFormat().format(Number(value) || 0);
const dayLabel = iso => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const when = iso => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso)) + " UTC";
const yesNo = value => h("span", { class: value ? "analytics-yes" : "analytics-no" }, icon(value ? "circle-check" : "circle-dashed", { size: 14 }), value ? "Yes" : "Not yet");

function metric(label, value, note) {
  return h("div", { class: "ds-metric" }, h("span", { class: "ds-metric-label" }, label), h("span", { class: "ds-metric-value" }, number(value)), note && h("span", { class: "ds-metric-note" }, note));
}
function section(title, description, ...body) {
  return h("section", { class: "ds-panel analytics-section" }, h("div", { class: "ds-panel-header" }, h("h2", {}, title), description && h("p", {}, description)), h("div", { class: "ds-panel-body" }, ...body));
}
function quiet(glyph, title, description) {
  const node = emptyState({ glyph: icon(glyph, { size: 22 }), title, description }); node.setAttribute("data-variant", "dashed"); return node;
}

/** Pure: turn the API payload into the numbers the view shows. Exported for tests. */
export function analyticsSummary(data) {
  const traffic = data?.traffic ?? {}, funnel = data?.funnel ?? {};
  const people = Array.isArray(data?.people) ? data.people : [];
  return {
    pageviews: Number(traffic.pageviews) || 0,
    visitorDays: Number(traffic.visitor_days) || 0,
    signupForms: Number(traffic.signups_submitted) || 0,
    newPeople: people.length,
    anyoneSignedUp: people.length > 0,
    funnel: [
      { label: "Workspaces created", value: Number(funnel.workspaces_created) || 0 },
      { label: "Agent connected", value: Number(funnel.with_agent_call) || 0 },
      { label: "Saved a memory", value: Number(funnel.saved_memory) || 0 },
      { label: "Recalled a memory", value: Number(funnel.recalled_memory) || 0 },
      { label: "Saved a handoff", value: Number(funnel.saved_handoff) || 0 },
      { label: "Resumed a handoff", value: Number(funnel.resumed_handoff) || 0 },
      { label: "Started checkout", value: Number(funnel.started_checkout) || 0 },
      { label: "Paying", value: Number(funnel.paying) || 0 },
    ],
  };
}

export function analyticsView({ api, fail = () => {}, isCurrent = () => true, initialDays = 30 }) {
  let days = ANALYTICS_WINDOWS.includes(initialDays) ? initialDays : 30, request = 0, disposed = false;
  const body = h("div", { class: "analytics-body" });
  const status = h("p", { class: "ds-sr-only", role: "status" });
  const refresh = h("button", { type: "button", class: "small", onclick: () => load() }, icon("refresh-cw", { size: 14 }), "Refresh");
  const windowSelect = h("select", { id: "analytics-window", name: "window", onchange: event => { days = Number(event.target.value); load(); } },
    ANALYTICS_WINDOWS.map(value => h("option", { value: String(value), selected: value === days }, `Last ${value} days`)));
  const toolbar = h("div", { class: "ds-toolbar analytics-toolbar" },
    h("label", { class: "ds-field analytics-window" }, h("span", { class: "ds-sr-only" }, "Time window"), windowSelect), refresh);
  const element = h("div", { class: "analytics-view" }, toolbar, status, body);
  const stopMotion = typeof document !== "undefined" ? observeLoadingMotion(element) : () => {};

  function render(data) {
    const summary = analyticsSummary(data);
    const daily = Array.isArray(data.daily) ? data.daily : [];
    const signedUp = summary.anyoneSignedUp
      ? dataTable({ caption: "People who joined", columns: [{ key: "email", label: "Email" }, { key: "joined", label: "Joined" }, { key: "how", label: "How" }, { key: "workspace", label: "Workspace" }, { key: "agent", label: "Agent connected" }, { key: "memory", label: "Saved memory" }],
        rows: data.people.map(person => ({ email: person.email, joined: when(person.joinedAt), how: person.how, workspace: person.workspace, agent: yesNo(person.agentConnected), memory: yesNo(person.savedMemory) })) })
      : quiet("user-plus", `No one new in the last ${days} days`, summary.signupForms ? `${number(summary.signupForms)} sign-up forms were sent, but nobody finished email verification yet.` : "Nobody has sent the sign-up form in this window.");
    const hasTraffic = summary.pageviews > 0;
    body.replaceChildren(
      h("div", { class: "ds-metric-grid analytics-metrics" },
        metric("New people", summary.newPeople, "First joined in this window"),
        metric("Sign-up forms sent", summary.signupForms, "Before email verification"),
        metric("Page views", summary.pageviews, "Public pages and app"),
        metric("Visitor-days", summary.visitorDays, "One visitor counted once per day")),
      section("Did anyone sign up?", summary.anyoneSignedUp ? `${number(summary.newPeople)} ${summary.newPeople === 1 ? "person" : "people"} joined Engram for the first time.` : "", signedUp),
      section("Visitors per day", "UTC days. Hover a column for the exact counts.",
        hasTraffic ? columnChart(daily.map(row => ({ label: row.day, value: row.visitors, title: `${dayLabel(row.day)}: ${number(row.visitors)} visitors, ${number(row.pageviews)} views${row.signup_forms ? `, ${number(row.signup_forms)} sign-up forms` : ""}` })),
          { label: `Visitors per day, last ${days} days`, startLabel: daily.length ? dayLabel(daily[0].day) : "", endLabel: daily.length ? dayLabel(daily[daily.length - 1].day) : "" })
          : quiet("activity", "No visits recorded yet", "Visits from browsers with Do Not Track or Global Privacy Control on are never counted.")),
      section("Sign-up funnel", "Workspaces created in this window and how far they got.",
        summary.funnel[0].value ? barList(summary.funnel, { label: "Sign-up funnel", max: summary.funnel[0].value }) : quiet("filter", "No workspaces created yet", "Steps fill in once someone signs up and connects an agent.")),
      h("div", { class: "analytics-grid" },
        section("Top pages", "",
          data.pages?.length ? dataTable({ caption: "Top pages", columns: [{ key: "path", label: "Page" }, { key: "views", label: "Views", numeric: true }, { key: "visitor_days", label: "Visitor-days", numeric: true }], rows: data.pages }) : quiet("file-text", "No page views yet", "")),
        section("Where visitors came from", "Referring sites, by visitor-days.",
          data.referrers?.length ? barList(data.referrers.map(row => ({ label: row.referrer, value: row.visitor_days })), { label: "Referrers" }) : quiet("globe", "No referrers yet", ""))),
      h("div", { class: "analytics-grid" },
        section("Button clicks", "Named calls to action on the site.",
          data.ctas?.length ? barList(data.ctas.map(row => ({ label: CTA_LABELS[row.cta] || row.cta, value: row.clicks })), { label: "Button clicks" }) : quiet("circle-dashed", "No clicks yet", "")),
        section("Campaigns", "Visits that arrived with utm tags.",
          data.campaigns?.length ? dataTable({ caption: "Campaigns", columns: [{ key: "name", label: "Source / medium / campaign" }, { key: "visitor_days", label: "Visitor-days", numeric: true }, { key: "invite_requests", label: "Invite asks", numeric: true }, { key: "signups_submitted", label: "Sign-ups", numeric: true }],
            rows: data.campaigns.map(row => ({ ...row, name: `${row.source} / ${row.medium} / ${row.campaign}` })) }) : quiet("tag", "No tagged visits yet", "Add utm_source and utm_campaign to links you share."))),
      h("ul", { class: "analytics-notes" }, (data.notes || []).map(note => h("li", {}, note))));
    status.textContent = `Analytics loaded for the last ${days} days.`;
  }

  async function load() {
    const id = ++request;
    refresh.disabled = true; windowSelect.disabled = true; refresh.setAttribute("aria-busy", "true");
    body.setAttribute("aria-busy", "true");
    body.replaceChildren(loadingState({ label: "Loading site analytics…", lines: 4 }));
    try {
      const data = await api.analytics(days);
      if (disposed || id !== request || !isCurrent()) return;
      render(data);
    } catch (error) {
      if (disposed || id !== request || !isCurrent()) return;
      fail(error);
      body.replaceChildren(h("div", { class: "notice", role: "alert" }, error?.status === 403 ? "Only the signup operator can see site analytics." : "Analytics could not be loaded.", error?.status !== 403 && h("button", { type: "button", class: "text small", onclick: () => load() }, "Try again")));
    } finally {
      if (!disposed && id === request) { refresh.disabled = false; windowSelect.disabled = false; refresh.setAttribute("aria-busy", "false"); body.setAttribute("aria-busy", "false"); }
    }
  }

  load();
  return { element, dispose() { disposed = true; stopMotion(); } };
}
