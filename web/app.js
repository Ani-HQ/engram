import { api, AuthError, workspaceApi } from "./api.js";
import { icon } from "./icons.js";
import { profileCard, profileSkeleton, updateProfileCard, updateProfileTimes } from "./profile.js";
import { createProfilePresentationEditor, profilePresentationChanged, profilePresentationValue } from "./profile-presentation-editor.js";
import { createProfilePhotoEditor, profilePhotoChanged, profilePhotoUpdate } from "./profile-photo-editor.js";
import { billingPanel, workspacePanel, workspacePending, provisioningPanel } from "./account.js";
import { watchPublicActivity } from "./live-activity.js";
import { activityFeed, activityFilters, activitySkeleton, activityDetail, activityDetailHeader, refreshActivityTimes } from "./activity-view.js";
import { activityDestination, activityHref, activitySections } from "./activity-navigation.js";
import { agentVisual, visualIcon, agentSources, toolVisual } from "./tooling.js";
import { activityKind as normalizeActivityKind, connectionClient, connectionIdentity, withConnectionIdentity } from "./connection-model.js";
import { agentOverview, connectionInventory } from "./connection-view.js";
import { connectionAgents, connectionSetupView } from "./connection-setup-view.js";
import { connectionKeyPayload, genericConnectionDraft } from "./connection-setup-state.js";
import { memoryLoading, setMemoryLoadingDelayed } from "./memory-loading.js";
import { memoryDocumentView } from "./memory-document-view.js";
import { taskReportingSetup, taskReportingInstructions } from "./task-reporting-view.js";
import { taskReportingStatus } from "./task-reporting-model.js";
import { memoryUsagePanel } from "./memory-usage-view.js";
import { aiConfiguration, attentionResults } from "./insights-view.js";
import { confidenceLabel, reviewAllowed, reviewPlan } from "./insight-model.js";
import { onboardingGuide } from "./onboarding-view.js";
import { accessKeyConfiguration, onboardingProgress, shouldOfferOnboarding, createOnboardingReader } from "./onboarding-model.js";
import { parseInviteEntry, parseSignupPolicy, signupAuthMode, signupEntryMode, emailLinkRecovery } from "./signup-model.js";
import { signupView } from "./signup-view.js";
import { signupAdminPanel } from "./signup-admin.js";
import { sharingView } from "./sharing-view.js";
import { statusBadge, loadingState, observeLoadingMotion, observeSelects } from "./design-system.js";
import { createJevSettingsPanel } from "./jev-settings.js";
import { createAccessClock, friendAccessCard, friendAccessPresentation } from "./access-view.js";
import { applyWorkspaceName, createWorkspaceNameEditor, captureSetupFocus, restoreSetupFocus } from "./workspace-name.js";

const root = document.querySelector("#app");
const state = {
  session: null, view: "activity", activityTab: "history", activityKind: "all", activities: [], activityStats: {}, checkedAt: null, freshIds: new Set(), agents: [], tools: [], memories: [], tokens: [],
  connections: null, connectionError: "", connectionFetchedAt: 0, connectionList: "current",
  filters: { q: "", agent: "", tool: "", status: "", resource: "", runId: "" },
  account: null,
  insights: null, insightsQuery: "", insightsActivityId: "", insightBusy: false, insightError: "",
  memoryTab: "saved", reviews: [], reviewState: "pending", reviewMore: false,
  memoryQuery: "", more: false, loading: false, error: "", demo: Boolean(document.querySelector('meta[name="engram-demo"]')), mcp: "", token: null, showcase: null, showcaseDraft: null,
};
const activityHistoryActive = () => state.view === "activity" && state.activityTab === "history";
const activityChecksActive = () => state.view === "activity" && state.activityTab === "checks";
let generation = 0;
let searchTimer, memoryLoadingTimer;
let returnFocus, returnActivityFocus, returnFocusSelector = null, pendingActivityRender = false;
let detailGeneration = 0;
let showcaseSaving = false;
let previewWatcher;
let profilePhotoEditor;
let currentActivity, activityRequest = 0, activityRefreshTimer;
let inputMode = "pointer";
let navigationOpen = false;
let accountFocusTarget = null;
let sessionMutation = false, authEpoch = 0;
let insightTimer, pendingInsightRun = false;
let provisioningTimer, provisioningChecking = false, provisioningError = "", provisioningAttempt = 0;
let connectionDraft = null, connectionFocusPending = null, connectionEditor = null, skipDetailReturnFocus = false;
const connectionKeyRequests = new Map();
const connectionMutations = new Map();
let signupPolicy = null, signupPolicyRequest = null, authPanel = null, signupAdmin = null, jevSettingsPanel = null, pendingInviteEntry = null;
let sharingPanel = null;
let workspaceNameEpoch = 0;
let accessSnapshot = null, accessClock = () => null, accessRefreshTimer, accessRequest = 0, accessError = "", accessRefreshing = false;
const setupByWorkspace = new Map();
const setupReader = createOnboardingReader(workspaceId => api.onboarding(workspaceId), () => state.session?.org.id);
const dialog = el("dialog", { class: "detail", "aria-labelledby": "detail-title" });
dialog.addEventListener("click", event => { if (event.target === dialog) closeDetail(); });
dialog.addEventListener("close", () => {
  connectionEditor = null;
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
  if (wasActivity && state.session && activityHistoryActive() && !state.loading && !sessionMutation) loadActivity({ quiet: true });
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
  let copying = false, resetTimer;
  const node = button([icon("copy", { size: 14 }), label], async () => {
    if (copying) return;
    copying = true; clearTimeout(resetTimer); node.setAttribute('aria-busy', 'true'); node.setAttribute('aria-disabled', 'true');
    node.replaceChildren(el('span', { class: 'ds-spinner', 'aria-hidden': 'true' }), 'Copying…');
    const copied = await copy(typeof value === "function" ? value() : value);
    copying = false; node.removeAttribute('aria-busy'); node.removeAttribute('aria-disabled');
    if (!node.isConnected) return;
    if (copied) {
      node.dataset.feedback = 'success'; node.replaceChildren(icon("check", { size: 14, class: 'ds-feedback-icon' }), "Copied");
      resetTimer = setTimeout(() => { if (node.isConnected) { node.replaceChildren(...original); delete node.dataset.feedback; } }, 2000);
    } else node.replaceChildren(...original);
  }, { class: "small", ...attrs });
  const original = [...node.childNodes];
  return node;
}
function busy(button, label, pending) { button.disabled = pending; button.setAttribute('aria-busy', String(pending)); button.replaceChildren(...(pending ? [el("span", { class: "ds-spinner", "aria-hidden": "true" }), label] : [label])); }
function skeletonRows(count = 5, label = "Loading workspace…") {
  return loadingState({ label, lines: count });
}
const option = (value, label) => el("option", { value }, label);
function select(label, value, options, change, attrs = {}) {
  const node = el("select", { "aria-label": label, onchange: event => change(event.target.value), ...attrs }, options.map(([key, text]) => option(key, text)));
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
  const node = el("div", { class: "toast ds-toast", role: "status", "aria-live": "polite" }, message);
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
function closeDetail() { connectionEditor = null; clearTimeout(memoryLoadingTimer); detailGeneration += 1; dialog.close(); clearDetailContents(); }
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
  return el("div", { class: "page-heading" }, el("div", { class: "ds-heading-group" }, el("h1", {}, title), el("p", {}, description)), side);
}
function notice(message, retry) {
  return el("div", { class: "notice", role: "alert" }, message, retry && button("Try again", retry, { class: "text small" }));
}
function activitySectionHrefs() {
  return {
    historyHref: activityHref({ kind: state.activityKind, filters: state.filters }),
    checksHref: activityHref({ tab: "checks", query: state.insightsQuery, activityId: state.insightsActivityId }),
  };
}
function writeRoute() {
  if (state.view === "activity") {
    const hrefs = activitySectionHrefs();
    history.replaceState(null, "", state.activityTab === "checks" ? hrefs.checksHref : hrefs.historyHref);
    for (const key of ["history", "checks"]) document.querySelector(`[data-activity-section="${key}"]`)?.setAttribute("href", hrefs[`${key}Href`]);
    return;
  }
  const query = new URLSearchParams();
  if (state.view === "memory" && state.memoryTab === "review") { query.set("tab", "review"); if (state.reviewState !== "pending") query.set("state", state.reviewState); }
  history.replaceState(null, "", `#${state.view}${query.size ? `?${query}` : ""}`);
}
function readRoute() {
  const [rawView, query = ""] = location.hash.slice(1).split("?");
  const params = new URLSearchParams(query), destination = activityDestination(rawView, params);
  state.view = ["activity", "memory", "connect", "sharing", "showcase", "workspace", "billing"].includes(destination.view) ? destination.view : "activity";
  state.activityTab = destination.activityTab;
  if (state.view !== "connect") connectionFocusPending = null;
  if (activityChecksActive()) {
    const q = params.get("q") || "", activityId = params.get("activityId") || "";
    if (q !== state.insightsQuery || activityId !== state.insightsActivityId) { state.insights = null; state.insightError = ""; }
    state.insightsQuery = q; state.insightsActivityId = activityId;
  } else if (activityHistoryActive()) {
    state.activityKind = normalizeActivityKind(params.get("kind"));
    for (const key of Object.keys(state.filters)) state.filters[key] = params.get(key) || "";
  }
  state.memoryTab = params.get("tab") === "review" ? "review" : "saved";
  state.reviewState = ["pending", "deferred", "applied", "rejected", "approved"].includes(params.get("state")) ? params.get("state") : "pending";
  if (rawView === "attention") writeRoute();
}
function setupState() {
  if (!state.session || !["owner", "member"].includes(state.session.role)) return null;
  const workspaceId = state.session.org.id;
  if (!setupByWorkspace.has(workspaceId)) {
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(`engram-setup-dismissed:${workspaceId}`) === "1"; } catch {}
    setupByWorkspace.set(workspaceId, { data: state.session.onboarding, visible: !dismissed && shouldOfferOnboarding(state.session.onboarding), agentId: "", checking: false, error: "" });
  }
  const setup = setupByWorkspace.get(workspaceId), ownerEmail = state.session.role === "owner" ? state.session.email : null;
  if (ownerEmail && setup.nameIdentity !== ownerEmail) {
    setup.nameEditor?.invalidate(); setup.nameIdentity = ownerEmail;
    setup.nameEditor = createWorkspaceNameEditor({ workspaceId, name: state.session.org.name,
      save: name => api.renameWorkspace(name, workspaceId),
      context: () => !sessionMutation && state.session?.org.id === workspaceId && state.session?.role === "owner" && state.session?.email === ownerEmail ? `${authEpoch}:${workspaceNameEpoch}:${workspaceId}:${ownerEmail}` : null,
      changed: () => { if (state.session?.org.id === workspaceId && setupByWorkspace.get(workspaceId) === setup) renderSetup(); },
      saved: org => {
        if (applyWorkspaceName(state.session, org)) render();
      },
      failed: error => { if (error instanceof AuthError) expired("Your session expired. Please sign in again."); },
    });
  }
  setup.nameEditor?.syncName(state.session.org.name);
  return setup;
}
function invalidateWorkspaceNames() { ++workspaceNameEpoch; for (const setup of setupByWorkspace.values()) setup.nameEditor?.invalidate(); }
function setupPanel() {
  const setup = setupState();
  if (!setup?.visible || state.view === "connect") return null;
  return onboardingGuide({ ...setup, session: state.session, mcp: state.mcp || `${location.origin}/mcp`, policies: state.session.org.policies, inventory: state.connections, demo: state.demo,
    onChoose: agentId => { setup.agentId = agentId; renderSetup(); },
    onDisclosureChange: (key, open) => { (setup.disclosures ||= {})[key] = open; },
    onCheck: refreshSetup, onDismiss: dismissSetup, onReporting: taskReportingHelp,
    onCreateKey: agentId => beginConnection({ agentId }), copyControl: copyButton });
}
function renderSetup(focusTitle = false) {
  const slot = document.querySelector("#setup-slot");
  if (!slot) return;
  const focus = captureSetupFocus(slot);
  const panel = setupPanel(); slot.replaceChildren(...(panel ? [panel] : []));
  if (focusTitle) slot.querySelector("#setup-title")?.focus({ preventScroll: true });
  else restoreSetupFocus(slot, focus);
}
function openSetup({ agentSetup = false } = {}) {
  const setup = setupState(); if (!setup) return;
  setup.visible = true;
  if (agentSetup) setup.disclosures = { ...setup.disclosures, completedAgent: true, agentHelp: true };
  try { sessionStorage.removeItem(`engram-setup-dismissed:${state.session.org.id}`); } catch {}
  if (state.view === "connect") { location.hash = "activity"; return; }
  renderSetup(true);
  if (agentSetup) document.querySelector("#setup-agent")?.focus({ preventScroll: true });
  document.querySelector(".setup-guide")?.scrollIntoView({ block: "start", behavior: "instant" }); refreshSetup();
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
    announcements.textContent = onboardingProgress(result.data).done ? "This workspace has received successful connection, save and recall calls." : `${onboardingProgress(result.data).completed} of 3 workspace checks received.`;
  } catch (error) {
    if (state.session?.org.id !== workspaceId) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
    setup.error = errorMessage(error);
  } finally { setup.checking = false; if (state.session?.org.id === workspaceId) renderSetup(); }
}
function render() {
  const setupFocus = captureSetupFocus(document.querySelector("#setup-slot"));
  sharingPanel?.dispose(); sharingPanel = null;
  authPanel?.dispose(); authPanel = null;
  signupAdmin?.dispose(); signupAdmin = null;
  jevSettingsPanel?.dispose(); jevSettingsPanel = null;
  previewWatcher?.stop(); previewWatcher = null;
  profilePhotoEditor?.dispose(); profilePhotoEditor = null;
  if (!state.session) return;
  if (workspacePending(state.session)) {
    root.replaceChildren(provisioningPanel({ session: state.session, checking: provisioningChecking, error: provisioningError,
      retry: () => pollProvisioning(), signOut, switchOrg }));
    return;
  }
  const orgs = state.session.orgs?.length ? state.session.orgs : [state.session.org];
  const titles = { activity: "Activity", memory: "Memory", connect: "Connections", sharing: "Sharing", showcase: "Public profile", workspace: "Workspace", billing: "Plan & billing" };
  const navigation = [["activity", "Activity", "activity"], ["memory", "Memory", "brain"], ["connect", "Connections", "plug"]];
  if (["owner", "member"].includes(state.session.role)) navigation.push(["sharing", "Sharing", "share-2"]);
  if (state.session.role === "owner") navigation.push(["showcase", "Public profile", "globe"]);
  if (["owner", "member"].includes(state.session.role)) navigation.push(["workspace", "Workspace", "settings-2"]);
  if (state.session.role === "owner") navigation.push(["billing", "Plan & billing", "file-text"]);
  const workspaceKind = state.session.org.kind === "personal" ? "Personal workspace" : "Team workspace";
  const navigationLink = ([key, label, name]) => el("a", { href: `#${key}`, "aria-current": state.view === key ? "page" : null, onclick: () => { if (navigationOpen) { setNavigationOpen(false); document.querySelector('#main')?.focus({ preventScroll: true }); } } }, icon(name, { size: 16 }), el("span", {}, label));
  const workspaceNavigation = navigation.filter(([key]) => !["showcase", "workspace", "billing"].includes(key));
  const manageNavigation = navigation.filter(([key]) => ["showcase", "workspace", "billing"].includes(key));
  root.replaceChildren(
    el("a", { class: "ds-button ds-skip-link", href: "#main", onclick: event => { event.preventDefault(); const main = document.querySelector("#main"); main?.focus(); main?.scrollIntoView(); } }, "Skip to content"),
    ...(state.demo ? [el("div", { class: "demo" }, "LOCAL PREVIEW", el("span", {}, "Sample data · No connected accounts are being monitored"))] : []),
    el("div", { class: "app-shell" },
      el("aside", { class: "sidebar", "aria-label": "Workspace navigation", "data-navigation-open": String(navigationOpen) },
        el("a", { class: "wordmark", href: "#activity", "aria-label": "engram home" }, el("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 27, height: 27, alt: "" }), "engram"),
        el("div", { class: "workspace-picker" }, el("span", { class: "workspace-initial", "aria-hidden": "true" }, state.session.org.name.slice(0, 1).toUpperCase()), select("Workspace", String(state.session.org.id), orgs.map(org => [String(org.id), org.name]), switchOrg, { "data-select-variant": "embedded" })),
        iconButton(navigationOpen ? "x" : "menu", "Navigation", () => setNavigationOpen(!navigationOpen), { class: "ds-icon-button ds-disclosure-toggle mobile-navigation-toggle", "aria-controls": "workspace-navigation", "aria-expanded": String(navigationOpen) }),
        el("nav", { class: "nav", id: "workspace-navigation", "aria-label": "Main navigation" },
          el("div", { class: "nav-group" }, el("span", { class: "nav-group-label" }, "Workspace"), workspaceNavigation.map(navigationLink)),
          manageNavigation.length > 0 && el("div", { class: "nav-group" }, el("span", { class: "nav-group-label" }, "Manage"), manageNavigation.map(navigationLink))),
        el("div", { class: "sidebar-bottom" },
          el("a", { class: "workspace-note", href: "/privacy" }, icon("shield-check", { size: 14 }), "Privacy & data"),
          el("div", { class: "sidebar-account" },
            el("span", { class: "sidebar-account-avatar", "aria-hidden": "true" }, (state.session.email || state.session.name || "E").slice(0, 1).toUpperCase()),
            el("div", { class: "sidebar-account-copy" }, el("span", { title: state.session.email || state.session.name }, state.session.email || state.session.name), el("small", {}, `${state.session.role.slice(0, 1).toUpperCase()}${state.session.role.slice(1)}`))),
          button([icon("log-out", { size: 15 }), "Sign out"], signOut, { class: "text" }))),
      el("div", { class: "main-column" },
        el("div", { class: "app-topbar" }, el("div", { class: "breadcrumbs" }, el("span", {}, state.session.org.name), statusBadge(workspaceKind, { tone: "neutral", className: "workspace-kind-badge" }), icon("chevron-right", { size: 13 }), el("span", {}, titles[state.view])),
          el("div", { class: "topbar-actions" }, state.view !== "connect" && setupState() && button("Getting started", openSetup, { class: "text small setup-resume", "aria-label": "Open getting started guide", "aria-controls": "setup-slot" }), state.session.role === "owner" && state.view !== "showcase" && button([icon("share-2", { size: 14 }), "Share activity"], () => { location.hash = "showcase"; }, { class: "small" }), iconButton("log-out", "Sign out", signOut, { class: "icon-button mobile-signout" }))),
        el("main", { class: "workspace", id: "main", tabindex: -1 }, el("div", { id: "friend-access-slot" }), el("div", { id: "setup-slot" }, setupPanel()), state.view === "activity" ? activityView() : state.view === "memory" ? memoryView() : state.view === "sharing" ? selectiveSharingView() : state.view === "showcase" ? showcaseView() : ["workspace", "billing"].includes(state.view) ? accountView() : connectView()))));
  renderFriendAccess();
  if (state.view === "showcase" && state.showcase?.preview) watchPreview();
  setSessionControlsBusy(sessionMutation);
  restoreSetupFocus(document.querySelector("#setup-slot"), setupFocus);
  if (accountFocusTarget?.workspaceId === state.session.org.id && accountFocusTarget.view === state.view) {
    const target = document.querySelector(`[data-account-focus="${accountFocusTarget.key}"]`);
    if (target) { target.focus({ preventScroll: true }); accountFocusTarget = null; }
  }
  requestAnimationFrame(revealCurrentNavigation);
}
function setNavigationOpen(open, restoreFocus = false) {
  navigationOpen = Boolean(open);
  const sidebar = document.querySelector('.sidebar'), toggle = sidebar?.querySelector('.mobile-navigation-toggle');
  if (sidebar) sidebar.dataset.navigationOpen = String(navigationOpen);
  if (toggle) { toggle.setAttribute('aria-expanded', String(navigationOpen)); toggle.replaceChildren(icon(navigationOpen ? 'x' : 'menu', { size: 18 })); if (restoreFocus) toggle.focus(); }
}
function revealCurrentNavigation() {
  const nav = document.querySelector(".nav"), active = nav?.querySelector('[aria-current="page"]');
  if (!active || nav.scrollWidth <= nav.clientWidth) return;
  const bounds = nav.getBoundingClientRect(), selected = active.getBoundingClientRect();
  if (selected.left < bounds.left) nav.scrollLeft -= bounds.left - selected.left;
  else if (selected.right > bounds.right) nav.scrollLeft += selected.right - bounds.right;
}
function renderFriendAccess() {
  clearTimeout(accessRefreshTimer);
  const slot = document.querySelector("#friend-access-slot"), access = state.session?.access;
  if (!slot) return;
  if (access !== accessSnapshot) { accessSnapshot = access; accessClock = createAccessClock(access); }
  const now = accessClock();
  const view = friendAccessPresentation(access, { now });
  const signature = JSON.stringify(view ? [view.state, view.label, view.days, view.expiresAt, view.unlimited, view.hasOtherAccess, accessError] : null);
  if (slot.dataset.accessSignature !== signature) {
    const focused = slot.contains(document.activeElement) ? document.activeElement.tagName.toLowerCase() : null;
    const card = friendAccessCard(access, { now, error: accessError, retry: refreshFriendAccess });
    slot.replaceChildren(...(card ? [card] : [])); slot.dataset.accessSignature = signature;
    if (focused) (slot.querySelector(focused) || slot.querySelector("a"))?.focus({ preventScroll: true });
  }
  if (view && !document.hidden) accessRefreshTimer = setTimeout(refreshFriendAccess, Math.min(3_600_000, view.nextChangeMs ?? 3_600_000));
}
async function refreshFriendAccess() {
  if (!state.session || sessionMutation || accessRefreshing || document.hidden) return;
  const workspaceId = state.session.org.id, epoch = authEpoch, request = ++accessRequest;
  accessRefreshing = true;
  const retry = document.querySelector("#friend-access-slot button");
  if (retry) { retry.disabled = true; retry.textContent = "Checking…"; }
  try {
    const result = await api.me(workspaceId);
    if (request !== accessRequest || epoch !== authEpoch || sessionMutation || state.session?.org.id !== workspaceId || result.org?.id !== workspaceId) return;
    state.session.access = result.access; accessError = "";
  } catch (error) {
    if (request !== accessRequest || epoch !== authEpoch || state.session?.org.id !== workspaceId) return;
    if (error instanceof AuthError) return expired();
    accessError = "unavailable";
  } finally { accessRefreshing = false; if (request === accessRequest && epoch === authEpoch && state.session?.org.id === workspaceId) { if (retry) { retry.disabled = false; retry.textContent = "Try again"; } renderFriendAccess(); } }
}
function watchPreview() {
  const orgId = state.session.org.id, slug = state.showcase.profile.slug;
  const status = document.querySelector(".preview-label > span");
  const stream = state.showcase.profile.published ? watchPublicActivity(state.showcase.urls.stream || `${state.showcase.urls.json}/stream`, {
    snapshot: data => {
      if (state.session?.org.id !== orgId || state.view !== "showcase" || data.profile.slug !== slug) return;
      // The owner endpoint can preview safe events before opting in. An
      // aggregate-only public update must not erase that private preview.
      state.showcase.preview = { ...data, activity: data.activity?.enabled ? data.activity : state.showcase.preview?.activity || data.activity };
      const card = document.querySelector(".profile-preview-content .public-profile");
      if (card) updateProfileCard(card, showcasePreviewData(state.showcase.preview));
    },
    state: value => { if (status?.isConnected) status.textContent = Boolean(state.showcaseDraft?.showActivity) !== Boolean(state.showcase?.profile.showActivity) ? "Unsaved sharing preview" : profilePhotoChanged(state.showcaseDraft, state.showcase?.profile) || profilePresentationChanged(state.showcaseDraft, state.showcase?.profile) || ["slug", "displayName", "bio"].some(key => state.showcaseDraft?.[key] !== state.showcase?.profile[key]) ? "Unsaved preview" : { live: "Live public preview", connecting: "Connecting…", reconnecting: "Reconnecting…", paused: "Preview paused", closed: "Preview disconnected" }[value] || "Public preview"; },
    closed: () => { if (status?.isConnected) status.textContent = "Preview changed · reload to reconnect"; },
  }) : { stop() {}, pause() {}, resume() {} };
  let timeRefresh;
  const updateTimes = () => {
    if (document.hidden || state.session?.org.id !== orgId || state.view !== "showcase") return;
    const card = document.querySelector(".profile-preview-content .public-profile");
    if (card) updateProfileTimes(card);
  };
  const resumeTimes = () => { clearInterval(timeRefresh); updateTimes(); timeRefresh = setInterval(updateTimes, 30_000); };
  previewWatcher = {
    stop() { clearInterval(timeRefresh); stream.stop(); },
    pause() { clearInterval(timeRefresh); stream.pause(); },
    resume() { resumeTimes(); stream.resume(); },
  };
  resumeTimes();
  if (document.hidden) previewWatcher.pause();
}
function activityView() {
  const checking = activityChecksActive(), memory = state.activityKind === "memory";
  const description = checking ? "Review recorded work for loose ends, find related activity, and prepare a handoff."
    : memory ? "Memory calls recorded by Engram in this workspace." : state.activityKind === "tasks" ? "Steps, progress, and outcomes reported by your agents." : "Memory calls and agent-reported work across this workspace.";
  return [heading("Activity", description, !checking && el("div", { class: "activity-refresh-controls" },
    el("span", { class: "activity-refresh-label" }, el("span", { class: "activity-refresh-dot", "aria-hidden": "true" }), state.activities.length > 100 ? "History view · Updates paused" : "Auto-updates every 5s"),
    iconButton("refresh-cw", "Refresh activity", () => loadActivity(), { id: "activity-refresh" }))),
    activitySections({ tab: state.activityTab, ...activitySectionHrefs() }),
    checking ? el("section", { class: "activity-checks", "aria-label": "Activity checks" }, activityChecksView()) : activityHistoryView(),
  ];
}
function activityHistoryView() {
  const search = el("input", { type: "search", class: "search", placeholder: "Search work, tools, or approaches…", "aria-label": "Search activity", value: state.filters.q,
    oninput: event => { state.filters.q = event.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => { writeRoute(); loadActivity(); }, 250); } });
  return [
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
    el("div", { id: "activity-results", class: "ds-results", "aria-busy": String(state.loading) }, activityResults()),
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
  if (activityChecksActive()) {
    state.filters[key] = value;
    if (dialog.open) closeDetail();
    location.hash = activityHref({ kind: state.activityKind, filters: state.filters });
    return;
  }
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
    state.activities.length ? activityFeed(state.activities.map(activity => withConnectionIdentity(activity, state.connections?.connections)), { onOpen: openActivity, onFilter: filterActivities, onResource: openActivityResource, kind: state.activityKind, filters: state.filters, freshIds: state.freshIds }) : state.loading ? activitySkeleton() : state.error ? null : empty(filtered ? "No matching activity" : state.activityKind === "tasks" ? "No task reports yet" : "Every thread starts somewhere.", filtered ? "Try another search or clear the filters." : state.activityKind === "tasks" ? "Agents report task progress and results here. You can see their recorded memory calls in All activity." : "Ask a connected agent to read or save a memory. Its Engram calls will appear here. External work appears when the agent reports it.",
      !filtered && state.activityKind === "tasks" ? el("div", { class: "task-empty-actions" }, button("Set up reporting", taskReportingHelp, { class: "primary" }), button("See all activity", () => changeActivityKind("all"))) : button(filtered ? "Clear filters" : "View connections", () => { if (filtered) clearActivityFilters(); else location.hash = "connect"; })),
    state.activities.length > 0 && el("div", { class: "activity-list-footer" },
      el("span", {}, `${state.activities.length} ${state.activities.length === 1 ? "activity" : "activities"}${state.more ? " shown" : ""}`),
      el("span", { class: "activity-key-hint" }, el("kbd", {}, "↑"), el("kbd", {}, "↓"), "to move", el("kbd", {}, "Enter"), "to inspect"),
      state.more && button(state.loading ? [icon("loader-circle", { size: 14, class: "spin" }), "Loading…"] : "Load more", () => loadActivity({ append: true }), { class: "small", disabled: state.loading })),
    state.activities.length > 100 && el("div", { class: "activity-history-paused", role: "status" }, icon("clock", { size: 13 }), "Live refresh is paused while you explore older work.", button("Back to latest", () => loadActivity(), { class: "text small" })),
    el("p", { class: "activity-footnote" }, icon("shield-check", { size: 13 }), memory ? "Private to this workspace. These operations were observed by Engram." : "Private to this workspace. Memory calls are recorded by Engram; external work comes from agent reports."),
  ];
}
function refreshActivityResults() {
  if (!activityHistoryActive()) return;
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
  if (!state.session || !activityHistoryActive()) return;
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
    if (requestId !== generation || !activityHistoryActive() || workspaceId !== state.session?.org.id) return;
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
    state.agents = data.agents ?? []; state.tools = data.tools ?? []; state.more = Boolean(data.more); state.demo ||= Boolean(data.demo); state.error = "";
    state.activityStats = data.stats || {}; state.checkedAt = data.checkedAt;
    if (!quiet) announcements.textContent = `${state.activities.length} ${state.activities.length === 1 ? "activity" : "activities"} loaded`;
    for (const [label, values, selected, placeholder] of [["Filter by agent", state.agents, state.filters.agent, "All agents"], ["Filter by tool", state.tools, state.filters.tool, "All tools"]]) {
      const control = document.querySelector(`select[aria-label="${label}"]`);
      if (!control) continue;
      const focused = control === document.activeElement || control.closest('.ds-select')?.contains(document.activeElement);
      if (focused && control.options.length > 1) continue;
      const options = [["", placeholder], ...values.map(value => [value, label === "Filter by agent" ? agentLabel(value) : toolLabel(value)])];
      // Compare the rendered options so a refresh deferred during keyboard use is retried on the next poll.
      if (JSON.stringify([...control.options].map(item => [item.value, item.textContent])) !== JSON.stringify(options)) {
        control.replaceChildren(...options.map(([value, text]) => option(value, text))); control.value = selected;
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
  clearTimeout(searchTimer); clearTimeout(insightTimer); ++generation;
  const wasChecks = activityChecksActive();
  state.insightsQuery = q; state.insightsActivityId = activityId; state.insights = null; state.insightError = ""; state.insightBusy = false;
  pendingInsightRun = state.session.canWrite !== false && Boolean(q.trim() || activityId);
  // Select Checks before closing a source drawer, so close cannot poll History.
  state.activityTab = "checks";
  if (dialog.open) closeDetail();
  if (wasChecks) { writeRoute(); render(); if (pendingInsightRun) { pendingInsightRun = false; runInsights(); } }
  else location.hash = activityHref({ tab: "checks", query: q, activityId });
}
function activityChecksView() {
  const pending = ["queued", "running"].includes(state.insights?.job?.status);
  const checking = state.insightBusy || pending, readOnly = state.session.canWrite === false;
  const query = el("input", { id: "activity-check-query", type: "search", class: "search", maxlength: 500, readonly: checking, placeholder: "e.g. deployment work", "aria-label": "Find related work", "aria-describedby": "activity-check-hint", value: state.insightsQuery,
    oninput: event => { state.insightsQuery = event.target.value; writeRoute(); } });
  const run = el("button", { type: "submit", class: "primary large", disabled: checking || readOnly, 'aria-busy': String(checking) }, icon(checking ? "loader-circle" : "layers", { size: 14, class: checking ? "spin" : "" }), checking ? "Checking…" : "Run checks");
  return [
    state.insightsActivityId && el("div", { class: "insight-scope" }, icon("layers", { size: 13 }), "One activity selected", button("Check all activity", () => {
      if (checking) return;
      clearTimeout(insightTimer); ++generation; state.insightsActivityId = ""; state.insights = null; state.insightError = ""; writeRoute(); render();
      document.querySelector("#activity-check-query")?.focus({ preventScroll: true });
    }, { class: "text small", disabled: checking })),
    el("form", { class: "insight-toolbar activity-check-toolbar", onsubmit: event => { event.preventDefault(); runInsights(); } },
      el("label", { class: "field activity-check-query", for: "activity-check-query" }, "Find related work (optional)", el("span", { class: "search-field" }, icon("search", { size: 15 }), query)), run),
    el("p", { class: "ds-hint activity-check-hint", id: "activity-check-hint" }, "Leave this blank to check recorded work for loose ends. Add a description to find related activity. Results include source links and a handoff brief."),
    readOnly && el("p", { class: "ds-notice", role: "status" }, "Write access is required to run a check. You can still read existing results."),
    el("div", { id: "insights-results", class: "ds-results", "aria-busy": String(checking) }, insightResults()),
  ];
}
function insightResults() {
  const job = state.insights?.job, pending = ["queued", "running"].includes(job?.status);
  return [state.insightError && notice(state.insightError, () => loadInsights()),
    pending && loadingState({ label: job.status === "queued" ? "Checks queued…" : "Checking activity…", description: "Read-only checks. Your agents and memory stay unchanged.", lines: 2 }),
    ["failed", "cancelled"].includes(job?.status) && notice(job.status === "cancelled" ? "This check was cancelled. You can run it again." : "The check could not finish. Run checks to try again."),
    !state.insights && state.insightBusy ? skeletonRows(3, "Starting checks…") : (state.insights?.result || !pending) && attentionResults(state.insights, { onSource: openInsightSource, onActivity: id => openInsightSource(id), onCopy: async text => { if (await copy(text)) toast("Brief copied"); } }),
    state.insights?.external && aiConfiguration(state.insights.external),
  ];
}
function refreshInsights() {
  const target = document.querySelector("#insights-results");
  if (!activityChecksActive() || !target) return;
  target.replaceChildren(...insightResults().flat(Infinity).filter(Boolean)); target.setAttribute("aria-busy", String(state.insightBusy || ["queued", "running"].includes(state.insights?.job?.status)));
  const query = document.querySelector("#activity-check-query");
  if (query) query.readOnly = state.insightBusy || ["queued", "running"].includes(state.insights?.job?.status);
  const scope = document.querySelector(".insight-scope button");
  if (scope) scope.disabled = state.insightBusy || ["queued", "running"].includes(state.insights?.job?.status);
  const run = document.querySelector(".insight-toolbar button");
  if (run) { const checking = state.insightBusy || ["queued", "running"].includes(state.insights?.job?.status); run.disabled = checking || state.session.canWrite === false; run.setAttribute('aria-busy', String(checking)); run.replaceChildren(icon(checking ? "loader-circle" : "layers", { size: 14, class: checking ? "spin" : "" }), checking ? "Checking…" : "Run checks"); }
}
async function runInsights() {
  if (!state.session || state.session.canWrite === false || !activityChecksActive() || state.insightBusy || ["queued", "running"].includes(state.insights?.job?.status) || sessionMutation) return;
  const workspaceId = state.session.org.id, requestId = ++generation;
  clearTimeout(insightTimer); writeRoute(); state.insightBusy = true; state.insightError = ""; refreshInsights();
  try {
    const input = { ...(state.insightsQuery.trim() ? { q: state.insightsQuery.trim() } : {}), ...(state.insightsActivityId ? { activityId: state.insightsActivityId } : {}) };
    const data = await api.runInsights(input, workspaceId);
    if (requestId !== generation || workspaceId !== state.session?.org.id || !activityChecksActive()) return;
    state.insights = { ...data, result: null }; state.insightBusy = false; refreshInsights();
    await loadInsights({ jobId: data.job.id });
  } catch (error) {
    if (requestId !== generation || workspaceId !== state.session?.org.id) return;
    if (error instanceof AuthError) return expired();
    state.insightBusy = false; state.insightError = errorMessage(error); refreshInsights();
  }
}
async function loadInsights({ jobId, quiet = false } = {}) {
  if (!state.session || !activityChecksActive()) return;
  const workspaceId = state.session.org.id, requestId = ++generation;
  clearTimeout(insightTimer); if (!quiet) { state.insightBusy = true; state.insightError = ""; refreshInsights(); }
  try {
    const data = await api.insights(jobId ? { jobId } : {}, workspaceId);
    if (requestId !== generation || workspaceId !== state.session?.org.id || !activityChecksActive()) return;
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
    el("div", { id: "review-results", class: "ds-results", "aria-busy": String(state.loading) }, reviewResults())];
  return [heading("Memory", "Decisions, preferences, and project context saved in this workspace.", state.session.canWrite !== false && button([icon("plus", { size: 15 }), "Add memory"], captureMemory, { class: "primary small" })),
    tabs,
    el("div", { class: "filters" }, el("div", { class: "search-field memory-search" }, icon("search", { size: 16 }), el("input", { type: "search", class: "search", placeholder: "Search memory…", "aria-label": "Search memory", value: state.memoryQuery, oninput: event => { state.memoryQuery = event.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(loadMemories, 250); } }), el("kbd", {}, "/"))),
    el("div", { id: "memory-results", class: "ds-results", "aria-busy": String(state.loading) }, memoryResults())];
}
function memoryResults() {
  return [state.error && notice(state.error, loadMemories),
    ...state.memories.map(memory => button([
      el("span", { class: "memory-icon" }, icon("file-text", { size: 19 })),
      el("span", { class: "memory-row-copy" }, el("strong", { class: "action-title" }, memory.title || memory.slug), memory.type === "shared-context" && statusBadge("Approved snapshot · read-only", { tone: "lilac" }), el("span", { class: "muted" }, memory.snippet || (memory.type === "shared-context" ? "An approved excerpt shared with this workspace." : memory.slug))),
      memory.updated_at && el("span", { class: "memory-date" }, day(memory.updated_at)),
    ], () => memoryDetail(memory.slug), { class: "memory-row ds-card" })),
    !state.memories.length && !state.error && (state.loading ? skeletonRows(4) : state.memoryQuery ? empty("No matching memory", "Try another search or clear it to see your saved memory.", button("Clear search", () => { state.memoryQuery = ""; const search = document.querySelector('input[aria-label="Search memory"]'); if (search) { search.value = ""; search.focus(); } loadMemories(); })) : empty("Keep the good bits.", "Save a decision, preference, or project detail here. Your connected agents can pick it up later.", state.session.canWrite !== false && button([icon("plus", { size: 14 }), "Add your first memory"], captureMemory))),
    state.more && button(state.loading ? "Loading…" : "Load more", () => loadMemories({ append: true }), { class: "small", disabled: state.loading })];
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
  const title = el("input", { name: "title", autocomplete: "off", placeholder: "A short title…", required: true, maxlength: 160 });
  const text = el("textarea", { name: "memory", autocomplete: "off", placeholder: "A decision, useful context, or something to remember…", required: true });
  const save = el("button", { class: "primary", type: "submit" }, "Save memory");
  const feedback = el("p", { id: "capture-feedback", class: "detail-note", role: "alert", tabindex: -1 });
  showDetail("New memory", el("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); busy(save, "Saving…", true); event.currentTarget.setAttribute('aria-busy', 'true'); feedback.textContent = "";
    const requestId = detailGeneration;
    try { await api.capture({ title: title.value, text: text.value }, workspaceId); if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return; closeDetail(); toast("Memory saved"); loadMemories(); }
    catch (error) { if (workspaceId !== state.session?.org.id || requestId !== detailGeneration) return; if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); feedback.textContent = errorMessage(error); feedback.focus(); }
    finally { busy(save, "Save memory", false); save.closest('form')?.setAttribute('aria-busy', 'false'); }
  } }, el("h2", { id: "detail-title" }, "Add memory"), field("Title", title), field("Memory", text), feedback, save));
}
function reviewResults() {
  return [state.error && notice(state.error, loadReviews),
    ...state.reviews.map(item => button([el("span", {}, el("strong", {}, `${item.kind.replaceAll("_", " ")} proposal`), el("small", {}, item.payload?.otherSlug || item.payload?.slug || `Review #${item.id}`)), el("span", { class: "review-state" }, item.state, " · ", day(item.createdAt))], () => reviewDetail(item.id), { class: "review-row" })),
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
    const { item, entry } = data, plan = reviewPlan(item, entry), feedback = el("p", { role: "status", "aria-live": "polite", tabindex: -1, class: "detail-note" });
    const allowed = reviewAllowed(state.session), pending = item.state === "pending";
    const controls = el("div", { class: "review-actions" });
    for (const [action, label] of [["approve", "Apply proposed change"], ["defer", "Defer"], ["reject", "Reject"]]) {
      controls.append(button(label, async event => {
        if (!allowed || !pending || (action === "approve" && !plan.supported)) return;
        const version = detailGeneration, submit = event.currentTarget; controls.querySelectorAll("button").forEach(node => node.disabled = true); busy(submit, "Saving…", true); controls.setAttribute('aria-busy', 'true'); feedback.setAttribute('role', 'status'); feedback.textContent = "Saving decision…";
        try {
          await api.resolveReview(id, action, workspaceId);
          if (workspaceId !== state.session?.org.id || version !== detailGeneration) return;
          closeDetail(); toast(action === "approve" ? "Proposed change applied" : action === "defer" ? "Proposal deferred" : "Proposal rejected"); loadReviews();
        } catch (error) {
          if (workspaceId !== state.session?.org.id || version !== detailGeneration) return;
          if (error instanceof AuthError) return expired();
          busy(submit, label, false); controls.setAttribute('aria-busy', 'false'); feedback.setAttribute('role', 'alert'); feedback.textContent = errorMessage(error); controls.querySelectorAll("button").forEach(node => node.disabled = node.dataset.approval === "true" && !plan.supported); feedback.focus();
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
  const workspaceId = state.session.org.id, epoch = authEpoch;
  const canConnect = ["owner", "member"].includes(state.session.role);
  return el("div", { class: "connect-layout" },
    heading("Connections", "Connect an agent and manage its access to this workspace.",
      el("div", { class: "ds-row connection-page-actions" },
        button("Refresh", loadConnections, { class: "small", "aria-label": "Refresh connections", disabled: state.loading }),
        canConnect && button("Connect an agent", () => beginConnection(), { class: "primary small", "data-connect-action": "true" }))),
    state.error && notice(state.error, loadConnections),
    state.connectionError && notice("Connection status could not load. Refresh to try again.", loadConnections),
    canConnect && state.connections && el("div", { class: "connection-list-filter" }, field("Connection list", select("Connection list", state.connectionList, [
      ["current", `Current (${state.connections.connections.filter(connection => !connection.archivedAt).length})`],
      ["archived", `Archived (${state.connections.connections.filter(connection => connection.archivedAt).length})`],
    ], value => {
      if (authEpoch !== epoch || workspaceId !== state.session?.org.id) return;
      state.connectionList = value; render(); selectControls.update();
      document.querySelector('select[aria-label="Connection list"]')?.focus({ preventScroll: true });
    }))),
    canConnect ? state.connections ? connectionInventory(state.connections, { list: state.connectionList, onInspect: connectionHelp,
      actions: connection => button(state.session.role === "owner" ? "Manage" : "Details", () => connectionHelp(connection), { class: "text small", "aria-label": `${state.session.role === "owner" ? "Manage" : "Details for"} ${connection.displayName || connection.name || "connection"}` }),
    }) : !state.error && !state.connectionError && skeletonRows(3, "Loading connections…") : empty("Managed by your workspace owner", "Sign in with your own account to connect an agent or manage its access."),
  );
}

function beginConnection({ agentId, draft } = {}) {
  if (sessionMutation || !["owner", "member"].includes(state.session?.role)) return;
  if (draft) connectionDraft = { ...draft, keyExpanded: true };
  else if (agentId !== undefined) connectionDraft = { name: "", canWrite: true, helpAgentId: agentId, helpExpanded: true, keyExpanded: true };
  else connectionDraft = genericConnectionDraft(connectionDraft || {});
  if (!connectionAgents.some(agent => agent.id === connectionDraft.helpAgentId)) connectionDraft.helpAgentId = "";
  const workspaceId = state.session.org.id;
  if (state.view !== "connect") {
    connectionFocusPending = { workspaceId, afterLoad: true };
    if (dialog.open) { skipDetailReturnFocus = true; closeDetail(); }
    location.hash = "connect";
    return;
  }
  openConnectionDialog();
}

function openConnectionDialog() {
  const workspaceId = state.session.org.id, epoch = authEpoch, scopedApi = workspaceApi(workspaceId);
  const requestKey = `${epoch}:${workspaceId}`;
  const editor = { workspaceId, epoch, draft: { ...connectionDraft }, error: "", generation: -1, render: null, isCurrent: null };
  connectionEditor = editor;
  const currentWorkspace = () => !sessionMutation && authEpoch === epoch && state.session?.org.id === workspaceId && state.view === "connect";
  editor.isCurrent = () => currentWorkspace() && connectionEditor === editor && dialog.open && editor.generation === detailGeneration;
  editor.render = focusKey => {
    if (!currentWorkspace()) return;
    const content = connectionSetupView({ helpAgentId: editor.draft.helpAgentId, keyExpanded: editor.draft.keyExpanded, helpExpanded: editor.draft.helpExpanded, endpoint: state.mcp || `${location.origin}/mcp`, workspace: state.session.org, draft: editor.draft,
      busy: connectionKeyRequests.has(requestKey), error: editor.error, copyControl: copyButton,
      onHelpChoose: helpAgentId => {
        if (!editor.isCurrent() || connectionKeyRequests.has(requestKey)) return;
        editor.draft = { ...editor.draft, helpAgentId, helpExpanded: true }; connectionDraft = { ...editor.draft }; editor.render("help");
      },
      onKeyToggle: keyExpanded => { if (editor.isCurrent() && dialog.contains(content)) { editor.draft.keyExpanded = keyExpanded; connectionDraft = { ...editor.draft }; } },
      onHelpToggle: helpExpanded => { if (editor.isCurrent() && dialog.contains(content)) { editor.draft.helpExpanded = helpExpanded; connectionDraft = { ...editor.draft }; } },
      onDraft: draft => { if (editor.isCurrent()) { editor.draft = { ...editor.draft, name: draft.name, canWrite: draft.canWrite }; connectionDraft = { ...editor.draft }; } },
      onDone: () => { if (editor.isCurrent()) { closeDetail(); loadConnections(); } },
      onSubmit: async input => {
        if (!editor.isCurrent() || connectionKeyRequests.has(requestKey)) return;
        editor.draft = { ...editor.draft, name: input.name, canWrite: input.canWrite, keyExpanded: true }; connectionDraft = { ...editor.draft }; editor.error = "";
        const request = {}; connectionKeyRequests.set(requestKey, request);
        editor.render();
        try {
          const data = await scopedApi.mintToken(connectionKeyPayload(editor.draft, input));
          if (!currentWorkspace()) return;
          state.connectionFetchedAt = 0;
          // A dismissed/replaced dialog never reopens or exposes a late key.
          if (!editor.isCurrent()) { loadConnections(); return; }
          connectionDraft = null; connectionEditor = null;
          tokenDetail(data, editor.draft.helpAgentId);
          loadConnections();
        } catch (error) {
          if (!currentWorkspace()) return;
          if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
          if (editor.isCurrent()) editor.error = errorMessage(error);
        } finally {
          if (connectionKeyRequests.get(requestKey) === request) connectionKeyRequests.delete(requestKey);
          const active = connectionEditor;
          if (active?.workspaceId === workspaceId && active.epoch === epoch && active.isCurrent()) {
            const focused = document.activeElement;
            const focusKey = focused?.dataset.connectionFocus || focused?.closest('.ds-select')?.querySelector('select')?.dataset.connectionFocus;
            active.render(active === editor ? "name" : focusKey);
          }
        }
      },
    });
    showDetail("Connect an agent", content, { returnTo: '[data-connect-action]' });
    returnFocusSelector = '[data-connect-action]';
    editor.generation = detailGeneration;
    selectControls.update();
    if (focusKey) content.querySelector(`[data-connection-focus="${focusKey}"]`)?.focus({ preventScroll: true });
  };
  editor.render(editor.draft.keyExpanded ? "name" : "prompt");
}

function taskReportingHelp() {
  const workspaceId = state.session.org.id;
  showDetail("Task reporting", taskReportingSetup(state.connections, {
    copyControl: copyButton("Copy agent instructions", taskReportingInstructions),
    onInspect: connection => { if (workspaceId === state.session?.org.id) connectionHelp(connection); },
    onManage: () => { if (workspaceId !== state.session?.org.id) return; closeDetail(); location.hash = "connect"; },
    onSetup: () => { if (workspaceId !== state.session?.org.id) return; closeDetail(); openSetup({ agentSetup: true }); },
  }), { reporting: true });
  dialog.scrollTop = 0;
}
function connectionHelp(connection) {
  const workspaceId = state.session.org.id, epoch = authEpoch, reporting = taskReportingStatus(connection), reconnect = reporting.reconnect;
  const owner = state.session.role === "owner", archived = Boolean(connection.archivedAt);
  const token = connection.kind === "token" && !archived && connection.status === "authorized" ? state.tokens.find(token => token.name === connection.name && !token.revokedAt) : null;
  const pending = connectionMutations.has(`${epoch}:${workspaceId}:${connection.id}`);
  const endpoint = state.mcp || `${location.origin}/mcp`;
  showDetail(owner ? "Manage connection" : archived ? "Archived connection" : reconnect ? "Reconnect agent" : "Connection details", [
    el("div", { class: "detail-tool-icon" }, visualIcon(agentVisual(connection.agent, { ...connection, harness: connection.harness || connectionClient(connection).harness || "other" }), { size: 26 })),
    el("h2", { id: "detail-title" }, connection.displayName || connection.name || "Agent connection"),
    el("p", { class: "detail-note", title: connectionClient(connection).detail }, `Client: ${connectionClient(connection).label}`),
    el("p", { class: "detail-note" }, archived ? "This connection is archived and disconnected. Its memory and activity stay available. Restore it to the current list, then reconnect separately when you need it." : reconnect ? "This authorization no longer grants access. Reconnect in the agent, or replace its access key." : connection.status === "authorized" ? "This authorization can access Engram. Activity appears when the agent makes memory calls or reports its work." : "This connection's access could not be verified. Refresh Connections to check its current status."),
    owner && el("section", { class: "connection-management stack", "aria-label": "Manage connection" },
      el("h3", {}, "Connection actions"),
      pending && el("p", { class: "detail-note", role: "status" }, el("span", { class: "ds-spinner", "aria-hidden": "true" }), "Updating this connection… Refresh Connections to check the result."),
      token && el("div", { class: "ds-toolbar" },
        button("Edit source", () => connectionSource(token), { class: "small", disabled: pending }),
        button(token.canWrite === false ? "Allow writes" : "Make read only", () => changeConnectionPermission(connection, token), { class: "small", disabled: pending }),
        button("Disconnect", () => disconnect(token.name), { class: "small", disabled: pending })),
      el("p", { class: "detail-note" }, archived ? "Restore returns the listing. Access stays disconnected." : "Archive disconnects the agent and keeps its listing in Archived."),
      el("div", { class: "ds-toolbar" },
        button(archived ? "Restore connection" : "Archive connection", () => connectionLifecycleConfirm(connection, archived ? "restore" : "archive"), { class: "small", disabled: pending }),
        button("Delete connection", () => connectionLifecycleConfirm(connection, "delete"), { class: "ds-button small", "data-variant": "danger", disabled: pending })),
      el("p", { class: "detail-note" }, "Delete removes this connection permanently. Memories and activity stay available.")),
    el("dl", {}, el("dt", {}, "Connection"), el("dd", {}, connection.kind === "oauth" ? "Agent sign-in" : connection.name || "Unavailable"), el("dt", {}, "Access"), el("dd", {}, connection.canWrite === true ? "Read and write" : connection.canWrite === false ? "Read only" : "Unavailable"), el("dt", {}, "Task reports"), el("dd", {}, reporting.label)),
    el("p", { class: "detail-note" }, reporting.detail),
    memoryUsagePanel(connection),
    !archived && el("details", { class: "connection-guide" }, el("summary", {}, "Reconnect from your agent"), el("ol", {},
      el("li", {}, "Open the agent’s MCP or connector settings and choose Engram."),
      el("li", {}, "Use this endpoint, then sign in or update the bearer token as required by the agent."),
      el("li", {}, "Ask the agent to call Engram’s whoami tool, then refresh Connections to check for contact.")),
      el("div", { class: "endpoint" }, el("code", {}, endpoint), copyButton("Copy", endpoint)),
      el("p", { class: "detail-note" }, "For access keys, replace the bearer token in the agent’s MCP settings with a fresh key. Give each agent or computer its own connection."),
    owner && connection.kind === "token" && button("Create a fresh key", () => {
      if (workspaceId !== state.session?.org.id) return;
      beginConnection({ draft: { name: `${connection.name.slice(0, 96)}-new`, harness: connection.harness, sourceLabel: connection.sourceLabel, canWrite: connection.canWrite, helpAgentId: connection.harness || "", keyExpanded: true } });
    }, { class: "small", disabled: pending })),

  ]);
}
function connectionLifecycleConfirm(connection, action) {
  if (state.session?.role !== "owner" || sessionMutation) return;
  const workspaceId = state.session.org.id, epoch = authEpoch, key = `${epoch}:${workspaceId}:${connection.id}`;
  const scopedApi = workspaceApi(workspaceId);
  const name = connection.displayName || connection.name || "this connection";
  const label = action === "delete" ? "Delete connection" : action === "restore" ? "Restore connection" : "Archive connection";
  const feedback = el("p", { class: "form-feedback detail-note ds-notice", "data-tone": "danger", role: "alert", tabindex: "-1" });
  const submit = button(label, async () => {
    if (connectionMutations.has(key) || sessionMutation || authEpoch !== epoch || state.session?.org.id !== workspaceId || state.session?.role !== "owner") return;
    const requestId = detailGeneration, request = {};
    connectionMutations.set(key, request); busy(submit, action === "delete" ? "Deleting…" : action === "restore" ? "Restoring…" : "Archiving…", true); cancel.disabled = true; feedback.textContent = "";
    const current = () => authEpoch === epoch && state.session?.org.id === workspaceId && !sessionMutation;
    const currentDialog = () => current() && dialog.open && requestId === detailGeneration;
    try {
      const result = await scopedApi.manageConnection(connection.id, action);
      if (!current()) return;
      state.connectionFetchedAt = 0;
      if (!currentDialog()) return;
      if (result?.ok !== true || result.id !== connection.id || result.action !== action) throw new Error("The connection change could not be confirmed. Refresh Connections before trying again.");
      if (state.connections) state.connections = { ...state.connections, connections: state.connections.connections.flatMap(row => row.id !== connection.id ? [row] : action === "delete" ? [] : [{ ...row, archivedAt: action === "archive" ? result.archivedAt : null, status: "revoked" }]) };
      if (action === "restore") state.connectionList = "current";
      returnFocusSelector = '[aria-label="Refresh connections"]';
      closeDetail(); render(); toast(action === "delete" ? "Connection deleted. History kept." : action === "restore" ? "Connection restored. Reconnect to grant access." : "Connection archived and disconnected.");
      if (state.view === "connect") loadConnections();
    } catch (error) {
      if (!currentDialog()) return;
      if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
      feedback.textContent = errorMessage(error); feedback.focus();
    } finally {
      if (connectionMutations.get(key) === request) connectionMutations.delete(key);
      if (currentDialog()) { busy(submit, label, false); cancel.disabled = false; }
    }
  }, { class: action === "delete" ? "ds-button" : "primary", "data-variant": action === "delete" ? "danger" : undefined, disabled: connectionMutations.has(key) });
  const cancel = button("Cancel", () => connectionHelp(connection), { disabled: connectionMutations.has(key) });
  showDetail("Manage connection", [el("h2", { id: "detail-title" }, `${action === "delete" ? "Delete" : action === "restore" ? "Restore" : "Archive"} ${name}?`),
    el("p", { class: "detail-note" }, action === "delete" ? "This permanently removes the connection from your list and revokes its access. You cannot undo this deletion. Its memories, activity, and task reports stay available." : action === "restore" ? "This returns the connection to your current list. Access stays disconnected. Sign in again from the agent or create a fresh key when you want to reconnect." : "This revokes the connection’s access and moves it to Archived. Its memories, activity, and task reports stay available. Restoring its listing later will not restore access."),
    feedback, el("div", { class: "ds-toolbar" }, cancel, submit)]);
}
function changeConnectionPermission(connection, token) {
  const workspaceId = state.session.org.id, epoch = authEpoch, canWrite = token.canWrite === false;
  const feedback = el("p", { class: "form-feedback detail-note ds-notice", "data-tone": "danger", role: "alert", tabindex: "-1" });
  const save = button(canWrite ? "Allow writes" : "Make read only", async () => {
    if (sessionMutation || epoch !== authEpoch || workspaceId !== state.session?.org.id || state.session.role !== "owner" || save.disabled) return;
    const requestId = detailGeneration; busy(save, "Updating…", true); feedback.textContent = "";
    try {
      await api.setTokenWrite(token.name, canWrite, workspaceId);
      if (epoch !== authEpoch || workspaceId !== state.session?.org.id || requestId !== detailGeneration || !dialog.open || sessionMutation) return;
      token.canWrite = canWrite; connection.canWrite = canWrite; connectionHelp(connection); toast("Connection permission updated");
      if (state.view === "connect") loadConnections();
    } catch (error) {
      if (epoch !== authEpoch || workspaceId !== state.session?.org.id || requestId !== detailGeneration || !dialog.open || sessionMutation) return;
      if (error instanceof AuthError) return expired();
      feedback.textContent = errorMessage(error); feedback.focus(); busy(save, canWrite ? "Allow writes" : "Make read only", false);
    }
  }, { class: "primary" });
  showDetail("Connection permission", [el("h2", { id: "detail-title" }, canWrite ? "Allow this connection to write?" : "Make this connection read only?"),
    el("p", { class: "detail-note" }, canWrite ? "The connection can save memory and send task reports, subject to workspace policy and plan access." : "The connection can still read memory. New memory writes and task reports will be denied."), feedback,
    el("div", { class: "ds-toolbar" }, button("Cancel", () => connectionHelp(connection)), save)]);
}
function focusConnectionKey(afterLoad = false) {
  const intent = connectionFocusPending;
  if (!intent || intent.workspaceId !== state.session?.org.id || state.view !== "connect" || !connectionDraft) return;
  if (intent.afterLoad && !afterLoad) return;
  connectionFocusPending = null;
  if (!dialog.open) openConnectionDialog();
}
function connectionSource(token) {
  const workspaceId = state.session.org.id;
  const source = select("Agent source", token.harness || "other", agentSources, () => {});
  const sourceLabel = el("input", { name: "source-label", value: token.sourceLabel || "", autocomplete: "off", maxlength: 100, placeholder: "Optional source label…" });
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
  } }, el("h2", { id: "detail-title" }, token.name), el("p", { class: "detail-note" }, "This is a source label you set. Client names received from a connection are shown separately."), field("Source", source), field("Display label", sourceLabel), feedback, save));
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
  finally {
    if (requestId === generation) {
      const focusLabel = !dialog.open && state.view === "connect" ? document.activeElement?.getAttribute("aria-label") : null;
      const focusConnect = !dialog.open && state.view === "connect" && document.activeElement?.hasAttribute("data-connect-action");
      state.loading = false; render();
      if (["Refresh connections", "Connection list"].includes(focusLabel)) {
        selectControls.update();
        document.querySelector(`[aria-label="${focusLabel}"]`)?.focus({ preventScroll: true });
      }
      if (focusConnect) document.querySelector("[data-connect-action]")?.focus({ preventScroll: true });
      focusConnectionKey(true);
    }
  }
}
function tokenDetail(data, helpAgentId = "") {
  const secret = el("input", { type: "password", class: "connection-secret", value: data.token, readonly: true, autocomplete: "off", spellcheck: "false", "aria-label": "New access key" });
  const reveal = button("Show key", () => { const shown = secret.type === "text"; secret.type = shown ? "password" : "text"; reveal.textContent = shown ? "Show key" : "Hide key"; reveal.setAttribute("aria-pressed", String(!shown)); }, { class: "small", "aria-pressed": "false" });
  const formats = [["other", "MCP JSON"], ["codex", "Codex · TOML"], ["vscode", "VS Code · JSON"], ["claude-code", "Claude Code · JSON"], ["github-copilot", "GitHub Copilot · JSON"], ["gemini-cli", "Gemini CLI · JSON"], ["opencode", "OpenCode · JSON"], ["openclaw", "OpenClaw · JSON"]];
  const selected = formats.some(([id]) => id === helpAgentId) ? helpAgentId : "other";
  const preview = el("pre", { tabindex: "0" }, accessKeyConfiguration(selected, data.mcp));
  const format = select("Configuration format", selected, formats, () => { preview.textContent = accessKeyConfiguration(format.value, data.mcp); });
  showDetail("Connect an agent", el("div", { class: "connection-result ds-stack" },
    el("div", { class: "ds-heading-group" }, el("h2", { id: "detail-title" }, data.name),
      el("p", { class: "ds-hint" }, `Copy this key now. It is only shown once. Its permission is ${data.canWrite === false ? "read only" : "read and write"}; workspace policy and hosted plan access also apply.`)),
    el("div", { class: "connection-secret-row" }, secret, reveal),
    el("div", { class: "ds-row" }, copyButton("Copy access key", data.token, { class: "primary small" })),
    el("h3", {}, "Add Engram in your agent’s MCP settings"),
    el("p", { class: "ds-hint" }, "Use this endpoint and the key above as the bearer token. Creating a key grants access; contact is recorded after the agent calls Engram."),
    el("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "MCP endpoint. Scroll horizontally to read." }, data.mcp),
    el("div", { class: "ds-row" }, copyButton("Copy endpoint", data.mcp, { class: "small" })),
    el("details", { class: "connection-install" }, el("summary", {}, "MCP configuration"),
      el("p", { class: "ds-hint" }, "Optional examples for clients that accept a configuration file. Changing the format does not label the connection. The copy button includes the key."),
      field("Configuration format", format), preview,
      copyButton("Copy configuration with key", () => accessKeyConfiguration(format.value, data.mcp, secret.value), { class: "small" })),
    el("p", { class: "ds-hint" }, "Reload the agent after updating its settings, then refresh Connections. Its client name appears when the app supplies one."),
    el("div", { class: "ds-row" }, button("Done", () => { closeDetail(); loadConnections(); }, { class: "small" })),
  ), { returnTo: '[data-connect-action]' });
  returnFocusSelector = '[data-connect-action]';
  selectControls.update();
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
  if (state.session.role !== "owner") return [heading("Public profile", "A shareable view of your agents’ work."), empty("Managed by your workspace owner", "Only workspace owners can publish a profile and choose its sharing scope.")];
  if (!state.showcase) return [heading("Public profile", "A live window into your agents’ work, with private details left out."), state.error ? notice(state.error, loadShowcase) : profileSkeleton()];
  const draft = state.showcaseDraft;
  const saved = state.showcase.profile;
  const hasChanges = value => ["slug", "displayName", "bio"].some(key => value[key] !== saved[key]) || Boolean(value.showActivity) !== Boolean(saved.showActivity) || profilePhotoChanged(value, saved) || profilePresentationChanged(value, saved);
  const workspaceId = state.session.org.id, epoch = authEpoch;
  const publicUrl = saved.published ? state.showcase.urls.page : `${location.origin}/u/${draft.slug || "your-name"}`;
  const nameError = el("p", { id: "showcase-name-error", class: "ds-field-error", hidden: true });
  const slugError = el("p", { id: "showcase-slug-error", class: "ds-field-error", hidden: true });
  const bioError = el("p", { id: "showcase-bio-error", class: "ds-field-error", hidden: true });
  const name = el("input", { name: "displayName", autocomplete: "name", value: draft.displayName, placeholder: "Your name", maxlength: 80, "aria-describedby": "showcase-name-error" });
  const slug = el("input", { name: "slug", value: draft.slug, autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "your-name", required: true, minlength: 3, maxlength: 48, pattern: "(?=.{3,48}$)[a-z0-9]+(?:-[a-z0-9]+)*", "aria-describedby": "slug-hint showcase-slug-error" });
  const bio = el("textarea", { name: "bio", maxlength: 160, rows: 3, placeholder: "A line about you and the work your agents do.", "aria-describedby": "bio-hint showcase-bio-error" }, draft.bio);
  const showActivity = el("input", { type: "checkbox", name: "showActivity", checked: Boolean(draft.showActivity), "aria-describedby": "activity-sharing-note" });
  const feedback = el("div", { id: "showcase-feedback", role: "status", "aria-live": "polite", tabindex: -1, class: "form-feedback" });
  const save = el("button", { type: "submit", class: "primary", "data-showcase-focus": "save", "aria-describedby": "showcase-feedback" }, icon("check", { size: 15 }), "Save changes");
  let pending = false;
  const isCurrent = () => !sessionMutation && authEpoch === epoch && state.session?.org.id === workspaceId && state.view === "showcase" && form.isConnected;
  const setFieldError = (control, errorNode, message = "") => {
    control.setAttribute("aria-invalid", String(Boolean(message)));
    control.setCustomValidity(message);
    errorNode.textContent = message; errorNode.hidden = !message;
  };
  const setFeedback = (message, error = false) => {
    feedback.setAttribute("role", error ? "alert" : "status");
    feedback.setAttribute("aria-live", error ? "assertive" : "polite");
    feedback.textContent = message;
  };
  const validate = () => {
    if (photo.isBusy()) { setFeedback("Wait for your photo to finish preparing.", true); return false; }
    const errors = [
      [slug, slugError, /^(?=.{3,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.value) ? "" : "Use 3–48 lowercase letters or numbers, with single hyphens between them."],
      [name, nameError, name.value.trim().length <= 80 ? "" : "Use a display name of at most 80 characters."],
      [bio, bioError, bio.value.trim().length <= 160 ? "" : "Use an About you description of at most 160 characters."],
    ];
    for (const [control, errorNode, message] of errors) setFieldError(control, errorNode, message);
    const invalid = errors.find(([, , message]) => message);
    if (invalid) { setFeedback("Check the highlighted profile field before saving.", true); invalid[0].focus(); return false; }
    if (!presentation.validate()) { setFeedback("Check your highlight fields before saving.", true); return false; }
    setFeedback(""); return true;
  };
  const publish = button([icon(saved.published ? "eye-off" : "globe", { size: 15 }), saved.published ? "Unpublish" : "Publish profile"], async () => {
    if (pending || !isCurrent()) return;
    update();
    if (!saved.published && !validate()) return;
    await persistShowcase(!saved.published, publish, feedback, saved.published ? saved : state.showcaseDraft, controller);
  }, { class: saved.published ? "small" : "primary small", "data-showcase-focus": "publish", "aria-describedby": "showcase-feedback" });
  const preview = el("div", { class: "profile-preview-content" }, showcasePreview());
  const presentation = createProfilePresentationEditor({ profile: draft, isCurrent, onChange: () => { setFeedback(""); update(); } });
  const photo = profilePhotoEditor = createProfilePhotoEditor({ photo: draft.photo ?? null, isCurrent, onChange: () => { setFeedback(""); update(); } });
  const update = () => {
    if (!isCurrent() || pending) return;
    state.showcaseDraft = { ...draft, displayName: name.value, slug: slug.value, bio: bio.value, showActivity: showActivity.checked, photo: photo.read(), ...presentation.read() };
    const card = preview.querySelector('.public-profile');
    if (card && state.showcase?.preview) updateProfileCard(card, showcasePreviewData(state.showcase.preview));
    else preview.replaceChildren(showcasePreview());
    const count = document.querySelector("#bio-hint"); if (count) count.textContent = `${bio.value.length} / 160`;
    const changedAddress = document.querySelector("#slug-change-hint"); if (changedAddress) changedAddress.hidden = !(saved.published && slug.value !== saved.slug);
    const permalink = document.querySelector("#profile-permalink"); if (permalink && !saved.published) permalink.textContent = `${location.origin}/u/${slug.value || "your-name"}`;
    const previewStatus = document.querySelector(".preview-label > span"); if (previewStatus) previewStatus.textContent = Boolean(showActivity.checked) !== Boolean(saved.showActivity) ? "Unsaved sharing preview" : hasChanges(state.showcaseDraft) ? "Unsaved preview" : "What others will see";
    save.disabled = photo.isBusy() || !hasChanges(state.showcaseDraft);
  };
  for (const [control, errorNode] of [[name, nameError], [slug, slugError], [bio, bioError]]) control.addEventListener("input", () => { if (!pending && isCurrent()) { setFieldError(control, errorNode); setFeedback(""); } });
  [name, slug, bio, showActivity].forEach(node => node.addEventListener("input", update));
  save.disabled = !hasChanges(draft);
  const controller = {
    workspaceId, epoch, isCurrent,
    setPending(value) { if (pending === value) return; pending = value; form.setAttribute("aria-busy", String(value)); for (const control of [name, slug, bio, showActivity, save, publish]) control.disabled = value; presentation.setPending(value); photo.setPending(value); if (!value) update(); },
    error(message, focus = true) { setFeedback(message, true); if (message === "That showcase address is already taken") { setFieldError(slug, slugError, "This profile address is already taken. Choose another address."); if (focus) slug.focus(); } else if (focus) feedback.focus(); },
  };
  const form = el("form", { class: "showcase-form stack", novalidate: true, onsubmit: async event => { event.preventDefault(); if (pending || !isCurrent()) return; update(); if (validate()) await persistShowcase(saved.published, save, feedback, state.showcaseDraft, controller); } },
    presentation.layoutElement,
    photo.element,
    field("Display name", name), nameError,
    field("Profile URL", el("div", { class: "slug-field" }, el("span", {}, "/u/"), slug)),
    el("p", { id: "slug-hint", class: "field-hint" }, "3–48 lowercase letters or numbers, with single hyphens between them."), slugError,
    el("p", { id: "slug-change-hint", class: "field-hint", hidden: true }, "Changing this address makes the old link unavailable."),
    field("About you", bio), el("p", { class: "field-hint counter", id: "bio-hint" }, `${bio.value.length} / 160`), bioError,
    presentation.element,
    el("label", { class: "ds-option" }, showActivity, el("span", {}, el("strong", {}, "Share a redacted activity stream"), el("small", { id: "activity-sharing-note" }, "Show agent products, services, broad action labels, status, and receipt times. Task text, repository and document names, URLs, and personal agent aliases stay private."))),
    el("p", { class: "field-hint" }, "Off hides the activity stream. Counts, broad categories, and any highlights you write can still appear on a published profile. Review the preview before saving; saved changes to a published profile become public."), feedback,
    el("div", { class: "form-actions" }, save, el("span", { class: "field-hint" }, saved.published ? "Changes update your public page." : "Saving keeps your profile private.")));
  const urls = state.showcase.urls;
  return [
    heading("Public profile", "A live window into your agents’ work, with private details left out.", publish),
    state.error && notice(state.error),
    el("div", { class: "showcase-layout" },
      el("div", { class: "showcase-controls" },
        el("section", { class: "visibility-panel" }, el("div", { class: "visibility-title" }, icon(saved.published ? "globe" : "eye-off", { size: 17 }), el("strong", {}, saved.published ? "Your profile is public" : "Only you can see this"), el("span", { class: "visibility-badge" }, saved.published ? "Published" : "Draft")), el("p", {}, `Shows recorded activity from ${state.session.org.name}. ${saved.showActivity ? "Agent products and broad action labels are included." : "The activity stream is off; counts and broad categories can appear."} ${saved.highlights?.length ? "Your saved highlights are included when published. " : ""}Private task text and resource names are never added automatically.`)),
        form,
        el("section", { class: "share-links section" }, el("h3", {}, "Share anywhere"), el("p", {}, "Share the live profile link, or connect the same updates to your website."),
          el("div", { class: "share-link-row" }, el("span", { class: "share-link-label" }, icon("link", { size: 14 }), "Profile"), el("code", { id: "profile-permalink", class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "Profile URL. Scroll horizontally to read." }, publicUrl), copyButton("Copy", () => state.showcase.urls.page, { disabled: !saved.published, "aria-label": "Copy profile URL" })),
          saved.published && el("div", { class: "share-link-row" }, el("span", { class: "share-link-label" }, icon("code", { size: 14 }), "JSON"), el("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "JSON URL. Scroll horizontally to read." }, urls.json), copyButton("Copy", urls.json, { "aria-label": "Copy JSON URL" })),
          saved.published && el("div", { class: "share-link-row" }, el("span", { class: "share-link-label" }, icon("activity", { size: 14 }), "Live API"), el("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "Live API URL. Scroll horizontally to read." }, urls.stream || `${urls.json}/stream`), copyButton("Copy", urls.stream || `${urls.json}/stream`, { "aria-label": "Copy live API URL" })),
          saved.published && el("div", { class: "profile-link-actions" }, el("a", { href: urls.page, target: "_blank", rel: "noopener", class: "button-link" }, "Open profile"), el("a", { href: urls.card, target: "_blank", rel: "noopener", class: "button-link" }, icon("share-2", { size: 14 }), "Social card")),
          !saved.published && el("p", { class: "field-hint" }, "Publish to activate the profile, JSON endpoint, and live stream. Unpublishing disables all three."),
          saved.published && el("details", {}, el("summary", {}, "Live website embed"), el("p", { class: "detail-note" }, "Paste this into your website for live counts, or use EventSource in your own design. JSON and the stream follow the sharing scope saved above."), el("pre", {}, liveEmbed(urls.stream || `${urls.json}/stream`)), copyButton("Copy live embed", liveEmbed(urls.stream || `${urls.json}/stream`))),
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
  return profileCard(showcasePreviewData(snapshot), { compact: true });
}
function showcasePreviewData(snapshot) {
  const enabled = Boolean(state.showcaseDraft?.showActivity);
  const draft = state.showcaseDraft;
  return { ...snapshot, profile: { ...snapshot.profile, ...draft, photoUrl: draft ? draft.photo ?? null : snapshot.profile.photoUrl }, activity: { enabled, events: enabled ? snapshot.activity?.events || [] : [] } };
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
async function persistShowcase(published, submit, feedback, profile, controller) {
  if (!controller?.isCurrent() || (showcaseSaving && showcaseSaving.isCurrent())) return;
  const request = { isCurrent: controller.isCurrent };
  showcaseSaving = request;
  const currentOrg = controller.workspaceId;
  const original = [...submit.childNodes];
  const focusKey = submit.dataset.showcaseFocus;
  // Revoking publication never saves an unreviewed draft or discards its edits.
  const revoking = !published && state.showcase.profile.published;
  const retainedDraft = revoking && (["slug", "displayName", "bio", "showActivity"].some(key => state.showcaseDraft[key] !== state.showcase.profile[key]) || profilePhotoChanged(state.showcaseDraft, state.showcase.profile) || profilePresentationChanged(state.showcaseDraft, state.showcase.profile)) ? { ...state.showcaseDraft, published: false } : null;
  controller.setPending(true);
  busy(submit, published ? "Saving…" : "Updating…", true);
  feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  feedback.textContent = published ? "Saving public profile…" : "Saving private profile…";
  try {
    const presentation = profilePresentationValue(profile);
    const data = await api.saveShowcase({ slug: profile.slug, displayName: profile.displayName.trim(), bio: profile.bio.trim(), showActivity: profile.showActivity === true, layout: presentation.layout, highlights: presentation.highlights.map(item => ({ title: item.title.trim(), body: item.body.trim(), url: item.url.trim() })), ...profilePhotoUpdate(profile, state.showcase.profile), published }, currentOrg);
    if (!controller.isCurrent() || showcaseSaving !== request) return;
    const restoreFocus = document.activeElement === submit || document.activeElement === document.body;
    state.showcase = data; state.showcaseDraft = retainedDraft || { ...data.profile };
    state.error = "";
    showcaseSaving = false;
    render();
    const message = data.profile.published ? "Public profile saved." : retainedDraft ? "Profile unpublished. Your unsaved edits are still in the form." : revoking ? "Profile is private." : "Profile saved privately.";
    const savedFeedback = document.querySelector("#showcase-feedback");
    if (savedFeedback) savedFeedback.textContent = message;
    if (restoreFocus) {
      const target = ["save", "publish"].includes(focusKey) && document.querySelector(`[data-showcase-focus="${focusKey}"]`);
      (target && !target.disabled ? target : savedFeedback)?.focus({ preventScroll: true });
    }
    toast(message);
  } catch (error) {
    if (!controller.isCurrent() || showcaseSaving !== request) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again.");
    const restoreFocus = document.activeElement === submit || document.activeElement === document.body;
    controller.setPending(false);
    submit.removeAttribute("aria-busy"); submit.replaceChildren(...original);
    controller.error(errorMessage(error), restoreFocus);
  } finally {
    if (showcaseSaving === request) {
      showcaseSaving = false;
      if (controller.isCurrent()) { controller.setPending(false); submit.removeAttribute("aria-busy"); submit.replaceChildren(...original); }
    }
  }
}

function setSessionControlsBusy(pending) {
  const picker = document.querySelector('select[aria-label="Workspace"]');
  if (picker) {
    const container = picker.closest('.workspace-picker') || picker.parentElement;
    picker.disabled = Boolean(pending); container.setAttribute('aria-busy', String(pending));
    const spinner = container.querySelector('.workspace-switch-spinner');
    if (pending && !spinner) container.append(el('span', { class: 'ds-spinner workspace-switch-spinner', 'aria-hidden': 'true' }));
    else if (!pending) spinner?.remove();
  }
  document.querySelectorAll('.sidebar-bottom button, .mobile-signout').forEach(control => { control.disabled = Boolean(pending); });
}
async function switchOrg(orgId) {
  if (sessionMutation || !state.session) return;
  announcements.textContent = "";
  accountFocusTarget = null;
  sessionMutation = true; setSessionControlsBusy(true);
  ++accessRequest; clearTimeout(accessRefreshTimer); accessError = "";
  invalidateWorkspaceNames();
  sharingPanel?.dispose(); sharingPanel = null;
  signupAdmin?.dispose(); signupAdmin = null;
  jevSettingsPanel?.dispose(); jevSettingsPanel = null;
  const epoch = authEpoch;
  setupReader.invalidate();
  clearTimeout(provisioningTimer); ++provisioningAttempt; provisioningChecking = false; provisioningError = "";
  state.account = null;
  clearTimeout(searchTimer); clearTimeout(insightTimer); ++generation; closeDetail(); state.error = "";
  try {
    const session = await api.switchOrg(Number(orgId));
    if (epoch !== authEpoch) return;
    state.session = session; state.activities = []; state.activityStats = {}; state.freshIds = new Set(); state.memories = []; state.tokens = []; state.connections = null; state.connectionError = ""; state.connectionFetchedAt = 0; state.connectionList = "current"; connectionDraft = null; connectionFocusPending = null; state.agents = []; state.tools = []; state.showcase = null; state.showcaseDraft = null; state.insights = null; state.insightsQuery = ""; state.insightsActivityId = ""; state.insightBusy = false; state.insightError = ""; state.reviews = []; state.reviewMore = false; pendingInsightRun = false; Object.keys(state.filters).forEach(key => state.filters[key] = ""); writeRoute(); render(); await loadView();
  } catch (error) {
    if (epoch !== authEpoch) return;
    if (error instanceof AuthError) return expired("Your session expired. Please sign in again."); toast(errorMessage(error)); render();
  } finally {
    sessionMutation = false; setSessionControlsBusy(false);
    // Sharing's controller starts requests only after the workspace switch ends.
    if (epoch === authEpoch && state.session && state.view === "sharing") render();
    if (workspacePending(state.session)) scheduleProvisioning();
  }
}

function selectiveSharingView() {
  const title = heading("Sharing", "Describe what belongs with your team or another agent. Review the exact excerpts before granting access.");
  if (!["owner", "member"].includes(state.session.role)) return [title, empty("Managed by your workspace owner", "Use your human account to review and share context.")];
  if (state.session.role === "member") return [title, empty("Start from your personal workspace", "Choose your personal workspace in the workspace picker to review and share excerpts. Approved team snapshots are available in Memory.")];
  const workspaceId = state.session.org.id, epoch = authEpoch;
  sharingPanel = sharingView({ api: workspaceApi(workspaceId), copy: value => navigator.clipboard.writeText(value),
    fail: error => { if (error instanceof AuthError) expired(); },
    isCurrent: () => !sessionMutation && authEpoch === epoch && state.view === "sharing" && state.session?.org.id === workspaceId });
  return [title, sharingPanel.element];
}

function accountView() {
  const billing = state.view === "billing";
  const workspaceId = state.session.org.id;
  const title = billing ? "Plan & billing" : "Workspace";
  const description = billing ? "Your current plan, access, and subscription details. All in one place." : "A shared space with clear boundaries. Manage people, permissions, and processing.";
  if (!["owner", "member"].includes(state.session.role) || (billing && state.session.role !== "owner")) return [heading(title, description), empty("Managed by your workspace owner", "Sign in with your own account to manage this workspace.")];
  if (!state.account || state.account.view !== state.view) return [heading(title, description), state.error ? notice(state.error, loadAccount) : skeletonRows(3)];
  const fail = error => { if (workspaceId === state.session?.org.id && error instanceof AuthError) expired("Your session expired. Please sign in again."); };
  const notify = message => { if (workspaceId === state.session?.org.id) toast(message); };
  const scopedApi = workspaceApi(workspaceId);
  const epoch = authEpoch;
  const owningView = state.view;
  const isPanelCurrent = () => !sessionMutation && authEpoch === epoch && state.view === owningView && state.session?.org.id === workspaceId;
  const isCurrent = () => isPanelCurrent() && state.view === "workspace";
  if (!billing) signupAdmin = signupAdminPanel({ session: state.session, api: scopedApi, fail, copy: value => navigator.clipboard.writeText(value), isCurrent: () => !sessionMutation && state.view === "workspace" && state.session?.org.id === workspaceId && state.session?.capabilities?.manageSignupInvites === true });
  const keepAccountFocus = feedback => { if (feedback?.restoreFocus && ['privacy-save', 'jev-save'].includes(feedback.focusKey)) accountFocusTarget = { workspaceId, view: owningView, key: feedback.focusKey }; };
  if (!billing) jevSettingsPanel = createJevSettingsPanel({ data: state.account.jev, error: state.account.jevError, api: scopedApi, fail, refresh: loadAccount, isCurrent, saved: (result, feedback) => {
    if (!isCurrent()) return;
    keepAccountFocus(feedback);
    state.account.jev = result;
    state.session.org.policies.jevProcessing = result.enabled === true;
    if (state.account.external) state.account.external.jevConsented = result.enabled === true;
    toast("Jev settings saved"); render();
  } });
  return [heading(title, description), billing ? billingPanel({ billing: state.account.billing, catalog: state.account.catalog, jev: state.account.jev, jevError: state.account.jevError, api: scopedApi, notify, fail, refresh: loadAccount, isCurrent: isPanelCurrent }) : [workspacePanel({ session: state.session, members: state.account.members, invites: state.account.invites, api: scopedApi, notify, fail, isCurrent, saved: (policies, feedback) => { if (isCurrent()) { keepAccountFocus(feedback); state.session.org.policies = policies; loadAccount(); } } }), jevSettingsPanel?.element, signupAdmin?.element, state.account.external && aiConfiguration(state.account.external, { settings: false })]];
}
async function loadAccount() {
  if (!["owner", "member"].includes(state.session.role) || (state.view === "billing" && state.session.role !== "owner")) return;
  const requestId = ++generation, view = state.view, workspaceId = state.session.org.id; state.error = ""; state.loading = true;
  try {
    const jevRequest = api.jev(workspaceId).then(jev => ({ jev, jevError: "" })).catch(error => { if (error instanceof AuthError) throw error; return { jev: null, jevError: errorMessage(error) }; });
    const [base, jev] = await Promise.all([view === "billing" ? Promise.all([api.billing(workspaceId), api.plans()]).then(([billing, catalog]) => ({ billing, catalog })) : Promise.all([api.members(workspaceId), api.insights({}, workspaceId)]).then(([members, insights]) => ({ ...members, external: insights.external })), jevRequest]);
    const data = { ...base, ...jev };
    if (requestId !== generation || state.view !== view || workspaceId !== state.session?.org.id) return;
    state.account = { view, ...data };
  } catch (error) { if (requestId === generation) { if (error instanceof AuthError) return expired(); state.error = errorMessage(error); state.account = null; } }
  finally { if (requestId === generation) { state.loading = false; render(); } }
}
async function signOut() {
  if (sessionMutation) return;
  sessionMutation = true; ++authEpoch; setSessionControlsBusy(true);
  invalidateWorkspaceNames();
  sharingPanel?.dispose(); sharingPanel = null;
  signupAdmin?.dispose(); signupAdmin = null;
  jevSettingsPanel?.dispose(); jevSettingsPanel = null;
  try { await api.logout(); expired(); }
  catch (error) { toast(errorMessage(error)); }
  finally { sessionMutation = false; setSessionControlsBusy(false); }
}
function expired(message = "") {
  ++authEpoch;
  ++accessRequest; clearTimeout(accessRefreshTimer); accessSnapshot = null; accessError = "";
  invalidateWorkspaceNames();
  sharingPanel?.dispose(); sharingPanel = null;
  signupAdmin?.dispose(); signupAdmin = null;
  jevSettingsPanel?.dispose(); jevSettingsPanel = null;
  setupReader.invalidate(); setupByWorkspace.clear();
  previewWatcher?.stop(); previewWatcher = null;
  state.account = null;
  clearTimeout(provisioningTimer); ++provisioningAttempt; provisioningChecking = false; provisioningError = "";
  clearTimeout(searchTimer); clearTimeout(insightTimer); ++generation; closeDetail(); state.session = null; state.activities = []; state.activityStats = {}; state.freshIds = new Set(); state.memories = []; state.tokens = []; state.connections = null; state.connectionError = ""; state.connectionFetchedAt = 0; state.connectionList = "current"; connectionDraft = null; connectionFocusPending = null; state.agents = []; state.tools = []; state.showcase = null; state.showcaseDraft = null; state.insights = null; state.insightsQuery = ""; state.insightsActivityId = ""; state.insightBusy = false; state.insightError = ""; state.reviews = []; pendingInsightRun = false; renderAuth("email", message);
}
function renderAuth(mode = "email", message = "") {
  mode = signupAuthMode(mode, signupPolicy);
  sharingPanel?.dispose(); sharingPanel = null;
  authPanel?.dispose(); signupAdmin?.dispose(); signupAdmin = null;
  jevSettingsPanel?.dispose(); jevSettingsPanel = null;
  authPanel = signupView({ mode, policy: signupPolicy, message, api, inviteEntry: pendingInviteEntry, inviteSubmitted: () => { pendingInviteEntry = null; },
    changeMode: next => { pendingInviteEntry = null; history.replaceState(null, "", next === "create" ? "#invite" : "#signin"); renderAuth(next); },
    signedIn: session => { state.session = session; readRoute(); render(); loadView(); },
    retryPolicy: async () => { const epoch = authEpoch; try { await loadSignupPolicy(); } catch {} if (!state.session && epoch === authEpoch) renderAuth(mode, message); },
  });
  root.replaceChildren(...[state.demo && el("div", { class: "demo" }, "Preview · Sample data. Sign-in and connections are simulated."), authPanel.element].filter(Boolean));
  // A fresh auth screen must not inherit a long workspace page’s scroll position.
  // Form feedback updates in place, so submission never resets scrolling or focus.
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}
function captureInviteEntry() {
  if (!location.hash.startsWith("#invite=")) return false;
  pendingInviteEntry = parseInviteEntry(location.hash);
  // Clear the credential and editable email hint before awaiting any request.
  // Their only remaining use is the current in-memory invite form.
  history.replaceState(null, "", "#invite");
  return true;
}
async function loadSignupPolicy() {
  if (signupPolicy) return signupPolicy;
  if (!signupPolicyRequest) signupPolicyRequest = api.signupPolicy().then(value => signupPolicy = parseSignupPolicy(value)).finally(() => { signupPolicyRequest = null; });
  return signupPolicyRequest;
}
async function openAuth(message = "") {
  const epoch = authEpoch;
  try { await loadSignupPolicy(); } catch {}
  if (!state.session && epoch === authEpoch) renderAuth(signupEntryMode(signupPolicy, location.hash, location.pathname), message);
}
async function loadView() {
  if (workspacePending(state.session)) { scheduleProvisioning(); return; }
  if (activityChecksActive()) { if (pendingInsightRun) { pendingInsightRun = false; await runInsights(); } else await loadInsights({ jobId: state.insights?.job?.id }); }
  else if (activityHistoryActive()) await loadActivity();
  else if (state.view === "memory") { if (state.memoryTab === "review") await loadReviews(); else await loadMemories(); }
  else if (state.view === "showcase") await loadShowcase();
  else if (state.view === "sharing") return;
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
  navigationOpen = false;
  accountFocusTarget = null;
  if (captureInviteEntry()) { if (state.session) expired(); openAuth(pendingInviteEntry ? "" : "This invite link could not be read. Ask for a fresh link, or enter a code manually."); return; }
  if (!state.session) { openAuth(); return; }
  clearTimeout(searchTimer); clearTimeout(insightTimer); ++generation; closeDetail(); state.insightBusy = false; state.error = ""; state.more = false; readRoute(); render(); window.scrollTo(0, 0); document.querySelector("#main")?.focus({ preventScroll: true }); loadView();
});
window.addEventListener("resize", () => requestAnimationFrame(revealCurrentNavigation), { passive: true });
document.addEventListener("click", event => {
  const link = event.target.closest?.("a.wikilink");
  if (link && state.session) { event.preventDefault(); memoryDetail(link.dataset.slug); }
});
document.addEventListener("pointerdown", () => { inputMode = "pointer"; document.documentElement.dataset.input = inputMode; }, { passive: true });
document.addEventListener("keydown", event => {
  inputMode = "keyboard"; document.documentElement.dataset.input = inputMode;
  if (event.key === "Escape" && navigationOpen && !dialog.open) { event.preventDefault(); setNavigationOpen(false, true); }
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !dialog.open && !document.activeElement?.isContentEditable && !document.activeElement?.closest('[role="combobox"], [role="listbox"]') && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    const search = document.querySelector(".search"); if (search) { event.preventDefault(); search.focus(); }
  }
});
setInterval(() => { if (!document.hidden && state.session && !workspacePending(state.session) && !sessionMutation && activityHistoryActive() && !state.loading && !dialog.open) loadActivity({ quiet: true }); }, 5000);
function refreshReturnedConnections() {
  if (!document.hidden && state.view === "connect" && ["owner", "member"].includes(state.session?.role) && !sessionMutation && !state.loading && !connectionKeyRequests.size && Date.now() - state.connectionFetchedAt > 3000) loadConnections();
}
window.addEventListener("focus", refreshReturnedConnections);
document.addEventListener("visibilitychange", () => {
  document.documentElement.dataset.pageHidden = String(document.hidden);
  if (document.hidden) { previewWatcher?.pause(); clearTimeout(activityRefreshTimer); clearTimeout(insightTimer); clearTimeout(provisioningTimer); clearTimeout(accessRefreshTimer); }
  else { if (workspacePending(state.session)) { scheduleProvisioning(0); return; } if (friendAccessPresentation(state.session?.access)) refreshFriendAccess(); previewWatcher?.resume(); refreshReturnedConnections(); if (currentActivity && dialog.open) fetchActivityDetail({ quiet: true }); if (activityChecksActive() && ["queued", "running"].includes(state.insights?.job?.status)) loadInsights({ jobId: state.insights.job.id, quiet: true }); }
});
window.addEventListener("pagehide", () => { pendingInviteEntry = null; authPanel?.clearSecrets(); signupAdmin?.clearSecrets(); sharingPanel?.clearSecrets(); profilePhotoEditor?.dispose(); profilePhotoEditor = null; previewWatcher?.pause(); clearTimeout(activityRefreshTimer); clearTimeout(insightTimer); clearTimeout(provisioningTimer); clearTimeout(accessRefreshTimer); });
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  if (workspacePending(state.session)) { scheduleProvisioning(0); return; }
  if (friendAccessPresentation(state.session?.access)) refreshFriendAccess();
  previewWatcher?.resume();
  if (currentActivity && dialog.open) fetchActivityDetail({ quiet: true });
  else if (state.session && activityHistoryActive() && !sessionMutation) loadActivity({ quiet: true });
  else if (state.session && activityChecksActive()) loadInsights({ jobId: state.insights?.job?.id, quiet: true });
  else if (state.session && state.view === "connect") refreshReturnedConnections();
  else if (state.session && state.view === "showcase" && !sessionMutation) render();
});
async function boot() {
  const invited = captureInviteEntry();
  // Warm the public policy for sign-out too; a failed policy check never stops
  // an existing session or makes signup available by assumption.
  loadSignupPolicy().catch(() => {});
  root.replaceChildren(el("main", { class: "auth boot-loader", role: "status" }, el("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 27, height: 27, alt: "" }), el("span", { class: "ds-spinner", "aria-hidden": "true" }), el("p", { class: "muted" }, "Opening your workspace…")));
  if (invited) { await openAuth(pendingInviteEntry ? "" : "This invite link could not be read. Ask for a fresh link, or enter a code manually."); return; }
  const hash = location.hash.slice(1), joining = hash.startsWith("join="), recovery = joining ? emailLinkRecovery(hash.slice(5)) : null;
  // Email bearer links must leave the address bar on both success and failure.
  if (joining) history.replaceState(null, "", recovery.hash);
  try {
    state.session = joining ? await api.acceptInvite(hash.slice(5)) : await api.me();
    if (joining) history.replaceState(null, "", "#activity");
    state.demo = Boolean(state.session.demo); readRoute(); render(); await loadView();
  } catch (error) { await openAuth(recovery ? [error instanceof AuthError ? "" : errorMessage(error), recovery.message].filter(Boolean).join(" ") : error instanceof AuthError ? "" : errorMessage(error)); }
}
let stopLoadingMotion = observeLoadingMotion(document.body);
let selectControls = observeSelects(document.body);
window.addEventListener('pagehide', () => { stopLoadingMotion(); selectControls.dispose(); });
window.addEventListener('pageshow', event => {
  if (event.persisted) { stopLoadingMotion = observeLoadingMotion(document.body); selectControls = observeSelects(document.body); }
});
boot();
