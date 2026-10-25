import { h } from "./profile.js";
import { icon } from "./icons.js";
import { agentVisual, visualIcon } from "./tooling.js";
import { relativeTime } from "./activity-view.js";
import { connectionState, connectionSummary, lastConnectionContact } from "./connection-model.js";
import { taskReportingStatus } from "./task-reporting-model.js";

const button = (children, action, attrs = {}) => h("button", { type: "button", onclick: action, ...attrs }, children);
const count = value => new Intl.NumberFormat().format(Number(value) || 0);
const name = connection => connection.displayName || connection.name || "Agent";
const avatar = connection => h("span", { class: "connection-avatar", "aria-hidden": "true" }, visualIcon(agentVisual(connection.name, { ...connection, harness: connection.harness || (connection.kind === "oauth" ? "other" : null) }), { size: 18 }));
const time = value => h("time", { datetime: value, "data-relative-time": value, title: new Date(value).toLocaleString() }, relativeTime(value));

export function agentOverview(data, { onManage, onFilter, selectedAgent = "", error = "", now = Date.now() } = {}) {
  if (!data) return error ? h("aside", { class: "agent-overview unavailable" }, icon("info", { size: 14 }), h("span", {}, "Connection status is unavailable."), button("View connections", onManage, { class: "text small" }))
    : h("aside", { class: "agent-overview is-loading", "aria-label": "Loading agent connections" }, h("span", { class: "ds-spinner", "aria-hidden": "true" }), h("span", { class: "muted" }, "Checking agent connections…"));
  const connections = data.connections || [], summary = connectionSummary(connections, now, data.recentWindowSeconds);
  const visible = [...connections].sort((a, b) => Number(b.status === "authorized") - Number(a.status === "authorized") || (Date.parse(lastConnectionContact(b, now) || b.createdAt) || 0) - (Date.parse(lastConnectionContact(a, now) || a.createdAt) || 0)).slice(0, 5);
  return h("aside", { class: "agent-overview ds-card", "aria-label": "Agent connections" },
    h("div", { class: "agent-overview-heading" }, h("div", {}, h("h2", {}, "Your agents"), h("span", {}, summary.recent ? `${summary.recent} seen recently` : summary.authorized ? `${summary.authorized} authorized · No recent contact` : connections.length ? "Connections need attention" : "Connect your first agent")),
      button(["Connections", icon("arrow-up-right", { size: 12 })], onManage, { class: "text small" })),
    visible.length > 0 && h("div", { class: "agent-presence-list" }, visible.map(connection => {
      const state = connectionState(connection, now, data.recentWindowSeconds);
      return button([avatar(connection), h("span", { class: "agent-presence-copy" }, h("strong", {}, name(connection)), h("span", {}, state.label)), icon(state.state === "reconnect" ? "info" : "chevron-right", { size: 12 })],
        () => state.state === "reconnect" ? onManage?.(connection) : onFilter?.(connection.agent === selectedAgent ? "" : connection.agent),
        { class: `agent-presence ${state.state}`, title: `${name(connection)} · ${state.explanation}`, "aria-pressed": String(connection.agent === selectedAgent), "data-connection-id": connection.id });
    })),
    summary.reconnect > 0 && h("div", { class: "agent-overview-note" }, icon("plug", { size: 13 }), h("span", {}, `${summary.reconnect} ${summary.reconnect === 1 ? "connection needs" : "connections need"} a fresh sign-in or key.`), button("Review", onManage, { class: "text small" })),
    !connections.length && h("p", { class: "agent-overview-note" }, "Connect an agent to start a shared history. Memory calls appear automatically."),
    error && h("p", { class: "agent-overview-note" }, "Connection status could not refresh. Showing the last checked state."),
    data.more && h("p", { class: "agent-overview-note" }, `Showing the first ${count(data.limit || connections.length)} connections.`));
}

export function connectionInventory(data, { actions, onInspect, now = Date.now() } = {}) {
  if (!data) return null;
  const all = data.connections || [], authorized = all.filter(connection => connection.status === "authorized"), attention = all.filter(connection => connection.status !== "authorized");
  const row = connection => {
    const state = connectionState(connection, now, data.recentWindowSeconds);
    return h("article", { class: `connection-row ds-card ${state.state}`, "data-connection-id": connection.id }, avatar(connection),
      h("div", { class: "connection-copy" }, h("div", { class: "connection-name" }, h("strong", {}, name(connection)), h("span", { class: "connection-auth-kind" }, connection.kind === "oauth" ? "Sign-in" : "Access key")),
        connection.kind === "token" && connection.name !== name(connection) && h("p", { class: "connection-installation" }, connection.name),
        h("p", {}, state.lastContactAt ? ["Last contact ", time(state.lastContactAt)] : "No agent calls recorded yet"),
        h("p", { class: "connection-counts" }, `${count(connection.memoryCalls)} memory ${Number(connection.memoryCalls) === 1 ? "call" : "calls"}`, h("span", { "aria-hidden": "true" }, "·"), `${count(connection.taskReports)} task ${Number(connection.taskReports) === 1 ? "report" : "reports"}`),
        h("p", { class: "connection-reporting-state", title: taskReportingStatus(connection).detail }, taskReportingStatus(connection).label)),
      h("div", { class: "connection-row-end" }, h("span", { class: `connection-state ds-badge ${state.state}`, "data-tone": state.state === "recent" ? "success" : state.state === "reconnect" ? "warning" : "neutral", title: state.explanation }, icon(state.state === "reconnect" ? "info" : state.state === "recent" ? "check" : "circle-dashed", { size: 12 }), state.label),
        actions?.(connection) || button(state.state === "reconnect" ? "Reconnect" : "Details", () => onInspect?.(connection), { class: "text small" })));
  };
  return h("div", { class: "connection-inventory" },
    authorized.length > 0 && h("section", {}, h("div", { class: "connection-section-title" }, h("h3", {}, "Authorized"), h("span", {}, count(authorized.length))), authorized.map(row)),
    attention.length > 0 && h("section", {}, h("div", { class: "connection-section-title" }, h("h3", {}, "Needs attention"), h("span", {}, count(attention.length))), attention.map(row)),
    !all.length && h("p", { class: "connection-empty" }, "No agent connections yet. Sign in from an agent or create a dedicated access key below."),
    data.more && h("p", { class: "detail-note" }, `Showing the first ${count(data.limit || all.length)} connections. Older connections are omitted from this view.`),
    h("p", { class: "connection-explainer" }, "Authorization confirms access. Last contact records a request received by Engram; it does not mean an agent is currently working. Work outside Engram appears when the agent reports it."));
}
