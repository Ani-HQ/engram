import { h } from "./profile.js";
import { onboardingAgents, agentConnectionGuide } from "./onboarding-model.js";
import { agentSources } from "./tooling.js";

const catalog = new Map(onboardingAgents.map(agent => [agent.id, agent]));
for (const [id, label] of agentSources) if (!catalog.has(id)) catalog.set(id, { id, label });
export const connectionAgents = Object.freeze([...catalog.values()].filter(agent => agent.id !== "other").concat(catalog.get("other")));

// This view only collects connection details. Its owner pins API work to the
// workspace and dialog, retains drafts, and handles one-time credentials.
export function connectionSetupView({ agentId = "", endpoint, draft = {}, keyOnly = false, busy = false, error = "", onChoose, onDraft, onSubmit, onDone, copyControl } = {}) {
  const agent = connectionAgents.find(item => item.id === agentId);
  const guide = agentConnectionGuide(agentId, endpoint) || (agent && agentConnectionGuide("other", endpoint));
  const connection = guide && { ...guide, ...agent };
  const oauth = connection?.oauth && !keyOnly;
  const choice = h("select", {
    id: "connection-agent", disabled: busy, "data-connection-focus": "agent",
    "aria-describedby": "connection-agent-note",
    onchange: event => { if (!busy) onChoose?.(event.target.value); },
  }, h("option", { value: "" }, "Choose an agent"), connectionAgents.map(agent => h("option", { value: agent.id }, agent.label)));
  choice.value = agentId;
  const view = h("div", { class: "connection-setup ds-stack", "aria-busy": String(busy) },
    h("div", { class: "ds-heading-group" }, h("h2", { id: "detail-title" }, "Connect an agent"),
      h("p", { id: "connection-agent-note", class: "ds-hint" }, "Choose the agent you want to give access to this workspace.")),
    h("label", { class: "field", for: "connection-agent" }, "Agent", choice),
    error && h("p", { id: "connection-create-feedback", class: "ds-notice", "data-tone": "danger", role: "alert" }, error),
    busy && h("p", { class: "ds-hint", role: "status" }, h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Creating access key…"));
  if (!agentId) return view;
  if (!connection) {
    view.append(h("p", { class: "ds-notice", "data-tone": "warning", role: "status" }, "Connection instructions are unavailable. Refresh Connections to check the workspace endpoint."));
    return view;
  }
  view.append(h("div", { class: "connection-setup-endpoint ds-stack" },
    h("p", { class: "ds-hint" }, oauth
      ? `In ${connection.label}, add Engram as a custom MCP connector. Use this endpoint and sign in to your Engram workspace when prompted.`
      : `Create an access key for ${connection.label}, then add the endpoint and key in its MCP settings.`),
    h("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "MCP endpoint. Scroll horizontally to read." }, connection.endpoint),
    h("div", { class: "ds-row" }, copyControl?.("Copy endpoint", connection.endpoint, { class: oauth ? "primary" : "", "data-connection-focus": "endpoint" }))));
  if (oauth) {
    view.append(h("p", { class: "ds-hint" }, "Connector sign-in requires OAuth to be enabled on this Engram installation."));
    if (onDone) view.append(h("div", { class: "ds-row" }, h("button", { type: "button", onclick: () => { if (!busy) onDone(); }, disabled: busy, "data-connection-focus": "refresh" }, "Refresh connections")));
    return view;
  }
  const name = h("input", {
    type: "text", name: "agent-name", required: true, maxlength: 100, autocomplete: "off", spellcheck: "false", autocapitalize: "none",
    placeholder: "e.g. work-laptop", readonly: busy, "data-connection-focus": "name",
    "aria-describedby": `connection-key-note${error ? " connection-create-feedback" : ""}`,
  });
  name.value = draft.name || "";
  const permission = h("select", { name: "permission", disabled: busy, "data-connection-focus": "permission", "aria-describedby": "connection-permission-note" },
    h("option", { value: "read" }, "Read only"), h("option", { value: "write" }, "Read and write"));
  permission.value = draft.canWrite === false ? "read" : "write";
  const input = () => ({ name: name.value, harness: agentId, canWrite: permission.value === "write" });
  name.addEventListener("input", () => { if (!busy) onDraft?.(input()); });
  permission.addEventListener("change", () => { if (!busy) onDraft?.(input()); });
  const form = h("form", { class: "connection-create-form ds-stack", "aria-busy": String(busy), onsubmit: event => {
    event.preventDefault();
    if (busy || (typeof form.reportValidity === "function" && !form.reportValidity())) return;
    onSubmit?.(input());
  } },
  h("label", { class: "field" }, "Connection name", name),
  h("p", { id: "connection-key-note", class: "ds-hint" }, "Use a name that helps you recognize this agent or computer in Connections."),
  h("label", { class: "field" }, "Permission", permission),
  h("p", { id: "connection-permission-note", class: "ds-hint" }, "Read and write allows this connection to save memory and report work. Workspace policy and hosted plan access also apply."),
  h("div", { class: "ds-row" }, h("button", { type: "submit", class: "primary", disabled: busy, "data-connection-focus": "submit" }, busy ? "Creating access key…" : "Create access key")));
  view.append(form);
  return view;
}
