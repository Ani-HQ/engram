import type postgres from "postgres";
import { ActionError, actionActorFor, actionLedger, mapAction, parseActionsQuery, type Action, type ActionStatus, type ActionsQuery } from "./actions";
import { sql } from "./db";
import type { TokenRecord } from "./policies";
import { redactSecrets } from "./redact";

export type ActivityKind = "task" | "action" | "memory";
export type ActivityView = "tasks" | "memory" | "all";

export interface Activity {
  id: string;
  summary: string;
  kind: ActivityKind;
  taskTitle: string | null;
  outcome: string | null;
  currentStep: string | null;
  resources: string[];
  status: ActionStatus;
  startedAt: string;
  updatedAt: string;
  agents: { name: string; status: ActionStatus; actionCount: number; lastActiveAt: string; workingActions: number; staleActions: number; harness: string | null; sourceLabel: string | null; sourceKind: "registered" | "reported" | null }[];
  tools: string[];
  approaches: { text: string; agent: string; evidence: "reported" | "observed" }[];
  actionCount: number;
  runId: string | null;
  evidence: "reported" | "observed" | "mixed";
  workingActions: number;
  staleActions: number;
}
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function validateActivityId(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > 204 ||
      !((value.startsWith("run:") && value.length > 4 && value.slice(4).trim() === value.slice(4)) ||
        /^action:[a-f0-9]{64}$/.test(value) || /^event:[A-Za-z0-9._:-]{1,100}$/.test(value))) {
    throw new ActionError("Invalid activity identifier");
  }
  return value;
}
function amount(value: unknown): number { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function date(value: unknown): string { return new Date(value as string).toISOString(); }
function status(value: unknown): ActionStatus { return value === "running" || value === "failed" ? value : "completed"; }
function evidence(value: unknown): "reported" | "observed" | "mixed" { return value === "observed" || value === "mixed" ? value : "reported"; }

export function parseActivityView(raw: unknown): ActivityView {
  const value = raw instanceof URLSearchParams ? raw.get("kind") : raw && typeof raw === "object" ? (raw as Record<string, unknown>).kind : undefined;
  if (value === undefined || value === null || value === "") return "all";
  if (value === "tasks" || value === "memory" || value === "all") return value;
  throw new ActionError("kind must be tasks, memory, or all");
}
function optionalText(value: unknown): string | null { return typeof value === "string" && value ? redactSecrets(value) : null; }
function mapActivity(row: any): Activity {
  return {
    id: String(row.activity_id), summary: redactSecrets(String(row.summary)), status: status(row.status),
    kind: row.kind === "memory" || row.kind === "task" ? row.kind : "action",
    taskTitle: optionalText(row.task_title), outcome: optionalText(row.outcome), currentStep: row.status === "running" ? optionalText(row.current_step) : null,
    resources: (Array.isArray(row.resources) ? row.resources : []).map((resource: unknown) => redactSecrets(String(resource))),
    startedAt: date(row.started_at), updatedAt: date(row.updated_at),
    agents: (Array.isArray(row.agents) ? row.agents : []).map((agent: any) => ({
      name: String(agent.name), status: status(agent.status), actionCount: amount(agent.action_count), lastActiveAt: date(agent.last_active_at),
      workingActions: amount(agent.working_actions), staleActions: amount(agent.stale_actions),
      harness: optionalText(agent.source?.harness ?? agent.harness), sourceLabel: optionalText(agent.source?.source_label ?? agent.source_label),
      sourceKind: ["registered", "reported"].includes(agent.source?.source_kind ?? agent.source_kind) ? (agent.source?.source_kind ?? agent.source_kind) : null,
    })),
    tools: (Array.isArray(row.tools) ? row.tools : []).map(String),
    approaches: (Array.isArray(row.approaches) ? row.approaches : []).map((method: any) => ({
      text: redactSecrets(String(method.text)), agent: String(method.agent), evidence: method.evidence === "observed" ? "observed" : "reported",
    })),
    actionCount: amount(row.action_count), runId: row.run_id ? redactSecrets(String(row.run_id)) : null,
    evidence: evidence(row.evidence), workingActions: amount(row.working_actions), staleActions: amount(row.stale_actions),
  };
}

function activityLedger(db: postgres.Sql, orgId: number) {
  const ledger = actionLedger(db, orgId);
  // IDs are stable across a logical action's heartbeats/completion. Hashing a
  // JSON pair avoids ambiguous agent/key concatenation; no extension is needed.
  return db`
    SELECT *, CASE
      WHEN nullif(btrim(run_id), '') IS NOT NULL THEN 'run:' || run_id
      WHEN action_key IS NOT NULL THEN 'action:' || encode(sha256(convert_to(json_build_array(agent, action_key)::text, 'UTF8')), 'hex')
      ELSE 'event:' || id END AS activity_id
    FROM (${ledger}) logical_actions`;
}
function grouped(db: postgres.Sql) {
  return db`
    SELECT activity_id,
      (array_agg(coalesce(first_summary, summary) ORDER BY started_at ASC, occurred_at ASC, recorded_at ASC, id ASC))[1] AS summary,
      CASE WHEN bool_or(status = 'running') THEN 'running' WHEN bool_or(status = 'failed') THEN 'failed' ELSE 'completed' END AS status,
      min(started_at) AS started_at, max(recorded_at) AS updated_at,
      count(*) AS action_count, min(run_id) AS run_id,
      CASE WHEN bool_and(evidence = 'observed') THEN 'memory'
        WHEN min(run_id) IS NOT NULL OR bool_or(task_title IS NOT NULL) THEN 'task' ELSE 'action' END AS kind,
      (array_agg(task_title ORDER BY recorded_at DESC, id DESC) FILTER (WHERE task_title IS NOT NULL))[1] AS task_title,
      (array_agg(outcome ORDER BY recorded_at DESC, id DESC) FILTER (WHERE outcome IS NOT NULL))[1] AS outcome,
      (array_agg(current_step ORDER BY recorded_at DESC, id DESC) FILTER (WHERE status = 'running' AND current_step IS NOT NULL))[1] AS current_step,
      coalesce(array_agg(DISTINCT resource ORDER BY resource) FILTER (WHERE resource IS NOT NULL), ARRAY[]::text[]) AS resources,
      CASE WHEN bool_and(evidence = 'reported') THEN 'reported' WHEN bool_and(evidence = 'observed') THEN 'observed' ELSE 'mixed' END AS evidence,
      array_agg(DISTINCT tool ORDER BY tool) AS tools,
      count(*) FILTER (WHERE status = 'running' AND recorded_at >= bounds.recent_cutoff) AS working_actions,
      count(*) FILTER (WHERE status = 'running' AND recorded_at < bounds.recent_cutoff) AS stale_actions
    FROM ledger CROSS JOIN bounds GROUP BY activity_id`;
}
function projection(db: postgres.Sql) {
  // These correlated aggregates run only for the paginated activities. Filters
  // choose whole activities first, so their other contributors are retained.
  return db`p.*,
    coalesce((SELECT jsonb_agg(to_jsonb(contributor) ORDER BY contributor.last_active_at DESC, contributor.name) FROM (
      SELECT agent AS name,
        CASE WHEN bool_or(status = 'running') THEN 'running' WHEN bool_or(status = 'failed') THEN 'failed' ELSE 'completed' END AS status,
        count(*) AS action_count, max(recorded_at) AS last_active_at,
        (array_agg(jsonb_build_object('harness', harness, 'source_label', source_label, 'source_kind', source_kind)
          ORDER BY (source_kind = 'registered') DESC, recorded_at DESC, id DESC) FILTER (WHERE source_kind IS NOT NULL))[1] AS source,
        count(*) FILTER (WHERE status = 'running' AND recorded_at >= bounds.recent_cutoff) AS working_actions,
        count(*) FILTER (WHERE status = 'running' AND recorded_at < bounds.recent_cutoff) AS stale_actions
      FROM ledger CROSS JOIN bounds WHERE activity_id = p.activity_id GROUP BY agent
    ) contributor), '[]'::jsonb) AS agents,
    coalesce((SELECT jsonb_agg(jsonb_build_object('text', method.approach, 'agent', method.agent, 'evidence', method.evidence)
      ORDER BY method.first_reported_at ASC, method.agent, method.approach) FROM (
        SELECT agent, approach, evidence, min(recorded_at) AS first_reported_at FROM ledger
        WHERE activity_id = p.activity_id AND nullif(approach, '') IS NOT NULL GROUP BY agent, approach, evidence
      ) method), '[]'::jsonb) AS approaches`;
}
function matches(db: postgres.Sql, query: ActionsQuery) {
  return db`
    (${query.runId}::text IS NULL OR run_id = ${query.runId})
    AND (${query.agent}::text IS NULL OR EXISTS (SELECT 1 FROM ledger WHERE activity_id = grouped.activity_id AND agent = ${query.agent}))
    AND (${query.tool}::text IS NULL OR EXISTS (SELECT 1 FROM ledger WHERE activity_id = grouped.activity_id AND tool = ${query.tool}))
    AND (${query.resource}::text IS NULL OR EXISTS (SELECT 1 FROM ledger WHERE activity_id = grouped.activity_id AND strpos(lower(coalesce(resource, '')), lower(${query.resource})) > 0))
    AND (${query.q}::text IS NULL OR EXISTS (SELECT 1 FROM ledger WHERE activity_id = grouped.activity_id
      AND strpos(lower(concat_ws(' ', summary, task_title, outcome, current_step, resource, detail, approach, agent, tool, run_id)), lower(${query.q})) > 0))`;
}

export async function listActivities(token: TokenRecord, raw: unknown = {}, db: postgres.Sql = sql, now = new Date()) {
  const actor = actionActorFor(token, false), query = parseActionsQuery(raw), view = parseActivityView(raw);
  const ledger = activityLedger(db, actor.orgId), groups = grouped(db), columns = projection(db), filter = matches(db, query);
  const recent = new Date(now.getTime() - 900_000).toISOString();
  const rows = await db`
    WITH all_ledger AS (${ledger}),
    ledger AS (SELECT * FROM all_ledger candidate WHERE ${view}::text = 'all'
      OR (${view}::text = 'tasks' AND EXISTS (SELECT 1 FROM all_ledger related WHERE related.activity_id = candidate.activity_id AND related.evidence = 'reported'))
      OR (${view}::text = 'memory' AND NOT EXISTS (SELECT 1 FROM all_ledger related WHERE related.activity_id = candidate.activity_id AND related.evidence = 'reported'))),
    bounds AS (SELECT ${recent}::timestamptz AS recent_cutoff), grouped AS (${groups}),
    matching AS (SELECT * FROM grouped WHERE ${filter}),
    page AS (SELECT * FROM matching WHERE (${query.status}::text IS NULL OR status = ${query.status})
      ORDER BY updated_at DESC, activity_id DESC LIMIT ${query.limit + 1} OFFSET ${query.offset}),
    projected AS (SELECT ${columns} FROM page p)
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(projected) ORDER BY updated_at DESC, activity_id DESC) FROM projected), '[]'::jsonb) AS activities,
      (SELECT count(*) FROM matching) AS total,
      (SELECT count(*) FROM matching WHERE status = 'running') AS running,
      (SELECT count(*) FROM matching WHERE status = 'completed') AS completed,
      (SELECT count(*) FROM matching WHERE status = 'failed') AS failed,
      (SELECT array_agg(DISTINCT agent ORDER BY agent) FROM ledger) AS agents,
      (SELECT array_agg(DISTINCT tool ORDER BY tool) FROM ledger) AS tools`;
  const row = rows[0] ?? {}, activities = Array.isArray(row.activities) ? row.activities : [];
  return {
    activities: activities.slice(0, query.limit).map(mapActivity), more: activities.length > query.limit,
    agents: Array.isArray(row.agents) ? row.agents.map(String) : [], tools: Array.isArray(row.tools) ? row.tools.map(String) : [],
    stats: { running: amount(row.running), completed: amount(row.completed), failed: amount(row.failed), total: amount(row.total) },
    checkedAt: now.toISOString(), freshnessSeconds: 900, kind: view,
  };
}

export async function getActivity(token: TokenRecord, id: string, db: postgres.Sql = sql, now = new Date()): Promise<{ activity: Activity & { actions: Action[] } }> {
  const actor = actionActorFor(token, false), activityId = validateActivityId(id);
  const ledger = activityLedger(db, actor.orgId), groups = grouped(db), columns = projection(db);
  const recent = new Date(now.getTime() - 900_000).toISOString();
  const rows = await db`
    WITH ledger AS (${ledger}), bounds AS (SELECT ${recent}::timestamptz AS recent_cutoff), grouped AS (${groups})
    SELECT ${columns},
      (SELECT jsonb_agg(to_jsonb(child) ORDER BY started_at ASC, occurred_at ASC, recorded_at ASC, id ASC)
        FROM ledger child WHERE child.activity_id = p.activity_id) AS actions
    FROM grouped p WHERE p.activity_id = ${activityId}`;
  if (!rows[0]) throw new ActionError("Activity not found", 404);
  return { activity: { ...mapActivity(rows[0]), actions: (Array.isArray(rows[0].actions) ? rows[0].actions : []).map(mapAction) } };
}

export async function handleActivitiesApi(req: Request, token: TokenRecord, db: postgres.Sql = sql): Promise<Response> {
  try {
    // Authorization precedes identifier parsing and all storage access.
    actionActorFor(token, false);
    if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
    const url = new URL(req.url);
    if (url.pathname === "/api/activities") return Response.json(await listActivities(token, url.searchParams, db), { headers: HEADERS });
    let id: string;
    try { id = decodeURIComponent(url.pathname.slice("/api/activities/".length)); } catch { throw new ActionError("Invalid activity identifier"); }
    return Response.json(await getActivity(token, id, db), { headers: HEADERS });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: error.status, headers: HEADERS });
    return Response.json({ error: "Activity history is temporarily unavailable" }, { status: 503, headers: HEADERS });
  }
}
