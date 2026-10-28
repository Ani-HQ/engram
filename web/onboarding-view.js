import { h } from "./profile.js";
import { onboardingAgents, onboardingProgress, onboardingWriteGuidance, agentConnectionGuide, connectionCheckPrompt, firstMemoryPrompt, recallMemoryPrompt } from "./onboarding-model.js";
import { workspaceNameForm } from "./workspace-name.js";
import { memorySetupGuide } from "./memory-usage-view.js";

const button = (label, action, attrs = {}) => h("button", { type: "button", onclick: action, ...attrs }, label);

export function onboardingGuide({ data, agentId = "", mcp, checking, error, policies, inventory, session, nameEditor, demo = false, disclosures = {}, onDisclosureChange = () => {}, onChoose, onCheck, onDismiss, onCreateKey, copyControl }) {
  const progress = onboardingProgress(data);
  const connection = agentConnectionGuide(agentId, mcp);
  const steps = [["agentConnected", "Connect an agent"], ["memorySaved", "Save a memory"], ["memoryRecalled", "Recall it"]];
  const checkCount = progress.available ? `${progress.completed} of ${steps.length} checks received` : "Not checked yet";
  const titles = { connect: "Connect your first agent.", remember: "Save your first memory.", recall: "Recall your first memory.", done: "Your workspace has memory." };
  const descriptions = {
    connect: "Give your agents a shared place to save decisions and pick them up in another session.",
    remember: "Ask a connected agent to save one useful decision or preference from your current work.",
    recall: "Ask your agent to bring back the decision or preference you saved. You can also try another connected agent.",
    done: "Engram has received successful connection, save and recall calls in this workspace.",
  };
  const disclosure = (key, label, content, open = false) => h("details", {
    class: "setup-secondary", open: disclosures[key] ?? open,
    ontoggle: event => onDisclosureChange(key, event.currentTarget.open),
  }, h("summary", { "data-setup-focus": key }, label), content);

  function agentSetup() {
    const choice = h("select", { id: "setup-agent", "data-setup-focus": "agent", onchange: event => onChoose(event.target.value) },
      h("option", { value: "" }, "Choose your agent"), onboardingAgents.map(agent => h("option", { value: agent.id }, agent.label)));
    choice.value = agentId;
    const content = h("div", { class: "setup-agent-content ds-stack" },
      h("p", { class: "ds-hint" }, "Choose the agent you want to connect. Each agent has its own setup instructions."),
      h("label", { class: "field", for: "setup-agent" }, "Agent", choice));
    if (!connection) {
      if (agentId) content.append(h("p", { class: "ds-notice", "data-tone": "warning", role: "status" }, "The setup instructions are unavailable. Refresh this page or review Connections for the workspace endpoint."));
      return content;
    }
    if (!connection.command) content.append(h("div", { class: "setup-connection ds-stack" },
      h("p", { class: "ds-hint" }, connection.oauth
        ? `In ${connection.label}, add a custom MCP connector with this endpoint, then sign in to your Engram workspace.`
        : `In ${connection.label}, add this endpoint in its MCP connection settings. Create an access key if it asks for a bearer token.`),
      h("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "MCP endpoint. Scroll horizontally to read." }, connection.endpoint),
      h("div", { class: "ds-row setup-actions" }, copyControl("Copy endpoint", connection.endpoint, { "data-setup-focus": "endpoint" }),
        !connection.oauth && button("Create an access key", () => onCreateKey(agentId), { "data-setup-focus": "create-key" })),
      connection.oauth && h("p", { class: "ds-hint" }, "Connector sign-in requires OAuth to be enabled on this Engram installation.")));
    const workflow = memorySetupGuide({ harness: connection.harness || connection.id, kind: connection.oauth ? "oauth" : "token" }, {
      endpoint: connection.endpoint, open: Boolean(connection.command),
      copyControl: (value, label) => copyControl(label, value, { "data-setup-focus": "command" }),
      onCreateKey: connection.command ? () => onCreateKey(agentId) : undefined,
    });
    const retainDisclosures = (node, key) => {
      if (node.tagName === "DETAILS") {
        if (typeof disclosures[key] === "boolean") node.toggleAttribute("open", disclosures[key]);
        node.children[0]?.setAttribute("data-setup-focus", key);
        node.addEventListener("toggle", event => { if (event.target === node) onDisclosureChange(key, node.open); });
      }
      Array.from(node.children).forEach((child, index) => retainDisclosures(child, `${key}-${index}`));
    };
    retainDisclosures(workflow, `workflow-${agentId}`);
    // A local guided command establishes the connection as well as its workflow.
    if (connection.command) content.append(workflow);
    content.append(h("div", { class: "setup-prompt ds-stack" },
      h("h3", {}, "Check the connection from your agent"),
      h("p", { class: "ds-hint" }, "After connecting, send this prompt to your agent. Engram checks for a successful tool call; a saved key or sign-in alone does not confirm contact."),
      copyControl("Copy connection check", connectionCheckPrompt, { class: progress.step === "connect" ? "primary" : "", "data-setup-focus": "connection-prompt" })));
    if (!connection.command) content.append(workflow);
    return content;
  }

  const stage = h("div", { class: "setup-stage ds-stack" });
  if (progress.done) stage.append(
    h("div", { class: "ds-row setup-actions" }, h("a", { href: "#memory", class: "button primary" }, "Open Memory"), h("a", { href: "#activity", class: "button" }, "View Activity")),
    h("p", { class: "ds-hint" }, "These workspace checks may come from different agents. They do not confirm that every agent has a workflow installed. ", h("a", { href: "#connect", class: "ds-touch-target" }, "Review connections")),
  );
  else if (progress.step === "connect") stage.append(agentSetup());
  else {
    const saving = progress.step === "remember";
    const guidance = onboardingWriteGuidance({ policies, agentId, inventory });
    stage.append(...[
      h("p", { class: "setup-prompt setup-prompt-text" }, saving ? firstMemoryPrompt : recallMemoryPrompt),
      saving && h("p", { class: guidance.state === "check-permissions" ? "ds-hint" : "ds-notice", "data-tone": guidance.state === "check-permissions" ? null : "warning", role: "status" }, guidance.message, " ", h("a", { href: guidance.href }, guidance.link)),
      h("div", { class: "ds-row setup-actions" }, copyControl(saving ? "Copy save prompt" : "Copy recall prompt", saving ? firstMemoryPrompt : recallMemoryPrompt, { class: "primary", "data-setup-focus": "prompt" })),
    ].filter(Boolean));
  }
  const nameForm = workspaceNameForm({ session, editor: nameEditor });
  const nameState = nameEditor?.state;
  return h("section", { class: "setup-guide", "aria-labelledby": "setup-title", "aria-busy": String(Boolean(checking)) },
    h("div", { class: "setup-heading" }, h("div", { class: "ds-heading-group" },
      demo && h("p", { class: "ds-hint setup-demo-note" }, "Local preview. Progress is simulated."),
      h("h2", { id: "setup-title", tabindex: "-1", "data-setup-focus": "title" }, titles[progress.step]),
      h("p", { class: "ds-hint" }, descriptions[progress.step])),
      button(progress.done ? "Close setup" : "Do this later", onDismiss, { class: "text", "data-setup-focus": "dismiss" })),
    !progress.done && h("div", { class: "setup-progress ds-stack" },
      h("p", { class: "ds-hint ds-tabular" }, "Workspace checks: ", checkCount),
      h("ol", { class: "setup-steps", "aria-label": "Getting started progress" }, steps.map(([key, label], index) => h("li", {
        "aria-current": progress.step === ["connect", "remember", "recall"][index] ? "step" : null, "data-complete": String(Boolean(progress.checks[key])),
      }, h("span", {}, label), h("span", { class: "setup-step-state" }, progress.checks[key] ? " · Done" : ""), h("span", { class: "sr-only" }, progress.checks[key] ? ": complete" : ": pending"))))),
    !progress.available && h("p", { class: "ds-hint", role: "status" }, checking ? "Checking successful agent calls received by this workspace." : "Workspace checks are unavailable. You can follow the setup instructions, then check again."),
    stage,
    h("div", { class: "setup-check" },
      button([checking && h("span", { class: "ds-spinner", "aria-hidden": "true" }), checking ? "Checking…" : "Check progress"], () => { if (!checking) onCheck(); }, { "aria-busy": String(Boolean(checking)), "aria-disabled": String(Boolean(checking)), "aria-describedby": "setup-check-feedback", "data-setup-focus": "check" }),
      h("p", { id: "setup-check-feedback", class: "ds-hint", role: error ? "alert" : "status", "aria-live": "polite" }, error || (checking ? "Checking activity received by this workspace…" : progress.done ? "All three workspace checks have successful agent calls." : progress.step === "connect" && !connection ? "Choose an agent to see connection instructions." : "After your agent runs the prompt, check progress here. Only successful agent calls complete a step."))),
    (progress.step !== "connect" || nameForm) && h("div", { class: "setup-options ds-stack" },
      progress.step !== "connect" && disclosure(progress.done ? "completedAgent" : "agentHelp", progress.done ? "Add or repair an agent" : "Agent connection help", agentSetup()),
      nameForm && disclosure("workspaceName", "Workspace name (optional)", nameForm, Boolean(nameState?.busy || nameState?.error || nameState?.feedback || nameState?.draft !== nameState?.name))),
  );
}
