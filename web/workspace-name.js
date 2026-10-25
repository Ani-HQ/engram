import { h } from "./profile.js";

const validName = value => typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const invalidName = "Use a workspace name between 1 and 100 characters without control characters.";

export function applyWorkspaceName(session, org) {
  if (!session?.org || session.org.id !== org?.id || !validName(org.name)) return false;
  session.org.name = org.name;
  if (Array.isArray(session.orgs)) session.orgs = session.orgs.map(item => item.id === org.id ? { ...item, name: org.name } : item);
  return true;
}

// Drafts belong to a workspace, while each save belongs to one uninterrupted
// session selection. Invalidating also covers leaving and returning to it.
export function createWorkspaceNameEditor({ workspaceId, name, save, context, changed = () => {}, saved = () => {}, failed = () => {} }) {
  let revision = 0;
  const state = { name, draft: name, busy: false, error: "", feedback: "" };
  return {
    state,
    setDraft(value) { state.draft = value; state.error = ""; state.feedback = ""; },
    syncName(value) { const pristine = state.draft === state.name; state.name = value; if (pristine && !state.busy) state.draft = value; },
    invalidate() { revision++; state.busy = false; state.error = ""; state.feedback = ""; },
    async submit() {
      const identity = context();
      if (state.busy || !identity) return;
      if (!validName(state.draft)) { state.error = invalidName; state.feedback = ""; changed(); return; }
      const name = state.draft.trim();
      if (name === state.name) return;
      const request = ++revision, current = () => request === revision && context() === identity;
      state.busy = true; state.error = ""; state.feedback = "Saving workspace name…"; changed();
      try {
        const result = await save(name);
        if (!current()) return;
        if (result?.org?.id !== workspaceId || result.org.name !== name || !validName(result.org.name)) throw new Error("The workspace name could not be confirmed. Please try again.");
        state.name = result.org.name; state.draft = result.org.name; state.feedback = "Workspace name saved.";
        saved(result.org);
      } catch (error) {
        if (!current()) return;
        state.error = error.message || "The workspace name could not be saved. Please try again."; state.feedback = ""; failed(error);
      } finally {
        if (current()) { state.busy = false; changed(); }
      }
    },
  };
}

export function workspaceNameForm({ session, editor }) {
  if (session?.role !== "owner" || typeof session.email !== "string" || !session.email.trim() || !editor) return null;
  const { state } = editor;
  const feedback = h("p", { id: "setup-name-feedback", class: "detail-note", role: state.error ? "alert" : "status", "aria-live": "polite" }, state.error || state.feedback);
  const input = h("input", { type: "text", maxlength: 100, required: true, autocomplete: "organization", readonly: state.busy, "aria-describedby": "setup-name-note setup-name-feedback", "data-setup-focus": "workspace-name", oninput: event => {
    editor.setDraft(event.target.value); feedback.textContent = ""; feedback.setAttribute("role", "status"); save.disabled = state.busy || state.draft.trim() === state.name;
  } });
  input.value = state.draft;
  const save = h("button", { type: "submit", class: "small", disabled: state.busy || state.draft.trim() === state.name, "data-setup-focus": "save-workspace-name" }, state.busy ? "Saving…" : "Save name");
  return h("section", { class: "setup-workspace-name", "aria-labelledby": "setup-name-title" }, h("h3", { id: "setup-name-title" }, "Name your workspace (optional)"),
    h("p", { id: "setup-name-note", class: "detail-note" }, "You can change this later here."),
    h("form", { class: "stack", onsubmit: event => { event.preventDefault(); return editor.submit(); } }, h("div", { class: "setup-name-fields" }, h("label", { class: "field" }, "Workspace name", input), save), feedback));
}

export function captureSetupFocus(slot, active = document.activeElement) {
  if (!slot?.contains(active) || !active?.dataset.setupFocus) return null;
  return { key: active.dataset.setupFocus, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
}

export function restoreSetupFocus(slot, snapshot) {
  if (!slot || !snapshot) return;
  let target = [...slot.querySelectorAll("[data-setup-focus]")].find(node => node.dataset.setupFocus === snapshot.key);
  if (target?.disabled) target = [...slot.querySelectorAll("[data-setup-focus]")].find(node => node.dataset.setupFocus === "workspace-name");
  target?.focus({ preventScroll: true });
  if (typeof snapshot.start === "number" && typeof snapshot.end === "number" && target?.setSelectionRange) target.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction || "none");
}
