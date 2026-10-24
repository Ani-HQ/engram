// Pure presentation model for the local demo. Callers scope records to the
// authenticated workspace before grouping; reports never become observed evidence.
import { createHash } from "node:crypto";

function newestFirst(a, b) {
  return b.occurredAt.localeCompare(a.occurredAt)
    || b.recordedAt.localeCompare(a.recordedAt)
    || Number(b.status !== "running") - Number(a.status !== "running")
    || b.id.localeCompare(a.id);
}

function logicalKey(action) {
  return action.actionKey
    ? JSON.stringify([action.agent, "action", action.actionKey])
    : JSON.stringify([action.agent, "event", action.id]);
}

export function latestLogicalActions(actions) {
  const latest = new Map();
  for (const action of [...actions].sort(newestFirst)) {
    const key = logicalKey(action);
    if (!latest.has(key)) latest.set(key, { ...action, startedAt: action.startedAt || action.occurredAt });
    else {
      const current = latest.get(key);
      const startedAt = [current.startedAt, action.startedAt || action.occurredAt].sort()[0];
      const kept = { ...current, startedAt, approach: current.approach?.trim() ? current.approach : action.approach };
      for (const field of ["taskTitle", "outcome", "currentStep", "harness", "sourceLabel", "sourceKind"]) {
        if (!kept[field]?.trim() && action[field]?.trim()) kept[field] = action[field];
      }
      latest.set(key, kept);
    }
  }
  return [...latest.values()];
}

function statusOf(actions) {
  return actions.some(action => action.status === "running") ? "running"
    : actions.some(action => action.status === "failed") ? "failed" : "completed";
}

function activityId(action) {
  if (action.runId?.trim()) return `run:${action.runId}`;
  if (!action.actionKey) return `event:${action.id}`;
  const postgresJson = `[${JSON.stringify(action.agent)}, ${JSON.stringify(action.actionKey)}]`;
  return `action:${createHash("sha256").update(postgresJson).digest("hex")}`;
}

export function groupActivities(actions, now = new Date()) {
  const groups = new Map();
  for (const action of latestLogicalActions(actions)) {
    const id = activityId(action);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(action);
  }
  return [...groups].map(([id, rows]) => {
    const allEvents = actions.filter(action => rows.some(latest => logicalKey(latest) === logicalKey(action)));
    const first = [...allEvents].sort((a, b) => (a.startedAt || a.occurredAt).localeCompare(b.startedAt || b.occurredAt)
      || a.occurredAt.localeCompare(b.occurredAt) || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))[0];
    const fresh = action => new Date(action.recordedAt).getTime() >= now.getTime() - 900_000;
    const working = own => own.filter(action => action.status === "running" && fresh(action)).length;
    const stale = own => own.filter(action => action.status === "running" && !fresh(action)).length;
    const agents = [...new Set(rows.map(action => action.agent))].sort().map(name => {
      const own = rows.filter(action => action.agent === name);
      const source = [...own].sort((a, b) => Number(b.sourceKind === "registered") - Number(a.sourceKind === "registered") || newestFirst(a, b)).find(row => row.harness);
      return { name, status: statusOf(own), actionCount: own.length, lastActiveAt: own.map(action => action.recordedAt).sort().at(-1), workingActions: working(own), staleActions: stale(own), harness: source?.harness || null, sourceLabel: source?.sourceLabel || null, sourceKind: source?.sourceKind || null };
    });
    const approaches = [];
    const seen = new Set();
    for (const action of [...rows].reverse()) {
      const text = action.approach?.trim();
      const key = JSON.stringify([action.agent, text, action.evidence]);
      if (text && !seen.has(key)) {
        approaches.push({ text, agent: action.agent, evidence: action.evidence });
        seen.add(key);
      }
    }
    return {
      id, summary: first.summary, status: statusOf(rows),
      kind: rows.every(row => row.evidence === "observed") ? "memory" : rows.some(row => row.runId?.trim() || row.taskTitle?.trim()) ? "task" : "action",
      taskTitle: rows.find(row => row.taskTitle?.trim())?.taskTitle || null,
      outcome: rows.find(row => row.outcome?.trim())?.outcome || null,
      currentStep: rows.find(row => row.status === "running" && row.currentStep?.trim())?.currentStep || null,
      resources: [...new Set(rows.map(row => row.resource).filter(Boolean))].sort(),
      startedAt: first.startedAt || first.occurredAt,
      updatedAt: rows.map(action => action.recordedAt).sort().at(-1),
      agents, tools: [...new Set(rows.map(action => action.tool))].sort(),
      approaches, actionCount: rows.length, runId: rows[0].runId?.trim() || null,
      evidence: new Set(rows.map(action => action.evidence)).size > 1 ? "mixed" : rows[0].evidence,
      workingActions: working(rows), staleActions: stale(rows),
      actions: [...rows].sort(newestFirst),
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

export function activityPage(actions, query = {}, now = new Date()) {
  const groups = groupActivities(actions, now).filter(group => !query.kind || query.kind === "all" || (query.kind === "memory" ? group.evidence === "observed" : group.evidence !== "observed"));
  const q = String(query.q || "").trim().toLowerCase();
  const matching = groups.filter(group => (!query.agent || group.agents.some(agent => agent.name === query.agent))
    && (!query.tool || group.tools.includes(query.tool))
    && (!query.runId || group.runId === query.runId)
    && (!query.resource || group.actions.some(action => String(action.resource || "").toLowerCase().includes(String(query.resource).toLowerCase())))
    && (!q || group.actions.some(action => [action.agent, action.tool, action.summary, action.taskTitle, action.outcome, action.currentStep, action.resource, action.runId, action.detail, action.approach].join(" ").toLowerCase().includes(q))));
  const filtered = matching.filter(group => !query.status || group.status === query.status);
  const offset = query.offset || 0;
  const limit = query.limit || 40;
  const stats = { running: 0, completed: 0, failed: 0, total: matching.length };
  for (const group of matching) stats[group.status] += 1;
  return {
    activities: filtered.slice(offset, offset + limit).map(({ actions: _, ...activity }) => activity),
    more: offset + limit < filtered.length,
    agents: [...new Set(groups.flatMap(group => group.agents.map(agent => agent.name)))].sort(),
    tools: [...new Set(groups.flatMap(group => group.tools))].sort(), stats,
    checkedAt: now.toISOString(), freshnessSeconds: 900,
  };
}

export function activityDetail(actions, id, now = new Date()) {
  return groupActivities(actions, now).find(activity => activity.id === id) || null;
}
