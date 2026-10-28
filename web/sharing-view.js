import { h } from "./profile.js";
import { loadingState } from "./design-system.js";
import { statusLabel } from "./status-label.js";

let instance = 0;
const button = (text, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, text);
const date = value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(parsed) + " UTC" : "Time unavailable";
};

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
    openPersonal.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Opening personal workspace…");
    sourceFeedback.setAttribute("role", "status"); sourceFeedback.textContent = "";
    try {
      const opened = await onOpenPersonal(selected.id);
      if (opened === false && current()) throw new Error("Your personal workspace could not be opened. Try again.");
    } catch (error) {
      if (current()) { sourceFeedback.setAttribute("role", "alert"); sourceFeedback.textContent = error.message || "Your personal workspace could not be opened. Try again."; fail(error); }
    } finally {
      if (current()) { switching = false; chooser.disabled = false; openPersonal.disabled = !selectedPersonal(); openPersonal.setAttribute("aria-busy", "false"); openPersonal.textContent = "Share from personal workspace"; }
    }
  }, { class: "primary", disabled: personal.length !== 1 || typeof onOpenPersonal !== "function" });
  const source = h("section", { class: "sharing-start", "aria-labelledby": prefix + "-source-title" },
    h("div", { class: "ds-heading-group" }, h("h2", { id: prefix + "-source-title" }, "Share personal memory"),
      h("p", {}, personal.length ? "Open your personal workspace to choose what this team can read." : "Your personal workspace is not available in this session. You can still read this team’s shared memory.")),
    personal.length > 1 && h("label", { class: "field" }, "Personal workspace", chooser),
    personal.length === 1 && h("p", { class: "field-hint" }, "From ", h("strong", {}, personal[0].name)),
    h("div", { class: "form-actions" }, personal.length > 0 && openPersonal, h("a", { class: "ds-button", href: "#memory" }, "Open team memory"), role === "owner" && h("a", { class: "ds-button", "data-variant": "text", href: "#workspace" }, "Manage people")),
    sourceFeedback);
  const list = h("div", { class: "sharing-received-list" });
  const loadState = h("div", { class: "sharing-load-state" });
  const count = h("p", { class: "field-hint", role: "status", "aria-live": "polite" });
  const refresh = button("Refresh shares", () => load(), { class: "small" });
  const loadMore = button("Load more shares", () => load(true), { class: "small", hidden: true });
  const received = h("section", { class: "sharing-manage", "aria-labelledby": prefix + "-received-title" },
    h("div", { class: "sharing-section-heading" }, h("h2", { id: prefix + "-received-title" }, "Received shares"), refresh),
    count, list, loadState, h("div", { class: "form-actions" }, loadMore));
  const element = h("section", { class: "sharing-view sharing-team-view" }, source, received);

  function excerpt(item) {
    const truncated = item.text.length > 180;
    return h("article", { class: "sharing-received" },
      h("h3", { tabindex: -1 }, item.title || "Approved excerpt"),
      h("p", { class: "sharing-received-preview" }, truncated ? item.text.slice(0, 179) + "…" : item.text),
      truncated && h("details", { class: "ds-highlight-disclosure sharing-approved-text" }, h("summary", {}, "Read full excerpt"), h("section", {}, h("p", {}, item.text))));
  }
  async function load(append = false) {
    if (!current() || loading || (append && !more)) return;
    const request = ++version, offset = append ? nextOffset : 0;
    const restoreFocus = [refresh, loadMore, ...loadState.querySelectorAll("button")].includes(document.activeElement);
    loading = true; refresh.disabled = true; loadMore.disabled = true;
    refresh.setAttribute("aria-busy", "true"); received.setAttribute("aria-busy", "true");
    if (!append) { items = []; nextOffset = 0; more = false; list.replaceChildren(); count.textContent = ""; loadMore.hidden = true; }
    loadState.replaceChildren(loadingState({ label: append ? "Loading more received shares…" : "Loading received shares…", compact: true }));
    try {
      const result = await api.receivedSharing({ limit: pageSize, offset });
      if (!current() || request !== version) return;
      if (result.sourceKind !== "team" || !Array.isArray(result.received) || typeof result.more !== "boolean" || result.received.length > 50 || (result.more && !result.received.length) || result.received.some(item => !item || typeof item.id !== "string" || !item.id || typeof item.shareId !== "string" || !item.shareId || typeof item.title !== "string" || typeof item.text !== "string")) throw new Error("Received shares could not be read. Try again.");
      const known = new Set(items.map(item => item.id)), added = [];
      for (const item of result.received) if (!known.has(item.id)) { known.add(item.id); items.push(item); added.push(excerpt(item)); }
      list.append(...added); nextOffset = offset + result.received.length; more = result.more;
      loadState.replaceChildren();
      if (!items.length) list.replaceChildren(h("div", { class: "ds-empty" }, h("h3", {}, "No received shares available"), h("p", {}, "Approved excerpts available to this team will appear here.")));
      count.textContent = items.length ? "Showing " + items.length + " approved excerpt" + (items.length === 1 ? "." : "s.") : "";
      loadMore.hidden = !more;
      if (restoreFocus) (append ? added[0]?.querySelector("h3") || refresh : refresh).focus();
    } catch (error) {
      if (!current() || request !== version) return;
      loadState.replaceChildren(h("div", { class: "ds-notice", "data-tone": "danger", role: "alert" },
        h("p", {}, error.message || "Received shares could not be loaded. Try again."), button("Try again", () => load(append), { class: "small" })));
      if (restoreFocus) loadState.querySelector("button")?.focus();
      fail(error);
    } finally {
      if (current() && request === version) { loading = false; refresh.disabled = false; loadMore.disabled = false; refresh.setAttribute("aria-busy", "false"); received.setAttribute("aria-busy", "false"); }
    }
  }
  function clear() {
    ++version; items = []; nextOffset = 0; more = false; loading = false;
    list.replaceChildren(); count.textContent = ""; loadMore.hidden = true; refresh.disabled = false;
    refresh.setAttribute("aria-busy", "false"); received.setAttribute("aria-busy", "false");
    loadState.replaceChildren(h("p", { class: "field-hint" }, "Refresh shares to reload received excerpts."));
  }
  load();
  return { element, clearSecrets: clear, dispose() { active = false; clear(); sourceFeedback.textContent = ""; } };
}

// No source text or credential is written to storage, markup, URLs or attributes.
export function sharingView({ api, workspaceKind = "personal", personalWorkspaces = [], onOpenPersonal, role, initialError = "", fail = () => {}, isCurrent = () => true, copy = value => navigator.clipboard.writeText(value), now = () => Date.now() }) {
  if (workspaceKind === "team") return teamSharingView({ api, personalWorkspaces, onOpenPersonal, role, initialError, fail, isCurrent });
  const prefix = "sharing-" + (++instance);
  let active = true, scope = 0, loadVersion = 0, previewVersion = 0, draftVersion = 0;
  let catalog = null, preview = null, candidates = [], previewTimer, previewBusy = false, commitBusy = false, loadBusy = false;
  const pendingGrants = new Map(), secretFields = new Set();
  const current = () => active && isCurrent();
  const feedback = h("p", { id: prefix + "-feedback", class: "sharing-feedback", tabindex: -1, role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const notice = (text, tone = "neutral", alert = false) => h("div", { class: "ds-notice", "data-tone": tone, role: alert ? "alert" : "status" }, text);
  const report = (text, error = false) => { feedback.setAttribute("role", error ? "alert" : "status"); feedback.textContent = text; };
  const loadState = h("div", { class: "sharing-load-state" });
  const instruction = h("textarea", { id: prefix + "-instruction", name: "instruction", rows: 4, minlength: 5, maxlength: 1000, required: true, autocomplete: "off", placeholder: "Share architecture decisions for the project. Exclude personal notes and contact details.", "aria-describedby": prefix + "-instruction-hint", oninput: () => invalidateReview("Instructions changed. Preview again before sharing.") });
  const recipientKind = h("select", { id: prefix + "-kind", name: "recipient-kind", required: true, onchange: () => { updateRecipient(); invalidateReview("Recipient changed. Preview again before sharing."); } },
    h("option", { value: "" }, "Choose a recipient"), h("option", { value: "team" }, "A team workspace"), h("option", { value: "agent" }, "One agent · read-only access"));
  const team = h("select", { id: prefix + "-team", name: "team", onchange: () => invalidateReview("Recipient changed. Preview again before sharing.") }, h("option", { value: "" }, "Choose a team"));
  const agent = h("input", { id: prefix + "-agent", name: "agent-name", maxlength: 80, autocomplete: "off", placeholder: "Research assistant", oninput: () => invalidateReview("Recipient changed. Preview again before sharing.") });
  const teamField = h("label", { class: "field", hidden: true }, "Team workspace", team);
  const agentField = h("label", { class: "field", hidden: true }, "Name this agent’s access", agent);
  const recipientNote = h("p", { class: "field-hint", id: prefix + "-recipient-note" }, "Choose who can read this approved snapshot.");
  const previewButton = h("button", { type: "submit", class: "primary" }, "Preview matching text");
  const cancelPreview = button("Cancel preview", () => { ++previewVersion; previewBusy = false; discardReview(); lockForm(); report("Preview canceled. Nothing was shared."); previewButton.focus(); }, { class: "text", hidden: true });
  const form = h("form", { class: "sharing-form", hidden: true, onsubmit: event => { event.preventDefault(); requestPreview(); } },
    h("h2", {}, "Create a share"),
    h("label", { class: "field" }, "Include and exclude", instruction),
    h("p", { class: "field-hint", id: prefix + "-instruction-hint" }, "Describe topics to include and anything to leave out. Use 5–1,000 characters."),
    h("div", { class: "sharing-recipient-fields" }, h("label", { class: "field" }, "Recipient", recipientKind), teamField, agentField),
    recipientNote, h("div", { class: "form-actions" }, previewButton, cancelPreview),
    h("p", { class: "field-hint" }, "Nothing is shared until you review and approve the exact text."));
  const review = h("div", { class: "sharing-review", "aria-label": "Review proposed shared text" });
  const credentials = h("div", { class: "sharing-credentials" });
  const grantsHeading = h("h2", { tabindex: "-1" }, "Approved snapshots");
  const refresh = button("Refresh shares", () => loadCatalog(), { class: "small" });
  const grantsList = h("div", { class: "sharing-grants" });
  const grants = h("section", { class: "sharing-manage" }, h("div", { class: "sharing-section-heading" }, grantsHeading, refresh), grantsList);
  const element = h("section", { class: "sharing-view" }, form, loadState, review, credentials, feedback, grants);

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
      : kind === "agent" ? "Creates a separate read-only credential for this approved snapshot. Existing full workspace connections keep their prior access; disconnect or revoke them if the agent should see only this slice."
      : "Choose who can read this approved snapshot.";
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
    if (loadBusy) refresh.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Refreshing shares…");
    else refresh.textContent = "Refresh shares";
    cancelPreview.hidden = !previewBusy;
    if (!previewBusy) previewButton.textContent = "Preview matching text";
  }
  function renderSourceState() {
    loadState.replaceChildren(...(!catalog ? [] : catalog.sourceKind === "personal" ? [h("details", { class: "ds-highlight-disclosure sharing-help" },
      h("summary", {}, "How matching and sharing work"),
      h("p", { class: "field-hint" }, catalog.modelAvailable ? "Optional Jev processing can help propose excerpts. You still review every word." : "Text matching proposes excerpts. It does not understand intent or exclusions; review every word."),
      h("p", { class: "field-hint" }, "Each share is a fixed snapshot. New or edited memory needs another review."),
      !catalog.modelAvailable && h("a", { class: "ds-touch-target", href: "#workspace" }, "Review processing settings"))] : [notice("This workspace receives approved excerpts. Open team memory to read them."), h("a", { class: "ds-button", href: "#memory" }, "Open team memory")]));
  }
  function invalidateCatalogLoad() {
    ++loadVersion;
    if (loadBusy) { loadBusy = false; renderSourceState(); }
  }
  function discardReview(message = "") {
    clearTimeout(previewTimer); preview = null; candidates = [];
    review.replaceChildren(...(message ? [notice(message)] : []));
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
    previewButton.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Finding candidate text…");
    discardReview(); review.replaceChildren(notice("Finding a bounded set of excerpts to review. Nothing is being shared."));
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
      if (current() && epoch === scope && version === previewVersion) { discardReview(); review.replaceChildren(notice(error.message || "Candidates could not be loaded. Try again.", "danger", true)); fail(error); }
    } finally {
      if (current() && epoch === scope && version === previewVersion) { previewBusy = false; lockForm(); }
    }
  }
  let acknowledge, shareButton, selectionNote;
  function renderCommitState() {
    if (!shareButton || !preview) return;
    const selected = candidates.filter(item => item.selected);
    const invalid = selected.some(item => !item.draft.trim() || item.draft.trim().length > 1200 || !item.text.includes(item.draft.trim()));
    candidates.forEach(item => item.editor?.setAttribute("aria-invalid", String(item.selected && (!item.draft.trim() || !item.text.includes(item.draft.trim())))));
    shareButton.disabled = commitBusy || preview.expired || preview.revision !== draftVersion || !selected.length || invalid || !acknowledge.checked;
    selectionNote.textContent = preview.expired ? "Preview expired. Preview again to review current text."
      : invalid ? "Keep a continuous part of each proposed excerpt, or leave that item unchecked."
      : !selected.length ? "Choose at least one excerpt. Nothing is selected automatically."
      : !acknowledge.checked ? "Review the recipient acknowledgment to share " + selected.length + " selected excerpt" + (selected.length === 1 ? "." : "s.")
      : selected.length + " excerpt" + (selected.length === 1 ? "" : "s") + " ready for explicit approval.";
  }
  function renderReview() {
    const data = preview, targetName = recipientName(data.recipient);
    const title = h("h3", { tabindex: "-1" }, "Check every word.");
    const candidateNodes = candidates.map((item, index) => {
      const checked = h("input", { type: "checkbox", name: "excerpt", value: item.id, onchange: () => { item.selected = checked.checked; acknowledge.checked = false; renderCommitState(); } });
      const editor = h("textarea", { rows: 5, maxlength: 1200, autocomplete: "off", spellcheck: "false", "aria-describedby": prefix + "-edit-hint", oninput: () => {
        item.draft = editor.value; acknowledge.checked = false;
        const invalid = item.selected && (!editor.value.trim() || !item.text.includes(editor.value.trim()));
        editor.setAttribute("aria-invalid", String(invalid)); renderCommitState();
      } }); editor.value = item.draft;
      item.checkbox = checked; item.editor = editor;
      return h("article", { class: "sharing-candidate" },
        h("label", { class: "ds-option" }, checked, h("span", {}, h("strong", {}, item.title || "Memory excerpt"), h("small", {}, item.reason || "Review whether this belongs in the share."))),
        h("label", { class: "field" }, "Exact text for the recipient · excerpt " + (index + 1), editor));
    });
    acknowledge = h("input", { type: "checkbox", required: true, onchange: renderCommitState });
    shareButton = button("Share approved text", commit, { class: "primary", disabled: true });
    selectionNote = h("p", { class: "field-hint", "aria-live": "polite" });
    const reviewBody = candidates.length ? [
      h("p", { class: "field-hint", id: prefix + "-edit-hint" }, "Keep a continuous part of each proposed excerpt. To remove a private detail in the middle, keep a smaller section or leave the item unchecked. Added or rewritten text cannot be shared from this preview."),
      h("div", { class: "sharing-candidates" }, candidateNodes),
      h("label", { class: "ds-option sharing-acknowledgment" }, acknowledge, h("span", {}, h("strong", {}, "I reviewed the selected text and want to share it with " + targetName + "."), h("small", {}, data.recipient.kind === "team" ? "Everyone authorized in that team can read this approved snapshot." : "The separate read-only credential will access this approved snapshot only."))),
      selectionNote, h("div", { class: "form-actions" }, shareButton, button("Cancel review", () => { ++previewVersion; discardReview(); report("Review canceled. Nothing was shared."); previewButton.focus(); }, { class: "text" })),
    ] : [notice("No matching excerpts were proposed. Adjust the instruction and preview again. Nothing was shared.")];
    review.replaceChildren(h("section", { class: "sharing-review-card" },
      h("div", { class: "ds-heading-group" }, statusLabel(data.method === "model" ? "Jev-assisted preview" : "Text match · manual review"), title,
        h("p", {}, data.method === "model" ? "Optional Jev processing helped select candidates. You still approve every excerpt." : "Text matching proposed these candidates. It does not fully interpret a natural-language policy; review the selection yourself.")),
      h("p", { class: "sharing-preview-meta" }, "Recipient: " + targetName + ". Showing " + candidates.length + " candidate excerpt(s). ", h("time", { datetime: data.expiresAt }, "Preview expires " + date(data.expiresAt)), Number(data.excludedCount) > 0 ? " · " + data.excludedCount + " excerpt(s) excluded." : ""),
      h("p", { class: "field-hint" }, (Number.isSafeInteger(data.scannedCount) ? "Scanned " + data.scannedCount + " source(s). " : "") + (Number.isSafeInteger(data.consideredCount) ? "Considered " + data.consideredCount + " excerpt(s). " : "Considered up to 16 excerpts. ") + "At most three excerpts per source, up to 1,200 characters each. This bounded review may miss relevant content or private details; check every selected word."),
      data.truncated === true && notice("The source scan reached its limit. This preview does not cover all available memory. Narrow the instruction or review another slice."),
      ...reviewBody));
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
    shareButton.setAttribute("aria-busy", "true"); shareButton.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Sharing approved text…"); report("");
    try {
      const result = await api.sharingCommit({ previewId: data.previewId, selections, acknowledged: true });
      if (!current() || epoch !== scope) return;
      catalog.shares = [result.share, ...(catalog.shares || []).filter(item => item.id !== result.share.id)];
      discardReview(); renderGrants(); clearCredential();
      report("Approved snapshot shared with " + recipientName(data.recipient) + ". New or changed memories were not added.");
      if (result.credential) showCredential(result.credential);
      else grantsHeading.focus({ preventScroll: true });
    } catch (error) {
      if (!current() || epoch !== scope) return;
      if ([409, 410].includes(error.status) || ["preview_changed", "preview_expired", "unavailable"].includes(error.code)) { data.expired = true; acknowledge.checked = false; }
      report(error.message || "Could not confirm the share. Refresh approved snapshots before retrying.", true); fail(error);
      candidates.forEach(item => { item.checkbox.disabled = false; item.editor.disabled = false; });
      review.querySelectorAll("button").forEach(control => { control.disabled = false; });
      acknowledge.disabled = false; shareButton.textContent = "Share approved text";
      if ([shareButton, document.body].includes(document.activeElement)) feedback.focus();
    } finally { if (current() && epoch === scope) { commitBusy = false; shareButton.setAttribute("aria-busy", "false"); lockForm(); renderCommitState(); } }
  }
  function clearCredential() {
    for (const field of secretFields) { field.value = ""; field.removeAttribute("value"); }
    secretFields.clear(); credentials.replaceChildren();
  }
  function showCredential(value) {
    clearCredential();
    const token = h("input", { type: "password", readonly: true, autocomplete: "off", spellcheck: "false", "aria-label": "Read-only share token" });
    token.value = String(value.token || ""); secretFields.add(token);
    const endpoint = h("input", { readonly: true, autocomplete: "off", "aria-label": "Read-only MCP endpoint" }); endpoint.value = String(value.mcpUrl || ""); secretFields.add(endpoint);
    const title = h("h3", { tabindex: "-1" }, "Connect this one agent.");
    const show = button("Show token", () => { if (!current() || !token.value) return; token.type = token.type === "password" ? "text" : "password"; show.textContent = token.type === "password" ? "Show token" : "Hide token"; }, { class: "small" });
    const copyToken = button("Copy token", async () => {
      if (!current() || !token.value || copyToken.disabled) return;
      const epoch = scope;
      const stillCurrent = () => current() && epoch === scope && secretFields.has(token) && Boolean(token.value);
      copyToken.disabled = true; copyToken.removeAttribute("data-feedback"); copyToken.setAttribute("aria-busy", "true"); copyToken.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Copying token…");
      try {
        if (await copy(token.value) === false) throw new Error();
        if (!stillCurrent()) return;
        copyToken.setAttribute("data-feedback", "success"); copyToken.replaceChildren("Token copied");
        report("Read-only token copied. Store it privately; it is shown only in this view.");
      } catch {
        if (!stillCurrent()) return;
        copyToken.setAttribute("data-feedback", "error"); copyToken.textContent = "Copy token";
        report("Could not copy. Show the token, then select and copy it.", true);
      } finally { if (stillCurrent()) { copyToken.disabled = false; copyToken.setAttribute("aria-busy", "false"); } }
    }, { class: "small", "aria-describedby": prefix + "-feedback" });
    credentials.replaceChildren(h("section", { class: "sharing-credential" },
      h("div", { class: "ds-heading-group" }, statusLabel("Read-only · approved text only"), title,
        h("p", {}, "Use this separate endpoint and token in the receiving agent. It can read only this approved snapshot. This is not a personal workspace credential.")),
      h("label", { class: "field" }, "MCP endpoint", endpoint), h("label", { class: "field" }, "Access token · shown once", token),
      h("div", { class: "form-actions" }, show, copyToken, button("Done · clear token", clearCredential, { class: "text small" })),
      h("p", { class: "field-hint" }, "If lost, replace the token from Approved snapshots below. Replacement immediately invalidates the previous token.")));
    title.focus({ preventScroll: true });
  }
  function renderGrants() {
    const items = catalog?.shares || [];
    const existingOpen = new Set([...grantsList.querySelectorAll("details[open]")].map(node => node.dataset.share));
    grantsList.replaceChildren(...(items.length ? items.map(share => {
      const status = share.revokedAt ? statusLabel("Revoked") : statusLabel("Active snapshot");
      const heading = h("h3", { tabindex: "-1" }, share.recipient?.name || "Approved snapshot");
      const info = h("div", { class: "sharing-grant-heading" }, heading, status);
      const actions = h("div", { class: "form-actions" });
      const manage = (kind, label, confirmLabel) => {
        let confirmed = false;
        const cancel = button("Cancel", () => { confirmed = false; control.textContent = label; cancel.hidden = true; }, { class: "text small", hidden: true });
        const control = button(label, async () => {
          if (!current() || pendingGrants.has(share.id) || share.revokedAt) return;
          if (!confirmed) { confirmed = true; control.textContent = confirmLabel; cancel.hidden = false; return; }
          const attempt = {}, epoch = scope; pendingGrants.set(share.id, attempt); invalidateCatalogLoad(); lockForm(); control.disabled = true; cancel.disabled = true; clearCredential(); report("");
          actions.setAttribute("aria-busy", "true"); control.setAttribute("aria-busy", "true"); control.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), kind === "revoke" ? "Revoking sharing…" : "Replacing token…");
          try {
            const result = kind === "revoke" ? await api.revokeSharing(share.id) : await api.rotateSharingToken(share.id);
            if (!current() || epoch !== scope || pendingGrants.get(share.id) !== attempt) return;
            if (kind === "revoke") {
              const updated = result?.share || { ...share, revokedAt: new Date(now()).toISOString() };
              catalog.shares = catalog.shares.map(item => item.id === share.id ? updated : item); renderGrants();
              report("Sharing revoked. Previously read or exported copies cannot be recalled."); grantsHeading.focus({ preventScroll: true });
            } else { showCredential(result.credential); report("Agent token replaced. The previous token no longer works."); }
          } catch (error) { if (current() && epoch === scope) { report(error.message || "The change could not be confirmed. Refresh shares and try again.", true); fail(error); if ([control, document.body].includes(document.activeElement)) feedback.focus(); } }
          finally { if (pendingGrants.get(share.id) === attempt) { pendingGrants.delete(share.id); lockForm(); control.disabled = false; actions.setAttribute("aria-busy", "false"); control.setAttribute("aria-busy", "false"); cancel.disabled = false; confirmed = false; control.textContent = label; cancel.hidden = true; } }
        }, { class: kind === "revoke" ? "text small" : "small" });
        actions.append(control, cancel);
      };
      const refreshPolicy = button("Preview this policy again", () => {
        if (!current() || commitBusy) return;
        instruction.value = share.instruction || ""; recipientKind.value = share.recipient?.kind || "";
        team.value = String(share.recipient?.orgId || ""); agent.value = share.recipient?.kind === "agent" ? share.recipient.name : "";
        updateRecipient(); invalidateReview("Policy loaded. Preview again to review current source text."); instruction.focus({ preventScroll: true });
      }, { class: "small" });
      if (!share.revokedAt) { actions.append(refreshPolicy); if (share.recipient?.kind === "agent") manage("rotate", "Replace agent token", "Confirm token replacement"); manage("revoke", "Revoke sharing", "Confirm revoke"); }
      const details = h("details", { class: "sharing-approved-text", "data-share": share.id, open: existingOpen.has(share.id) }, h("summary", {}, "Read approved text · " + share.itemCount + " excerpt(s)"),
        ...(share.items || []).map(item => h("section", {}, h("h4", {}, item.title || "Approved excerpt"), h("p", {}, item.text))));
      return h("article", { class: "sharing-grant" }, info, h("p", { class: "sharing-policy" }, share.instruction),
        h("p", { class: "field-hint" }, (share.recipient?.kind === "team" ? "Team snapshot · authorized team members can read it." : "Agent snapshot · isolated read-only access.") + " Created " + date(share.createdAt) + "."),
        details, actions, !share.revokedAt && share.recipient?.kind === "agent" && h("p", { class: "field-hint" }, "Replacing a token stops the old token immediately. Revoking the share stops all new reads."),
        !share.revokedAt && share.recipient?.kind === "team" && h("p", { class: "field-hint" }, "Revoking removes this approved snapshot from the receiving workspace. It cannot recall text already read or exported."));
    }) : [notice("No approved snapshots yet. Describe a slice above and preview the text to create a share.")]));
  }
  async function loadCatalog() {
    if (!current() || loadBusy || commitBusy || pendingGrants.size > 0) return;
    const version = ++loadVersion, epoch = scope;
    loadBusy = true; refresh.disabled = true; loadState.replaceChildren(notice("Loading sharing settings…")); lockForm();
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
      if (current() && epoch === scope && version === loadVersion) { loadState.replaceChildren(notice(error.message || "Sharing settings could not be loaded. Try again.", "danger", true), button("Try loading again", loadCatalog)); fail(error); }
    } finally { if (current() && epoch === scope && version === loadVersion) { loadBusy = false; lockForm(); } }
  }
  loadCatalog();
  return { element, clearSecrets() {
    const unfinished = previewBusy || commitBusy || pendingGrants.size > 0;
    ++scope; ++previewVersion; ++loadVersion; clearTimeout(previewTimer); pendingGrants.clear(); previewBusy = false; commitBusy = false; loadBusy = false;
    clearCredential(); discardReview(); lockForm(); refresh.disabled = false; if (catalog?.sourceKind === "personal") renderGrants();
    if (unfinished) report("A request may have completed. Refresh approved snapshots to confirm the current state.");
  }, dispose() {
    active = false; ++scope; ++previewVersion; ++loadVersion; clearTimeout(previewTimer); pendingGrants.clear(); clearCredential(); discardReview(); instruction.value = ""; agent.value = "";
  } };
}
