import { h } from "./profile.js";
import { emptyState, flashNew, pill, showToast, staggerIn } from "./design-system.js";
import { icon } from "./icons.js";
import { statusLabel } from "./status-label.js";

let instance = 0;
const button = (text, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, text);
const busy = text => [icon("loader-circle", { size: 14, class: "spin" }), text];
const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");
const date = value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(parsed) + " UTC" : "Time unavailable";
};
// Toasts confirm a finished change; the in-view status line stays the record.
const defaultToast = (message, tone = "success") => {
  if (typeof document === "undefined" || !document.body) return;
  showToast(message, { tone, glyph: icon(tone === "danger" ? "circle-alert" : tone === "info" ? "info" : "circle-check", { size: 16 }) });
};
const skeleton = (rows = 3) => Array.from({ length: rows }, () => h("div", { class: "ds-skeleton-row", "aria-hidden": "true" }, h("span"), h("span"), h("span"), h("span")));
const dashed = (glyph, title, description, action) => { const node = emptyState({ glyph: icon(glyph, { size: 22 }), title, description, action }); node.setAttribute("data-variant", "dashed"); return node; };
const disclosure = (summary, ...body) => h("details", { class: "sharing-approved-text" }, h("summary", {}, icon("chevron-right", { size: 14, class: "sharing-chevron" }), summary), ...body);

function teamSharingView({ api, personalWorkspaces, onOpenPersonal, role, initialError, fail, isCurrent }) {
  const prefix = "sharing-team-" + (++instance), pageSize = 25;
  const personal = [...new Map(personalWorkspaces.filter(workspace => Number.isSafeInteger(workspace?.id) && workspace.id > 0 && typeof workspace.name === "string" && workspace.name.trim()).map(workspace => [workspace.id, workspace])).values()];
  let active = true, version = 0, loading = false, switching = false, nextOffset = 0, more = false, items = [];
  const current = () => active && isCurrent();
  const sourceFeedback = h("p", { class: "sharing-feedback", role: initialError ? "alert" : "status", "aria-live": "polite", tabindex: -1 }, initialError);
  const chooser = h("select", { id: prefix + "-personal", name: "personal-workspace", onchange: () => { openPersonal.disabled = switching || !selectedPersonal() || typeof onOpenPersonal !== "function"; } },
    h("option", { value: "" }, "Choose your personal workspace"), personal.map(workspace => h("option", { value: workspace.id }, workspace.name)));
  const selectedPersonal = () => personal.length === 1 ? personal[0] : personal.find(workspace => String(workspace.id) === chooser.value);
  const openPersonal = button("Share from personal workspace", async () => {
    const selected = selectedPersonal();
    if (!current() || switching || !selected || typeof onOpenPersonal !== "function") return;
    switching = true; openPersonal.disabled = true; chooser.disabled = true; openPersonal.setAttribute("aria-busy", "true");
    openPersonal.replaceChildren(...busy("Opening personal workspace…"));
    sourceFeedback.setAttribute("role", "status"); sourceFeedback.textContent = "";
    try {
      const opened = await onOpenPersonal(selected.id);
      if (opened === false && current()) throw new Error("Your personal workspace could not be opened. Try again.");
    } catch (error) {
      if (current()) { sourceFeedback.setAttribute("role", "alert"); sourceFeedback.textContent = error.message || "Your personal workspace could not be opened. Try again."; fail(error); }
    } finally {
      if (current()) { switching = false; chooser.disabled = false; openPersonal.disabled = !selectedPersonal(); openPersonal.setAttribute("aria-busy", "false"); openPersonal.textContent = "Share from personal workspace"; }
    }
  }, { class: "primary small", disabled: personal.length !== 1 || typeof onOpenPersonal !== "function" });
  const source = h("section", { class: "ds-banner sharing-start", "aria-labelledby": prefix + "-source-title" },
    h("span", { class: "ds-banner-icon", "aria-hidden": "true" }, icon("share-2", { size: 18 })),
    h("div", { class: "ds-banner-copy" }, h("strong", { id: prefix + "-source-title" }, "Share personal memory"),
      h("span", {}, personal.length ? "Open your personal workspace to choose what this team can read." : "Your personal workspace isn’t available in this session. You can still read this team’s shared memory."),
      personal.length === 1 && h("span", { class: "sharing-source-name" }, "From ", h("strong", {}, personal[0].name))),
    h("div", { class: "sharing-start-actions" },
      personal.length > 1 && h("label", { class: "field sharing-start-chooser" }, h("span", { class: "ds-sr-only" }, "Personal workspace"), chooser),
      personal.length > 0 && openPersonal,
      h("a", { class: "button-link small", href: "#memory" }, "Open team memory"),
      role === "owner" && h("a", { class: "button-link small text", href: "#workspace" }, "Manage people")));
  const list = h("div", { class: "sharing-received-list" });
  const loadState = h("div", { class: "sharing-load-state" });
  const count = h("span", { role: "status", "aria-live": "polite" });
  const refresh = button("Refresh", () => load(), { class: "small", "aria-label": "Refresh shares" });
  const refreshIdle = () => refresh.replaceChildren(icon("refresh-cw", { size: 14 }), "Refresh");
  refreshIdle();
  const loadMore = button("Load more", () => load(true), { class: "small", hidden: true });
  const panel = h("div", { class: "ds-panel-list sharing-received-panel" },
    h("div", { class: "ds-panel-head" }, h("span", {}, "Approved excerpt"), h("span", { class: "sharing-head-end" }, "Read only")),
    list, loadState, h("div", { class: "ds-panel-foot" }, count, h("span", { class: "sharing-foot-end" }, loadMore)));
  const empty = h("div", { class: "sharing-empty-slot" });
  const received = h("section", { class: "sharing-manage", "aria-labelledby": prefix + "-received-title" },
    h("div", { class: "sharing-section-heading" }, h("div", { class: "sharing-section-title" }, h("h2", { id: prefix + "-received-title" }, "Shared with this team"), pill("Snapshot")), refresh),
    h("p", { class: "sharing-section-note" }, "Fixed excerpts approved from a personal workspace. They don’t update when the source changes."),
    panel, empty);
  const element = h("section", { class: "sharing-view sharing-team-view" }, source, sourceFeedback, received);

  function excerpt(item) {
    const truncated = item.text.length > 180;
    return h("article", { class: "sharing-received ds-row-hover" },
      h("h3", { tabindex: -1 }, item.title || "Approved excerpt"),
      h("p", { class: "sharing-received-preview" }, truncated ? item.text.slice(0, 179) + "…" : item.text),
      truncated && h("details", { class: "sharing-approved-text" }, h("summary", {}, icon("chevron-right", { size: 14, class: "sharing-chevron" }), "Read full excerpt"), h("section", {}, h("p", {}, item.text))));
  }
  async function load(append = false) {
    if (!current() || loading || (append && !more)) return;
    const request = ++version, offset = append ? nextOffset : 0;
    const restoreFocus = [refresh, loadMore, ...loadState.querySelectorAll("button"), ...empty.querySelectorAll("button")].includes(document.activeElement);
    loading = true; refresh.disabled = true; loadMore.disabled = true;
    refresh.setAttribute("aria-busy", "true"); received.setAttribute("aria-busy", "true"); refresh.replaceChildren(...busy("Refresh"));
    if (!append) { items = []; nextOffset = 0; more = false; list.replaceChildren(); count.textContent = ""; loadMore.hidden = true; empty.replaceChildren(); panel.hidden = false; }
    loadState.replaceChildren(...(append ? [] : skeleton(3)), h("p", { class: "sharing-loading-line", role: "status" }, icon("loader-circle", { size: 14, class: "spin" }), append ? "Loading more received shares…" : "Loading received shares…"));
    try {
      const result = await api.receivedSharing({ limit: pageSize, offset });
      if (!current() || request !== version) return;
      if (result.sourceKind !== "team" || !Array.isArray(result.received) || typeof result.more !== "boolean" || result.received.length > 50 || (result.more && !result.received.length) || result.received.some(item => !item || typeof item.id !== "string" || !item.id || typeof item.shareId !== "string" || !item.shareId || typeof item.title !== "string" || typeof item.text !== "string")) throw new Error("Received shares could not be read. Try again.");
      const known = new Set(items.map(item => item.id)), added = [];
      for (const item of result.received) if (!known.has(item.id)) { known.add(item.id); items.push(item); added.push(excerpt(item)); }
      list.append(...added); nextOffset = offset + result.received.length; more = result.more;
      if (!append) staggerIn(list);
      loadState.replaceChildren();
      panel.hidden = !items.length;
      if (!items.length) empty.replaceChildren(dashed("inbox", "No shared excerpts yet", "Excerpts approved for this team from a personal workspace show up here."));
      count.textContent = items.length ? "Showing " + items.length + " approved excerpt" + (items.length === 1 ? "." : "s.") : "";
      loadMore.hidden = !more;
      if (restoreFocus) (append ? added[0]?.querySelector("h3") || refresh : refresh).focus();
    } catch (error) {
      if (!current() || request !== version) return;
      panel.hidden = false;
      loadState.replaceChildren(h("div", { class: "sharing-row-error", role: "alert" }, icon("circle-alert", { size: 16 }),
        h("p", {}, error.message || "Received shares could not be loaded. Try again."), button("Try again", () => load(append), { class: "small" })));
      if (restoreFocus) loadState.querySelector("button")?.focus();
      fail(error);
    } finally {
      if (current() && request === version) { loading = false; refresh.disabled = false; loadMore.disabled = false; refresh.setAttribute("aria-busy", "false"); received.setAttribute("aria-busy", "false"); refreshIdle(); }
    }
  }
  function clear() {
    ++version; items = []; nextOffset = 0; more = false; loading = false;
    list.replaceChildren(); count.textContent = ""; loadMore.hidden = true; refresh.disabled = false; empty.replaceChildren(); panel.hidden = false;
    refresh.setAttribute("aria-busy", "false"); received.setAttribute("aria-busy", "false"); refreshIdle();
    loadState.replaceChildren(h("p", { class: "sharing-loading-line" }, "Refresh shares to reload received excerpts."));
  }
  load();
  return { element, clearSecrets: clear, dispose() { active = false; clear(); sourceFeedback.textContent = ""; } };
}

// No source text or credential is written to storage, markup, URLs or attributes.
export function sharingView({ api, workspaceKind = "personal", personalWorkspaces = [], onOpenPersonal, role, initialError = "", fail = () => {}, isCurrent = () => true, copy = value => navigator.clipboard.writeText(value), now = () => Date.now(), toast = defaultToast }) {
  if (workspaceKind === "team") return teamSharingView({ api, personalWorkspaces, onOpenPersonal, role, initialError, fail, isCurrent });
  const prefix = "sharing-" + (++instance);
  let active = true, scope = 0, loadVersion = 0, previewVersion = 0, draftVersion = 0;
  let catalog = null, preview = null, candidates = [], previewTimer, previewBusy = false, commitBusy = false, loadBusy = false;
  const pendingGrants = new Map(), secretFields = new Set();
  const current = () => active && isCurrent();
  const notify = (message, tone) => { try { toast(message, tone); } catch {} };
  const feedback = h("p", { id: prefix + "-feedback", class: "sharing-feedback", tabindex: -1, role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const notice = (text, tone = "neutral", alert = false) => h("div", { class: "sharing-notice", "data-tone": tone, role: alert ? "alert" : "status" }, icon(tone === "danger" ? "circle-alert" : tone === "warning" ? "triangle-alert" : "info", { size: 16 }), h("span", {}, text));
  const report = (text, error = false) => { feedback.setAttribute("role", error ? "alert" : "status"); feedback.textContent = text; };
  const loadState = h("div", { class: "sharing-load-state" });
  const instruction = h("textarea", { id: prefix + "-instruction", name: "instruction", rows: 4, minlength: 5, maxlength: 1000, required: true, autocomplete: "off", placeholder: "Architecture decisions for the billing project. Leave out personal notes and contact details.", "aria-describedby": prefix + "-instruction-hint", oninput: () => invalidateReview("Instructions changed. Preview again before sharing.") });
  const recipientKind = h("select", { id: prefix + "-kind", name: "recipient-kind", required: true, "aria-describedby": prefix + "-recipient-note", onchange: () => { updateRecipient(); invalidateReview("Recipient changed. Preview again before sharing."); } },
    h("option", { value: "" }, "Choose a recipient"), h("option", { value: "team" }, "A team workspace"), h("option", { value: "agent" }, "One agent · read-only access"));
  const team = h("select", { id: prefix + "-team", name: "team", onchange: () => invalidateReview("Recipient changed. Preview again before sharing.") }, h("option", { value: "" }, "Choose a team"));
  const agent = h("input", { id: prefix + "-agent", name: "agent-name", maxlength: 80, autocomplete: "off", placeholder: "Research assistant", oninput: () => invalidateReview("Recipient changed. Preview again before sharing.") });
  const teamField = h("label", { class: "field", hidden: true }, "Team", team);
  const agentField = h("label", { class: "field", hidden: true }, "Name this connection", agent);
  const recipientNote = h("p", { class: "field-hint", id: prefix + "-recipient-note" }, "Choose who can read the approved snapshot.");
  const previewButton = h("button", { type: "submit", class: "primary small" }, "Preview excerpts");
  const previewIdle = () => previewButton.replaceChildren(icon("sparkles", { size: 14 }), "Preview excerpts");
  previewIdle();
  const cancelPreview = button("Cancel", () => { ++previewVersion; previewBusy = false; discardReview(); lockForm(); report("Preview canceled. Nothing was shared."); previewButton.focus(); }, { class: "text small", hidden: true });
  const help = h("details", { class: "sharing-approved-text sharing-help" });
  const row = (id, label, hint, ...control) => h("div", { class: "ds-settings-row" },
    h("div", { class: "ds-settings-label" }, h("label", { for: id }, label), hint && h("p", { class: "ds-settings-help", id: id + "-hint" }, hint)),
    h("div", { class: "ds-settings-control" }, ...control));
  const review = h("div", { class: "sharing-review", "aria-label": "Review proposed excerpts" });
  const steps = [];
  const setReview = (...nodes) => { review.replaceChildren(...nodes); const reviewing = nodes.length > 0; steps[0]?.setAttribute("data-state", reviewing ? "complete" : "current"); steps[1]?.setAttribute("data-state", reviewing ? "current" : "upcoming"); };
  const step = (title, description, ...body) => steps[steps.push(h("li", { "data-state": steps.length ? "upcoming" : "current" },
    h("h2", {}, title), h("p", {}, description), ...body)) - 1];
  const form = h("form", { class: "sharing-form", hidden: true, onsubmit: event => { event.preventDefault(); requestPreview(); } },
    h("ol", { class: "ds-steps sharing-steps" },
      step("Describe the share", "Say what to include and what to leave out. Engram proposes matching excerpts.",
        h("div", { class: "ds-settings-card sharing-settings" },
          row(prefix + "-instruction", "What to share", "Topics to include and anything to leave out. 5–1,000 characters.", instruction),
          row(prefix + "-kind", "Recipient", "A team workspace, or one agent through a separate read-only connection.",
            recipientKind, teamField, agentField, recipientNote),
          h("div", { class: "ds-settings-foot" }, h("p", { class: "ds-settings-note sharing-lock-note" }, icon("lock", { size: 13 }), "Nothing is shared until you approve the exact text."), cancelPreview, previewButton)),
        help),
      step("Review and approve", "Check every proposed excerpt. Approve only the exact text you want shared.",
        h("p", { class: "sharing-step-idle" }, "Proposed excerpts appear here after you preview."), review)));
  const credentials = h("div", { class: "sharing-credentials" });
  const grantsHeading = h("h2", { tabindex: "-1" }, "Shares");
  const refresh = button("Refresh", () => loadCatalog(), { class: "small", "aria-label": "Refresh shares" });
  const grantsList = h("div", { class: "sharing-grants" });
  const grantsCount = h("span");
  const grantsPanel = h("div", { class: "ds-panel-list sharing-grants-panel" },
    h("div", { class: "ds-panel-head sharing-grant-head" }, h("span", {}, "Recipient"), h("span", { class: "sharing-head-end" }, "Created")),
    grantsList, h("div", { class: "ds-panel-foot" }, grantsCount, h("span", { class: "sharing-foot-end" }, "Snapshots don’t update when memory changes.")));
  const grantsEmpty = h("div", { class: "sharing-empty-slot" });
  const grants = h("section", { class: "sharing-manage", hidden: true },
    h("div", { class: "sharing-section-heading" }, h("div", { class: "sharing-section-title" }, grantsHeading, pill("Snapshot"), pill("Read only")), refresh),
    grantsPanel, grantsEmpty);
  const element = h("section", { class: "sharing-view" }, form, loadState, credentials, feedback, grants);

  function recipient() {
    if (recipientKind.value === "team") {
      const target = catalog?.targets?.find(item => Number(item.id) === Number(team.value));
      return target ? { kind: "team", orgId: Number(target.id) } : null;
    }
    const name = agent.value.trim();
    return recipientKind.value === "agent" && name && name.length <= 80 ? { kind: "agent", name } : null;
  }
  function recipientName(value) {
    return value?.kind === "team" ? catalog?.targets?.find(item => Number(item.id) === Number(value.orgId))?.name || "the selected team" : value?.name || "the selected agent";
  }
  function updateRecipient() {
    const kind = recipientKind.value;
    teamField.hidden = kind !== "team"; agentField.hidden = kind !== "agent";
    team.required = kind === "team"; agent.required = kind === "agent";
    recipientNote.textContent = kind === "team" ? "Everyone authorized in this team workspace can read the approved text. Team sharing policies still apply."
      : kind === "agent" ? "Creates a separate read-only connection for this snapshot only. Existing full-workspace connections keep their access; disconnect or revoke them if the agent should see only this slice."
      : "Choose who can read the approved snapshot.";
  }
  function lockForm() {
    [instruction, recipientKind, team, agent].forEach(field => { field.disabled = commitBusy; });
    previewButton.disabled = commitBusy || previewBusy || loadBusy;
    refresh.disabled = loadBusy || commitBusy || pendingGrants.size > 0;
    form.setAttribute("aria-busy", String(previewBusy || commitBusy));
    review.setAttribute("aria-busy", String(previewBusy || commitBusy));
    loadState.setAttribute("aria-busy", String(loadBusy));
    grantsList.setAttribute("aria-busy", String(loadBusy || pendingGrants.size > 0));
    previewButton.setAttribute("aria-busy", String(previewBusy));
    refresh.setAttribute("aria-busy", String(loadBusy));
    refresh.replaceChildren(...(loadBusy ? busy("Refresh") : [icon("refresh-cw", { size: 14 }), "Refresh"]));
    cancelPreview.hidden = !previewBusy;
    if (!previewBusy) previewIdle();
  }
  function renderSourceState() {
    if (catalog?.sourceKind === "personal") help.replaceChildren(h("summary", {}, icon("chevron-right", { size: 14, class: "sharing-chevron" }), "How matching works"),
      h("p", { class: "field-hint" }, catalog.modelAvailable ? "Optional Jev processing helps propose excerpts. Suggestions can be wrong; you still review every word." : "Text matching proposes excerpts. It does not understand intent or exclusions, so suggestions can be wrong; review every word."),
      h("p", { class: "field-hint" }, "Each share is a fixed snapshot. New or edited memory needs another review."),
      !catalog.modelAvailable && h("a", { class: "ds-touch-target", href: "#workspace" }, "Review processing settings"));
    loadState.replaceChildren(...(!catalog || catalog.sourceKind === "personal" ? [] : [h("div", { class: "ds-banner" }, h("span", { class: "ds-banner-icon", "aria-hidden": "true" }, icon("inbox", { size: 18 })),
      h("div", { class: "ds-banner-copy" }, h("strong", {}, "This workspace receives shares"), h("span", {}, "It receives approved excerpts. Open team memory to read them.")),
      h("a", { class: "button-link small", href: "#memory" }, "Open team memory"))]));
  }
  function invalidateCatalogLoad() {
    ++loadVersion;
    if (loadBusy) { loadBusy = false; renderSourceState(); }
  }
  function discardReview(message = "") {
    clearTimeout(previewTimer); preview = null; candidates = [];
    setReview(...(message ? [notice(message)] : []));
  }
  function invalidateReview(message) {
    if (commitBusy) return;
    ++draftVersion; ++previewVersion; previewBusy = false;
    const hadReview = Boolean(preview) || review.childNodes.length > 0;
    discardReview(hadReview ? message : ""); lockForm();
  }
  async function requestPreview() {
    if (!current() || previewBusy || commitBusy || catalog?.sourceKind !== "personal") return;
    const policy = instruction.value.trim(), target = recipient();
    if (policy.length < 5 || policy.length > 1000) { report("Describe what to include and exclude using 5–1,000 characters.", true); instruction.focus(); return; }
    if (!target) { report("Choose a team or name an agent before previewing.", true); (recipientKind.value === "agent" ? agent : recipientKind.value === "team" ? team : recipientKind).focus(); return; }
    const version = ++previewVersion, revision = draftVersion, epoch = scope;
    previewBusy = true; lockForm(); report("");
    previewButton.replaceChildren(...busy("Finding excerpts…"));
    discardReview(); setReview(h("div", { class: "ds-panel-list sharing-candidates-panel" },
      h("div", { class: "ds-panel-head" }, h("span", {}, "Proposed excerpts")), ...skeleton(3),
      h("div", { class: "ds-panel-foot", role: "status" }, icon("loader-circle", { size: 14, class: "spin" }), "Finding a bounded set of excerpts. Nothing is being shared.")));
    try {
      const result = await api.sharingPreview({ instruction: policy, recipient: target });
      if (!current() || epoch !== scope || version !== previewVersion || revision !== draftVersion) return;
      if (typeof result.previewId !== "string" || !Array.isArray(result.candidates) || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error("The preview could not be read. Try previewing again.");
      preview = { ...result, revision, recipient: target, expired: Date.parse(result.expiresAt) <= now() };
      candidates = result.candidates.slice(0, 12).map(item => ({ ...item, selected: false, draft: String(item.text || "") }));
      renderReview();
      previewTimer = setTimeout(() => {
        if (!current() || !preview || preview.previewId !== result.previewId) return;
        preview.expired = true; renderCommitState(); report("This preview expired. Preview again before sharing.", true);
      }, Math.max(0, Date.parse(result.expiresAt) - now()));
      review.querySelector("h3")?.focus({ preventScroll: true });
    } catch (error) {
      if (current() && epoch === scope && version === previewVersion) { discardReview(); setReview(notice(error.message || "Candidates could not be loaded. Try again.", "danger", true)); fail(error); }
    } finally {
      if (current() && epoch === scope && version === previewVersion) { previewBusy = false; lockForm(); }
    }
  }
  let acknowledge, shareButton, selectionNote;
  const approveLabel = count => count ? "Approve " + plural(count, "excerpt") : "Approve excerpts";
  function renderCommitState() {
    if (!shareButton || !preview) return;
    const selected = candidates.filter(item => item.selected);
    const invalid = selected.some(item => !item.draft.trim() || item.draft.trim().length > 1200 || !item.text.includes(item.draft.trim()));
    candidates.forEach(item => item.editor?.setAttribute("aria-invalid", String(item.selected && (!item.draft.trim() || !item.text.includes(item.draft.trim())))));
    shareButton.disabled = commitBusy || preview.expired || preview.revision !== draftVersion || !selected.length || invalid || !acknowledge.checked;
    if (!commitBusy) shareButton.replaceChildren(icon("check", { size: 14 }), approveLabel(selected.length));
    selectionNote.textContent = preview.expired ? "Preview expired. Preview again to review current text."
      : invalid ? "Keep a continuous part of each selected excerpt, or uncheck it."
      : !selected.length ? "Select the excerpts to share. Nothing is preselected."
      : !acknowledge.checked ? "Confirm your review to share " + plural(selected.length, "selected excerpt") + "."
      : plural(selected.length, "excerpt") + " ready to approve.";
  }
  function renderReview() {
    const data = preview, targetName = recipientName(data.recipient), model = data.method === "model";
    const title = h("h3", { tabindex: "-1" }, "Proposed excerpts");
    const candidateNodes = candidates.map((item, index) => {
      const checked = h("input", { type: "checkbox", name: "excerpt", value: item.id, "aria-label": "Include " + (item.title || "Memory excerpt") + " " + (index + 1), onchange: () => { item.selected = checked.checked; acknowledge.checked = false; renderCommitState(); } });
      const editor = h("textarea", { rows: 3, maxlength: 1200, autocomplete: "off", spellcheck: "false", "aria-describedby": prefix + "-edit-hint", oninput: () => {
        item.draft = editor.value; acknowledge.checked = false;
        const invalid = item.selected && (!editor.value.trim() || !item.text.includes(editor.value.trim()));
        editor.setAttribute("aria-invalid", String(invalid)); renderCommitState();
      } }); editor.value = item.draft;
      item.checkbox = checked; item.editor = editor;
      return h("article", { class: "sharing-candidate" },
        h("label", { class: "sharing-candidate-pick" }, checked, h("span", { class: "sharing-candidate-copy" },
          h("span", { class: "sharing-candidate-title" }, h("strong", {}, item.title || "Memory excerpt"), item.sourceKind === "trail" ? pill("Conversation") : item.sourceKind === "memory" ? pill("Memory") : null),
          h("small", {}, item.reason || "Check whether this belongs in the share."))),
        h("label", { class: "field sharing-candidate-text" }, h("span", { class: "ds-mono-label" }, "Text to share · " + (index + 1)), editor));
    });
    acknowledge = h("input", { type: "checkbox", required: true, onchange: renderCommitState });
    shareButton = button("Approve excerpts", commit, { class: "primary small", disabled: true });
    selectionNote = h("p", { class: "sharing-selection-note", "aria-live": "polite" });
    const list = h("div", { class: "sharing-candidates" }, candidateNodes);
    const reviewBody = candidates.length ? [
      h("div", { class: "ds-panel-list sharing-candidates-panel" },
        h("div", { class: "ds-panel-head" }, h("span", {}, "Excerpt"), h("span", { class: "sharing-head-end" }, candidates.length + " proposed")),
        h("p", { class: "sharing-edit-hint", id: prefix + "-edit-hint" }, "You can shorten an excerpt but not add to it. To drop a detail in the middle, keep a shorter part or leave it unchecked. Added or rewritten text can’t be shared from this preview."),
        list,
        h("label", { class: "sharing-acknowledgment" }, acknowledge, h("span", {}, h("strong", {}, "I reviewed the selected text and want to share it with " + targetName + "."), h("small", {}, data.recipient.kind === "team" ? "Everyone authorized in that team can read this approved snapshot." : "The separate read-only connection can read this approved snapshot only.")))),
      h("div", { class: "ds-action-bar sharing-approve-bar" }, selectionNote,
        h("div", { class: "ds-action-bar-actions" }, button("Cancel", () => { ++previewVersion; discardReview(); report("Review canceled. Nothing was shared."); previewButton.focus(); }, { class: "text small" }), shareButton)),
    ] : [dashed("search", "No excerpts matched", "Adjust the instruction and preview again. Nothing was shared.")];
    setReview(h("section", { class: "sharing-review-card" },
      h("div", { class: "sharing-review-heading" }, title, pill(model ? "Jev-assisted" : "Text match", { tone: model ? "accent" : "neutral" })),
      notice(model ? "Optional Jev processing proposed these. Suggestions can be wrong; you approve every excerpt." : "Text matching proposed these. It doesn’t fully interpret your instruction, so suggestions can be wrong. Check every word.", "warning"),
      h("p", { class: "sharing-preview-meta" }, "To " + targetName + " · " + plural(candidates.length, "excerpt") + " proposed", Number(data.excludedCount) > 0 ? " · " + data.excludedCount + " excluded" : "", " · ", h("time", { datetime: data.expiresAt }, "Expires " + date(data.expiresAt))),
      h("p", { class: "field-hint" }, (Number.isSafeInteger(data.scannedCount) ? "Scanned " + plural(data.scannedCount, "source") + ". " : "") + (Number.isSafeInteger(data.consideredCount) ? "Considered " + plural(data.consideredCount, "excerpt") + ". " : "Considered up to 16 excerpts. ") + "At most 3 excerpts per source, up to 1,200 characters each. This bounded review can miss relevant content or private details."),
      data.truncated === true && notice("Scan limit reached. This preview doesn’t cover all your memory. Narrow the instruction or review another slice.", "warning"),
      ...reviewBody));
    staggerIn(list);
    renderCommitState();
  }
  async function commit() {
    if (!current() || !preview || commitBusy || shareButton.disabled || Date.parse(preview.expiresAt) <= now()) { if (preview && Date.parse(preview.expiresAt) <= now()) { preview.expired = true; renderCommitState(); } return; }
    const data = preview, epoch = scope;
    const selections = candidates.filter(item => item.selected).map(item => ({ id: item.id, text: item.draft.trim() }));
    invalidateCatalogLoad();
    commitBusy = true; lockForm(); renderCommitState(); acknowledge.disabled = true;
    candidates.forEach(item => { item.checkbox.disabled = true; item.editor.disabled = true; });
    review.querySelectorAll("button").forEach(control => { control.disabled = true; });
    shareButton.setAttribute("aria-busy", "true"); shareButton.replaceChildren(...busy("Sharing…")); report("");
    try {
      const result = await api.sharingCommit({ previewId: data.previewId, selections, acknowledged: true });
      if (!current() || epoch !== scope) return;
      catalog.shares = [result.share, ...(catalog.shares || []).filter(item => item.id !== result.share.id)];
      discardReview(); renderGrants(result.share.id); clearCredential();
      report("Snapshot shared with " + recipientName(data.recipient) + ". It won’t pick up new or changed memory.");
      notify("Shared " + plural(selections.length, "excerpt") + " with " + recipientName(data.recipient));
      if (result.credential) showCredential(result.credential, recipientName(data.recipient));
      else grantsHeading.focus({ preventScroll: true });
    } catch (error) {
      if (!current() || epoch !== scope) return;
      if ([409, 410].includes(error.status) || ["preview_changed", "preview_expired", "unavailable"].includes(error.code)) { data.expired = true; acknowledge.checked = false; }
      report(error.message || "Could not confirm the share. Refresh shares before retrying.", true); fail(error);
      notify("Couldn’t share the snapshot", "danger");
      candidates.forEach(item => { item.checkbox.disabled = false; item.editor.disabled = false; });
      review.querySelectorAll("button").forEach(control => { control.disabled = false; });
      acknowledge.disabled = false;
      if ([shareButton, document.body].includes(document.activeElement)) feedback.focus();
    } finally { if (current() && epoch === scope) { commitBusy = false; shareButton.setAttribute("aria-busy", "false"); lockForm(); renderCommitState(); } }
  }
  function clearCredential() {
    for (const field of secretFields) { field.value = ""; field.removeAttribute("value"); }
    secretFields.clear(); credentials.replaceChildren();
  }
  function showCredential(value, name = "") {
    clearCredential();
    const token = h("input", { id: prefix + "-token", type: "password", readonly: true, autocomplete: "off", spellcheck: "false", "aria-label": "Read-only share token" });
    token.value = String(value.token || ""); secretFields.add(token);
    const endpoint = h("input", { id: prefix + "-endpoint", readonly: true, autocomplete: "off", "aria-label": "Read-only MCP endpoint" }); endpoint.value = String(value.mcpUrl || ""); secretFields.add(endpoint);
    const title = h("h3", { tabindex: "-1" }, name ? "Connect " + name : "Connect this agent");
    const show = button("Show token", () => { if (!current() || !token.value) return; token.type = token.type === "password" ? "text" : "password"; show.textContent = token.type === "password" ? "Show token" : "Hide token"; }, { class: "small" });
    const copyToken = button("Copy token", async () => {
      if (!current() || !token.value || copyToken.disabled) return;
      const epoch = scope;
      const stillCurrent = () => current() && epoch === scope && secretFields.has(token) && Boolean(token.value);
      copyToken.disabled = true; copyToken.removeAttribute("data-feedback"); copyToken.setAttribute("aria-busy", "true"); copyToken.replaceChildren(...busy("Copying…"));
      try {
        if (await copy(token.value) === false) throw new Error();
        if (!stillCurrent()) return;
        copyToken.setAttribute("data-feedback", "success"); copyToken.replaceChildren(icon("check", { size: 14 }), "Token copied");
        report("Read-only token copied. Store it privately; it is shown only in this view.");
        notify("Token copied");
      } catch {
        if (!stillCurrent()) return;
        copyToken.setAttribute("data-feedback", "error"); copyToken.textContent = "Copy token";
        report("Could not copy. Show the token, then select and copy it.", true);
      } finally { if (stillCurrent()) { copyToken.disabled = false; copyToken.setAttribute("aria-busy", "false"); } }
    }, { class: "small primary", "aria-describedby": prefix + "-feedback" });
    credentials.replaceChildren(h("section", { class: "ds-settings-card sharing-credential" },
      h("div", { class: "ds-settings-head" }, h("div", {}, title, h("p", {}, "Use this endpoint and token in the receiving agent. It can read only this approved snapshot. It is not a personal workspace credential.")), h("span", { class: "sharing-head-end" }, pill("Read only", { tone: "accent" }), pill("Snapshot"))),
      row(prefix + "-endpoint", "MCP endpoint", "Where the agent connects.", endpoint),
      row(prefix + "-token", "Access token", "Shown once. Copy it now and store it privately.", token, h("div", { class: "sharing-inline-actions" }, show, copyToken)),
      h("div", { class: "ds-settings-foot" }, h("p", { class: "ds-settings-note" }, "Lost it? Replace the token under Shares. The old token stops working immediately."),
        button("Done", clearCredential, { class: "small", "aria-label": "Done, clear token" }))));
    title.focus({ preventScroll: true });
  }
  function renderGrants(freshId = "") {
    const items = catalog?.shares || [];
    const existingOpen = new Set([...grantsList.querySelectorAll("details[open]")].map(node => node.dataset.share));
    const rows = items.map(share => {
      const isAgent = share.recipient?.kind === "agent", revoked = Boolean(share.revokedAt);
      const status = statusLabel(revoked ? "Revoked" : "Active", { className: "sharing-grant-status" });
      const heading = h("h3", { tabindex: "-1" }, share.recipient?.name || "Approved snapshot");
      const info = h("div", { class: "sharing-grant-heading" },
        h("span", { class: "sharing-grant-mark", "aria-hidden": "true" }, icon(isAgent ? "bot" : "users", { size: 16 })),
        h("div", { class: "sharing-grant-name" }, heading, pill(isAgent ? "Agent" : "Team"), status),
        h("time", { class: "sharing-grant-date", datetime: share.createdAt }, date(share.createdAt)));
      const actions = h("div", { class: "sharing-grant-actions" });
      const manage = (kind, label, confirmLabel) => {
        let confirmed = false;
        const cancel = button("Cancel", () => { confirmed = false; control.textContent = label; cancel.hidden = true; }, { class: "text small", hidden: true });
        const control = button(label, async () => {
          if (!current() || pendingGrants.has(share.id) || share.revokedAt) return;
          if (!confirmed) { confirmed = true; control.textContent = confirmLabel; cancel.hidden = false; return; }
          const attempt = {}, epoch = scope; pendingGrants.set(share.id, attempt); invalidateCatalogLoad(); lockForm(); control.disabled = true; cancel.disabled = true; clearCredential(); report("");
          actions.setAttribute("aria-busy", "true"); control.setAttribute("aria-busy", "true"); control.replaceChildren(...busy(kind === "revoke" ? "Revoking…" : "Replacing…"));
          try {
            const result = kind === "revoke" ? await api.revokeSharing(share.id) : await api.rotateSharingToken(share.id);
            if (!current() || epoch !== scope || pendingGrants.get(share.id) !== attempt) return;
            if (kind === "revoke") {
              const updated = result?.share || { ...share, revokedAt: new Date(now()).toISOString() };
              catalog.shares = catalog.shares.map(item => item.id === share.id ? updated : item); renderGrants();
              report("Share revoked. It stops future reads only; copies already read or exported can’t be recalled."); grantsHeading.focus({ preventScroll: true });
              notify("Share revoked");
            } else { showCredential(result.credential, share.recipient?.name || ""); report("Token replaced. The previous token no longer works."); notify("Token replaced"); }
          } catch (error) { if (current() && epoch === scope) { report(error.message || "The change could not be confirmed. Refresh shares and try again.", true); fail(error); notify(kind === "revoke" ? "Couldn’t revoke the share" : "Couldn’t replace the token", "danger"); if ([control, document.body].includes(document.activeElement)) feedback.focus(); } }
          finally { if (pendingGrants.get(share.id) === attempt) { pendingGrants.delete(share.id); lockForm(); control.disabled = false; actions.setAttribute("aria-busy", "false"); control.setAttribute("aria-busy", "false"); cancel.disabled = false; confirmed = false; control.textContent = label; cancel.hidden = true; } }
        }, { class: kind === "revoke" ? "small sharing-danger" : "small" });
        actions.append(control, cancel);
      };
      const refreshPolicy = button("Preview again", () => {
        if (!current() || commitBusy) return;
        instruction.value = share.instruction || ""; recipientKind.value = share.recipient?.kind || "";
        team.value = String(share.recipient?.orgId || ""); agent.value = share.recipient?.kind === "agent" ? share.recipient.name : "";
        updateRecipient(); invalidateReview("Policy loaded. Preview again to review current source text."); instruction.focus({ preventScroll: true });
      }, { class: "small" });
      if (!revoked) { actions.append(refreshPolicy); if (isAgent) manage("rotate", "Replace token", "Confirm replace"); manage("revoke", "Revoke", "Confirm revoke"); }
      const details = h("details", { class: "sharing-approved-text", "data-share": share.id, open: existingOpen.has(share.id) },
        h("summary", {}, icon("chevron-right", { size: 14, class: "sharing-chevron" }), "View " + plural(Number(share.itemCount) || 0, "approved excerpt")),
        ...(share.items || []).map(item => h("section", {}, h("h4", {}, item.title || "Approved excerpt"), h("p", {}, item.text))));
      return h("article", { class: "sharing-grant ds-row-hover", "data-revoked": revoked ? "true" : null },
        info, h("p", { class: "sharing-policy" }, share.instruction),
        h("p", { class: "sharing-grant-scope" }, isAgent ? "Separate read-only connection. Reads this snapshot only." : "Everyone authorized in the team can read this snapshot."),
        details, !revoked && actions,
        !revoked && h("p", { class: "field-hint" }, isAgent ? "Replacing the token stops the old one immediately. Revoking stops all new reads; it can’t recall text already read or exported." : "Revoking removes this snapshot from the receiving workspace. It can’t recall text already read or exported."));
    });
    grantsList.replaceChildren(...rows);
    grantsPanel.hidden = !items.length;
    grantsCount.textContent = items.length ? plural(items.length, "share") + " · " + items.filter(share => !share.revokedAt).length + " active" : "";
    grantsEmpty.replaceChildren(...(items.length ? [] : [dashed("share-2", "No shares yet", "Describe what to share above, then approve the excerpts.")]));
    if (freshId) flashNew(rows.filter((_, index) => items[index].id === freshId));
  }
  async function loadCatalog() {
    if (!current() || loadBusy || commitBusy || pendingGrants.size > 0) return;
    const version = ++loadVersion, epoch = scope;
    loadBusy = true; refresh.disabled = true;
    loadState.replaceChildren(...(catalog ? [] : [h("div", { class: "ds-panel-list", "aria-hidden": "true" }, h("div", { class: "ds-panel-head" }, h("span", {}, "Sharing")), ...skeleton(3))]),
      h("p", { class: "sharing-loading-line", role: "status" }, icon("loader-circle", { size: 14, class: "spin" }), "Loading sharing settings…"));
    lockForm();
    try {
      const result = await api.sharing();
      if (!current() || epoch !== scope || version !== loadVersion) return;
      catalog = { ...result, targets: Array.isArray(result.targets) ? result.targets : [], shares: Array.isArray(result.shares) ? result.shares : [] };
      const selected = team.value;
      team.replaceChildren(h("option", { value: "" }, catalog.targets.length ? "Choose a team" : "No eligible team workspaces"), ...catalog.targets.map(target => h("option", { value: target.id }, target.name)));
      team.value = selected;
      form.hidden = catalog.sourceKind !== "personal"; grants.hidden = catalog.sourceKind !== "personal";
      renderSourceState();
      if (catalog.sourceKind !== "personal") { ++previewVersion; discardReview(); clearCredential(); }
      else { updateRecipient(); if (preview?.recipient.kind === "team" && !catalog.targets.some(item => Number(item.id) === Number(preview.recipient.orgId))) invalidateReview("That team is no longer available. Choose a recipient and preview again."); renderGrants(); }
    } catch (error) {
      if (current() && epoch === scope && version === loadVersion) { loadState.replaceChildren(h("div", { class: "sharing-row-error", role: "alert" }, icon("circle-alert", { size: 16 }), h("p", {}, error.message || "Sharing settings could not be loaded. Try again."), button("Try again", loadCatalog, { class: "small" }))); fail(error); }
    } finally { if (current() && epoch === scope && version === loadVersion) { loadBusy = false; lockForm(); } }
  }
  loadCatalog();
  return { element, clearSecrets() {
    const unfinished = previewBusy || commitBusy || pendingGrants.size > 0;
    ++scope; ++previewVersion; ++loadVersion; clearTimeout(previewTimer); pendingGrants.clear(); previewBusy = false; commitBusy = false; loadBusy = false;
    clearCredential(); discardReview(); lockForm(); refresh.disabled = false; if (catalog?.sourceKind === "personal") renderGrants();
    if (unfinished) report("A request may have completed. Refresh shares to confirm the current state.");
  }, dispose() {
    active = false; ++scope; ++previewVersion; ++loadVersion; clearTimeout(previewTimer); pendingGrants.clear(); clearCredential(); discardReview(); instruction.value = ""; agent.value = "";
  } };
}
