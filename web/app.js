import { api, AuthError, workspaceApi } from "./api.js";
import { icon } from "./icons.js";
import { profileCard, profileSkeleton, updateProfileCard } from "./profile.js";
import { billingPanel, workspacePanel, workspacePending, provisioningPanel } from "./account.js";
import { watchPublicActivity } from "./live-activity.js";
import { activityFeed, activityFilters, activitySkeleton, activityDetail, activityDetailHeader, refreshActivityTimes } from "./activity-view.js";
import { agentVisual, visualIcon, agentSources, toolVisual } from "./tooling.js";
import { activityKind as normalizeActivityKind, connectionIdentity, withConnectionIdentity } from "./connection-model.js";
import { agentOverview, connectionInventory } from "./connection-view.js";
import { memoryLoading, setMemoryLoadingDelayed } from "./memory-loading.js";
import { memoryDocumentView } from "./memory-document-view.js";
import { taskReportingSetup, taskReportingInstructions } from "./task-reporting-view.js";
import { taskReportingStatus } from "./task-reporting-model.js";
import { aiConfiguration, attentionResults } from "./insights-view.js";
import { confidenceLabel, reviewAllowed, reviewPlan } from "./insight-model.js";
import { onboardingGuide } from "./onboarding-view.js";
import { agentConnectionGuide, accessKeyConfiguration, onboardingProgress, shouldOfferOnboarding, createOnboardingReader } from "./onboarding-model.js";

const root = document.querySelector("#app");
const state = {
  session: null, view: "activity", activityKind: "all", activities: [], activityStats: {}, checkedAt: null, freshIds: new Set(), agents: [], tools: [], memories: [], tokens: [],
  connections: null, connectionError: "", connectionFetchedAt: 0,
  filters: { q: "", agent: "", tool: "", status: "", resource: "", runId: "" },
  account: null,
  insights: null, insightsQuery: "", insightsActivityId: "", insightBusy: false, insightError: "",
  memoryTab: "saved", reviews: [], reviewState: "pending", reviewMore: false,
  memoryQuery: "", more: false, loading: false, error: "", demo: Boolean(document.querySelector('meta[name="engram-demo"]')), mcp: "", token: null, showcase: null, showcaseDraft: null,
};
let generation = 0;
let searchTimer, memoryLoadingTimer;
let returnFocus, returnActivityFocus, returnFocusSelector = null, pendingActivityRender = false;
let detailGeneration = 0;
let showcaseSaving = false;
let previewWatcher;
let currentActivity, activityRequest = 0, activityRefreshTimer;
let inputMode = "pointer";
let sessionMutation = false, authEpoch = 0;
let insightTimer, pendingInsightRun = false;
let provisioningTimer, provisioningChecking = false, provisioningError = "", provisioningAttempt = 0;
let connectionDraft = null, connectionFocusPending = null, skipDetailReturnFocus = false;
const setupByWorkspace = new Map();
const setupReader = createOnboardingReader(workspaceId => api.onboarding(workspaceId), () => state.session?.org.id);
const dialog = el("dialog", { class: "detail", "aria-labelledby": "detail-title" });
dialog.addEventListener("click", event => { if (event.target === dialog) closeDetail(); });
dialog.addEventListener("close", () => {
  clearDetailContents();
  clearTimeout(memoryLoadingTimer);
  const wasActivity = Boolean(currentActivity);
  detailGeneration += 1; currentActivity = null; ++activityRequest; clearTimeout(activityRefreshTimer);
  if (pendingActivityRender) { pendingActivityRender = false; refreshActivityResults(); }
  const card = returnActivityFocus && [...document.querySelectorAll(".activity-card")].find(node => node.dataset.activityId === returnActivityFocus.id);
  const opener = card && [...card.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === returnActivityFocus.key);
  const stableOpener = returnFocusSelector && document.querySelector(returnFocusSelector);
  if (skipDetailReturnFocus) skipDetailReturnFocus = false;
  else if (opener) opener.focus(); else if (stableOpener) stableOpener.focus(); else if (returnFocus?.isConnected) returnFocus.focus();
  returnFocusSelector = null;
  returnActivityFocus = null;
  if (wasActivity && state.session && state.view === "activity" && !state.loading && !sessionMutation) loadActivity({ quiet: true });
});
document.body.append(dialog);
const announcements = el("div", { class: "sr-only", role: "status", "aria-live": "polite" });
document.body.append(announcements);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else if (key === "checked") node.checked = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const button = (label, action, attrs = {}) => el("button", { type: "button", onclick: action, ...attrs }, label);
function iconButton(name, label, action, attrs = {}) {
  return button(icon(name, { size: 16 }), action, { class: "icon-button", title: label, "aria-label": label, ...attrs });
}
function copyButton(label, value, attrs = {}) {
  const node = button([icon("copy", { size: 14 }), label], async () => {
    const original = [...node.childNodes];
    if (await copy(typeof value === "function" ? value() : value)) {
      node.replaceChildren(icon("check", { size: 14 }), "Copied");
      setTimeout(() => { if (node.isConnected) node.replaceChildren(...original); }, 2000);
    }
  }, { class: "small", ...attrs });
  return node;
}
function busy(button, label, pending) { button.disabled = pending; button.replaceChildren(...(pending ? [icon("loader-circle", { size: 14, class: "spin" }), label] : [label])); }
function skeletonRows(count = 5) {
  return el("div", { class: "skeleton-rows", role: "status", "aria-label": "Loading activity" }, Array.from({ length: count }, () => el("div", { class: "skeleton-row" }, el("span", { class: "skeleton-line" }), el("span", { class: "skeleton-line" }), el("div", {}, el("span", { class: "skeleton-line" }), el("span", { class: "skeleton-line short" })), el("span", { class: "skeleton-line" }))));
}
const option = (value, label) => el("option", { value }, label);
function select(label, value, options, change) {
  const node = el("select", { "aria-label": label, onchange: event => change(event.target.value) }, options.map(([key, text]) => option(key, text)));
  node.value = value;
  return node;
}
const field = (label, input) => el("label", { class: "field" }, label, input);
const day = value => date(value, { month: "short", day: "numeric", year: "numeric" });
function date(value, options) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, options).format(parsed);
}
function errorMessage(error) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = el("div", { class: "toast", role: "status" }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 3500);
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); announcements.textContent = "Copied to clipboard"; return true; }
  catch { toast("Could not copy. Select and copy the text instead."); return false; }
}
function clearDetailContents() {
  // This dialog is reused. Erase fields before detaching its contents so neither
  // a hidden input nor its copy/reveal listeners keep a one-time key reachable.
  for (const field of dialog.querySelectorAll("input, textarea")) { field.value = ""; field.removeAttribute("value"); }
  dialog.replaceChildren();
}
function closeDetail() { clearTimeout(memoryLoadingTimer); detailGeneration += 1; dialog.close(); clearDetailContents(); }
function showDetail(title, body, { activity = false, memory = false, reporting = false, returnTo = null } = {}) {
  const previousFocus = document.activeElement;
  const restoreDetailFocus = dialog.open && dialog.contains(previousFocus);
  const restoreCloseFocus = restoreDetailFocus && previousFocus.closest?.(".detail-close-controls");
  clearTimeout(memoryLoadingTimer);
  detailGeneration += 1;
  if (!activity) { currentActivity = null; ++activityRequest; clearTimeout(activityRefreshTimer); }
  dialog.classList.toggle("activity-detail", activity);
  dialog.classList.toggle("memory-detail", memory);
  dialog.classList.toggle("task-reporting-detail", reporting);
  dialog.classList.toggle("motion-open", !dialog.open && inputMode === "pointer");
  if (!dialog.open) {
    returnFocus = document.activeElement;
    returnFocusSelector = returnTo;
    const card = returnFocus?.closest(".activity-card");
    returnActivityFocus = card ? { id: card.dataset.activityId, key: returnFocus.dataset.focusKey } : null;
  }
  dialog.replaceChildren(
    el("div", { class: "detail-header" }, el("span", {}, title), el("div", { class: "detail-close-controls" }, el("kbd", {}, "Esc"), iconButton("x", "Close details", closeDetail))),
    el("div", { class: "detail-body" }, body),
  );
  if (!dialog.open) { dialog.showModal(); dialog.scrollTop = 0; }
  else if (restoreDetailFocus) {
    const target = restoreCloseFocus ? dialog.querySelector(".detail-close-controls button") : dialog.querySelector("#detail-title");
    if (target) { if (!restoreCloseFocus) target.setAttribute("tabindex", "-1"); target.focus({ preventScroll: true }); }
  }
}
function empty(title, description, action) { return el("div", { class: "empty" }, el("div", { class: "empty-icon" }, icon("activity", { size: 22 })), el("h2", {}, title), el("p", {}, description), action); }
function heading(title, description, side) {
  return el("div", { class: "page-heading" }, el("div", {}, el("h1", {}, title), el("p", {}, description)), side);
}
function notice(message, retry) {
  return el("div", { class: "notice", role: "alert" }, message, retry && button("Try again", retry, { class: "text small" }));
}
function writeRoute() {
  const query = new URLSearchParams();
  if (state.view === "activity") {
    if (state.activityKind !== "all") query.set("kind", state.activityKind);
    Object.entries(state.filters).forEach(([key, value]) => value && query.set(key, value));
  }
  if (state.view === "memory" && state.memoryTab === "review") { query.set("tab", "review"); if (state.reviewState !== "pending") query.set("state", state.reviewState); }
  history.replaceState(null, "", `#${state.view}${query.size ? `?${query}` : ""}`);
}
function readRoute() {
  const [view, query = ""] = location.hash.slice(1).split("?");
  state.view = ["activity", "attention", "memory", "connect", "showcase", "workspace", "billing"].includes(view) ? view : "activity";
  if (state.view !== "connect") connectionFocusPending = null;
  const params = new URLSearchParams(query);
  state.activityKind = normalizeActivityKind(params.get("kind"));
  for (const key of Object.keys(state.filters)) state.filters[key] = params.get(key) || "";
  state.memoryTab = params.get("tab") === "review" ? "review" : "saved";
  state.reviewState = ["pending", "deferred", "applied", "rejected", "approved"].includes(params.get("state")) ? params.get("state") : "pending";
}
function setupState() {
  if (!state.session || !["owner", "member"].includes(state.session.role)) return null;
  const workspaceId = state.session.org.id;
  if (!setupByWorkspace.has(workspaceId)) {
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(`engram-setup-dismissed:${workspaceId}`) === "1"; } catch {}
    setupByWorkspace.set(workspaceId, { data: state.session.onboarding, visible: !dismissed && shouldOfferOnboarding(state.session.onboarding), agentId: "", checking: false, error: "" });
  }
  return setupByWorkspace.get(workspaceId);
}
function setupPanel() {
  const setup = setupState();
  if (!setup?.visible) return null;
  return onboardingGuide({ ...setup, mcp: state.mcp || `${location.origin}/mcp`, policies: state.session.org.policies, inventory: state.connections, demo: state.demo,
    onChoose: agentId => { setup.agentId = agentId; renderSetup(); },
    onCheck: refreshSetup, onDismiss: dismissSetup, onReporting: taskReportingHelp,
    onCreateKey: agentId => {
      const workspaceId = state.session.org.id;
      connectionDraft = { name: "", harness: agentSources.some(([key]) => key === agentId) || agentId === "vscode" ? agentId : "other", canWrite: true };
      connectionFocusPending = { workspaceId, afterLoad: state.view !== "connect" };
      if (state.view !== "connect") location.hash = "connect";
      else { render(); requestAnimationFrame(() => focusConnectionKey()); }
    }, copyControl: copyButton });
}
function renderSetup(focusTitle = false) {
  const slot = document.querySelector("#setup-slot");
  if (!slot) return;
  const focusKey = slot.contains(document.activeElement) ? document.activeElement?.dataset.setupFocus : null;
  const panel = setupPanel(); slot.replaceChildren(...(panel ? [panel] : []));
  const target = focusTitle ? slot.querySelector("#setup-title") : focusKey ? [...slot.querySelectorAll("[data-setup-focus]")].find(node => node.dataset.setupFocus === focusKey) : null;
  target?.focus({ preventScroll: true });
}
function openSetup() {
  const setup = setupState(); if (!setup) return;
  setup.visible = true;
  try { sessionStorage.removeItem(`engram-setup-dismissed:${state.session.org.id}`); } catch {}
  renderSetup(true); refreshSetup();
}
function dismissSetup() {
  const setup = setupState(); if (!setup) return;
  setup.visible = false;
  try { sessionStorage.setItem(`engram-setup-dismissed:${state.session.org.id}`, "1"); } catch {}
  renderSetup(); document.querySelector(".setup-resume")?.focus({ preventScroll: true });
}
async function refreshSetup() {
  const setup = setupState(); if (!setup || setup.checking || workspacePending(state.session)) return;
  const workspaceId = state.session.org.id;
  setup.checking = true; setup.error = ""; renderSetup();
  try {
    const result = await setupReader.read(workspaceId);
    if (result.stale) return;
    if (!onboardingProgress(result.data).available) throw new Error("Progress could not be checked. Please try again.");
    setup.data = result.data; state.session.onboarding = result.data;
    announcements.textContent = onboardingProgress(result.data).done ? "Your agent has connected, saved memory, and read memory." : `${onboardingProgress(result.data).completed} of 3 getting started steps complete.`;
  } catch (error) {
    if (state.session?.org.id !== workspaceId) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
    setup.error = errorMessage(error);
  } finally { setup.checking = false; if (state.session?.org.id === workspaceId) renderSetup(); }
}
function render() {
  previewWatcher?.stop(); previewWatcher = null;
  if (!state.session) return;
  if (workspacePending(state.session)) {
    root.replaceChildren(provisioningPanel({ session: state.session, checking: provisioningChecking, error: provisioningError,
      retry: () => pollProvisioning(), signOut, switchOrg }));
    return;
  }
  const orgs = state.session.orgs?.length ? state.session.orgs : [state.session.org];
  const titles = { activity: "Activity", attention: "Attention", memory: "Memory", connect: "Connections", showcase: "Public profile", workspace: "Workspace", billing: "Plan & billing" };
  const navigation = [["activity", "Activity", "activity"], ["attention", "Attention", "layers"], ["memory", "Memory", "brain"], ["connect", "Connections", "plug"]];
  if (state.session.role === "owner") navigation.push(["showcase", "Public profile", "globe"]);
  if (["owner", "member"].includes(state.session.role)) navigation.push(["workspace", "Workspace", "settings-2"]);
  if (state.session.role === "owner") navigation.push(["billing", "Plan & billing", "file-text"]);
  root.replaceChildren(
    ...(state.demo ? [el("div", { class: "demo" }, "LOCAL PREVIEW", el("span", {}, "Sample data · No connected accounts are being monitored"))] : []),
    el("div", { class: "app-shell" },
      el("aside", { class: "sidebar", "aria-label": "Workspace navigation" },
        el("a", { class: "wordmark", href: "#activity", "aria-label": "engram home" }, el("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 27, height: 27, alt: "" }), "engram"),
        el("div", { class: "workspace-picker" }, el("span", { class: "workspace-initial", "aria-hidden": "true" }, state.session.org.name.slice(0, 1).toUpperCase()), select("Workspace", String(state.session.org.id), orgs.map(org => [String(org.id), org.name]), switchOrg)),
        el("nav", { class: "nav", "aria-label": "Main navigation" }, navigation.map(([key, label, name]) => el("a", { href: `#${key}`, "aria-current": state.view === key ? "page" : null }, icon(name, { size: 17 }), el("span", {}, label)))),
        el("div", { class: "sidebar-bottom" }, el("a", { class: "workspace-note", href: "/privacy" }, icon("shield-check", { size: 14 }), "Private by default"), button([icon("log-out", { size: 15 }), "Sign out"], signOut, { class: "text" }))),
      el("div", { class: "main-column" },
        el("div", { class: "app-topbar" }, el("div", { class: "breadcrumbs" }, el("span", {}, state.session.org.name), icon("chevron-right", { size: 13 }), el("span", {}, titles[state.view])),
          el("div", { class: "topbar-actions" }, setupState() && button("Get started", openSetup, { class: "text small setup-resume", "aria-controls": "setup-slot" }), state.session.role === "owner" && state.view !== "showcase" && button([icon("share-2", { size: 14 }), "Share activity"], () => { location.hash = "showcase"; }, { class: "small" }), iconButton("log-out", "Sign out", signOut, { class: "icon-button mobile-signout" }))),
        el("main", { class: "workspace", id: "main" }, el("div", { id: "setup-slot" }, setupPanel()), state.view === "activity" ? activityView() : state.view === "attention" ? attentionView() : state.view === "memory" ? memoryView() : state.view === "showcase" ? showcaseView() : ["workspace", "billing"].includes(state.view) ? accountView() : connectView()))));
  if (state.view === "showcase" && state.showcase?.profile.published) watchPreview();
  setSessionControlsBusy(sessionMutation);
}
function watchPreview() {
  const orgId = state.session.org.id, slug = state.showcase.profile.slug;
  const status = document.querySelector(".preview-label > span");
  previewWatcher = watchPublicActivity(state.showcase.urls.stream || `${state.showcase.urls.json}/stream`, {
    snapshot: data => {
      if (state.session?.org.id !== orgId || state.view !== "showcase" || data.profile.slug !== slug) return;
      state.showcase.preview = data;
      const card = document.querySelector(".profile-preview-content .public-profile");
      if (card) updateProfileCard(card, { ...data, profile: { ...data.profile, ...state.showcaseDraft } });
    },
    state: value => { if (status?.isConnected) status.textContent = { live: "Live public preview", connecting: "Connecting…", reconnecting: "Reconnecting…", paused: "Preview paused", closed: "Preview disconnected" }[value] || "Public preview"; },
    closed: () => { if (status?.isConnected) status.textContent = "Preview changed · reload to reconnect"; },
  });
  if (document.hidden) previewWatcher.pause();
}
function activityView() {
  const memory = state.activityKind === "memory";
  const search = el("input", { type: "search", class: "search", placeholder: "Search work, tools, or approaches…", "aria-label": "Search activity", value: state.filters.q,
    oninput: event => { state.filters.q = event.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => { writeRoute(); loadActivity(); }, 250); } });
  return [
    heading("Activity", memory ? "Memory reads, searches and changes across your agents." : state.activityKind === "tasks" ? "Progress and results reported by your agents." : "Memory calls and task reports across your agents.", el("div", { class: "activity-refresh-controls" },
      el("span", { class: "activity-refresh-label" }, el("span", { class: "activity-refresh-dot", "aria-hidden": "true" }), state.activities.length > 100 ? "History view · Updates paused" : "Auto-updates every 5s"),
      iconButton("refresh-cw", "Refresh activity", () => loadActivity(), { id: "activity-refresh" }))),
    el("div", { id: "activity-agent-overview" }, activityAgents()),
    el("div", { class: "activity-kind-switcher", role: "group", "aria-label": "Activity type" },
      [["all", "All activity", "activity"], ["tasks", "Tasks", "layers"], ["memory", "Memory", "brain"]].map(([kind, label, mark]) => button([icon(mark, { size: 15 }), label], () => changeActivityKind(kind), { "aria-pressed": String(state.activityKind === kind), "data-activity-kind": kind }))),
    activityFilters(state.activityStats, state.filters.status, value => filterActivities("status", value)),
    el("div", { class: "filters activity-search-filters" }, el("div", { class: "search-field" }, icon("search", { size: 16 }), search, el("kbd", {}, "/")),
      button([icon("route", { size: 13 }), "Search by intent"], () => launchInsights({ q: state.filters.q }), { class: "small activity-intent-button", title: "Find related work; text matching is used when model processing is unavailable" }),
      el("span", { class: "filter-spacer" }),
      select("Filter by agent", state.filters.agent, [["", "All agents"], ...state.agents.map(agent => [agent, agentLabel(agent)])], value => filterActivities("agent", value)),
      select("Filter by tool", state.filters.tool, [["", "All tools"], ...state.tools.map(tool => [tool, toolLabel(tool)])], value => filterActivities("tool", value))),
    el("div", { id: "activity-filter-summary" }, activeActivityFilters()),
    el("div", { id: "activity-results", "aria-busy": String(state.loading) }, activityResults()),
  ];
}
function agentLabel(agent) { return connectionIdentity(agent, state.connections?.connections)?.displayName || agent; }
function toolLabel(tool) {
  const label = toolVisual(tool).label;
  const operation = String(tool).split(/__|\./).at(-1).replaceAll("_", " ");
  return label.toLowerCase() === operation.toLowerCase() ? label : `${label} · ${operation}`;
}
function activityAgents() {
  if (!["owner", "member"].includes(state.session?.role)) return null;
  return agentOverview(state.connections, { selectedAgent: state.filters.agent, error: state.connectionError,
    onManage: connection => { if (connection?.agent) connectionHelp(connection); else location.hash = "connect"; },
    onFilter: agent => filterActivities("agent", agent) });
}
function changeActivityKind(kind) {
  if (state.activityKind === kind) return;
  if (dialog.open) closeDetail();
  clearTimeout(searchTimer); state.activityKind = kind;
  state.activities = []; state.activityStats = {}; state.agents = []; state.tools = [];
  state.more = false; state.error = ""; state.freshIds = new Set();
  Object.keys(state.filters).forEach(key => state.filters[key] = "");
  writeRoute(); render(); loadActivity();
}
function clearActivityFilters() {
  Object.keys(state.filters).forEach(key => state.filters[key] = "");
  syncActivityControls(); writeRoute(); loadActivity();
}
function filterActivities(key, value) {
  if (dialog.open) closeDetail();
  clearTimeout(searchTimer); state.filters[key] = value;
  syncActivityControls(); writeRoute(); loadActivity();
}
function syncActivityControls() {
  for (const tab of document.querySelectorAll("[data-activity-status]")) {
    tab.setAttribute("aria-pressed", String(tab.dataset.activityStatus === state.filters.status));
    const key = tab.dataset.activityStatus || "total";
    tab.querySelector(".filter-count").textContent = state.activityStats[key] ?? "—";
  }
  for (const [label, key] of [["Filter by agent", "agent"], ["Filter by tool", "tool"]]) {
    const control = document.querySelector(`select[aria-label="${label}"]`);
    if (control) control.value = state.filters[key];
  }
  const search = document.querySelector('input[aria-label="Search activity"]');
  if (search && search.value !== state.filters.q) search.value = state.filters.q;
  document.querySelector("#activity-filter-summary")?.replaceChildren(...activeActivityFilters());
}
function activeActivityFilters() {
  const active = Object.entries(state.filters).filter(([key, value]) => value && key !== "status");
  if (!active.length && !state.filters.status) return [];
  const names = { q: "Search", agent: "Agent", tool: "Tool", resource: "Resource", runId: "Run" };
  return [el("div", { class: "activity-filter-summary" },
    active.map(([key, value]) => button([el("span", {}, `${names[key]}: ${key === "agent" ? agentLabel(value) : key === "tool" ? toolLabel(value) : value}`), icon("x", { size: 12 })], () => filterActivities(key, ""), { class: "activity-filter-chip", title: `Remove ${names[key].toLowerCase()} filter`, "aria-label": `Remove ${names[key].toLowerCase()} filter` })),
    button("Clear filters", clearActivityFilters, { class: "text small" }))];
}
function activityResults() {
  const filtered = Object.values(state.filters).some(Boolean);
  const memory = state.activityKind === "memory";
  return [
    state.error && notice(state.error, () => loadActivity()),
    state.activities.length ? activityFeed(state.activities.map(activity => withConnectionIdentity(activity, state.connections?.connections)), { onOpen: openActivity, onFilter: filterActivities, onResource: openActivityResource, kind: state.activityKind, filters: state.filters, freshIds: state.freshIds }) : state.loading ? activitySkeleton() : state.error ? null : empty(filtered ? "No matching activity" : state.activityKind === "tasks" ? "No task reports yet" : "Your activity starts with a call", filtered ? "Try another search or clear the filters." : state.activityKind === "tasks" ? "Agents report task progress and results here. You can see their recorded memory calls in All activity." : "Use Engram from an agent to read or save a memory. Its calls will appear here automatically.",
      !filtered && state.activityKind === "tasks" ? el("div", { class: "task-empty-actions" }, button("Set up reporting", taskReportingHelp, { class: "primary" }), button("See all activity", () => changeActivityKind("all"))) : button(filtered ? "Clear filters" : "View connections", () => { if (filtered) clearActivityFilters(); else location.hash = "connect"; })),
    state.activities.length > 0 && el("div", { class: "activity-list-footer" },
      el("span", {}, `${state.activities.length} ${state.activities.length === 1 ? "activity" : "activities"}${state.more ? " shown" : ""}`),
      el("span", { class: "activity-key-hint" }, el("kbd", {}, "↑"), el("kbd", {}, "↓"), "to move", el("kbd", {}, "Enter"), "to inspect"),
      state.more && button(state.loading ? [icon("loader-circle", { size: 14, class: "spin" }), "Loading…"] : ["Load more", icon("chevron-down", { size: 14 })], () => loadActivity({ append: true }), { class: "small", disabled: state.loading })),
    state.activities.length > 100 && el("div", { class: "activity-history-paused", role: "status" }, icon("clock", { size: 13 }), "Live refresh is paused while you explore older work.", button("Back to latest", () => loadActivity(), { class: "text small" })),
    el("p", { class: "activity-footnote" }, icon("shield-check", { size: 13 }), memory ? "Private to this workspace. These operations were observed by Engram." : "Private to this workspace. Memory calls are recorded by Engram; external work comes from agent reports."),
  ];
}
function refreshActivityResults() {
  if (state.view !== "activity") return;
  const target = document.querySelector("#activity-results"), refresh = document.querySelector("#activity-refresh");
  const overview = document.querySelector("#activity-agent-overview");
  if (overview && !overview.contains(document.activeElement)) overview.replaceChildren(...[activityAgents()].filter(Boolean));
  if (refresh) { refresh.disabled = state.loading; refresh.replaceChildren(icon(state.loading ? "loader-circle" : "refresh-cw", { size: 16, class: state.loading ? "spin" : "" })); }
  if (target && dialog.open) { pendingActivityRender = true; syncActivityControls(); return; }
  const focus = document.activeElement, card = focus?.closest(".activity-card");
  const focusedId = card?.dataset.activityId, focusKey = focus?.dataset.focusKey;
  const focusedIndex = card ? [...target.querySelectorAll(".activity-card")].indexOf(card) : -1;
  if (target) {
    target.replaceChildren(...activityResults().flat(Infinity).filter(Boolean)); target.setAttribute("aria-busy", String(state.loading));
    if (focusedId && focusKey) {
      const cards = [...target.querySelectorAll(".activity-card")];
      const nextCard = cards.find(node => node.dataset.activityId === focusedId);
      const nextFocus = [...(nextCard?.querySelectorAll("[data-focus-key]") || [])].find(node => node.dataset.focusKey === focusKey)
        || cards[Math.min(focusedIndex, cards.length - 1)]?.querySelector("[data-open-activity]")
        || document.querySelector('[data-activity-status][aria-pressed="true"]');
      nextFocus?.focus({ preventScroll: true });
    }
  }
  const refreshLabel = document.querySelector(".activity-refresh-label");
  if (refreshLabel) refreshLabel.replaceChildren(el("span", { class: "activity-refresh-dot", "aria-hidden": "true" }), state.activities.length > 100 ? "History view · Updates paused" : "Auto-updates every 5s");
  syncActivityControls();
}
async function loadActivity({ append = false, quiet = false } = {}) {
  if (quiet && state.activities.length > 100) return;
  const requestId = ++generation, workspaceId = state.session.org.id;
  let changed = true;
  if (!quiet) { state.loading = true; state.error = ""; state.freshIds = new Set(); refreshActivityResults(); }
  try {
    const inventoryDue = ["owner", "member"].includes(state.session.role) && (!state.connectionFetchedAt || !quiet || Date.now() - state.connectionFetchedAt > 30_000);
    const [feed, inventory] = await Promise.allSettled([
      api.activities({ ...state.filters, kind: state.activityKind, limit: quiet ? Math.max(30, state.activities.length) : 30, offset: append ? state.activities.length : 0 }, workspaceId),
      inventoryDue ? api.connections(workspaceId) : Promise.resolve(state.connections),
    ]);
    if (requestId !== generation || state.view !== "activity" || workspaceId !== state.session?.org.id) return;
    const previousIdentity = JSON.stringify(state.connections), previousConnectionError = state.connectionError;
    if (inventoryDue) {
      state.connectionFetchedAt = Date.now();
      if (inventory.status === "fulfilled") { state.connections = inventory.value; state.connectionError = ""; }
      else { if (inventory.reason instanceof AuthError) throw inventory.reason; state.connectionError = errorMessage(inventory.reason); }
    }
    if (feed.status === "rejected") throw feed.reason;
    const data = feed.value;
    const existingIds = new Set(state.activities.map(activity => activity.id));
    const next = append ? [...state.activities, ...data.activities] : data.activities;
    const identitiesChanged = previousIdentity !== JSON.stringify(state.connections);
    changed = JSON.stringify(state.activities) !== JSON.stringify(next) || identitiesChanged || previousConnectionError !== state.connectionError || Boolean(state.error);
    state.activities = [...new Map(next.map(activity => [activity.id, activity])).values()];
    state.freshIds = new Set(state.activities.filter(activity => !existingIds.has(activity.id)).map(activity => activity.id));
    const optionsChanged = identitiesChanged || JSON.stringify([state.agents, state.tools]) !== JSON.stringify([data.agents, data.tools]);
    state.agents = data.agents ?? []; state.tools = data.tools ?? []; state.more = Boolean(data.more); state.demo ||= Boolean(data.demo); state.error = "";
    state.activityStats = data.stats || {}; state.checkedAt = data.checkedAt;
    if (!quiet) announcements.textContent = `${state.activities.length} activities loaded`;
    if (optionsChanged) {
      for (const [label, values, selected, placeholder] of [["Filter by agent", state.agents, state.filters.agent, "All agents"], ["Filter by tool", state.tools, state.filters.tool, "All tools"]]) {
        const control = document.querySelector(`select[aria-label="${label}"]`);
        if (control && control !== document.activeElement) { control.replaceChildren(option("", placeholder), ...values.map(value => option(value, label === "Filter by agent" ? agentLabel(value) : toolLabel(value)))); control.value = selected; }
      }
    }
  } catch (error) {
    if (requestId !== generation || workspaceId !== state.session?.org.id) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
    state.error = quiet ? "Activity could not refresh. Showing the last loaded results." : errorMessage(error);
  } finally {
    if (requestId === generation) {
      state.loading = false;
      if (!quiet || changed || state.error) refreshActivityResults(); else { syncActivityControls(); const target = document.querySelector("#activity-results"); if (target) refreshActivityTimes(target); }
    }
  }
}
function openActivityResource(resource) {
  if (resource?.kind === "memory" && resource.slug) return memoryDetail(resource.slug);
  if (resource?.href) {
    try {
      const url = new URL(resource.href);
      if (["https:", "http:"].includes(url.protocol)) {
        window.open(url.href, "_blank", "noopener,noreferrer"); return;
      }
    } catch { /* Unsupported resource remains copyable. */ }
  }
  if (resource?.raw) copy(resource.raw).then(ok => { if (ok) toast("Resource copied"); });
}
function openActivity(activity, tab = "overview") {
  clearTimeout(activityRefreshTimer);
  currentActivity = { id: activity.id, orgId: state.session.org.id, data: activity, expandSteps: tab === "log", version: ++activityRequest, loading: true };
  const panel = el("div", { class: "activity-detail-panel", id: "activity-detail-panel" });
  showDetail(activity.kind === "memory" || activity.evidence === "observed" ? "Memory activity" : "Task activity", [
    el("div", { id: "activity-detail-intro" }, activityDetailHeader(activity, { onFilter: filterActivities })),
    panel,
    el("div", { class: "activity-detail-footer" },
      el("span", { id: "activity-detail-connection" }, activity.status === "running" ? "Updates every 5s" : "Activity log"),
      el("details", { class: "activity-options" }, el("summary", {}, icon("ellipsis", { size: 16 }), "More options"),
        el("div", { class: "activity-options-menu" },
          button([icon("file-text", { size: 13 }), "Create handoff"], () => launchInsights({ activityId: activity.id }), { class: "small", disabled: state.session.canWrite === false }),
          copyButton("Copy technical record", () => JSON.stringify(currentActivity?.data || activity, null, 2))))),
  ], { activity: true });
  renderActivityPanel(); fetchActivityDetail();
}
function renderActivityPanel() {
  if (!currentActivity || !dialog.open) return;
  const panel = dialog.querySelector("#activity-detail-panel");
  if (!panel) return;
  if (currentActivity.error) {
    panel.replaceChildren(notice(currentActivity.error, () => fetchActivityDetail())); return;
  }
  const data = withConnectionIdentity(currentActivity.data, state.connections?.connections);
  const openEntries = [...panel.querySelectorAll(".work-log-details[open]")].map(details => details.closest("[data-log-key]")?.dataset.logKey);
  const openSections = [...panel.querySelectorAll("details[open][data-focus-key]")].map(details => details.dataset.focusKey);
  const focusKey = panel.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  const scrollTop = dialog.scrollTop;
  panel.replaceChildren(activityDetail(data, { onFilter: filterActivities, onResource: openActivityResource, expandSteps: currentActivity.expandSteps }));
  if (data.actions) currentActivity.expandSteps = false;
  for (const details of panel.querySelectorAll(".work-log-details")) if (openEntries.includes(details.closest("[data-log-key]")?.dataset.logKey)) details.open = true;
  for (const details of panel.querySelectorAll("details[data-focus-key]")) if (openSections.includes(details.dataset.focusKey)) details.open = true;
  if (focusKey) [...panel.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  panel.setAttribute("aria-busy", String(currentActivity.loading));
  dialog.scrollTop = scrollTop;
  if (currentActivity.sourceActionId && data.actions) {
    const cited = [...panel.querySelectorAll("[data-action-id]")].find(node => node.dataset.actionId === currentActivity.sourceActionId);
    if (cited) {
      for (let ancestor = cited.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) if (ancestor.tagName === "DETAILS") ancestor.open = true;
      cited.classList.add("is-cited"); cited.setAttribute("tabindex", "-1"); cited.querySelector("details")?.setAttribute("open", ""); cited.focus({ preventScroll: true }); cited.scrollIntoView({ block: "center", behavior: "instant" });
    }
    else panel.prepend(el("p", { class: "detail-note" }, "This check cited an earlier action report. The work log shows the latest recorded state."));
    currentActivity.sourceActionId = null;
  }
}
async function fetchActivityDetail({ quiet = false } = {}) {
  const view = currentActivity;
  if (!view || !dialog.open || view.orgId !== state.session?.org.id) return;
  clearTimeout(activityRefreshTimer);
  const version = view.version, request = view.request = (view.request || 0) + 1;
  try {
    const response = await api.activity(view.id, view.orgId);
    if (!dialog.open || version !== currentActivity?.version || view.request !== request || view.orgId !== state.session?.org.id) return;
    const data = response.activity;
    const changed = JSON.stringify(data) !== JSON.stringify(view.data);
    view.data = data; view.loading = false; view.error = "";
    if (changed || !quiet) {
      dialog.querySelector("#activity-detail-intro")?.replaceChildren(activityDetailHeader(withConnectionIdentity(data, state.connections?.connections), { onFilter: filterActivities }));
      renderActivityPanel();
    }
    refreshActivityTimes(dialog);
    const connection = dialog.querySelector("#activity-detail-connection");
    if (connection) connection.textContent = data.status === "running" ? "Updates every 5s" : "Activity log";
  } catch (error) {
    if (!dialog.open || version !== currentActivity?.version || view.request !== request || view.orgId !== state.session?.org.id) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
    if (!quiet || !view.data.actions) { view.loading = false; view.error = errorMessage(error); renderActivityPanel(); }
    const connection = dialog.querySelector("#activity-detail-connection");
    if (connection) connection.textContent = "Could not refresh · Trying again";
  } finally {
    if (currentActivity?.version === version && view.request === request && dialog.open) {
      activityRefreshTimer = setTimeout(() => { if (!document.hidden) fetchActivityDetail({ quiet: true }); }, 5000);
    }
  }
}
function launchInsights({ q = "", activityId = "" } = {}) {
  clearTimeout(insightTimer); state.insightsQuery = q; state.insightsActivityId = activityId; state.insights = null; state.insightError = "";
  pendingInsightRun = Boolean(q.trim() || activityId);
  if (dialog.open) closeDetail();
  if (state.view === "attention") { render(); if (pendingInsightRun) { pendingInsightRun = false; runInsights(); } }
  else location.hash = "attention";
}
function attentionView() {
  const pending = ["queued", "running"].includes(state.insights?.job?.status);
  const query = el("input", { type: "search", class: "search", maxlength: 500, placeholder: "Describe the work you want to find…", "aria-label": "Search activity by intent", value: state.insightsQuery, oninput: event => state.insightsQuery = event.target.value });
  const run = el("button", { type: "submit", class: "primary small", disabled: state.insightBusy || pending || state.session.canWrite === false }, icon(pending ? "loader-circle" : "layers", { size: 14, class: pending ? "spin" : "" }), pending ? "Checking…" : "Run checks");
  return [heading("Attention", "A second look at what your agents recorded. Every finding links back to evidence."),
    state.insightsActivityId && el("div", { class: "insight-scope" }, icon("layers", { size: 13 }), "Checking one activity", button("Check all activity", () => { state.insightsActivityId = ""; state.insights = null; render(); }, { class: "text small", disabled: pending })),
    el("form", { class: "insight-toolbar", onsubmit: event => { event.preventDefault(); runInsights(); } }, el("div", { class: "search-field" }, icon("search", { size: 15 }), query), run),
    el("p", { class: "detail-note" }, "Optional: describe an intent to find related work. The result identifies whether matching used text or a configured model."),
    el("div", { id: "insights-results", "aria-busy": String(state.insightBusy) }, insightResults()),
  ];
}
function insightResults() {
  const job = state.insights?.job, pending = ["queued", "running"].includes(job?.status);
  return [state.insightError && notice(state.insightError, () => loadInsights()),
    pending && el("div", { class: "insight-job", role: "status" }, icon("loader-circle", { size: 16, class: "spin" }), el("div", {}, job.status === "queued" ? "Checks queued" : "Checking recorded activity", el("p", {}, "This is a read-only check. Your agents and memory are not changed."))),
    ["failed", "cancelled"].includes(job?.status) && notice(job.status === "cancelled" ? "This check was cancelled. You can run it again." : "The check could not finish. Run checks to try again."),
    !state.insights && state.insightBusy ? skeletonRows(3) : attentionResults(state.insights, { onSource: openInsightSource, onActivity: id => openInsightSource(id), onCopy: async text => { if (await copy(text)) toast("Brief copied"); } }),
    state.insights?.external && aiConfiguration(state.insights.external),
  ];
}
function refreshInsights() {
  const target = document.querySelector("#insights-results");
  if (state.view !== "attention" || !target) return;
  target.replaceChildren(...insightResults().flat(Infinity).filter(Boolean)); target.setAttribute("aria-busy", String(state.insightBusy));
  const run = document.querySelector(".insight-toolbar button");
  if (run) { const pending = ["queued", "running"].includes(state.insights?.job?.status); run.disabled = state.insightBusy || pending || state.session.canWrite === false; run.replaceChildren(icon(pending ? "loader-circle" : "layers", { size: 14, class: pending ? "spin" : "" }), pending ? "Checking…" : "Run checks"); }
}
async function runInsights() {
  if (!state.session || state.view !== "attention" || state.insightBusy || ["queued", "running"].includes(state.insights?.job?.status) || sessionMutation) return;
  const workspaceId = state.session.org.id, requestId = ++generation;
  clearTimeout(insightTimer); state.insightBusy = true; state.insightError = ""; refreshInsights();
  try {
    const input = { ...(state.insightsQuery.trim() ? { q: state.insightsQuery.trim() } : {}), ...(state.insightsActivityId ? { activityId: state.insightsActivityId } : {}) };
    const data = await api.runInsights(input, workspaceId);
    if (requestId !== generation || workspaceId !== state.session?.org.id || state.view !== "attention") return;
    state.insights = { ...data, result: null }; state.insightBusy = false; refreshInsights();
    await loadInsights({ jobId: data.job.id });
  } catch (error) {
    if (requestId !== generation || workspaceId !== state.session?.org.id) return;
    if (error instanceof AuthError) return expired();
    state.insightBusy = false; state.insightError = errorMessage(error); refreshInsights();
  }
}
async function loadInsights({ jobId, quiet = false } = {}) {
  if (!state.session || state.view !== "attention") return;
  const workspaceId = state.session.org.id, requestId = ++generation;
  clearTimeout(insightTimer); if (!quiet) { state.insightBusy = true; state.insightError = ""; refreshInsights(); }
  try {
    const data = await api.insights(jobId ? { jobId } : {}, workspaceId);
    if (requestId !== generation || workspaceId !== state.session?.org.id || state.view !== "attention") return;
    state.insights = data; state.insightBusy = false; state.insightError = ""; refreshInsights();
    if (["queued", "running"].includes(data.job?.status)) insightTimer = setTimeout(() => { if (!document.hidden) loadInsights({ jobId: data.job.id, quiet: true }); }, 1500);
    else if (jobId && data.job?.status === "completed") announcements.textContent = `Checks complete. ${data.result?.insights?.length || 0} findings.`;
  } catch (error) {
    if (requestId !== generation || workspaceId !== state.session?.org.id) return;
    if (error instanceof AuthError) return expired();
    state.insightBusy = false; state.insightError = errorMessage(error); refreshInsights();
  }
}
async function openInsightSource(id, actionId) {
  const workspaceId = state.session.org.id;
  showDetail("Source evidence", [el("h2", { id: "detail-title" }, "Opening work log…"), skeletonRows(2)]);
  const requestId = detailGeneration;
  try {
    const data = await api.activity(id, workspaceId);
    if (!dialog.open || requestId !== detailGeneration || workspaceId !== state.session?.org.id) return;
    openActivity(data.activity, "log"); currentActivity.sourceActionId = actionId; renderActivityPanel();
  } catch (error) {
    if (!dialog.open || requestId !== detailGeneration || workspaceId !== state.session?.org.id) return;
    if (error instanceof AuthError) return expired();
    showDetail("Source evidence", [el("h2", { id: "detail-title" }, "Source unavailable"), notice(errorMessage(error))]);
  }
}
function memoryView() {
  const tabs = el("div", { class: "memory-tabs", role: "group", "aria-label": "Memory views" }, ["saved", "review"].map(tab => button(tab === "saved" ? "Saved memory" : "Review proposals", () => { if (state.memoryTab === tab) return; state.memoryTab = tab; state.error = ""; state.more = false; ++generation; writeRoute(); render(); loadView(); }, { "aria-pressed": String(state.memoryTab === tab) })));
  if (state.memoryTab === "review") return [heading("Memory", "Review proposed relationships and organization before they change shared memory."), tabs,
    el("div", { class: "filters" }, select("Review state", state.reviewState, [["pending", "Pending"], ["deferred", "Deferred"], ["applied", "Applied"], ["rejected", "Rejected"]], value => { state.reviewState = value; writeRoute(); loadReviews(); })),
    el("div", { id: "review-results", "aria-busy": String(state.loading) }, reviewResults())];
  return [heading("Memory", "Context your agents can carry from one task to the next.", state.session.canWrite !== false && button([icon("plus", { size: 15 }), "Add memory"], captureMemory, { class: "primary small" })),
    tabs,
    el("div", { class: "filters" }, el("div", { class: "search-field memory-search" }, icon("search", { size: 16 }), el("input", { type: "search", class: "search", placeholder: "Search memory…", "aria-label": "Search memory", value: state.memoryQuery, oninput: event => { state.memoryQuery = event.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(loadMemories, 250); } }), el("kbd", {}, "/"))),
    el("div", { id: "memory-results", "aria-busy": String(state.loading) }, memoryResults())];
}
function memoryResults() {
  return [state.error && notice(state.error, loadMemories),
    ...state.memories.map(memory => button([
      el("span", { class: "memory-icon" }, icon("file-text", { size: 19 })),
      el("div", {}, el("span", { class: "action-title" }, memory.title || memory.slug), el("p", { class: "muted" }, memory.snippet || memory.slug)),
      el("span", { class: "memory-date" }, memory.updated_at ? day(memory.updated_at) : icon("chevron-right", { size: 14 })),
    ], () => memoryDetail(memory.slug), { class: "memory-row" })),
    !state.memories.length && !state.error && (state.loading ? skeletonRows(4) : empty("A little context goes a long way.", "Save decisions and context here, or ask a connected agent to remember them.", state.session.canWrite !== false && button([icon("plus", { size: 14 }), "Add your first memory"], captureMemory))),
    state.more && button("Load more", () => loadMemories({ append: true }), { class: "small", disabled: state.loading })];
}
function refreshMemoryResults() {
  const target = document.querySelector("#memory-results");
  if (state.view === "memory" && target) { target.replaceChildren(...memoryResults().flat(Infinity).filter(Boolean)); target.setAttribute("aria-busy", String(state.loading)); }
}
async function loadMemories({ append = false } = {}) {
  const requestId = ++generation, workspaceId = state.session.org.id; state.loading = true; state.error = ""; refreshMemoryResults();
  try {
    const data = state.memoryQuery ? await api.search({ q: state.memoryQuery, limit: 40 }, workspaceId) : await api.pages({ limit: 40, offset: append ? state.memories.length : 0, sort: "updated_desc" }, workspaceId);
    if (requestId !== generation || state.view !== "memory" || state.memoryTab !== "saved" || workspaceId !== state.session?.org.id) return;
    state.memories = append ? [...state.memories, ...(data.pages ?? [])] : data.results ?? data.pages ?? [];
    state.more = !state.memoryQuery && Boolean(data.more);
  } catch (error) { if (requestId === generation && workspaceId === state.session?.org.id) { if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); state.error = errorMessage(error); } }
  finally { if (requestId === generation) { state.loading = false; refreshMemoryResults(); } }
}
async function memoryDetail(slug) {
  const workspaceId = state.session.org.id;
  const loading = memoryLoading(slug);
  showDetail("Memory", loading, { memory: true });
  dialog.scrollTop = 0;
  const requestId = detailGeneration;
  memoryLoadingTimer = setTimeout(() => {
    if (dialog.open && loading.isConnected && requestId === detailGeneration && workspaceId === state.session?.org.id) setMemoryLoadingDelayed(loading);
  }, 8000);
  try {
    const data = await api.page(slug, workspaceId);
    if (!dialog.open || requestId !== detailGeneration || workspaceId !== state.session?.org.id) return;
    showDetail("Memory", memoryDocumentView(data, { copyControl: copyButton("Copy text", data.page.body, { class: "memory-document-copy", "aria-label": "Copy full memory text" }) }), { memory: true });
  } catch (error) { if (requestId !== detailGeneration || !dialog.open || workspaceId !== state.session?.org.id) return; if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); showDetail("Memory", [el("h2", { id: "detail-title" }, "Could not load memory"), notice(errorMessage(error), () => memoryDetail(slug))], { memory: true }); }
}
function captureMemory() {
  const workspaceId = state.session.org.id;
  const title = el("input", { placeholder: "A short title", required: true, maxlength: 160 });
  const text = el("textarea", { placeholder: "A decision, useful context, or something to remember…", required: true });
  const save = el("button", { class: "primary", type: "submit" }, "Save memory");
  const feedback = el("p", { class: "detail-note", role: "alert" });
  showDetail("New memory", el("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); busy(save, "Saving…", true); feedback.textContent = "";
    const requestId = detailGeneration;
    try { await api.capture({ title: title.value, text: text.value }, workspaceId); if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return; closeDetail(); toast("Memory saved"); loadMemories(); }
    catch (error) { if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return; if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); feedback.textContent = errorMessage(error); }
    finally { busy(save, "Save memory", false); }
  } }, el("h2", { id: "detail-title" }, "Add memory"), field("Title", title), field("Memory", text), feedback, save));
}
function reviewResults() {
  return [state.error && notice(state.error, loadReviews),
    ...state.reviews.map(item => button([el("span", {}, el("strong", {}, `${item.kind.replaceAll("_", " ")} proposal`), el("small", {}, item.payload?.otherSlug || item.payload?.slug || `Review #${item.id}`)), el("span", { class: "review-state" }, item.state, " · ", day(item.createdAt)), icon("chevron-right", { size: 14 })], () => reviewDetail(item.id), { class: "review-row" })),
    !state.reviews.length && !state.error && (state.loading ? skeletonRows(3) : empty("No proposals here", state.reviewState === "pending" ? "New memory proposals appear here when reconciliation finds a relationship or a change worth reviewing. Nothing is applied automatically." : `There are no ${state.reviewState} proposals in this workspace.`)),
    state.reviewMore && button("Load more", () => loadReviews({ append: true }), { class: "small", disabled: state.loading }),
  ];
}
function refreshReviews() {
  const target = document.querySelector("#review-results");
  if (state.view === "memory" && state.memoryTab === "review" && target) { target.replaceChildren(...reviewResults().flat(Infinity).filter(Boolean)); target.setAttribute("aria-busy", String(state.loading)); }
}
async function loadReviews({ append = false } = {}) {
  const workspaceId = state.session.org.id, requestId = ++generation; state.loading = true; state.error = ""; refreshReviews();
  try {
    const data = await api.reviews({ state: state.reviewState, limit: 40, offset: append ? state.reviews.length : 0 }, workspaceId);
    if (requestId !== generation || workspaceId !== state.session?.org.id || state.view !== "memory" || state.memoryTab !== "review") return;
    state.reviews = append ? [...state.reviews, ...data.items] : data.items; state.reviewMore = data.more;
  } catch (error) { if (requestId === generation && workspaceId === state.session?.org.id) { if (error instanceof AuthError) return expired(); state.error = errorMessage(error); } }
  finally { if (requestId === generation) { state.loading = false; refreshReviews(); } }
}
async function reviewDetail(id) {
  const workspaceId = state.session.org.id;
  showDetail("Memory review", [el("h2", { id: "detail-title" }, "Loading proposal…"), skeletonRows(2)]);
  const requestId = detailGeneration;
  try {
    const data = await api.review(id, workspaceId);
    if (!dialog.open || requestId !== detailGeneration || workspaceId !== state.session?.org.id) return;
    const { item, entry } = data, plan = reviewPlan(item, entry), feedback = el("p", { role: "status", class: "detail-note" });
    const allowed = reviewAllowed(state.session), pending = item.state === "pending";
    const controls = el("div", { class: "review-actions" });
    for (const [action, label] of [["approve", "Apply proposed change"], ["defer", "Defer"], ["reject", "Reject"]]) {
      controls.append(button(label, async () => {
        if (!allowed || !pending || (action === "approve" && !plan.supported)) return;
        const version = detailGeneration; controls.querySelectorAll("button").forEach(node => node.disabled = true); feedback.textContent = "Saving decision…";
        try {
          await api.resolveReview(id, action, workspaceId);
          if (workspaceId !== state.session?.org.id || version !== detailGeneration) return;
          closeDetail(); toast(action === "approve" ? "Proposed change applied" : action === "defer" ? "Proposal deferred" : "Proposal rejected"); loadReviews();
        } catch (error) {
          if (workspaceId !== state.session?.org.id || version !== detailGeneration) return;
          if (error instanceof AuthError) return expired();
          feedback.textContent = errorMessage(error); controls.querySelectorAll("button").forEach(node => node.disabled = node.dataset.approval === "true" && !plan.supported);
        }
      }, { class: action === "approve" ? "primary small" : "small", disabled: !allowed || !pending || (action === "approve" && !plan.supported), "data-approval": String(action === "approve") }));
    }
    showDetail("Memory review", [el("h2", { id: "detail-title" }, `${item.kind.replaceAll("_", " ")} proposal`),
      el("p", { class: "detail-note" }, `Review #${item.id} · ${item.state}`, confidenceLabel(item.confidence) ? ` · ${confidenceLabel(item.confidence)}` : ""),
      el("div", { class: "review-proposal" }, el("h3", {}, plan.title), el("p", {}, plan.change), el("p", { class: "detail-note" }, plan.note), plan.target && el("code", {}, plan.target)),
      el("div", { class: "review-comparison" }, entry && el("section", {}, el("h3", {}, "Current source memory"), button(entry.slug, () => memoryDetail(entry.slug), { class: "text small" }), el("pre", {}, entry.rawText)), item.payload?.otherText && el("section", {}, el("h3", {}, "Related memory excerpt"), item.payload.otherSlug && button(item.payload.otherSlug, () => memoryDetail(item.payload.otherSlug), { class: "text small" }), el("pre", {}, item.payload.otherText))),
      el("details", {}, el("summary", {}, "Full proposal data"), el("pre", {}, JSON.stringify(item.payload, null, 2))),
      pending && controls, feedback,
      el("p", { class: "review-actions-note" }, !allowed ? "Your workspace policy limits review decisions to an owner or eligible member." : pending ? "Defer and reject leave memory unchanged. This interface has no undo action for applied proposals; inspect the change above before applying it." : `Resolved${item.resolvedBy ? ` by ${item.resolvedBy}` : ""}. Deferred proposals are kept for reference; reopening is not available in the current review API.`),
    ]);
  } catch (error) {
    if (!dialog.open || requestId !== detailGeneration || workspaceId !== state.session?.org.id) return;
    if (error instanceof AuthError) return expired();
    showDetail("Memory review", [el("h2", { id: "detail-title" }, "Could not load proposal"), notice(errorMessage(error))]);
  }
}
function connectView() {
  const workspaceId = state.session.org.id, scopedApi = workspaceApi(workspaceId);
  const canConnect = ["owner", "member"].includes(state.session.role);
  const name = el("input", { placeholder: "e.g. mac-claude", value: connectionDraft?.name || "", required: true, maxlength: 100, name: "agent-name" });
  const source = select("Agent source", connectionDraft?.harness || "", [["", "Choose a source"], ...agentSources, ["vscode", "VS Code"]], () => {});
  source.required = true;
  const permission = select("Connection permission", connectionDraft?.canWrite === false ? "read" : "write", [["read", "Read only"], ["write", "Read and write"]], () => {});
  const mint = el("button", { class: "primary", type: "submit" }, icon("plus", { size: 15 }), "Create connection");
  return el("div", { class: "connect-layout" },
    heading("Connections", "See who has access and when Engram last heard from them.", iconButton("refresh-cw", "Refresh connections", loadConnections, { disabled: state.loading })),
    state.error && notice(state.error, loadConnections),
    state.connectionError && notice("Connection status could not load. Refresh to try again.", loadConnections),
    canConnect && (state.connections ? connectionInventory(state.connections, { onInspect: connectionHelp, actions: connection => {
      if (connection.kind !== "token" || connection.status !== "authorized" || state.session.role !== "owner") return null;
      const token = state.tokens.find(token => token.name === connection.name && !token.revokedAt);
      if (!token) return null;
      return el("div", { class: "connection-actions" }, button("Source", () => connectionSource(token), { class: "text small" }), button(token.canWrite === false ? "Allow writes" : "Read only", async event => {
        const control = event.currentTarget; control.disabled = true;
        try { await scopedApi.setTokenWrite(token.name, token.canWrite === false); if (workspaceId !== state.session?.org.id) return; await loadConnections(); toast("Connection permission updated"); }
        catch (error) { if (workspaceId !== state.session?.org.id) return; if (error instanceof AuthError) return expired(); toast(errorMessage(error)); control.disabled = false; }
      }, { class: "text small", title: token.canWrite === false ? "Allow this key to write" : "Make this key read only" }), button("Disconnect", () => disconnect(token.name), { class: "text small" }));
    } }) : state.loading && skeletonRows(3)),
    el("h3", {}, "MCP endpoint"), el("p", { class: "detail-note" }, "Add this URL as a custom connector in your agent. Sign in when prompted."),
    el("div", { class: "endpoint" }, el("code", {}, state.mcp || `${location.origin}/mcp`), copyButton("Copy", () => state.mcp || `${location.origin}/mcp`)),
    canConnect && el("div", { class: "section" }, el("h2", {}, "Create an access key"), el("p", {}, "For agents that use a key instead of sign-in. Give each installation a name so its calls stay attributable."),
      el("form", { class: "inline-form connection-key-form", id: "connection-key-form", onsubmit: async event => {
        event.preventDefault(); busy(mint, "Connecting…", true);
        try { const data = await scopedApi.mintToken({ name: name.value, harness: source.value, canWrite: permission.value === "write" }); if (workspaceId !== state.session?.org.id) return; connectionDraft = null; state.token = data; tokenDetail(data); name.value = ""; loadConnections(); }
        catch (error) { if (workspaceId !== state.session?.org.id) return; if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); toast(errorMessage(error)); }
        finally { busy(mint, "Create connection", false); }
      } }, field("Agent name", name), field("Source", source), field("Permission", permission), mint)),
    el("div", { class: "section" }, el("h2", {}, "Task reporting"), el("p", {}, "Memory access and task reporting are separate. An agent needs write access and a reporting workflow to send task progress and results."), button("Set up reporting", taskReportingHelp, { class: "small" })),
    el("div", { class: "section" }, el("h2", {}, "One history, two ways to use it"),
      el("p", {}, "Ask a connected agent to show activity by agent, tool, resource, or result. The Activity view reads the same records."),
      el("details", {}, el("summary", {}, "For agents and integrations"),
        el("p", { class: "detail-note" }, "Use list_actions to read activity and record_action to report an external action. Engram memory operations appear automatically. External tools need to report their actions."),
        el("pre", {}, 'list_actions({ agent: "mac-claude", limit: 20 })\n\nrecord_action({\n  taskTitle: "Prepare the launch brief",\n  tool: "files.write",\n  summary: "Wrote the launch brief",\n  outcome: "Created a brief with the launch checklist and open questions.",\n  resource: "docs/launch.md",\n  status: "completed",\n  runId: "launch-prep-unique-id"\n})'))),
  );
}
function taskReportingHelp() {
  const workspaceId = state.session.org.id;
  showDetail("Task reporting", taskReportingSetup(state.connections, {
    copyControl: copyButton("Copy agent instructions", taskReportingInstructions),
    onInspect: connection => { if (workspaceId === state.session?.org.id) connectionHelp(connection); },
    onManage: () => { if (workspaceId !== state.session?.org.id) return; closeDetail(); location.hash = "connect"; },
  }), { reporting: true });
  dialog.scrollTop = 0;
}
function connectionHelp(connection) {
  const workspaceId = state.session.org.id, reporting = taskReportingStatus(connection), reconnect = reporting.reconnect;
  const endpoint = state.mcp || `${location.origin}/mcp`;
  showDetail(reconnect ? "Reconnect agent" : "Connection details", [
    el("div", { class: "detail-tool-icon" }, visualIcon(agentVisual(connection.agent, { ...connection, harness: connection.harness || (connection.kind === "oauth" ? "other" : null) }), { size: 26 })),
    el("h2", { id: "detail-title" }, connection.displayName || connection.name || "Agent connection"),
    el("p", { class: "detail-note" }, reconnect ? "This authorization no longer grants access. Reconnect in the agent, or replace its access key." : connection.status === "authorized" ? "This authorization can access Engram. Activity appears when the agent makes memory calls or reports its work." : "This connection's access could not be verified. Refresh Connections to check its current status."),
    el("dl", {}, el("dt", {}, "Connection"), el("dd", {}, connection.kind === "oauth" ? "Agent sign-in" : connection.name || "Unavailable"), el("dt", {}, "Access"), el("dd", {}, connection.canWrite === true ? "Read and write" : connection.canWrite === false ? "Read only" : "Unavailable"), el("dt", {}, "Task reports"), el("dd", {}, reporting.label)),
    el("p", { class: "detail-note" }, reporting.detail),
    button("Set up task reporting", taskReportingHelp, { class: "small" }),
    el("div", { class: "connection-guide" }, el("h3", {}, "Connect from your agent"), el("ol", {},
      el("li", {}, "Open the agent’s MCP or connector settings and choose Engram."),
      el("li", {}, "Use this endpoint, then sign in when prompted."),
      el("li", {}, "Ask the agent to search or save a memory. Check Activity for its first recorded call."))),
    el("div", { class: "endpoint" }, el("code", {}, endpoint), copyButton("Copy", endpoint)),
    el("p", { class: "detail-note" }, "If the agent uses an access key, replace the old key in its configuration. Each agent and machine needs its own connection. Engram can only list authorizations issued by this workspace."),
    ["owner", "member"].includes(state.session.role) && button("Create a fresh key", () => {
      if (workspaceId !== state.session?.org.id) return;
      connectionDraft = { name: connection.kind === "token" ? `${connection.name.slice(0, 96)}-new` : "", harness: agentSources.some(([key]) => key === connection.harness) ? connection.harness : "", canWrite: connection.canWrite };
      connectionFocusPending = { workspaceId, afterLoad: state.view !== "connect" };
      skipDetailReturnFocus = true;
      closeDetail();
      if (state.view !== "connect") location.hash = "connect";
      else requestAnimationFrame(() => focusConnectionKey());
    }, { class: "small" }),
  ]);
}
function focusConnectionKey(afterLoad = false) {
  const intent = connectionFocusPending;
  if (!intent || intent.workspaceId !== state.session?.org.id || state.view !== "connect" || !connectionDraft) return;
  if (intent.afterLoad && !afterLoad) return;
  connectionFocusPending = null;
  if (dialog.open) return;
  const form = document.querySelector("#connection-key-form"); if (!form) return;
  const input = form.querySelector('[name="agent-name"]'), source = form.querySelector('[aria-label="Agent source"]'), permission = form.querySelector('[aria-label="Connection permission"]');
  input.value = connectionDraft.name;
  if (source) source.value = connectionDraft.harness;
  if (permission) permission.value = connectionDraft.canWrite === false ? "read" : "write";
  form.scrollIntoView({ block: "center", behavior: "instant" }); input.focus({ preventScroll: true });
}
function connectionSource(token) {
  const workspaceId = state.session.org.id;
  const source = select("Agent source", token.harness || "other", agentSources, () => {});
  const sourceLabel = el("input", { value: token.sourceLabel || "", maxlength: 100, placeholder: "Optional source label" });
  const feedback = el("p", { class: "detail-note", role: "alert" });
  const save = el("button", { type: "submit", class: "primary" }, "Save source");
  showDetail("Connection source", el("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); busy(save, "Saving…", true); feedback.textContent = "";
    const requestId = detailGeneration;
    try {
      await api.setTokenSource({ name: token.name, harness: source.value, ...(sourceLabel.value.trim() ? { sourceLabel: sourceLabel.value.trim() } : {}) }, workspaceId);
      if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return;
      closeDetail(); await loadConnections(); toast("Connection source updated");
    } catch (error) {
      if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return;
      if (error instanceof AuthError) return expired(); feedback.textContent = errorMessage(error);
    } finally { busy(save, "Save source", false); }
  } }, el("h2", { id: "detail-title" }, token.name), el("p", { class: "detail-note" }, "Choose the product this agent runs in. Its name and access stay the same."), field("Source", source), field("Display label", sourceLabel), feedback, save));
}
async function loadConnections() {
  const requestId = ++generation, workspaceId = state.session.org.id; state.loading = true; state.error = "";
  try {
    const canInspect = ["owner", "member"].includes(state.session.role);
    const [tokens, inventory] = await Promise.allSettled([canInspect ? api.tokens(workspaceId) : Promise.resolve({ tokens: [], mcp: `${location.origin}/mcp` }), canInspect ? api.connections(workspaceId) : Promise.resolve(null)]);
    if (requestId !== generation || state.view !== "connect" || workspaceId !== state.session?.org.id) return;
    if (inventory.status === "fulfilled") { state.connections = inventory.value; state.connectionError = ""; state.connectionFetchedAt = Date.now(); }
    else { if (inventory.reason instanceof AuthError) throw inventory.reason; state.connectionError = errorMessage(inventory.reason); }
    if (tokens.status === "rejected") throw tokens.reason;
    state.tokens = tokens.value.tokens ?? []; state.mcp = tokens.value.mcp || `${location.origin}/mcp`;
  }
  catch (error) { if (requestId === generation) { if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); state.error = errorMessage(error); } }
  finally { if (requestId === generation) { state.loading = false; render(); focusConnectionKey(true); } }
}
function tokenDetail(data) {
  const connection = agentConnectionGuide(data.harness, data.mcp);
  const secret = el("input", { type: "password", class: "connection-secret", value: data.token, readonly: true, autocomplete: "off", spellcheck: "false", "aria-label": "New access key" });
  const reveal = button("Show key", () => { const shown = secret.type === "text"; secret.type = shown ? "password" : "text"; reveal.textContent = shown ? "Show key" : "Hide key"; reveal.setAttribute("aria-pressed", String(!shown)); }, { class: "small", "aria-pressed": "false" });
  const installer = connection?.command;
  showDetail("New connection", [el("h2", { id: "detail-title" }, data.name), el("p", { class: "detail-note" }, `Copy this key now. It is only shown once. Its permission is ${data.canWrite === false ? "read only" : "read and write"}; workspace policy and hosted plan access also apply. Creating it does not verify your agent's connection.`),
    el("div", { class: "connection-secret-row" }, secret, reveal), copyButton("Copy access key", data.token, { class: "primary small" }),
    installer && el("div", { class: "section connection-install" }, el("h3", {}, `Set up ${connection.label}`), el("p", { class: "detail-note" }, "Run this command in your terminal and paste the key at its hidden prompt. The key is not part of the command or your shell history."), el("pre", {}, installer), copyButton("Copy setup command", installer)),
    el("details", { class: "section connection-install" }, el("summary", {}, "Manual MCP configuration"), el("p", { class: "detail-note" }, "Replace the placeholder with this key in your agent's configuration. The copy button includes the key; store that configuration securely."), el("pre", {}, accessKeyConfiguration(data.harness, data.mcp)), copyButton("Copy configuration with key", () => accessKeyConfiguration(data.harness, data.mcp, data.token))),
    el("p", { class: "detail-note" }, "Reload your agent's MCP connection, ask it to call Engram’s whoami tool, then check your getting started progress."),
  ], { returnTo: '#connection-key-form button[type="submit"]' });
  // Keep credentials only in this open dialog, never in browser storage.
  state.token = null;
}
function disconnect(name) {
  const workspaceId = state.session.org.id;
  const confirmButton = button("Disconnect agent", async () => {
    busy(confirmButton, "Disconnecting…", true);
    const requestId = detailGeneration;
    try { await api.revokeToken(name, workspaceId); if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return; closeDetail(); toast("Agent disconnected"); loadConnections(); }
    catch (error) { if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return; if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); toast(errorMessage(error)); busy(confirmButton, "Disconnect agent", false); }
  }, { class: "primary" });
  showDetail("Connection", [el("h2", { id: "detail-title" }, `Disconnect ${name}?`), el("p", { class: "detail-note" }, "This revokes its access to Engram. Its existing activity and memory stay available."), confirmButton]);
}
function showcaseView() {
  if (state.session.role !== "owner") return [heading("Public profile", "A shareable view of your agents’ work."), empty("Managed by your workspace owner", "Only workspace owners can publish activity totals.")];
  if (!state.showcase) return [heading("Public profile", "A small window into what your agents get done."), state.error ? notice(state.error, loadShowcase) : profileSkeleton()];
  const draft = state.showcaseDraft;
  const saved = state.showcase.profile;
  const publicUrl = saved.published ? state.showcase.urls.page : `${location.origin}/u/${draft.slug || "your-name"}`;
  const name = el("input", { name: "displayName", autocomplete: "name", value: draft.displayName, placeholder: "Your name", required: true, maxlength: 80 });
  const slug = el("input", { name: "slug", value: draft.slug, placeholder: "your-name", required: true, minlength: 3, maxlength: 48, pattern: "[a-z0-9]+(?:-[a-z0-9]+)*", "aria-describedby": "slug-hint" });
  const bio = el("textarea", { name: "bio", maxlength: 160, rows: 3, placeholder: "A line about you and the work your agents do.", "aria-describedby": "bio-hint" }, draft.bio);
  const feedback = el("div", { role: "alert", class: "form-feedback" });
  const save = el("button", { type: "submit", class: "primary" }, icon("check", { size: 15 }), "Save changes");
  const publish = button([icon(saved.published ? "eye-off" : "globe", { size: 15 }), saved.published ? "Unpublish" : "Publish profile"], async () => {
    if (!saved.published && !form.reportValidity()) return;
    await persistShowcase(!saved.published, publish, feedback, saved.published ? saved : state.showcaseDraft);
  }, { class: saved.published ? "small" : "primary small" });
  const preview = el("div", { class: "profile-preview-content" }, showcasePreview());
  const update = () => {
    state.showcaseDraft = { ...draft, displayName: name.value, slug: slug.value, bio: bio.value };
    preview.replaceChildren(showcasePreview());
    const count = document.querySelector("#bio-hint"); if (count) count.textContent = `${bio.value.length} / 160`;
    const changedAddress = document.querySelector("#slug-change-hint"); if (changedAddress) changedAddress.hidden = !(saved.published && slug.value !== saved.slug);
    const permalink = document.querySelector("#profile-permalink"); if (permalink && !saved.published) permalink.textContent = `${location.origin}/u/${slug.value || "your-name"}`;
    save.disabled = ["slug", "displayName", "bio"].every(key => state.showcaseDraft[key] === saved[key]);
  };
  [name, slug, bio].forEach(node => node.addEventListener("input", update));
  save.disabled = ["slug", "displayName", "bio"].every(key => draft[key] === saved[key]);
  const form = el("form", { class: "showcase-form stack", onsubmit: async event => { event.preventDefault(); await persistShowcase(saved.published, save, feedback); } },
    field("Display name", name),
    field("Profile URL", el("div", { class: "slug-field" }, el("span", {}, "/u/"), slug)),
    el("p", { id: "slug-hint", class: "field-hint" }, "3–48 lowercase letters, numbers, or hyphens."),
    el("p", { id: "slug-change-hint", class: "field-hint", hidden: true }, "Changing this address makes the old link unavailable."),
    field("About you", bio), el("p", { class: "field-hint counter", id: "bio-hint" }, `${bio.value.length} / 160`), feedback,
    el("div", { class: "form-actions" }, save, el("span", { class: "field-hint" }, saved.published ? "Changes update your public page." : "Saving keeps your profile private.")));
  const urls = state.showcase.urls;
  return [
    heading("Public profile", "A small window into what your agents get done.", publish),
    state.error && notice(state.error),
    el("div", { class: "showcase-layout" },
      el("div", { class: "showcase-controls" },
        el("section", { class: "visibility-panel" }, el("div", { class: "visibility-title" }, icon(saved.published ? "globe" : "eye-off", { size: 17 }), el("strong", {}, saved.published ? "Your profile is public" : "Only you can see this"), el("span", { class: "visibility-badge" }, saved.published ? "Published" : "Draft")), el("p", {}, `Shows live working counts and activity totals for ${state.session.org.name}. Task content, resources, and agent names stay private.`)),
        form,
        el("section", { class: "share-links section" }, el("h3", {}, "Share anywhere"), el("p", {}, "Share the live profile link, or connect the same updates to your website."),
          el("div", { class: "share-link-row" }, el("span", { class: "share-link-label" }, icon("link", { size: 14 }), "Profile"), el("code", { id: "profile-permalink" }, publicUrl), copyButton("Copy", () => state.showcase.urls.page, { disabled: !saved.published })),
          saved.published && el("div", { class: "share-link-row" }, el("span", { class: "share-link-label" }, icon("code", { size: 14 }), "JSON"), el("code", {}, urls.json), copyButton("Copy", urls.json)),
          saved.published && el("div", { class: "share-link-row" }, el("span", { class: "share-link-label" }, icon("activity", { size: 14 }), "Live API"), el("code", {}, urls.stream || `${urls.json}/stream`), copyButton("Copy", urls.stream || `${urls.json}/stream`)),
          saved.published && el("div", { class: "profile-link-actions" }, el("a", { href: urls.page, target: "_blank", rel: "noopener", class: "button-link" }, icon("external-link", { size: 14 }), "Open profile"), el("a", { href: urls.card, target: "_blank", rel: "noopener", class: "button-link" }, icon("share-2", { size: 14 }), "Social card")),
          !saved.published && el("p", { class: "field-hint" }, "Publish to activate the profile, JSON endpoint, and live stream. Unpublishing disables all three."),
          saved.published && el("details", {}, el("summary", {}, "Live website embed"), el("p", { class: "detail-note" }, "Paste this into your website for live counts, or use EventSource in your own design. The stream shares aggregates only."), el("pre", {}, liveEmbed(urls.stream || `${urls.json}/stream`)), copyButton("Copy live embed", liveEmbed(urls.stream || `${urls.json}/stream`))),
          saved.published && el("details", {}, el("summary", {}, "Image card embed"), el("p", { class: "detail-note" }, "A scalable snapshot for pages that do not run JavaScript."), el("pre", {}, `<a href="${urls.page}">\n  <img src="${urls.json}/card.svg"\n       alt="My agent activity on Engram" />\n</a>`), copyButton("Copy image embed", `<a href="${urls.page}"><img src="${urls.json}/card.svg" alt="My agent activity on Engram" /></a>`)))),
      el("div", { class: "showcase-preview" }, el("div", { class: "preview-label" }, icon("eye", { size: 14 }), "Public preview", el("span", {}, "What others will see")), preview)),
  ];
}
function liveEmbed(streamUrl) {
  return `<div id="engram-activity" aria-live="polite">Connecting…</div>
<script>
(() => {
  const target = document.getElementById("engram-activity");
  let feed, retry;
  function stop() {
    clearTimeout(retry);
    feed?.close();
    feed = null;
  }
  function connect() {
    stop();
    const current = feed = new EventSource(${JSON.stringify(streamUrl)});
    current.addEventListener("snapshot", event => {
      if (feed !== current) return;
      const { live, stats } = JSON.parse(event.data);
      const count = live.workingAgents;
      target.textContent = count + (count === 1 ? " agent working · " : " agents working · ")
        + stats.completedActions + " actions completed";
    });
    current.addEventListener("error", () => {
      if (feed !== current) return;
      target.textContent = current.readyState === 2
        ? "Live activity unavailable" : "Reconnecting…";
    });
    current.addEventListener("closed", event => {
      if (feed !== current) return;
      stop();
      target.textContent = "Live activity unavailable";
      if (JSON.parse(event.data).reason === "unavailable") retry = setTimeout(connect, 5000);
    });
  }
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", event => { if (event.persisted) connect(); });
  connect();
})();
</script>`;
}
function showcasePreview() {
  const snapshot = state.showcase?.preview;
  if (!snapshot) return profileSkeleton();
  return profileCard({ ...snapshot, profile: { ...snapshot.profile, ...state.showcaseDraft } }, { compact: true });
}
async function loadShowcase() {
  if (state.session.role !== "owner") return;
  const requestId = ++generation, workspaceId = state.session.org.id; state.loading = true; state.error = "";
  try {
    const data = await api.showcase(workspaceId);
    if (requestId !== generation || state.view !== "showcase" || workspaceId !== state.session?.org.id) return;
    state.showcase = data; state.showcaseDraft = { ...data.profile };
  } catch (error) { if (requestId === generation) { if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); state.error = errorMessage(error); } }
  finally { if (requestId === generation) { state.loading = false; render(); } }
}
async function persistShowcase(published, submit, feedback, profile = state.showcaseDraft) {
  if (showcaseSaving) return;
  showcaseSaving = true;
  const currentOrg = state.session.org.id;
  document.querySelectorAll(".showcase-form input, .showcase-form textarea, .showcase-form button, .page-heading > button").forEach(node => node.disabled = true);
  busy(submit, published ? "Saving…" : "Updating…", true); feedback.textContent = "";
  try {
    const data = await api.saveShowcase({ ...profile, published }, currentOrg);
    if (state.session?.org.id !== currentOrg) return;
    state.showcase = data; state.showcaseDraft = { ...data.profile };
    if (state.view === "showcase") render();
    toast(published ? "Public profile saved" : "Profile is private");
  } catch (error) {
    if (state.session?.org.id !== currentOrg) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); state.error = errorMessage(error);
    if (state.view === "showcase") render();
  } finally { showcaseSaving = false; }
}

function setSessionControlsBusy(pending) {
  const picker = document.querySelector('select[aria-label="Workspace"]');
  if (picker) picker.disabled = Boolean(pending);
  document.querySelectorAll('.sidebar-bottom button, .mobile-signout').forEach(control => { control.disabled = Boolean(pending); });
}
async function switchOrg(orgId) {
  if (sessionMutation || !state.session) return;
  sessionMutation = true; setSessionControlsBusy(true);
  const epoch = authEpoch;
  setupReader.invalidate();
  clearTimeout(provisioningTimer); ++provisioningAttempt; provisioningChecking = false; provisioningError = "";
  state.account = null;
  clearTimeout(searchTimer); clearTimeout(insightTimer); ++generation; closeDetail(); state.error = "";
  try {
    const session = await api.switchOrg(Number(orgId));
    if (epoch !== authEpoch) return;
    state.session = session; state.activities = []; state.activityStats = {}; state.freshIds = new Set(); state.memories = []; state.tokens = []; state.connections = null; state.connectionError = ""; state.connectionFetchedAt = 0; connectionDraft = null; connectionFocusPending = null; state.agents = []; state.tools = []; state.showcase = null; state.showcaseDraft = null; state.insights = null; state.insightsQuery = ""; state.insightsActivityId = ""; state.insightBusy = false; state.insightError = ""; state.reviews = []; state.reviewMore = false; pendingInsightRun = false; Object.keys(state.filters).forEach(key => state.filters[key] = ""); writeRoute(); render(); await loadView();
  } catch (error) {
    if (epoch !== authEpoch) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); toast(errorMessage(error)); render();
  } finally { sessionMutation = false; setSessionControlsBusy(false); if (workspacePending(state.session)) scheduleProvisioning(); }
}

function accountView() {
  const billing = state.view === "billing";
  const workspaceId = state.session.org.id;
  const title = billing ? "Plan & billing" : "Workspace";
  const description = billing ? "Simple pricing. A workspace that stays yours." : "People, privacy, and access in one place.";
  if (!["owner", "member"].includes(state.session.role) || (billing && state.session.role !== "owner")) return [heading(title, description), empty("Managed by your workspace owner", "Sign in with your own account to manage this workspace.")];
  if (!state.account || state.account.view !== state.view) return [heading(title, description), state.error ? notice(state.error, loadAccount) : skeletonRows(3)];
  const fail = error => { if (workspaceId === state.session?.org.id && error instanceof AuthError) expired("Your session expired. Please sign in again."); };
  const notify = message => { if (workspaceId === state.session?.org.id) toast(message); };
  const scopedApi = workspaceApi(workspaceId);
  return [heading(title, description), billing ? billingPanel({ billing: state.account.billing, catalog: state.account.catalog, api: scopedApi, notify, fail, refresh: loadAccount }) : [workspacePanel({ session: state.session, members: state.account.members, invites: state.account.invites, api: scopedApi, notify, fail, saved: policies => { if (state.session?.org.id === workspaceId) { state.session.org.policies = policies; loadAccount(); } } }), state.account.external && aiConfiguration(state.account.external, { settings: false })]];
}
async function loadAccount() {
  if (!["owner", "member"].includes(state.session.role) || (state.view === "billing" && state.session.role !== "owner")) return;
  const requestId = ++generation, view = state.view, workspaceId = state.session.org.id; state.error = ""; state.loading = true;
  try {
    const data = view === "billing" ? await Promise.all([api.billing(workspaceId), api.plans()]).then(([billing, catalog]) => ({ billing, catalog })) : await Promise.all([api.members(workspaceId), api.insights({}, workspaceId)]).then(([members, insights]) => ({ ...members, external: insights.external }));
    if (requestId !== generation || state.view !== view || workspaceId !== state.session?.org.id) return;
    state.account = { view, ...data };
  } catch (error) { if (requestId === generation) { if (error instanceof AuthError) return expired(); state.error = errorMessage(error); state.account = null; } }
  finally { if (requestId === generation) { state.loading = false; render(); } }
}
async function signOut() {
  if (sessionMutation) return;
  sessionMutation = true; ++authEpoch; setSessionControlsBusy(true);
  try { await api.logout(); expired(); }
  catch (error) { toast(errorMessage(error)); }
  finally { sessionMutation = false; setSessionControlsBusy(false); }
}
function expired(message = "") {
  ++authEpoch;
  setupReader.invalidate(); setupByWorkspace.clear();
  previewWatcher?.stop(); previewWatcher = null;
  state.account = null;
  clearTimeout(provisioningTimer); ++provisioningAttempt; provisioningChecking = false; provisioningError = "";
  clearTimeout(searchTimer); clearTimeout(insightTimer); ++generation; closeDetail(); state.session = null; state.activities = []; state.activityStats = {}; state.freshIds = new Set(); state.memories = []; state.tokens = []; state.connections = null; state.connectionError = ""; state.connectionFetchedAt = 0; connectionDraft = null; connectionFocusPending = null; state.agents = []; state.tools = []; state.showcase = null; state.showcaseDraft = null; state.insights = null; state.insightsQuery = ""; state.insightsActivityId = ""; state.insightBusy = false; state.insightError = ""; state.reviews = []; pendingInsightRun = false; renderAuth("email", message);
}
function renderAuth(mode = "email", message = "") {
  const email = el("input", { type: "email", required: true, autocomplete: "email", placeholder: "you@example.com" });
  const token = el("input", { type: "password", required: true, autocomplete: "off", placeholder: "Access token" });
  const name = el("input", { required: true, placeholder: "Workspace name", maxlength: 100 });
  const submit = el("button", { type: "submit", class: "primary" }, mode === "token" ? "Sign in" : mode === "create" ? "Create workspace" : "Email me a sign-in link");
  const feedback = el("div", { role: "status", class: "detail-note" }, message);
  const form = el("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); const originalLabel = submit.textContent; busy(submit, mode === "token" ? "Signing in…" : "Sending link…", true); feedback.textContent = "";
    try {
      if (mode === "token") { state.session = await api.login(token.value.trim()); readRoute(); render(); loadView(); }
      else {
        const data = mode === "create" ? await api.createOrg({ name: name.value.trim(), email: email.value.trim() }) : await api.loginEmail(email.value.trim());
        feedback.replaceChildren(data.url ? el("a", { href: data.url }, "Continue to your workspace →") : "Check your email for a sign-in link.");
      }
    } catch (error) { feedback.textContent = errorMessage(error); }
    finally { busy(submit, originalLabel, false); }
  } }, mode === "create" && field("Workspace", name), field(mode === "token" ? "Access token" : "Email", mode === "token" ? token : email), submit, feedback);
  root.replaceChildren(...[state.demo && el("div", { class: "demo" }, "Preview · Sample data. Sign-in and connections are simulated."), el("main", { class: "auth" }, el("a", { class: "wordmark", href: "/" }, el("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 27, height: 27, alt: "" }), "engram"), el("h1", {}, mode === "create" ? "A home for your agents." : "Your agents. One place."),
    el("p", {}, "Activity and shared memory across the agents you use."), form,
    el("div", { class: "auth-switch" }, button(mode === "token" ? "Sign in with email" : "Use an access token", () => renderAuth(mode === "token" ? "email" : "token"), { class: "text small" }), " · ", button(mode === "create" ? "Sign in" : "Create a workspace", () => renderAuth(mode === "create" ? "email" : "create"), { class: "text small" })),
    el("div", { class: "auth-links" }, el("a", { href: "/pricing" }, "Pricing"), el("a", { href: "/self-host" }, "Self-host"), el("a", { href: "/privacy" }, "Privacy")))].filter(Boolean));
}
async function loadView() {
  if (workspacePending(state.session)) { scheduleProvisioning(); return; }
  if (state.view === "activity") await loadActivity();
  else if (state.view === "attention") { if (pendingInsightRun) { pendingInsightRun = false; await runInsights(); } else await loadInsights(); }
  else if (state.view === "memory") { if (state.memoryTab === "review") await loadReviews(); else await loadMemories(); }
  else if (state.view === "showcase") await loadShowcase();
  else if (["workspace", "billing"].includes(state.view)) await loadAccount();
  else await loadConnections();
}

function scheduleProvisioning(delay = 4000) {
  clearTimeout(provisioningTimer);
  if (!workspacePending(state.session) || document.hidden || sessionMutation) return;
  provisioningTimer = setTimeout(pollProvisioning, delay);
}
async function pollProvisioning() {
  clearTimeout(provisioningTimer);
  if (!workspacePending(state.session) || provisioningChecking || sessionMutation || document.hidden) return;
  const workspaceId = state.session.org.id, epoch = authEpoch, attempt = ++provisioningAttempt;
  provisioningChecking = true; provisioningError = ""; render();
  try {
    const session = await api.provisioning(workspaceId);
    if (epoch !== authEpoch || attempt !== provisioningAttempt || state.session?.org.id !== workspaceId) return;
    if (!session?.org || session.org.id !== workspaceId) throw new Error("Workspace setup status is unavailable. Please check again.");
    state.session = session;
    if (!workspacePending(session)) { state.loading = false; state.error = ""; render(); await loadView(); }
  } catch (error) {
    if (epoch !== authEpoch || attempt !== provisioningAttempt || state.session?.org.id !== workspaceId) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
    provisioningError = errorMessage(error);
  } finally {
    if (attempt === provisioningAttempt) { provisioningChecking = false; render(); scheduleProvisioning(provisioningError ? 10_000 : 4000); }
  }
}
window.addEventListener("hashchange", () => {
  if (!state.session) return;
  clearTimeout(searchTimer); clearTimeout(insightTimer); ++generation; closeDetail(); state.insightBusy = false; state.error = ""; state.more = false; readRoute(); render(); window.scrollTo(0, 0); loadView();
});
document.addEventListener("click", event => {
  const link = event.target.closest?.("a.wikilink");
  if (link && state.session) { event.preventDefault(); memoryDetail(link.dataset.slug); }
});
document.addEventListener("pointerdown", () => { inputMode = "pointer"; document.documentElement.dataset.input = inputMode; }, { passive: true });
document.addEventListener("keydown", event => {
  inputMode = "keyboard"; document.documentElement.dataset.input = inputMode;
  if (event.key === "/" && !dialog.open && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    const search = document.querySelector(".search"); if (search) { event.preventDefault(); search.focus(); }
  }
});
setInterval(() => { if (!document.hidden && state.session && !workspacePending(state.session) && !sessionMutation && state.view === "activity" && !state.loading && !dialog.open) loadActivity({ quiet: true }); }, 5000);
document.addEventListener("visibilitychange", () => {
  document.documentElement.dataset.pageHidden = String(document.hidden);
  if (document.hidden) { previewWatcher?.pause(); clearTimeout(activityRefreshTimer); clearTimeout(insightTimer); clearTimeout(provisioningTimer); }
  else { if (workspacePending(state.session)) { scheduleProvisioning(0); return; } previewWatcher?.resume(); if (currentActivity && dialog.open) fetchActivityDetail({ quiet: true }); if (state.view === "attention" && ["queued", "running"].includes(state.insights?.job?.status)) loadInsights({ jobId: state.insights.job.id, quiet: true }); }
});
window.addEventListener("pagehide", () => { previewWatcher?.pause(); clearTimeout(activityRefreshTimer); clearTimeout(insightTimer); clearTimeout(provisioningTimer); });
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  if (workspacePending(state.session)) { scheduleProvisioning(0); return; }
  previewWatcher?.resume();
  if (currentActivity && dialog.open) fetchActivityDetail({ quiet: true });
  else if (state.session && state.view === "activity" && !sessionMutation) loadActivity({ quiet: true });
  else if (state.session && state.view === "attention") loadInsights({ jobId: state.insights?.job?.id, quiet: true });
});
async function boot() {
  root.replaceChildren(el("main", { class: "auth boot-loader", role: "status" }, el("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 27, height: 27, alt: "" }), icon("loader-circle", { size: 18, class: "spin" }), el("p", { class: "muted" }, "Opening your workspace…")));
  try {
    const hash = location.hash.slice(1);
    state.session = hash.startsWith("join=") ? await api.acceptInvite(hash.slice(5)) : await api.me();
    if (hash.startsWith("join=")) history.replaceState(null, "", "#activity");
    state.demo = Boolean(state.session.demo); readRoute(); render(); await loadView();
  } catch (error) { renderAuth(location.hash === "#start" ? "create" : "email", error instanceof AuthError ? "" : errorMessage(error)); }
}
boot();
