import { h } from "./profile.js";
import { icon } from "./icons.js";
import { onboardingAgents, onboardingProgress, onboardingWriteGuidance, agentConnectionGuide, connectionCheckPrompt, firstMemoryPrompt, recallMemoryPrompt } from "./onboarding-model.js";
import { workspaceNameForm } from "./workspace-name.js";

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
  const stage = h("div", { class: "setup-stage" });
  if (progress.done) stage.append(...[
    h("h3", {}, "Your shared memory is taking shape."),
    h("p", {}, "An agent connected, saved memory, and read memory in this workspace. Open your memory to see what was saved, and check what your agent returned."),
    h("div", { class: "setup-actions" }, h("a", { href: "#memory", class: "button primary" }, "Open Memory"), h("a", { href: "#activity", class: "button" }, "View Activity")),
    h("div", { class: "setup-next" }, h("strong", {}, "Next, see the work behind the results."), h("p", {}, progress.checks.taskReported ? "This workspace has also received an agent task report." : "Task progress appears when an agent reports real work. Set this up when you're ready."), button("Set up task reporting", onReporting, { class: "text small", "data-setup-focus": "reporting" })),
  ].filter(Boolean));
  else if (progress.step === "connect") stage.append(...[
    h("h3", {}, "Where will you use Engram?"),
    h("p", {}, "Connect one agent now. You can add the others later."),
    h("label", { class: "field", for: "setup-agent" }, "Agent", choice),
    connection && (connection.oauth
      ? h("div", { class: "setup-connection" }, h("p", {}, `In ${connection.label}, add a custom MCP connector with this endpoint, then sign in to your Engram workspace.`), h("pre", { tabindex: "0", "aria-label": "MCP endpoint" }, connection.endpoint), copyControl("Copy endpoint", connection.endpoint, { "data-setup-focus": "endpoint" }), h("p", { class: "setup-note" }, "Connector sign-in needs OAuth enabled on this installation. If it isn't available, ask your operator or choose a client that accepts an access key."))
      : h("div", { class: "setup-connection" },
        h("p", {}, connection.command ? "Create an access key, then run this command in your terminal. Paste the key when the hidden prompt asks for it." : "Create an access key, then add this endpoint and its bearer token in your client's MCP settings."),
        button("Create an access key", () => onCreateKey(agentId), { class: "primary small", "data-setup-focus": "create-key" }),
        h("pre", { tabindex: "0", "aria-label": connection.command ? "Setup command without an access key" : "MCP endpoint" }, connection.command || connection.endpoint),
        copyControl(connection.command ? "Copy setup command" : "Copy endpoint", connection.command || connection.endpoint, { "data-setup-focus": "command" }),
        connection.command && h("p", { class: "setup-note" }, "Requires Node.js 18 or newer. Restart or reload the agent's MCP connection after setup."))),
    connection && h("div", { class: "setup-prompt" }, h("strong", {}, "Then check from the agent"), h("p", {}, "Ask it to call Engram’s whoami tool. A saved key or sign-in alone does not complete this step."), copyControl(promptLabel, prompt, { "data-setup-focus": "prompt" })),
  ].filter(Boolean));
  else stage.append(...[
    h("h3", {}, progress.step === "remember" ? "Give your next task some context." : "Bring that context back."),
    h("p", {}, progress.step === "remember" ? "Ask your connected agent to save one real decision or preference from work you're doing together." : "Ask the agent to recall the decision or preference you saved. You can also try this from a second connected agent."),
    progress.step === "remember" && h("p", { class: writeGuidance.state === "check-permissions" ? "detail-note" : "notice", role: "status" }, writeGuidance.message, " ", h("a", { href: writeGuidance.href }, writeGuidance.link)),
    h("div", { class: "setup-prompt" }, h("p", {}, prompt), copyControl(promptLabel, prompt, { class: "primary small", "data-setup-focus": "prompt" })),
  ].filter(Boolean));
  return h("section", { class: "setup-guide", "aria-labelledby": "setup-title", "aria-busy": String(Boolean(checking)) },
    h("div", { class: "setup-heading" }, h("div", {}, h("span", { class: "eyebrow" }, demo ? "LOCAL PREVIEW · SIMULATED PROGRESS" : "GET STARTED"), h("h2", { id: "setup-title", tabindex: "-1", "data-setup-focus": "title" }, "Memory your agents can use.")), button("Do this later", onDismiss, { class: "text small", "data-setup-focus": "dismiss" })),
    workspaceNameForm({ session, editor: nameEditor }),
    h("ol", { class: "setup-steps", "aria-label": "Getting started progress" }, steps.map(([key, label], index) => h("li", { class: progress.checks[key] ? "complete" : progress.step === ["connect", "remember", "recall"][index] ? "current" : "", "aria-current": progress.step === ["connect", "remember", "recall"][index] ? "step" : null }, h("span", { class: "setup-step-symbol", "aria-hidden": "true" }, progress.checks[key] ? icon("check", { size: 13 }) : String(index + 1)), h("span", {}, label), h("span", { class: "sr-only" }, progress.checks[key] ? ": complete" : ": pending")))),
    !progress.available && h("p", { class: "notice", role: "status" }, "Progress hasn't been checked yet. You can follow the steps below, then check again."),
    stage,
    h("div", { class: "setup-check" }, button([icon("refresh-cw", { size: 14 }), checking ? "Checking…" : "Check progress"], () => { if (!checking) onCheck(); }, { class: "small", "aria-disabled": String(Boolean(checking)), "data-setup-focus": "check" }), h("p", { role: error ? "alert" : "status", "aria-live": "polite" }, error || (checking ? "Checking activity received by this workspace…" : progress.done ? "All three steps have successful agent calls." : "Steps update after Engram receives successful agent calls. Copying a prompt does not complete a step."))),
  );
}
