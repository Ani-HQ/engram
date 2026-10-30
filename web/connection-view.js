import { h } from "./profile.js";
import { relativeTime } from "./activity-view.js";
import { connectionClient, connectionState, connectionSummary, currentConnections, lastConnectionContact } from "./connection-model.js";
import { taskReportingStatus } from "./task-reporting-model.js";
import { agentVisual, visualIcon } from "./tooling.js";
import { identityMark, staggerIn } from "./design-system.js";

const presenceFor = state => ({ recent: "recent", ready: "quiet", quiet: "quiet", reconnect: "reconnect" })[state] || "";
/** The connected product's mark with its connection presence. A display hint, never proof of setup. */
export function connectionMark(connection, state, size = "md") {
  const visual = agentVisual(connection.agent, { harness: connection.harness || connectionClient(connection).harness, sourceLabel: connection.sourceLabel });
  return identityMark(visualIcon(visual, { size: size === "lg" ? 24 : 18 }), { size, presence: presenceFor(state.state) });
}

const button = (children, action, attrs = {}) => h("button", { type: "button", onclick: action, ...attrs }, children);
const count = value => new Intl.NumberFormat().format(Number(value) || 0);
const name = connection => connection.displayName || connection.name || "Agent";
const time = value => h("time", { datetime: value, "data-relative-time": value, title: new Date(value).toLocaleString() }, relativeTime(value));

export function agentOverview(data, { onManage, onFilter, selectedAgent = "", error = "", now = Date.now() } = {}) {
  if (!data) return error ? h("aside", { class: "agent-overview unavailable" }, h("span", {}, "Connection status is unavailable."), button("View connections", onManage, { class: "text small" }))
    : h("aside", { class: "agent-overview is-loading", "aria-label": "Loading agent connections" }, h("span", { class: "ds-spinner", "aria-hidden": "true" }), h("span", { class: "muted" }, "Checking agent connections…"));
  const connections = currentConnections(data.connections || []), summary = connectionSummary(connections, now, data.recentWindowSeconds);
  const visible = [...connections].sort((a, b) => Number(b.status === "authorized") - Number(a.status === "authorized") || (Date.parse(lastConnectionContact(b, now) || b.createdAt) || 0) - (Date.parse(lastConnectionContact(a, now) || a.createdAt) || 0)).slice(0, 5);
  return h("aside", { class: "agent-overview", "aria-label": "Agent connections" },
    h("div", { class: "agent-overview-heading" }, h("div", {}, h("h2", {}, "Your agents"), h("span", {}, summary.recent ? `${summary.recent} seen recently` : summary.authorized ? `${summary.authorized} authorized · No recent contact` : connections.length ? "Connections need attention" : "Connect your first agent")),
      button("Connections", onManage, { class: "text small" })),
    visible.length > 0 && staggerIn(h("div", { class: "agent-presence-list" }, visible.map(connection => {
      const state = connectionState(connection, now, data.recentWindowSeconds);
      return button([connectionMark(connection, state), h("span", { class: "agent-presence-copy" }, h("strong", {}, name(connection)), h("span", {}, state.label))],
        () => state.state === "reconnect" ? onManage?.(connection) : onFilter?.(connection.agent === selectedAgent ? "" : connection.agent),
        { class: `agent-presence ${state.state}`, title: `${name(connection)} · ${state.explanation}`, "aria-pressed": String(connection.agent === selectedAgent), "data-connection-id": connection.id });
    }))),
    summary.reconnect > 0 && h("div", { class: "agent-overview-note" }, h("span", {}, `${summary.reconnect} ${summary.reconnect === 1 ? "connection needs" : "connections need"} a fresh sign-in or key.`), button("Review", onManage, { class: "text small" })),
    !connections.length && h("p", { class: "agent-overview-note" }, "Connect an agent to start a shared history. Memory calls appear automatically."),
    error && h("p", { class: "agent-overview-note" }, "Connection status could not refresh. Showing the last checked state."),
    data.more && h("p", { class: "agent-overview-note" }, `Showing the first ${count(data.limit || connections.length)} connections.`));
}

export function connectionInventory(data, { actions, onInspect, list = "current", now = Date.now() } = {}) {
  if (!data) return null;
  const all = (data.connections || []).filter(connection => !connection.deletedAt && Boolean(connection.archivedAt) === (list === "archived")), authorized = all.filter(connection => connection.status === "authorized"), attention = all.filter(connection => connection.status !== "authorized");
  const row = connection => {
    const state = connectionState(connection, now, data.recentWindowSeconds);
    const reporting = taskReportingStatus(connection);
    return h("article", { class: `connection-row ds-row-hover ${state.state}`, "data-connection-id": connection.id },
      connectionMark(connection, state, "lg"),
      h("div", { class: "connection-copy" }, h("div", { class: "connection-name" }, h("strong", {}, name(connection)), " ", h("span", { class: `connection-state status-label ${state.state}`, "data-tone": state.state === "reconnect" ? "danger" : "neutral", title: state.explanation }, state.label)),
        h("p", { title: connectionClient(connection).detail }, connection.kind === "oauth" ? "Sign-in" : "Access key", connection.kind === "token" && connection.name !== name(connection) ? ` · ${connection.name}` : "", ` · Client: ${connectionClient(connection).label}`),
        h("p", { class: "connection-counts" }, state.lastContactAt ? ["Last contact ", time(state.lastContactAt)] : "No agent calls recorded yet", ` · ${count(connection.memoryCalls)} memory ${Number(connection.memoryCalls) === 1 ? "call" : "calls"} · ${count(connection.taskReports)} task ${Number(connection.taskReports) === 1 ? "report" : "reports"} · `, h("span", { class: "connection-reporting-state", title: reporting.detail }, reporting.label)),
        connection.archivedAt && h("p", {}, "Archived ", time(connection.archivedAt))),
      h("div", { class: "connection-row-end" },
        actions?.(connection) || button(state.state === "reconnect" ? "Reconnect" : "Details", () => onInspect?.(connection), { class: "text small" })));
  };
  return h("div", { class: "connection-inventory" },
    list === "archived" ? all.length > 0 && h("section", {}, h("div", { class: "connection-section-title" }, h("h3", {}, "Archived"), h("span", {}, count(all.length))), all.map(row)) : [
      authorized.length > 0 && h("section", {}, h("div", { class: "connection-section-title" }, h("h3", {}, "Authorized"), h("span", {}, count(authorized.length))), authorized.map(row)),
      attention.length > 0 && h("section", {}, h("div", { class: "connection-section-title" }, h("h3", {}, "Needs attention"), h("span", {}, count(attention.length))), attention.map(row))],
    !all.length && h("p", { class: "connection-empty" }, list === "archived" ? "No archived connections. Archived connections stay here until you restore or delete them." : "No current connections. Choose Connect an agent to add one, or restore an archived connection."),
    data.more && h("p", { class: "detail-note" }, `Showing the first ${count(data.limit || all.length)} connections. Older connections are omitted from this view.`),
    h("p", { class: "connection-explainer" }, "Authorization confirms access. Last contact records a request received by Engram; it does not mean an agent is currently working. Work outside Engram appears when the agent reports it."));
}
