import { h } from "./profile.js";
import { identityMark, loadingState } from "./design-system.js";
import { icon } from "./icons.js";
import { agentVisual, visualIcon } from "./tooling.js";
import { agentList, devicePresentation, formatUserCode, installCommand, requestedAgo } from "./device-model.js";

// Each state opens with an icon tile; its heading names the status in words.
const tile = (name, tone = "accent") => h("div", { class: "ds-result device-tile", "data-tone": tone, "aria-hidden": "true" },
  h("span", { class: "ds-result-tile" }, icon(name, { size: 22 })));
const title = (text, description) => h("div", { class: "ds-heading-group device-heading" },
  h("h1", { id: "device-title", tabindex: "-1" }, text), description && h("p", {}, description));

function commandBlock(origin, copyControl) {
  const command = installCommand(origin);
  return h("div", { class: "device-command ds-stack" },
    h("p", { class: "device-command-label" }, icon("terminal", { size: 14 }), "Run in a terminal on that computer"),
    h("div", { class: "ds-command" },
      h("code", { class: "ds-code-scroll", tabindex: "0", role: "region", "aria-label": "Setup command. Scroll horizontally to read." }, h("span", { class: "ds-term-prompt", "aria-hidden": "true" }, "$ "), command),
      copyControl?.("Copy", command, { "aria-label": "Copy setup command" })));
}

function codeEntry({ input = "", error = "", busy = false, onSubmit }) {
  const field = h("input", {
    id: "device-code", name: "device-code", type: "text", required: true, maxlength: 12, autocomplete: "one-time-code", autocapitalize: "characters",
    spellcheck: "false", placeholder: "BCDF-GHJK", value: input, "aria-describedby": error ? "device-code-hint device-code-error" : "device-code-hint",
    ...(error ? { "aria-invalid": "true" } : {}), readonly: busy,
  });
  field.value = input;
  const form = h("form", { class: "device-entry ds-stack", novalidate: true, onsubmit: event => { event.preventDefault(); if (!busy) onSubmit?.(field.value); } },
    h("label", { class: "ds-field", for: "device-code" }, "Code from your terminal", field),
    h("p", { class: "ds-hint", id: "device-code-hint" }, "Eight letters, like BCDF-GHJK. Capitals and the hyphen are optional."),
    error && h("p", { class: "ds-field-error", id: "device-code-error", role: "alert" }, error),
    h("button", { type: "submit", class: "primary device-submit", disabled: busy }, "Continue"));
  return form;
}

function agentsValue(agents = []) {
  return h("ul", { class: "device-agents", role: "list" }, agents.map(agent => {
    let visual = agentVisual(agent.label, { harness: agent.harness });
    if (!visual.brand) visual = agentVisual(agent.label);
    return h("li", {}, identityMark(visualIcon(visual, { size: 14 }), { size: "xs" }), h("span", {}, agent.label));
  }));
}

function workspaceValue({ workspace, workspaces = [], switching = false, onSwitchWorkspace }) {
  if (workspaces.length < 2) return h("span", {}, workspace?.name || "This workspace");
  const select = h("select", { id: "device-workspace", "aria-label": "Workspace for this computer", disabled: switching, onchange: event => onSwitchWorkspace?.(event.target.value) },
    workspaces.map(item => h("option", { value: String(item.id) }, item.name)));
  select.value = String(workspace?.id ?? "");
  return h("div", { class: "device-workspace ds-stack" }, select,
    h("small", {}, switching ? "Switching workspace…" : "Keys are created in the selected workspace."));
}

function details(rows) {
  return h("dl", { class: "ds-evidence-list device-details", "aria-label": "Connection request" },
    rows.map(([label, value]) => h("div", { class: "ds-evidence-row" }, h("dt", {}, label), h("dd", {}, value))));
}

function finished({ glyph = "circle-check", tone = "accent", heading, description, noticeTone = "neutral", message, body, actions }) {
  return [tile(glyph, tone), title(heading, description), message && h("p", { class: "ds-notice", "data-tone": noticeTone, role: "status" }, message), body, actions && h("div", { class: "ds-row device-finish" }, actions)];
}

/**
 * Console screen for `#device` and `#device=CODE`. All state is supplied by the
 * owner; callbacks perform requests. Nothing here reads or stores credentials.
 */
export function deviceView({
  code = "", input = "", request = null, loading = false, error = "", errorCode = "", entryError = "", busy = "", result = "",
  workspace = null, workspaces = [], role = "member", switching = false, origin = "", now = Date.now(),
  copyControl, onSubmitCode, onApprove, onDeny, onRetry, onSwitchWorkspace, onStartOver, connectionsHref = "#connect",
} = {}) {
  const view = h("section", { class: "device-view ds-decision ds-stack", "aria-labelledby": "device-title", "aria-busy": String(Boolean(loading || busy)) });
  const shown = formatUserCode(code) || code;
  const startOver = h("button", { type: "button", onclick: () => onStartOver?.() }, "Enter a different code");
  const connections = h("a", { class: "button ds-touch-target", href: connectionsHref }, "View connections");
  if (!["owner", "member"].includes(role)) {
    view.append(...finished({ glyph: "lock", tone: "neutral", heading: "Connect a computer", description: "Sign in with your own account to approve a computer for this workspace." }).filter(Boolean));
    return view;
  }
  const state = devicePresentation({ code, request, loading, error, errorCode, result });
  const agents = request?.agents || [];
  const workspaceName = workspace?.name || "this workspace";
  const parts = {
    entry: () => [
      tile("terminal"),
      title("Connect a computer", "Run this command on the computer you want to connect, then enter the code it shows."),
      commandBlock(origin, copyControl),
      codeEntry({ input, error: entryError, onSubmit: onSubmitCode }),
    ],
    loading: () => [tile("loader-circle", "neutral"), title("Connect this computer?"), loadingState({ label: "Checking this code…", lines: 3 })],
    "not-found": () => [
      tile("search", "neutral"),
      title("We couldn’t find that code", "Check the code in your terminal and enter it again. Codes last 10 minutes."),
      codeEntry({ input: input || shown, error: error || "This code was not found.", onSubmit: onSubmitCode }),
    ],
    error: () => [
      tile("circle-alert", "danger"),
      title("Connect this computer?"),
      h("p", { class: "ds-notice", "data-tone": "danger", role: "alert" }, error || "This request could not be loaded. Please try again."),
      h("div", { class: "ds-decision-actions" }, h("button", { type: "button", class: "primary", onclick: () => onRetry?.() }, icon("refresh-cw", { size: 14 }), "Try again"), startOver),
    ],
    expired: () => finished({ glyph: "clock", tone: "neutral", heading: "This code has expired", description: "Codes last 10 minutes. Run the command again in your terminal for a new one.", body: commandBlock(origin, copyControl), actions: [startOver] }),
    denied: () => finished({ glyph: "circle-x", tone: "danger", heading: "This request was denied", description: "Nothing was connected. Run the command again in your terminal to start over.", actions: [startOver] }),
    approved: () => finished({ glyph: "circle-check", heading: "Already approved", description: "Return to your terminal to finish setting up this computer.", actions: [connections] }),
    consumed: () => finished({ glyph: "badge-check", heading: "This computer is connected", description: "Its agents already received their access keys. You can review or revoke them in Connections.", actions: [connections] }),
    "approved-now": () => finished({
      glyph: "shield-check", heading: "Computer approved", noticeTone: "success",
      message: "Approved. Return to your terminal. Your agents are being set up.",
      description: agents.length ? `Your terminal will finish connecting ${agentList(agents)} to ${workspaceName}.` : `Your terminal will finish connecting to ${workspaceName}.`,
      actions: [connections],
    }),
    "denied-now": () => finished({ glyph: "circle-x", tone: "danger", heading: "Request denied", message: "Nothing was connected. You can close this tab.", actions: [startOver] }),
    pending: () => {
      const approving = busy === "approve", denying = busy === "deny", disabled = Boolean(busy) || switching;
      return [
        tile("terminal"),
        title("Connect this computer?", `A terminal on ${request.device} asked to connect its agents to Engram.`),
        h("div", { class: "ds-confirm-code" },
          h("p", { class: "ds-confirm-code-label", id: "device-confirm-label" }, "Check this code matches your terminal"),
          h("span", { class: "ds-confirm-code-value", "aria-describedby": "device-confirm-label" }, request.userCode || shown)),
        details([
          ["Computer", h("span", {}, request.device)],
          ["Agents", agentsValue(agents)],
          ["Workspace", workspaceValue({ workspace, workspaces, switching, onSwitchWorkspace })],
          ["Requested", h("span", { title: new Date(request.createdAt).toLocaleString() }, requestedAgo(request.createdAt, now) || "Recently")],
        ]),
        h("p", { class: "ds-hint device-grant" }, icon("key-round", { size: 14 }), h("span", {}, `Approving creates one access key for each agent, in your name, with read and write access to ${workspaceName}. You can revoke them in Connections.`)),
        error && h("p", { class: "ds-notice", "data-tone": "danger", role: "alert" }, error),
        h("div", { class: "ds-decision-actions device-actions" },
          h("button", { type: "button", disabled, "aria-busy": String(denying), onclick: () => onDeny?.() }, denying ? [icon("loader-circle", { size: 14, class: "ds-spin" }), "Denying…"] : "Deny"),
          h("button", { type: "button", class: "primary", disabled, "aria-busy": String(approving), onclick: () => onApprove?.() }, approving ? [icon("loader-circle", { size: 14, class: "ds-spin" }), "Approving…"] : "Approve")),
        h("p", { class: "ds-hint device-caveat" }, "Didn’t run this command, or the code doesn’t match? Choose Deny."),
      ];
    },
  };
  view.append(...(parts[state] || parts.error)().flat().filter(Boolean));
  return view;
}
