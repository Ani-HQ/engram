const reconnectStatuses = new Set(["revoked", "expired", "membership_removed"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const validCount = value => Number.isSafeInteger(value) && value >= 0;

/**
 * Presentation evidence only. Eligible means this credential is authorized and
 * carries write access; workspace policy and billing may still deny a report.
 * Receipts do not establish installed hooks, automatic capture or current work.
 */
export function taskReportingStatus(connection) {
  const source = record(connection);
  const reportCount = validCount(source.taskReports) ? source.taskReports : 0;
  const archived = Boolean(source.archivedAt);
  const reconnect = !archived && reconnectStatuses.has(source.status);
  const authorized = !archived && !source.deletedAt && source.status === "authorized";
  const eligible = authorized && source.canWrite === true;
  const readOnly = authorized && source.canWrite === false;
  const withReports = eligible && reportCount > 0;
  const evidence = { eligible, reconnect, readOnly, withReports, reportCount };

  if (archived) return { ...evidence, state: "archived", label: "Archived", detail: "This connection is archived and disconnected. Its past task reports remain available." };

  if (reconnect) return {
    ...evidence, state: "reconnect", label: "Reconnect needed",
    detail: source.status === "membership_removed"
      ? "This connection's workspace membership is no longer current. Restore access and reconnect before sending task reports."
      : source.status === "expired"
        ? "This sign-in has expired. Reconnect from the agent before sending task reports."
        : "This access was revoked. The agent needs a new sign-in or access key before sending task reports.",
  };
  if (readOnly) return {
    ...evidence, state: "read-only", label: "Read-only access",
    detail: "This credential has read-only access and cannot send new task reports.",
  };
  if (!eligible || !validCount(source.taskReports)) return {
    ...evidence, state: "unknown", label: "Report status unavailable",
    detail: "Connection access or task report history is unavailable or incomplete.",
  };
  if (withReports) return {
    ...evidence, state: "reports-received", label: "Reports received",
    detail: "Engram has received task reports from this connection. This does not verify automatic capture or current work.",
  };
  return {
    ...evidence, state: "no-reports", label: "No task reports",
    detail: "Engram has not received task reports from this connection. Memory calls are counted separately.",
  };
}

/** Counts only the supplied workspace inventory; `more` preserves its bounds. */
export function taskReportingSummary(payload) {
  const source = record(payload), available = Array.isArray(source.connections);
  const connections = available ? source.connections.filter(connection => !connection?.archivedAt && !connection?.deletedAt) : [];
  const summary = { eligible: 0, reconnect: 0, readOnly: 0, withReports: 0,
    total: connections.length, more: available && source.more === true, available };
  for (const connection of connections) {
    const status = taskReportingStatus(connection);
    for (const key of ["eligible", "reconnect", "readOnly", "withReports"]) {
      if (status[key]) summary[key] += 1;
    }
  }
  return summary;
}
