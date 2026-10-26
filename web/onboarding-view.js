import { h } from "./profile.js";
import { icon } from "./icons.js";
import { onboardingAgents, onboardingProgress, onboardingWriteGuidance, agentConnectionGuide, connectionCheckPrompt, firstMemoryPrompt, recallMemoryPrompt } from "./onboarding-model.js";
import { workspaceNameForm } from "./workspace-name.js";
import { statusBadge, progressBar } from "./design-system.js";
import { memorySetupGuide } from "./memory-usage-view.js";

const button = (label, action, attrs = {}) => h("button", { type: "button", onclick: action, ...attrs }, label);

export function onboardingGuide({ data, agentId = "", mcp, checking, error, policies, inventory, session, nameEditor, demo = false, onChoose, onCheck, onDismiss, onCreateKey, onReporting, copyControl }) {
  const progress = onboardingProgress(data);
  const writeGuidance = onboardingWriteGuidance({ policies, agentId, inventory });
  const connection = agentConnectionGuide(agentId, mcp);
  const choice = h("select", { id: "setup-agent", "data-setup-focus": "agent", onchange: event => onChoose(event.target.value) },
    h("option", { value: "" }, "Choose your agent"), onboardingAgents.map(agent => h("option", { value: agent.id }, agent.label)));
  choice.value = agentId;
  const prompt = progress.step === "connect" ? connectionCheckPrompt : progress.step === "remember" ? firstMemoryPrompt : recallMemoryPrompt;
  const promptLabel = progress.step === "connect" ? "Copy connection check" : progress.step === "remember" ? "Copy save prompt" : "Copy recall prompt";
  const steps = [["agentConnected", "Connect an agent"], ["memorySaved", "Save something useful"], ["memoryRecalled", "Read memory from your agent"]];
  const checkCount = progress.available ? `${progress.completed} of ${steps.length} checks observed` : "Not checked yet";
  const measuredProgress = progress.available
    ? progressBar({ label: "Workspace setup checks", value: progress.completed, max: steps.length, valueText: checkCount })
    : checking ? progressBar({ label: "Checking workspace setup", valueText: "Waiting for the first check results." }) : null;
  const stage = h("div", { class: "setup-stage" });
  stage.append(h("h3", {}, "Which agent are you using?"),
    h("p", {}, "Set up a new agent or update an existing one. The guided installer handles its Engram files."),
    h("label", { class: "field", for: "setup-agent" }, "Agent", choice));
  if (connection) {
    if (connection.oauth) stage.append(h("div", { class: "setup-connection" }, h("p", {}, `In ${connection.label}, add a custom MCP connector with this endpoint, then sign in to your Engram workspace.`), h("pre", { tabindex: "0", "aria-label": "MCP endpoint" }, connection.endpoint), copyControl("Copy endpoint", connection.endpoint, { "data-setup-focus": "endpoint" }), h("p", { class: "setup-note" }, "Connector sign-in needs OAuth enabled on this installation. The provider controls persistent instructions and hooks; a local installer cannot enable them in a cloud session.")));
    else if (!connection.command) stage.append(h("div", { class: "setup-connection" }, h("p", {}, "Use this endpoint in the provider’s MCP connection screen. Create a dedicated key if it asks for a bearer token."), h("pre", { tabindex: "0", "aria-label": "MCP endpoint" }, connection.endpoint), copyControl("Copy endpoint", connection.endpoint, { "data-setup-focus": "endpoint" }), button("Create an access key", () => onCreateKey(agentId), { class: "small", "data-setup-focus": "create-key" })));
    stage.append(memorySetupGuide({ harness: connection.harness || connection.id, kind: connection.oauth ? 'oauth' : 'token' }, {
      endpoint: connection.endpoint, open: true,
      copyControl: (value, label) => copyControl(label, value, { "data-setup-focus": "command" }),
      onCreateKey: connection.command ? () => onCreateKey(agentId) : undefined,
    }));
  }
  if (progress.done) stage.append(...[
    h("div", { class: "setup-next" }, h("strong", {}, "Memory calls confirmed."),
    h("p", {}, "An agent connected, saved memory, and read memory in this workspace. These receipts do not confirm that every agent has a workflow installed.")),
    h("div", { class: "setup-actions" }, h("a", { href: "#memory", class: "button primary" }, "Open Memory"), h("a", { href: "#activity", class: "button" }, "View Activity")),
    h("div", { class: "setup-next" }, h("strong", {}, "Check each connection."), h("p", {}, "Connections separates access, memory receipts, and explicit workflow checks. Automatic use on every task is not independently verified."), h("a", { href: "#connect", class: "button small" }, "Review connections")),
  ].filter(Boolean));
  else if (progress.step === "connect") stage.append(...[
    connection && h("div", { class: "setup-prompt" }, h("strong", {}, "Then check from the agent"), h("p", {}, "Ask it to call Engram’s whoami tool. A saved key or sign-in alone does not complete this step."), copyControl(promptLabel, prompt, { "data-setup-focus": "prompt" })),
  ].filter(Boolean));
  else stage.append(...[
    h("div", { class: "setup-next" }, h("strong", {}, progress.step === "remember" ? "Give your next task some context." : "Bring that context back.")),
    h("p", {}, progress.step === "remember" ? "Ask your connected agent to save one real decision or preference from work you're doing together." : "Ask the agent to recall the decision or preference you saved. You can also try this from a second connected agent."),
    progress.step === "remember" && h("p", { class: writeGuidance.state === "check-permissions" ? "detail-note" : "notice", role: "status" }, writeGuidance.message, " ", h("a", { href: writeGuidance.href }, writeGuidance.link)),
    h("div", { class: "setup-prompt" }, h("p", {}, prompt), copyControl(promptLabel, prompt, { class: "primary small", "data-setup-focus": "prompt" })),
  ].filter(Boolean));
  return h("section", { class: "setup-guide ds-card", "aria-labelledby": "setup-title", "aria-busy": String(Boolean(checking)) },
    h("div", { class: "setup-heading" }, h("div", { class: "ds-heading-group" }, h("span", { class: "eyebrow ds-eyebrow" }, demo ? "LOCAL PREVIEW · SIMULATED PROGRESS" : "GUIDED AGENT SETUP"), h("h2", { id: "setup-title", tabindex: "-1", "data-setup-focus": "title" }, "Set up your agent."), h("div", { class: "ds-row" }, statusBadge(progress.done ? "Memory calls confirmed" : "Guided setup", { tone: progress.done ? "success" : "neutral" }))), button("Do this later", onDismiss, { class: "text small", "data-setup-focus": "dismiss" })),
    workspaceNameForm({ session, editor: nameEditor }),
    h("div", { class: "setup-progress" }, h("div", { class: "ds-toolbar" }, h("span", { class: "setup-progress-label" }, "Workspace setup"), h("span", { class: "setup-progress-count ds-tabular" }, checkCount)), measuredProgress),
    h("ol", { class: "setup-steps", "aria-label": "Getting started progress" }, steps.map(([key, label], index) => h("li", { class: progress.checks[key] ? "complete" : progress.step === ["connect", "remember", "recall"][index] ? "current" : "", "aria-current": progress.step === ["connect", "remember", "recall"][index] ? "step" : null }, h("span", { class: "setup-step-symbol", "aria-hidden": "true" }, progress.checks[key] ? icon("check", { size: 13 }) : String(index + 1)), h("span", {}, label), h("span", { class: "sr-only" }, progress.checks[key] ? ": complete" : ": pending")))),
    !progress.available && h("p", { class: "notice", role: "status" }, checking ? "Checking successful agent calls received by this workspace." : "No checks yet. Follow the steps below, then check progress."),
    stage,
    h("div", { class: "setup-check" }, button([checking ? h("span", { class: "ds-spinner", "aria-hidden": "true" }) : icon("refresh-cw", { size: 14 }), checking ? "Checking…" : "Check progress"], () => { if (!checking) onCheck(); }, { class: "small", "aria-busy": String(Boolean(checking)), "aria-disabled": String(Boolean(checking)), "aria-describedby": "setup-check-feedback", "data-setup-focus": "check" }), h("p", { id: "setup-check-feedback", role: error ? "alert" : "status", "aria-live": "polite" }, error || (checking ? "Checking activity received by this workspace…" : progress.done ? "All three steps have successful agent calls." : "Steps update after Engram receives successful agent calls. Copying a prompt does not complete a step."))),
  );
}
