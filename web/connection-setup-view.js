import { h } from "./profile.js";
import { onboardingAgents, agentConnectionGuide, accessKeyConfiguration, connectionSetupPrompt } from "./onboarding-model.js";
import { agentSources, agentVisual, visualIcon } from "./tooling.js";
import { identityMark } from "./design-system.js";
import { icon } from "./icons.js";

const catalog = new Map(onboardingAgents.map(agent => [agent.id, agent]));
for (const [id, label] of agentSources) if (!catalog.has(id)) catalog.set(id, { id, label });
export const connectionAgents = Object.freeze([...catalog.values()].filter(agent => agent.id !== "other").concat(catalog.get("other")));

// A product mark is a display hint for the tab, never a claim about the client.
function clientMark(agent) {
  if (!agent) return identityMark(icon("sparkles", { size: 13 }), { size: "xs" });
  if (agent.id === "other") return identityMark(icon("plug", { size: 13 }), { size: "xs" });
  let visual = agentVisual(agent.label, { harness: agent.id });
  if (!visual.brand) visual = agentVisual(agent.label);
  return identityMark(visual.brand ? visualIcon(visual, { size: 13 }) : icon("bot", { size: 13 }), { size: "xs" });
}
const step = (title, ...body) => h("li", {}, h("h3", {}, title), ...body);

// Setup help is optional display state. It never supplies the credential's
// source; the owner pins API work to the workspace and handles one-time keys.
export function connectionSetupView({ endpoint, workspace, draft = {}, helpAgentId = "", keyExpanded = false, busy = false, error = "", onHelpChoose, onKeyToggle, onDraft, onSubmit, onDone, copyControl } = {}) {
  const view = h("div", { class: "connection-setup ds-stack", "aria-busy": String(busy) },
    h("div", { class: "ds-heading-group" }, h("h2", { id: "detail-title" }, "Connect an agent"),
      h("p", { class: "ds-hint" }, "Copy this setup prompt into your agent to connect it to Engram, or pick your client for its own steps.")));
  // Reuse endpoint validation without selecting a product or generating an
  // installer command. Invalid endpoints cannot be copied or receive a key.
  const connection = agentConnectionGuide("other", endpoint);
  const prompt = connectionSetupPrompt(endpoint, workspace);
  if (!connection || !prompt) {
    view.append(h("p", { class: "ds-notice", "data-tone": "warning", role: "status" }, "Connection instructions are unavailable. Refresh Connections to check the workspace endpoint."));
    return view;
  }

  // Client tabs. "Any agent" is the generic setup prompt; a client tab shows
  // that client's steps. Choosing a tab does not label the connection.
  const agent = connectionAgents.find(item => item.id === helpAgentId);
  const selected = agent ? agent.id : "";
  const tabs = [{ id: "", label: "Any agent" }, ...connectionAgents];
  const choose = id => { if (!busy && id !== selected) onHelpChoose?.(id); };
  const tablist = h("div", { class: "ds-window-tabs connection-tabs", role: "tablist", "aria-label": "Setup steps for", onkeydown: event => {
    const index = tabs.findIndex(item => item.id === selected);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined || busy) return;
    event.preventDefault();
    choose(tabs[(next + tabs.length) % tabs.length].id);
  } }, tabs.map(item => {
    const current = item.id === selected;
    return h("button", {
      type: "button", role: "tab", class: "ds-client-tab", id: `connection-tab-${item.id || "any"}`, "aria-selected": String(current), "aria-controls": "connection-tab-panel",
      tabindex: current ? "0" : "-1", disabled: busy, "data-connection-focus": current ? "help" : `help-${item.id || "any"}`, onclick: () => choose(item.id),
    }, clientMark(item.id ? item : null), h("span", {}, item.label));
  }));

  const endpointBlock = (primary = false) => h("div", { class: "ds-command connection-endpoint" },
    h("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "MCP endpoint. Scroll horizontally to read." }, connection.endpoint),
    copyControl?.("Copy endpoint", connection.endpoint, { class: primary ? "primary small" : "small", "data-connection-focus": "endpoint" }));
  const steps = h("ol", { class: "ds-steps" });
  if (!agent) {
    steps.append(
      step("Copy the setup prompt",
        h("p", {}, "It holds this workspace’s endpoint and tells your agent how to connect safely."),
        h("div", { class: "connection-setup-endpoint ds-stack" }, endpointBlock(),
          h("div", { class: "ds-row" }, copyControl?.("Copy setup prompt", prompt, { class: "primary small", "data-connection-focus": "prompt" })),
          h("details", { class: "connection-setup-disclosure" },
            h("summary", { "data-connection-focus": "prompt-toggle" }, "Review setup prompt"),
            h("pre", { tabindex: "0", role: "region", "aria-label": "Connection setup prompt" }, prompt)))),
      step("Paste it into your agent", h("p", {}, "Sign-in is available when your client and this Engram installation support OAuth.")),
      step("Need a bearer token?", h("p", {}, "If your client asks for a bearer token, create an access key below.")));
  } else if (agent.oauth) {
    steps.append(
      step("Copy the endpoint", endpointBlock(true)),
      step(`Add a connector in ${agent.label}`, h("p", {}, `In ${agent.label}, add Engram as a custom MCP connector with the endpoint above, then sign in to your Engram workspace when prompted.`)),
      step("Sign in", h("p", {}, "Sign-in is available when your client and this Engram installation support OAuth. If it doesn’t, use an access key below.")));
  } else {
    steps.append(
      step("Create an access key", h("p", {}, `In ${agent.label}, use the endpoint below and an Engram access key as the bearer token. Create the key below; it is shown once.`)),
      step("Add the configuration",
        h("p", {}, "Configuration example. Replace <access-token> with your key. Configuration file formats vary by client."),
        h("pre", { tabindex: "0", role: "region", "aria-label": `${agent.label} MCP configuration example` }, accessKeyConfiguration(agent.id, connection.endpoint)),
        endpointBlock()),
      step("Reload the agent", h("p", {}, "Restart or reload its MCP connections so Engram’s tools appear.")));
  }
  // Keep the chosen client's tab in view once the dialog has laid out.
  if (selected && typeof requestAnimationFrame === "function") requestAnimationFrame(() => {
    const current = tablist.querySelector?.('[aria-selected="true"]');
    if (!current || !tablist.isConnected) return;
    const left = current.offsetLeft - tablist.offsetLeft, right = left + current.offsetWidth;
    if (left < tablist.scrollLeft || right > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = Math.max(0, left - 24);
  });
  view.append(h("div", { class: "ds-window connection-window" }, tablist,
    h("div", { class: "ds-window-panel", id: "connection-tab-panel", role: "tabpanel", "aria-labelledby": `connection-tab-${selected || "any"}` }, steps)));

  const name = h("input", {
    id: "connection-key-name", type: "text", name: "agent-name", required: true, maxlength: 100, autocomplete: "off", spellcheck: "false", autocapitalize: "none",
    placeholder: "e.g. work-laptop", readonly: busy, "data-connection-focus": "name",
    "aria-describedby": `connection-key-note${error ? " connection-create-feedback" : ""}`,
  });
  name.value = draft.name || "";
  const permission = h("select", { id: "connection-key-permission", name: "permission", disabled: busy, "data-connection-focus": "permission", "aria-describedby": "connection-permission-note" },
    h("option", { value: "read" }, "Read only"), h("option", { value: "write" }, "Read and write"));
  permission.value = draft.canWrite === false ? "read" : "write";
  const input = () => ({ name: name.value, canWrite: permission.value === "write" });
  name.addEventListener("input", () => { if (!busy) onDraft?.(input()); });
  permission.addEventListener("change", () => { if (!busy) onDraft?.(input()); });
  const form = h("form", { class: "connection-create-form ds-settings-card", "aria-busy": String(busy), onsubmit: event => {
    event.preventDefault();
    if (busy || (typeof form.reportValidity === "function" && !form.reportValidity())) return;
    onSubmit?.(input());
  } },
  h("div", { class: "ds-settings-row" },
    h("div", { class: "ds-settings-label" }, h("label", { for: "connection-key-name" }, "Connection name"), h("p", { id: "connection-key-note", class: "ds-settings-help" }, "Use a name that helps you recognize this connection or computer.")),
    h("div", { class: "ds-settings-control" }, name)),
  h("div", { class: "ds-settings-row" },
    h("div", { class: "ds-settings-label" }, h("label", { for: "connection-key-permission" }, "Permission"), h("p", { id: "connection-permission-note", class: "ds-settings-help" }, "Read and write allows this connection to save memory and report work. Workspace policy and hosted plan access also apply.")),
    h("div", { class: "ds-settings-control" }, permission)),
  h("div", { class: "ds-settings-foot" },
    h("p", { class: "ds-settings-note" }, "The key is shown once. Keep it out of shell history and screenshots."),
    h("button", { type: "submit", class: "primary small", disabled: busy, "aria-busy": String(busy), "data-connection-focus": "submit" }, busy ? [icon("loader-circle", { size: 14, class: "ds-spin" }), "Creating key…"] : "Create access key")));
  view.append(h("details", { class: "connection-setup-disclosure connection-key", open: Boolean(keyExpanded || busy || error), ontoggle: event => {
    if (event.currentTarget.isConnected !== false) onKeyToggle?.(event.currentTarget.open);
  } },
    h("summary", { "data-connection-focus": "key-toggle" }, icon("key-round", { size: 14 }), "Need an access key?"),
    h("div", { class: "ds-stack" },
      error && h("p", { id: "connection-create-feedback", class: "ds-notice", "data-tone": "danger", role: "alert" }, error),
      busy && h("p", { class: "ds-hint", role: "status" }, h("span", { class: "ds-spinner", "aria-hidden": "true" }), "Creating access key…"),
      form)));

  view.append(h("div", { class: "connection-setup-foot" },
    h("p", { class: "ds-hint" }, "After your agent connects, refresh Connections to see its client name when available."),
    onDone && h("button", { type: "button", class: "small", onclick: () => { if (!busy) onDone(); }, disabled: busy, "data-connection-focus": "refresh" }, icon("refresh-cw", { size: 14 }), "Refresh connections")));
  return view;
}
