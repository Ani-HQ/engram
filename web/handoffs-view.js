import { h } from "./profile.js";
import { evidenceList, loadingState, taskRecord } from "./design-system.js";
import { icon } from "./icons.js";
import { relativeTime } from "./activity-view.js";
import { statusLabel } from "./status-label.js";

// Saved task records that another agent can continue. Everything shown here is
// agent-reported; the view keeps save time, author and the recheck rule visible.

let instance = 0;
const PAGE = 20;
const button = (children, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, children);
const exact = value => {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Time unavailable";
};
const TRIGGERS = { start: "Started", decision: "Decision", plan: "Plan change", blocker: "Blocker", milestone: "Milestone", handoff: "Handoff", completed: "Completed" };

/** One sentence a person pastes into any connected agent. */
export function continuePrompt(task) {
  return `Continue the Engram task “${task.title}” (${task.id}). Use resume_task, recheck the repository, then pick up from its next step.`;
}

function validList(result) {
  return result && Array.isArray(result.tasks) && typeof result.more === "boolean" && result.tasks.length <= 50 &&
    result.tasks.every(task => task && /^task_[a-f0-9]{32}$/.test(task.id) && typeof task.title === "string" && ["open", "closed"].includes(task.status));
}

export function handoffsView({ api, role, canWrite = true, copyControl, fail = () => {}, isCurrent = () => true }) {
  const prefix = `handoffs-${++instance}`;
  const human = ["owner", "member"].includes(role);
  let active = true, version = 0, loading = false, status = "open", q = "", offset = 0, more = false, tasks = [], searchTimer;
  const current = () => active && isCurrent();

  const announce = h("p", { class: "ds-sr-only", role: "status", "aria-live": "polite" });
  const results = h("div", { class: "ds-results handoffs-results", id: `${prefix}-results`, "aria-busy": "false" });
  const loadMore = button("Load more tasks", () => load({ append: true }), { class: "small", hidden: true });
  const refresh = button("Refresh", () => load(), { class: "small" });
  const search = h("input", { type: "search", class: "search", placeholder: "Search tasks…", "aria-label": "Search saved tasks",
    oninput: event => { q = event.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => load(), 250); } });
  const statusButtons = [["open", "Open"], ["closed", "Closed"]].map(([value, label]) => button(label, () => {
    if (status === value) return; status = value; syncStatus(); load();
  }, { class: "activity-filter-tab", "aria-pressed": String(status === value), "data-handoff-status": value }));
  function syncStatus() { for (const node of statusButtons) node.setAttribute("aria-pressed", String(node.dataset.handoffStatus === status)); }

  const element = h("section", { class: "handoffs-view", "aria-labelledby": `${prefix}-title` },
    h("div", { class: "handoffs-intro" },
      h("div", { class: "ds-heading-group" },
        h("h2", { id: `${prefix}-title` }, "Pick up where any agent left off."),
        h("p", {}, "Connected agents save a compact task record when work starts, at decisions and plan changes, and when you ask for a handoff. Copy a task’s prompt into another agent to continue from the last confirmed save.")),
      h("p", { class: "field-hint" }, "Records are agent-reported. The next agent rechecks files, Git and tests before relying on them.")),
    h("div", { class: "handoffs-toolbar" },
      h("div", { class: "activity-switcher", role: "group", "aria-label": "Task status" }, statusButtons),
      h("div", { class: "search-field" }, icon("search", { size: 16 }), search),
      refresh),
    results, h("div", { class: "form-actions handoffs-more" }, loadMore), announce);

  const empty = (title, text, action) => h("div", { class: "empty handoffs-empty" }, h("h2", {}, title), h("p", {}, text), action);
  function emptyState() {
    if (q) return empty(`No tasks match “${q}”`, "Try other words from the title, objective or next step.",
      button("Clear search", () => { search.value = ""; q = ""; load(); search.focus(); }, { class: "small" }));
    if (status === "closed") return empty("No closed tasks", "Tasks an agent completes, or that you close, appear here.");
    return empty("No saved tasks yet", "When a connected agent starts real work, makes a decision or hands off, it saves a task record here. You can also ask it: “Save a handoff to Engram.”",
      h("a", { class: "ds-button", href: "#connect" }, "Connect an agent"));
  }

  function badges(task) {
    const latest = task.latest;
    const words = [task.status === "closed" ? latest?.trigger === "completed" ? "Completed" : "Closed" : latest?.trigger === "handoff" ? "Handoff" : "Open",
      task.lineages > 1 && `${task.lineages} lineages`, task.project].filter(Boolean);
    return h("p", { class: "handoff-badges" }, statusLabel(words.join(" · ")));
  }

  function card(task) {
    const latest = task.latest, detailId = `${prefix}-detail-${task.id}`;
    const detail = h("div", { class: "handoff-detail", id: detailId, hidden: true });
    const toggle = button("View record", () => toggleDetail(task, toggle, detail),
      { class: "small ds-disclosure-toggle", "aria-expanded": "false", "aria-controls": detailId });
    const copy = copyControl ? copyControl("Copy continue prompt", () => continuePrompt(task), { class: "small primary", "aria-label": `Copy continue prompt for ${task.title}` }) : null;
    return h("article", { class: "handoff-card", "data-task-id": task.id },
      h("div", { class: "handoff-card-heading" }, h("h3", { tabindex: -1 }, task.title), badges(task)),
      latest?.next && h("p", { class: "handoff-next" }, h("span", {}, "Next"), latest.next),
      h("div", { class: "handoff-meta" },
        latest ? [
          h("span", { class: "handoff-author", title: latest.savedBy }, latest.savedBy),
          latest.reportedSource && h("span", { title: "Reported source, not a verified identity" }, `via ${latest.reportedSource}`),
          h("span", {}, TRIGGERS[latest.trigger] || "Saved"),
          h("time", { datetime: latest.savedAt, title: exact(latest.savedAt), "data-relative-time": latest.savedAt }, relativeTime(latest.savedAt)),
        ] : h("span", {}, "No confirmed checkpoint")),
      h("div", { class: "form-actions" }, copy, toggle),
      detail);
  }

  async function toggleDetail(task, toggle, detail) {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open)); detail.hidden = !open;
    if (!open || detail.dataset.loaded === "true") return;
    detail.replaceChildren(loadingState({ label: "Loading task record…", compact: true }));
    try {
      const data = await api.task(task.id);
      if (!current()) return;
      detail.dataset.loaded = "true";
      detail.replaceChildren(...detailContent(data, toggle));
    } catch (error) {
      if (!current()) return;
      fail(error);
      detail.replaceChildren(h("div", { class: "ds-notice", "data-tone": "danger", role: "alert" }, error.message || "This task record could not be loaded.",
        button("Try again", () => { toggle.setAttribute("aria-expanded", "false"); toggleDetail(task, toggle, detail); }, { class: "small text" })));
    }
  }

  function detailContent(data, toggle) {
    const checkpoint = data.current, task = data.task;
    if (!checkpoint) return [h("p", { class: "field-hint" }, "This task has no confirmed checkpoint.")];
    const feedback = h("p", { class: "handoffs-feedback", role: "status", "aria-live": "polite" });
    const actions = h("div", { class: "form-actions handoff-detail-actions" });
    if (canWrite) actions.append(task.status === "closed"
      ? button("Reopen task", () => changeState(task, "reopen", feedback), { class: "small" })
      : button("Close task", () => changeState(task, "close", feedback), { class: "small" }));
    if (human) actions.append(deleteControl(task, feedback, toggle));
    return [
      // The card already leads with the next step; the record continues from the objective.
      taskRecord({ ...checkpoint.record, next: undefined }),
      evidenceList([
        { label: "Saved by", value: checkpoint.savedBy, note: checkpoint.harness ? `Reported source: ${checkpoint.harness}` : undefined },
        { label: "Saved", value: exact(checkpoint.savedAt), note: TRIGGERS[checkpoint.trigger] },
        { label: "Revision", value: `${checkpoint.revision} on ${checkpoint.lineage}` },
        ...(checkpoint.repo || checkpoint.branch ? [{ label: "Repository", value: [checkpoint.repo, checkpoint.branch].filter(Boolean).join(" · ") }] : []),
      ], { label: "Checkpoint provenance" }),
      data.lineages.length > 1 && h("div", { class: "ds-notice", "data-tone": "warning" },
        `${data.lineages.length} parallel lineages: ${data.lineages.map(lineage => `${lineage.lineage} (revision ${lineage.revision})`).join(", ")}. The next agent will ask which to continue.`),
      data.history.length > 1 && h("details", { class: "ds-highlight-disclosure handoff-history" },
        h("summary", {}, `History · ${data.history.length}${data.moreHistory ? "+" : ""} saves`),
        h("ol", { class: "ds-task-record-list", role: "list" }, data.history.map(item => h("li", {},
          `Revision ${item.revision} · ${TRIGGERS[item.trigger] || "Saved"} · ${item.savedBy}`, h("small", {}, `${exact(item.savedAt)}${item.lineage !== "main" ? ` · ${item.lineage}` : ""} · Next: ${item.next}`))))),
      actions, feedback,
    ];
  }

  async function changeState(task, action, feedback) {
    feedback.setAttribute("role", "status"); feedback.textContent = action === "close" ? "Closing…" : "Reopening…";
    try {
      await api[action === "close" ? "closeTask" : "reopenTask"](task.id);
      if (!current()) return;
      announce.textContent = action === "close" ? `Closed ${task.title}.` : `Reopened ${task.title}.`;
      await load({ focus: true });
    } catch (error) {
      if (!current()) return;
      fail(error); feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "The task could not be updated. Try again.";
    }
  }

  // An inline two-step confirmation. Native browser dialogs would block automation and focus.
  function deleteControl(task, feedback) {
    const wrapper = h("span", { class: "handoff-delete" });
    const start = button("Delete task", () => {
      wrapper.replaceChildren(
        button("Confirm delete", () => remove(task, feedback, wrapper), { class: "small", "data-variant": "danger" }),
        button("Cancel", () => { wrapper.replaceChildren(start); start.focus(); }, { class: "small text" }));
      wrapper.firstChild.focus();
    }, { class: "small text", "data-variant": "danger" });
    wrapper.append(start);
    return wrapper;
  }

  async function remove(task, feedback, wrapper) {
    for (const node of wrapper.querySelectorAll("button")) node.disabled = true;
    try {
      await api.deleteTask(task.id);
      if (!current()) return;
      const article = results.querySelector(`[data-task-id="${task.id}"]`);
      const undoError = h("span", { class: "handoffs-feedback", role: "alert" });
      const undo = button("Undo", async () => {
        undo.disabled = true; undoError.textContent = "";
        try { await api.restoreTask(task.id); if (current()) await load({ focus: true }); }
        catch (error) { if (current()) { fail(error); undo.disabled = false; undoError.textContent = error.message || "The task could not be restored. Try again."; } }
      }, { class: "small text" });
      const notice = h("div", { class: "ds-notice handoff-deleted", role: "status" }, h("span", {}, `Deleted “${task.title}”. Agents can no longer find or resume it.`), undo, undoError);
      article?.replaceWith(notice); undo.focus();
      tasks = tasks.filter(item => item.id !== task.id);
    } catch (error) {
      if (!current()) return;
      fail(error); for (const node of wrapper.querySelectorAll("button")) node.disabled = false;
      feedback.setAttribute("role", "alert"); feedback.textContent = error.message || "The task could not be deleted. Try again.";
    }
  }

  async function load({ append = false, focus = false } = {}) {
    if (!current() || (append && (!more || loading))) return;
    const request = ++version, from = append ? offset : 0;
    const restore = document.activeElement === refresh;
    loading = true; refresh.disabled = true; loadMore.disabled = true; results.setAttribute("aria-busy", "true");
    if (!append) results.replaceChildren(loadingState({ label: "Loading saved tasks…", lines: 3 }));
    try {
      const result = await api.tasks({ status, q, limit: PAGE, offset: from });
      if (!current() || request !== version) return;
      if (!validList(result)) throw new Error("Saved tasks could not be read. Try again.");
      tasks = append ? [...tasks, ...result.tasks] : result.tasks; offset = from + result.tasks.length; more = result.more;
      const cards = result.tasks.map(card);
      if (append) results.append(...cards); else results.replaceChildren(...(tasks.length ? cards : [emptyState()]));
      loadMore.hidden = !more;
      announce.textContent = tasks.length ? `${tasks.length} ${status} task${tasks.length === 1 ? "" : "s"} shown.` : "No tasks shown.";
      if (append) cards[0]?.querySelector("h3")?.focus(); else if (focus) results.querySelector("h3")?.focus(); else if (restore) refresh.focus();
    } catch (error) {
      if (!current() || request !== version) return;
      fail(error);
      results.replaceChildren(h("div", { class: "ds-notice", "data-tone": "danger", role: "alert" },
        error.code === "continuation_unavailable" ? error.message : error.message || "Saved tasks could not be loaded.",
        button("Try again", () => load(), { class: "small text" })));
    } finally {
      if (request === version) { loading = false; refresh.disabled = false; loadMore.disabled = false; results.setAttribute("aria-busy", "false"); }
    }
  }

  load();
  return {
    element,
    refresh: () => load(),
    dispose() { active = false; clearTimeout(searchTimer); },
  };
}
