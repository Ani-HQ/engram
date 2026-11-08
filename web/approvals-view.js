import { h } from "./profile.js";
import { emptyState, loadingState, pill, showToast, staggerIn } from "./design-system.js";
import { icon } from "./icons.js";

// Approvals: teammates' agents ask for something from your personal memory.
// Nothing leaves until you review exact excerpts here. Answers are just this
// once, or 90 days for that person on a topic you confirm.

let sequence = 0;
const button = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const busyLabel = text => [icon("loader-circle", { size: 14, class: "spin" }), text];
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const day = iso => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
const toast = (message, tone = "success") => { try { showToast(message, { tone, glyph: icon(tone === "danger" ? "circle-alert" : "circle-check", { size: 16 }) }); } catch {} };
const quiet = (glyph, title, description) => { const node = emptyState({ glyph: icon(glyph, { size: 22 }), title, description }); node.setAttribute("data-variant", "dashed"); return node; };
const notice = (text, tone = "neutral", alert = false) => h("div", { class: "sharing-notice", "data-tone": tone, role: alert ? "alert" : "status" }, icon(tone === "danger" ? "circle-alert" : tone === "warning" ? "triangle-alert" : "info", { size: 16 }), h("span", {}, text));

/** Pure: how long a request has left, in words. Exported for tests. */
export function timeLeft(expiresAt, now = Date.now()) {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "Lapsed";
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${plural(hours, "hour")} left` : `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}
/** Pure: the label for a decided request. */
export function outcomeLabel(item) {
  if (item.status === "answered") return item.automatic ? "Answered automatically" : "Shared";
  if (item.status === "declined") return "Declined";
  if (item.status === "expired") return "Lapsed";
  return "Waiting";
}

export function approvalsView({ api, fail = () => {}, isCurrent = () => true, now = () => Date.now() }) {
  const prefix = `approvals-${++sequence}`;
  let disposed = false, request = 0, data = null, error = "", open = null;
  const busy = new Set();
  const status = h("p", { class: "ds-sr-only", role: "status", "aria-live": "polite" });
  const body = h("div", { class: "approvals-body" });
  const refresh = button([icon("refresh-cw", { size: 14 }), "Refresh"], () => load(), { class: "small" });
  const element = h("div", { class: "approvals-view" }, h("div", { class: "ds-toolbar approvals-toolbar" }, refresh), status, body);
  const live = () => !disposed && isCurrent();

  function section(title, count, ...content) {
    return h("section", { class: "ds-panel approvals-section" },
      h("div", { class: "ds-panel-header" }, h("h2", {}, title, count !== null && h("span", { class: "approvals-count" }, ` ${count}`))),
      h("div", { class: "ds-panel-body" }, ...content));
  }

  function render() {
    if (!live()) return;
    refresh.disabled = request > 0 && !data && !error;
    if (!data && !error) { body.replaceChildren(loadingState({ label: "Loading requests…", lines: 3 })); return; }
    if (!data) { body.replaceChildren(h("div", { class: "notice", role: "alert" }, error, button("Try again", () => load(), { class: "text small" }))); return; }
    const pending = data.pending || [], grants = data.grants || [], history = data.history || [];
    const list = h("div", { class: "approvals-list" }, pending.map(pendingCard));
    body.replaceChildren(
      section("Waiting for you", pending.length,
        pending.length ? list : quiet("inbox", "Nothing waiting", "When a teammate's agent asks for something from your memory, it shows up here and by email.")),
      section("Active 90-day approvals", grants.length,
        grants.length ? h("ul", { class: "approvals-grants" }, grants.map(grantRow)) : h("p", { class: "field-hint" }, "None. A 90-day approval lets one teammate get excerpts you already approved on a topic without asking again.")),
      history.length ? section("Past requests", null, h("ul", { class: "approvals-history" }, history.map(historyRow))) : null,
      h("p", { class: "field-hint approvals-gaps" }, "Known limits: excerpt matching is simple and can miss things or suggest the wrong ones, so your review is the privacy control. Revoking a share removes it from the team, but an agent that already read it keeps what it read."));
    staggerIn(list);
  }

  function pendingCard(item) {
    const reviewing = open?.id === item.id;
    return h("article", { class: "approvals-card", "data-open": String(reviewing), "aria-labelledby": `${prefix}-${item.id}` },
      h("header", { class: "approvals-card-head" },
        h("div", {},
          h("h3", { id: `${prefix}-${item.id}` }, `${item.requester} asked`),
          h("p", { class: "approvals-meta" }, `From their agent in ${item.team.name} · `, h("time", { datetime: item.expiresAt }, timeLeft(item.expiresAt, now())))),
        !reviewing && h("div", { class: "ds-row" },
          button("Decline", () => decline(item), { class: "text small", disabled: busy.has(item.id) }),
          button([icon("eye", { size: 14 }), "Review excerpts"], () => review(item), { class: "primary small", disabled: busy.has(item.id) }))),
      h("blockquote", { class: "approvals-question" }, item.question),
      reviewing && reviewPanel(item));
  }

  function reviewPanel(item) {
    const state = open;
    if (state.loading) return h("div", { class: "approvals-review", "aria-busy": "true" }, loadingState({ label: "Finding excerpts in your memory…", lines: 3, compact: true }));
    if (state.error) return h("div", { class: "approvals-review" }, notice(state.error, "danger", true), h("div", { class: "ds-row" }, button("Close", () => { open = null; render(); }, { class: "text small" }), button("Try again", () => review(item), { class: "small" })));
    const candidates = state.candidates;
    if (!candidates.length) return h("div", { class: "approvals-review" },
      quiet("search", "Nothing in your memory matched", `Declining tells ${item.requester} you didn't share anything. It doesn't say why.`),
      h("div", { class: "ds-action-bar" }, h("span"), h("div", { class: "ds-action-bar-actions" }, button("Close", () => { open = null; render(); }, { class: "text small" }), button("Decline", () => decline(item), { class: "small" }))));

    const nodes = candidates.map((candidate, index) => {
      const checked = h("input", { type: "checkbox", checked: candidate.selected, "aria-label": `Include excerpt ${index + 1}`, onchange: () => { candidate.selected = checked.checked; state.acknowledged = false; sync(); } });
      const editor = h("textarea", { rows: 3, maxlength: 1200, autocomplete: "off", spellcheck: "false", "aria-describedby": `${prefix}-edit-hint`, oninput: () => { candidate.draft = editor.value; state.acknowledged = false; sync(); } });
      editor.value = candidate.draft;
      candidate.editor = editor;
      return h("article", { class: "sharing-candidate" },
        h("label", { class: "sharing-candidate-pick" }, checked, h("span", { class: "sharing-candidate-copy" },
          h("span", { class: "sharing-candidate-title" }, h("strong", {}, candidate.title || "Memory excerpt")),
          h("small", {}, candidate.reason || "Check whether this belongs in the answer."))),
        h("label", { class: "field sharing-candidate-text" }, h("span", { class: "ds-mono-label" }, `Text to share · ${index + 1}`), editor));
    });
    const once = h("input", { type: "radio", name: `${prefix}-mode`, value: "once", checked: state.mode === "once", onchange: () => { state.mode = "once"; sync(); } });
    const standing = h("input", { type: "radio", name: `${prefix}-mode`, value: "standing", checked: state.mode === "standing", onchange: () => { state.mode = "standing"; sync(); } });
    const topic = h("input", { type: "text", maxlength: 200, value: state.topic, "aria-label": "Topic for the 90-day approval", oninput: event => { state.topic = event.target.value; sync(); } });
    const acknowledge = h("input", { type: "checkbox", checked: state.acknowledged, onchange: event => { state.acknowledged = event.target.checked; sync(); } });
    const approve = button("Approve", () => approveItem(item), { class: "primary small" });
    const noteLine = h("p", { class: "sharing-selection-note", "aria-live": "polite" });
    function sync() {
      const selected = candidates.filter(c => c.selected);
      const invalid = selected.some(c => !c.draft.trim() || !c.text.includes(c.draft.trim()));
      candidates.forEach(c => c.editor?.setAttribute("aria-invalid", String(c.selected && (!c.draft.trim() || !c.text.includes(c.draft.trim())))));
      topic.disabled = state.mode !== "standing" || state.saving;
      acknowledge.checked = state.acknowledged;
      const topicOk = state.mode === "once" || state.topic.trim().length >= 3;
      approve.disabled = state.saving || !selected.length || invalid || !state.acknowledged || !topicOk;
      if (!state.saving) approve.replaceChildren(icon("check", { size: 14 }), selected.length ? `Approve ${plural(selected.length, "excerpt")}` : "Approve excerpts");
      noteLine.textContent = invalid ? "Keep a continuous part of each selected excerpt, or uncheck it."
        : !selected.length ? "Select what to share. Nothing is preselected."
        : !topicOk ? "Name the topic for the 90-day approval."
        : !state.acknowledged ? "Confirm your review to approve." : `${plural(selected.length, "excerpt")} ready.`;
    }
    const list = h("div", { class: "sharing-candidates" }, nodes);
    const panel = h("div", { class: "approvals-review" },
      notice(state.method === "model" ? "Jev proposed these excerpts. Suggestions can be wrong; check every word." : "Text matching proposed these. It can be wrong; check every word.", "warning"),
      h("p", { class: "sharing-edit-hint", id: `${prefix}-edit-hint` }, "You can shorten an excerpt but not add to it."),
      list,
      h("fieldset", { class: "approvals-mode" }, h("legend", {}, "How long"),
        h("label", { class: "approvals-choice" }, once, h("span", {}, h("strong", {}, "Just this once"), h("small", {}, "Only this answer. The next question asks you again."))),
        h("label", { class: "approvals-choice" }, standing, h("span", {}, h("strong", {}, `${item.requester}, this topic, for 90 days`), h("small", {}, "Later questions on this topic get excerpts you've already approved, without asking. Anything new still comes to you."))),
        h("label", { class: "field approvals-topic" }, h("span", { class: "ds-mono-label" }, "Topic"), topic)),
      h("label", { class: "sharing-acknowledgment" }, acknowledge, h("span", {},
        h("strong", {}, `I reviewed the selected text and want to share it with ${item.team.name}.`),
        h("small", {}, `Everyone in ${item.team.name} can read approved excerpts until you revoke them in Sharing.`))),
      h("div", { class: "ds-action-bar sharing-approve-bar" }, noteLine,
        h("div", { class: "ds-action-bar-actions" }, button("Cancel", () => { open = null; render(); }, { class: "text small", disabled: state.saving }), approve)));
    sync();
    staggerIn(list);
    return panel;
  }

  function grantRow(grant) {
    return h("li", { class: "approvals-row" },
      h("div", {}, h("strong", {}, grant.topic), h("p", { class: "approvals-meta" }, `${grant.requester} · ${grant.team.name} · until ${day(grant.expiresAt)}`)),
      button("Revoke", () => revokeGrant(grant), { class: "small", disabled: busy.has(grant.id), "aria-label": `Revoke ${grant.requester}'s approval for ${grant.topic}` }));
  }

  function historyRow(item) {
    return h("li", { class: "approvals-row" },
      h("div", {}, h("span", {}, item.question), h("p", { class: "approvals-meta" }, `${item.requester} · ${item.team.name} · ${day(item.decidedAt || item.createdAt)}`)),
      pill(outcomeLabel(item), { tone: item.status === "answered" ? "accent" : "neutral" }));
  }

  async function review(item) {
    open = { id: item.id, loading: true, candidates: [], mode: "once", topic: item.question.slice(0, 200), acknowledged: false, saving: false };
    render();
    try {
      const result = await api.previewApproval(item.id);
      if (!live() || open?.id !== item.id) return;
      open = { ...open, loading: false, previewId: result.preview.previewId, method: result.preview.method, topic: typeof result.suggestedTopic === "string" && result.suggestedTopic.trim() ? result.suggestedTopic.slice(0, 200) : open.topic,
        candidates: (result.preview.candidates || []).slice(0, 12).map(candidate => ({ ...candidate, selected: false, draft: String(candidate.text || "") })) };
    } catch (err) {
      if (!live() || open?.id !== item.id) return;
      fail(err); open = { ...open, loading: false, error: err.message || "Excerpts could not be loaded." };
    }
    render();
    element.querySelector(`[aria-labelledby="${prefix}-${item.id}"] .approvals-review`)?.focus?.();
  }

  async function approveItem(item) {
    const state = open; if (!state || state.saving) return;
    const selections = state.candidates.filter(c => c.selected).map(c => ({ id: c.id, text: c.draft.trim() }));
    state.saving = true; render();
    try {
      const result = await api.approveRequest(item.id, { mode: state.mode, ...(state.mode === "standing" ? { topic: state.topic.trim() } : {}), previewId: state.previewId, selections, acknowledged: true });
      if (!live()) return;
      open = null;
      toast(result.grantId ? `Shared with ${item.requester} and approved for 90 days` : `Shared with ${item.requester}`);
      status.textContent = "Approved.";
      await load();
    } catch (err) {
      if (!live()) return;
      fail(err); state.saving = false; toast(err.message || "The answer could not be sent.", "danger"); render();
    }
  }

  async function decline(item) {
    busy.add(item.id); open = null; render();
    try { await api.declineRequest(item.id); if (live()) { toast(`Declined. ${item.requester} sees that nothing was shared.`); await load(); } }
    catch (err) { if (live()) { fail(err); toast(err.message || "The request could not be declined.", "danger"); } }
    finally { busy.delete(item.id); render(); }
  }

  async function revokeGrant(grant) {
    busy.add(grant.id); render();
    try { await api.revokeApprovalGrant(grant.id); if (live()) { toast("Approval revoked. Shared excerpts stay until you revoke them in Sharing."); await load(); } }
    catch (err) { if (live()) { fail(err); toast(err.message || "The approval could not be revoked.", "danger"); } }
    finally { busy.delete(grant.id); render(); }
  }

  async function load() {
    const id = ++request;
    refresh.disabled = true; refresh.replaceChildren(...busyLabel("Refresh"));
    try {
      const result = await api.approvals();
      if (!live() || id !== request) return;
      data = result; error = "";
      status.textContent = `${plural((result.pending || []).length, "request")} waiting.`;
    } catch (err) {
      if (!live() || id !== request) return;
      fail(err); error = err.message || "Requests could not be loaded.";
    } finally {
      if (live() && id === request) { refresh.disabled = false; refresh.replaceChildren(icon("refresh-cw", { size: 14 }), "Refresh"); render(); }
    }
  }

  load();
  return { element, dispose() { disposed = true; } };
}
