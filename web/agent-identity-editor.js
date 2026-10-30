// Name and logo for one connection. A connected agent can describe itself with
// the set_identity tool; a workspace owner can override, reset or lock it here.
// Both are display hints only: they never verify the product behind a credential.
import { h } from "./profile.js";
import { convertProfilePhoto } from "./profile-photo-editor.js";
import { agentIdentity, agentVisual, detectedAgentVisual, visualIcon } from "./tooling.js";
import { identityMark, pill } from "./design-system.js";

let sequence = 0;
const sourceText = identity => !identity?.source ? "Detected from the connection"
  : identity.source === "owner" ? "Set by a workspace owner" : "Self-described by the agent. Not verified.";

/**
 * @param {object} connection  a row from /api/connections
 * @param {{ owner: boolean, save: (body: object) => Promise<object>, onSaved?: (identity: object) => void }} options
 */
export function agentIdentitySection(connection, { owner, save, onSaved = () => {} }) {
  const id = `agent-identity-${++sequence}`;
  const current = agentIdentity(connection.agent);
  const preview = h("div", { class: "agent-identity-preview" });
  const feedback = h("p", { id: `${id}-feedback`, class: "ds-field-error", role: "alert", hidden: true });
  let logo; // undefined: unchanged; null: clear; string: new data URL
  let busy = false, nameInput = null;

  const renderPreview = () => {
    const name = nameInput?.value.trim() || current?.name || connection.displayName || connection.name || "Agent";
    const hints = { harness: connection.harness, sourceLabel: connection.sourceLabel };
    const visual = typeof logo === "string" ? { logo } : logo === null ? detectedAgentVisual(connection.agent, hints) : agentVisual(connection.agent, hints);
    preview.replaceChildren(identityMark(visualIcon(visual, { size: 26 }), { size: "lg" }),
      h("div", { class: "agent-identity-copy" }, h("strong", {}, name), h("span", { class: "detail-note" }, sourceText(current))));
  };

  const reported = current && (current.reportedName || current.reportedLogo)
    ? h("p", { class: "detail-note" }, "The agent reported ", current.reportedName ? `the name “${current.reportedName}”` : "", current.reportedName && current.reportedLogo ? " and " : "", current.reportedLogo ? "a logo" : "", current.reportedAt ? ` on ${new Date(current.reportedAt).toLocaleDateString()}.` : ".")
    : h("p", { class: "detail-note" }, "Custom agents can set their own name and logo with Engram’s set_identity tool. They show here as self-described.");

  if (!owner) {
    renderPreview();
    return h("section", { class: "agent-identity stack", "aria-label": "Name and logo" }, h("h3", {}, "Name and logo"), preview, reported,
      current?.locked && h("p", { class: "detail-note" }, "A workspace owner locked this name and logo."));
  }

  nameInput = h("input", { id: `${id}-name`, type: "text", maxlength: "60", autocomplete: "off", placeholder: connection.displayName || connection.name || "Agent", value: current?.ownerName || current?.name || "", oninput: renderPreview, "aria-describedby": `${id}-feedback` });
  const file = h("input", { id: `${id}-file`, type: "file", accept: "image/png,image/jpeg,image/webp", class: "ds-sr-only", onchange: async () => {
    const chosen = file.files?.[0]; file.value = "";
    if (!chosen) return;
    feedback.hidden = true;
    try { logo = await convertProfilePhoto(chosen); renderPreview(); }
    catch (error) { feedback.textContent = error instanceof Error ? error.message : "This image could not be opened."; feedback.hidden = false; }
  } });
  const upload = h("label", { class: "ds-button small", for: `${id}-file`, tabindex: "0", onkeydown: event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); file.click(); } } }, current?.logo ? "Replace logo" : "Upload logo");
  const removeLogo = h("button", { type: "button", class: "text small", hidden: !current?.logo, onclick: () => { logo = null; removeLogo.hidden = true; renderPreview(); } }, "Remove logo");
  const lock = h("input", { id: `${id}-lock`, type: "checkbox", class: "ds-switch", role: "switch", checked: Boolean(current?.locked), "aria-describedby": `${id}-lock-note` });

  const run = async (button, label, body) => {
    if (busy) return;
    busy = true; feedback.hidden = true;
    const original = button.textContent; button.textContent = label; button.disabled = true;
    try {
      const result = await save({ id: connection.id, ...body });
      if (!result?.identity) throw new Error("The change could not be confirmed. Refresh Connections and try again.");
      onSaved(result.identity);
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : "The change could not be saved.";
      feedback.hidden = false;
    } finally { busy = false; button.textContent = original; button.disabled = false; }
  };
  const saveButton = h("button", { type: "button", class: "ds-button small", "data-variant": "primary", onclick: () => {
    const name = nameInput.value.trim();
    const body = { locked: lock.checked };
    if (name !== (current?.ownerName || current?.name || "")) body.name = name;
    if (logo !== undefined) body.logo = logo ?? "";
    run(saveButton, "Saving…", body);
  } }, "Save");
  const resetButton = h("button", { type: "button", class: "ds-button small", disabled: !current?.source, onclick: () => run(resetButton, "Resetting…", { reset: true }) }, "Reset to detected");

  renderPreview();
  return h("section", { class: "agent-identity stack", "aria-label": "Name and logo" },
    h("div", { class: "agent-identity-head" }, h("h3", {}, "Name and logo"), current?.source && pill(current.source === "owner" ? "Set by owner" : "Self-described")),
    preview, reported,
    h("label", { class: "ds-field", for: `${id}-name` }, "Display name", nameInput),
    h("div", { class: "ds-toolbar" }, upload, file, removeLogo),
    h("p", { class: "detail-note" }, "Square logos work best. JPG, PNG or WebP, up to 5 MB; Engram stores a small PNG."),
    h("label", { class: "agent-identity-lock", for: `${id}-lock` }, lock, h("span", {}, h("strong", {}, "Lock name and logo"), h("span", { id: `${id}-lock-note`, class: "detail-note" }, "The agent can no longer change them."))),
    feedback,
    h("div", { class: "ds-toolbar" }, saveButton, resetButton));
}
