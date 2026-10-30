import { h } from "./profile.js";
import { taskReportingStatus, taskReportingSummary } from "./task-reporting-model.js";
import { identityMark } from "./design-system.js";
import { icon } from "./icons.js";
import { agentVisual, visualIcon } from "./tooling.js";

/** Guidance for a connected agent, not an adapter or a promise of capture. */
export const taskReportingInstructions = `Report real work to this Engram workspace with record_action.

Before reporting, confirm that record_action and list_actions are available. If either is missing, reconnect Engram or refresh its tools. Reporting requires write access; workspace policy and plan restrictions still apply. If reporting remains unavailable or denied, explain the reporting gap and continue the authorized work without claiming that a report was saved. Do not loop through authentication attempts.

Use one stable runId for the user's task. Use a separate stable actionKey for each actual operation or attempt, and keep that actionKey through its running updates and final result. Generate a new eventId for each report; reuse an eventId only when retrying the identical report.

1. Start: call record_action with status "running", the actual tool or operation, a factual summary, taskTitle, runId, actionKey, eventId, and currentStep when known. Only report work you are actually starting.
2. Update: while that operation is still running, report a factual currentStep with the same runId and actionKey and a new eventId. Refresh within 15 minutes when possible. Do not send invented progress or heartbeats after work has stopped.
3. Finish: report status "completed" or "failed", with the same runId and actionKey and a new eventId. Include a concise factual outcome and a resource identifier when useful. Omit currentStep after completion. A retry after a terminal result is a new attempt with a new actionKey.

Report only actions and outcomes you observed. Do not backfill invented tasks, tool calls, timing, success, or progress. Do not include secrets, private prompts, raw transcripts, or hidden chain-of-thought. An optional approach is a brief high-level method, not private reasoning.

Use list_actions with the runId to check the received reports. Treat reporting as best effort: do not claim a report was saved unless Engram confirms it, and do not repeat an uncertain write with a different eventId. These instructions do not install hooks or automatically capture work outside Engram.`;

const button = (label, fn, attrs = {}) => h("button", { type: "button", onclick: fn, ...attrs }, label);
const count = value => new Intl.NumberFormat().format(value);
const plural = (value, one, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;
const text = value => typeof value === "string" ? value.trim() : "";

/** Workspace inventory evidence only; callbacks remain with the owning app. */
export function taskReportingSetup(data, { onInspect, onManage, onSetup, copyControl } = {}) {
  const summary = taskReportingSummary(data);
  const connections = Array.isArray(data?.connections) ? data.connections.filter(connection => !connection?.archivedAt && !connection?.deletedAt) : [];
  const reconnectDetail = !summary.available
    ? "Connection status is unavailable. Open Connections to check access, then refresh your agent's Engram tools."
    : !summary.total
      ? "Connect an agent first. After connecting, check that record_action and list_actions appear in its tool list."
      : summary.reconnect
        ? `${plural(summary.reconnect, "connection needs", "connections need")} a fresh sign-in or access key. Refresh your agent's tools so record_action and list_actions appear.`
        : "No connections in this list need a fresh sign-in or key. If record_action or list_actions is missing, reconnect Engram or refresh its tool list.";
  const writeDetail = !summary.available
    ? "Task reports need an authorized connection with write access. Workspace policy and plan restrictions may still limit reporting."
    : `${plural(summary.eligible, "connection has", "connections have")} write access${summary.readOnly ? `; ${count(summary.readOnly)} ${summary.readOnly === 1 ? "is" : "are"} read-only` : ""}. Workspace policy and plan restrictions may still limit reporting.`;
  const reportDetail = !summary.available
    ? "Use guided setup to install the workflow for a supported runtime. Reporting remains subject to the agent’s supported lifecycle events."
    : `${summary.withReports ? `${plural(summary.withReports, "connection has", "connections have")} sent task reports.` : "No task reports from write-authorized connections in this list."} Guided setup installs the supported workflow. A received report does not prove every task is captured.`;

  const step = (number, title, detail, action) => h("li", { class: "task-reporting-step" }, h("h3", {}, title), h("p", {}, detail), action);

  const row = value => {
    const connection = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const state = taskReportingStatus(connection);
    const name = text(connection.displayName) || text(connection.name) || "Agent connection";
    const identity = text(connection.name);
    const validReports = Number.isSafeInteger(connection.taskReports) && connection.taskReports >= 0;
    const kind = connection.kind === "oauth" ? "Sign-in" : connection.kind === "token" ? "Access key" : "Connection";
    const client = connection.client?.state === "identified" ? connection.client.harness : undefined;
    const mark = identityMark(visualIcon(agentVisual(identity || name, { harness: client }), { size: 16 }), { size: "sm" });
    return button([
      mark,
      h("span", { class: "task-reporting-connection-copy" }, h("strong", {}, name),
        identity && identity !== name && h("span", { class: "task-reporting-identity" }, identity),
        h("span", { class: "task-reporting-connection-meta" }, kind, validReports && ` · ${plural(state.reportCount, "report")} received`)),
      h("span", { class: "task-reporting-connection-state" }, state.label, icon("chevron-right", { size: 14 })),
    ], () => onInspect?.(connection), { class: `task-reporting-connection ds-row-hover ${state.state}`, title: state.detail, "aria-label": `${name}: ${state.label}. ${state.detail}` });
  };

  return h("section", { class: "task-reporting-setup", "aria-labelledby": "detail-title" },
    h("h2", { id: "detail-title" }, "See what your agents do"),
    h("p", { class: "task-reporting-intro" }, "Tasks appear when an agent sends a work report to Engram. Guided setup connects the agent and installs its supported memory and reporting workflow."),
    onSetup && button([icon("plug-zap", { size: 14 }), "Set up or repair an agent"], onSetup, { class: "primary small task-reporting-setup-action" }),
    h("ol", { class: "ds-steps task-reporting-steps" },
      step(1, "Reconnect and refresh tools", reconnectDetail, onManage && button(summary.reconnect ? "Review connections" : "Open Connections", () => onManage(), { class: "text task-reporting-link" })),
      step(2, "Use write access", writeDetail),
      step(3, "Install the supported workflow", reportDetail)),
    h("details", { class: "task-reporting-instructions" },
      h("summary", {}, icon("chevron-right", { size: 14, class: "task-reporting-chevron" }), h("span", {}, "Advanced: reporting contract")),
      h("div", { class: "task-reporting-instruction-body" },
        h("div", { class: "task-reporting-instruction-toolbar" }, h("p", {}, "For custom integrations or a deliberate one-task instruction. Guided setup handles supported agent files automatically."), copyControl),
        h("pre", { tabindex: "0", "aria-label": "Task reporting instructions" }, h("code", {}, taskReportingInstructions)))),
    h("section", { class: "task-reporting-connections ds-panel-list", "aria-label": "Task reports by connection" },
      h("div", { class: "ds-panel-head task-reporting-connections-heading" }, h("h3", {}, "Your connections"), summary.available && h("span", {}, plural(summary.total, "connection"))),
      connections.slice(0, 6).map(row),
      !summary.available && h("p", { class: "task-reporting-empty" }, icon("wifi-off", { size: 14 }), "Connection status could not be checked. The instructions above are still available."),
      summary.available && !summary.total && h("p", { class: "task-reporting-empty" }, icon("plug", { size: 14 }), "No connections yet. Open Connections to sign in from an agent or create a dedicated access key."),
      (connections.length > 6 || summary.more) && h("p", { class: "ds-panel-foot task-reporting-bounds" }, `Showing ${plural(Math.min(connections.length, 6), "connection")}${summary.more ? " from a limited inventory" : ` of ${count(summary.total)}`}. Open Connections to review more.`)),
    h("p", { class: "task-reporting-footnote" }, h("span", {}, "Memory calls appear in the Memory activity feed. A received task report does not verify automatic capture or mean an agent is currently working.")));
}
