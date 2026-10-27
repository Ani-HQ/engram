import { h } from "./profile.js";
import { onboardingAgents, agentConnectionGuide, accessKeyConfiguration, connectionSetupPrompt } from "./onboarding-model.js";
import { agentSources } from "./tooling.js";

const catalog = new Map(onboardingAgents.map(agent => [agent.id, agent]));
for (const [id, label] of agentSources) if (!catalog.has(id)) catalog.set(id, { id, label });
export const connectionAgents = Object.freeze([...catalog.values()].filter(agent => agent.id !== "other").concat(catalog.get("other")));

// Setup help is optional display state. It never supplies the credential's
// source; the owner pins API work to the workspace and handles one-time keys.
export function connectionSetupView({ endpoint, workspace, draft = {}, helpAgentId = "", keyExpanded = false, helpExpanded = false, busy = false, error = "", onHelpChoose, onKeyToggle, onHelpToggle, onDraft, onSubmit, onDone, copyControl } = {}) {
  const view = h("div", { class: "connection-setup ds-stack", "aria-busy": String(busy) },
    h("div", { class: "ds-heading-group" }, h("h2", { id: "detail-title" }, "Connect an agent"),
      h("p", { class: "ds-hint" }, "Copy this setup prompt into your agent to connect it to Engram.")));
  // Reuse endpoint validation without selecting a product or generating an
  // installer command. Invalid endpoints cannot be copied or receive a key.
  const connection = agentConnectionGuide("other", endpoint);
  const prompt = connectionSetupPrompt(endpoint, workspace);
  if (!connection || !prompt) {
    view.append(h("p", { class: "ds-notice", "data-tone": "warning", role: "status" }, "Connection instructions are unavailable. Refresh Connections to check the workspace endpoint."));
    return view;
  }
  view.append(h("div", { class: "connection-setup-endpoint ds-stack" },
    h("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "MCP endpoint. Scroll horizontally to read." }, connection.endpoint),
    h("div", { class: "ds-row" },
      copyControl?.("Copy setup prompt", prompt, { class: "primary small", "data-connection-focus": "prompt" }),
      copyControl?.("Copy endpoint", connection.endpoint, { class: "small", "data-connection-focus": "endpoint" })),
    h("details", { class: "connection-setup-disclosure" },
      h("summary", { "data-connection-focus": "prompt-toggle" }, "Review setup prompt"),
      h("div", { class: "ds-stack" }, h("pre", { tabindex: "0", role: "region", "aria-label": "Connection setup prompt" }, prompt))),
    h("p", { class: "ds-hint" }, "Sign-in is available when your client and this Engram installation support OAuth."),
    h("p", { class: "ds-notice" }, h("strong", {}, "If your client asks for a bearer token, create an access key below."))));

  const name = h("input", {
    type: "text", name: "agent-name", required: true, maxlength: 100, autocomplete: "off", spellcheck: "false", autocapitalize: "none",
    placeholder: "e.g. work-laptop", readonly: busy, "data-connection-focus": "name",
    "aria-describedby": `connection-key-note${error ? " connection-create-feedback" : ""}`,
  });
  name.value = draft.name || "";
  const permission = h("select", { name: "permission", disabled: busy, "data-connection-focus": "permission", "aria-describedby": "connection-permission-note" },
    h("option", { value: "read" }, "Read only"), h("option", { value: "write" }, "Read and write"));
  permission.value = draft.canWrite === false ? "read" : "write";
  const input = () => ({ name: name.value, canWrite: permission.value === "write" });
  name.addEventListener("input", () => { if (!busy) onDraft?.(input()); });
  permission.addEventListener("change", () => { if (!busy) onDraft?.(input()); });
  const form = h("form", { class: "connection-create-form ds-stack", "aria-busy": String(busy), onsubmit: event => {
    event.preventDefault();
    if (busy || (typeof form.reportValidity === "function" && !form.reportValidity())) return;
    onSubmit?.(input());
  } },
  h("label", { class: "field" }, "Connection name", name),
  h("p", { id: "connection-key-note", class: "ds-hint" }, "Use a name that helps you recognize this connection or computer."),
  h("label", { class: "field" }, "Permission", permission),
  h("p", { id: "connection-permission-note", class: "ds-hint" }, "Read and write allows this connection to save memory and report work. Workspace policy and hosted plan access also apply."),
  h("div", { class: "ds-row" }, h("button", { type: "submit", class: "primary small", disabled: busy, "data-connection-focus": "submit" }, busy ? "Creating access key…" : "Create access key")));
  view.append(h("details", { class: "connection-setup-disclosure", open: Boolean(keyExpanded || busy || error), ontoggle: event => {
    if (event.currentTarget.isConnected !== false) onKeyToggle?.(event.currentTarget.open);
  } },
    h("summary", { "data-connection-focus": "key-toggle" }, "Need an access key?"),
    h("div", { class: "ds-stack" },
      error && h("p", { id: "connection-create-feedback", class: "ds-notice", "data-tone": "danger", role: "alert" }, error),
      busy && h("p", { class: "ds-hint", role: "status" }, h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Creating access key…"),
      form)));

  const agent = connectionAgents.find(item => item.id === helpAgentId);
  const choice = h("select", {
    id: "connection-help-agent", disabled: busy, "data-connection-focus": "help", "aria-describedby": "connection-help-note",
    onchange: event => { if (!busy) onHelpChoose?.(event.target.value); },
  }, h("option", { value: "" }, "Choose an agent (optional)"), connectionAgents.map(agent => h("option", { value: agent.id }, agent.label)));
  choice.value = agent ? helpAgentId : "";
  const help = h("div", { class: "ds-stack" },
    h("p", { id: "connection-help-note", class: "ds-hint" }, "Choose an agent for setup instructions. This choice does not label the connection."),
    h("label", { class: "field", for: "connection-help-agent" }, "Agent for setup help", choice));
  if (agent?.oauth) {
    help.append(h("p", { class: "ds-hint" }, `In ${agent.label}, add Engram as a custom MCP connector with the endpoint above, then sign in to your Engram workspace when prompted.`));
  } else if (agent) {
    help.append(h("p", { class: "ds-hint" }, `In ${agent.label}, use the endpoint above and an Engram access key as the bearer token.`),
      h("p", { class: "ds-hint" }, "Configuration example. Replace <access-token> with your key. Configuration file formats vary by client."),
      h("pre", { tabindex: "0", role: "region", "aria-label": `${agent.label} MCP configuration example` }, accessKeyConfiguration(agent.id, connection.endpoint)));
  }
  view.append(h("details", { class: "connection-setup-disclosure", open: helpExpanded, ontoggle: event => {
    if (event.currentTarget.isConnected !== false) onHelpToggle?.(event.currentTarget.open);
  } },
    h("summary", { "data-connection-focus": "help-toggle" }, "Agent-specific setup help"), help));
  view.append(h("div", { class: "ds-stack" },
    h("p", { class: "ds-hint" }, "After your agent connects, refresh Connections to see its client name when available."),
    onDone && h("div", { class: "ds-row" }, h("button", { type: "button", class: "small", onclick: () => { if (!busy) onDone(); }, disabled: busy, "data-connection-focus": "refresh" }, "Refresh connections"))));
  return view;
}
