const reconnectStatuses = new Set(["revoked", "expired", "membership_removed"]);
const timestamp = value => { if (!value) return null; const n = Date.parse(value); return Number.isFinite(n) ? n : null; };

export function activityKind(value) { return value === "tasks" || value === "memory" ? value : "all"; }

export function lastConnectionContact(connection = {}, now = Date.now()) {
  const values = [connection.lastContactAt, connection.lastMemoryAt, connection.lastTaskReportAt, connection.lastAuthenticatedAt]
    .map(timestamp).filter(value => value !== null && value <= now + 60_000);
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
}

export function connectionState(connection = {}, now = Date.now(), recentWindowSeconds = 900) {
  const lastContactAt = lastConnectionContact(connection, now);
  if (reconnectStatuses.has(connection.status)) return {
    state: "reconnect", label: "Reconnect needed", lastContactAt,
    explanation: connection.status === "membership_removed" ? "This connection's workspace membership is no longer current."
      : connection.status === "expired" ? "This sign-in has expired. Reconnect from the agent." : "This access was revoked. The agent needs a new sign-in or access key.",
  };
  if (connection.status !== "authorized") return { state: "unknown", label: "Status unavailable", lastContactAt, explanation: "Engram could not establish this connection's authorization status." };
  if (!lastContactAt) return { state: "ready", label: connection.kind === "oauth" ? "Signed in" : "Key issued", lastContactAt, explanation: "Access is authorized. No agent contact has been recorded yet." };
  const age = now - Date.parse(lastContactAt), window = Number.isFinite(recentWindowSeconds) && recentWindowSeconds > 0 ? recentWindowSeconds : 900;
  if (age <= window * 1000) return { state: "recent", label: "Seen recently", lastContactAt, explanation: "Engram received contact in the last 15 minutes. This does not mean the agent is currently working." };
  return { state: "quiet", label: "Quiet", lastContactAt, explanation: "Access is authorized. The agent has not contacted Engram recently." };
}

export function connectionSummary(connections = [], now = Date.now(), recentWindowSeconds = 900) {
  const states = connections.map(connection => connectionState(connection, now, recentWindowSeconds));
  return {
    total: connections.length,
    authorized: connections.filter(connection => connection.status === "authorized").length,
    reconnect: states.filter(value => value.state === "reconnect").length,
    recent: states.filter(value => value.state === "recent").length,
    lastContactAt: lastConnectionContact({ lastContactAt: states.map(value => value.lastContactAt).filter(Boolean).sort().at(-1) }, now),
  };
}

export function connectionIdentity(agent, connections = []) {
  return connections.find(connection => connection.agent === agent) || null;
}

export function withConnectionIdentity(activity, connections = []) {
  const decorate = agent => {
    const identity = connectionIdentity(agent.name, connections);
    if (!identity) return agent;
    return { ...agent, displayName: identity.displayName || agent.name,
      harness: agent.harness || identity.harness || (identity.kind === "oauth" ? "other" : null), sourceLabel: agent.sourceLabel || identity.sourceLabel || null };
  };
  return { ...activity,
    agents: (activity.agents || []).map(decorate),
    ...(activity.actions ? { actions: activity.actions.map(action => {
      const identity = connectionIdentity(action.agent, connections);
      return identity ? { ...action, displayName: identity.displayName || action.agent,
        harness: action.harness || identity.harness || (identity.kind === "oauth" ? "other" : null), sourceLabel: action.sourceLabel || identity.sourceLabel || null } : action;
    }) } : {}),
  };
}
