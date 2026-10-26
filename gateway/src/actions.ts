import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { currentOrg } from "./context";
import { sql } from "./db";
import { canUseTool, DEFAULT_POLICIES, hasOauthScope, normalizeToken, type TokenRecord } from "./policies";
import { redactSecrets } from "./redact";
import { parseReportedSource } from "./agent-source";

export type ActionStatus = "completed" | "failed" | "running";

export interface Action {
  id: string;
  agent: string;
  tool: string;
  summary: string;
  resource: string | null;
  status: ActionStatus;
  evidence: "reported" | "observed";
  runId: string | null;
  actionKey: string | null;
  eventId: string | null;
  occurredAt: string;
  recordedAt: string;
  detail: string | null;
  approach: string | null;
  startedAt: string;
  taskTitle: string | null;
  outcome: string | null;
  currentStep: string | null;
  harness: string | null;
  sourceLabel: string | null;
  sourceKind: "registered" | "reported" | null;
}

export class ActionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const STATUSES = new Set(["completed", "failed", "running"]);
const INPUT_FIELDS = new Set(["tool", "summary", "resource", "status", "runId", "occurredAt", "detail", "actionKey", "eventId", "approach", "taskTitle", "outcome", "currentStep", "harness", "sourceLabel"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ActionError("Expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new ActionError(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") throw new ActionError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.includes("\0")) throw new ActionError(`${name} must not contain null characters`);
  if (trimmed.length > max) throw new ActionError(`${name} must be at most ${max} characters`);
  if (!trimmed && required) throw new ActionError(`${name} is required`);
  return trimmed ? redactSecrets(trimmed) : null;
}

function identifier(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)) {
    throw new ActionError(`${name} must be an opaque identifier of 1–200 letters, numbers, dots, underscores, colons, slashes, or hyphens`);
  }
  if (redactSecrets(value) !== value) throw new ActionError(`${name} must not contain credentials`);
  return value;
}

export function parseActionInput(raw: unknown, now = new Date()) {
  const input = object(raw);
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.has(key)) throw new ActionError(`Unknown action field: ${key}`);
  }
  const tool = text(input.tool, "tool", 160, true)!;
  const summary = text(input.summary, "summary", 500, true)!;
  const status = input.status ?? "completed";
  if (typeof status !== "string" || !STATUSES.has(status)) throw new ActionError("status must be completed, failed, or running");
  const rawTime = text(input.occurredAt, "occurredAt", 40);
  // Require a timezone: interpreting a local date differently on each server would
  // put the same reported action at different places on the timeline.
  if (rawTime && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(rawTime)) {
    throw new ActionError("occurredAt must be an ISO timestamp with a timezone");
  }
  const occurredAt = rawTime ? new Date(rawTime) : now;
  if (rawTime) {
    const [year, month, day] = rawTime.slice(0, 10).split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth) throw new ActionError("occurredAt must be a valid date");
  }
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() < 0 || occurredAt.getTime() > now.getTime() + 300_000) {
    throw new ActionError("occurredAt must be a valid timestamp no more than five minutes in the future");
  }
  let source: ReturnType<typeof parseReportedSource>;
  try { source = parseReportedSource(input.harness, input.sourceLabel); }
  catch (error) { throw new ActionError(error instanceof Error ? error.message : "Invalid source metadata"); }
  return {
    tool, summary, status: status as ActionStatus,
    taskTitle: text(input.taskTitle, "taskTitle", 300),
    outcome: text(input.outcome, "outcome", 2_000),
    currentStep: text(input.currentStep, "currentStep", 500),
    ...source,
    resource: text(input.resource, "resource", 2_000),
    runId: text(input.runId, "runId", 200),
    detail: text(input.detail, "detail", 20_000),
    approach: text(input.approach, "approach", 1_000),
    actionKey: identifier(input.actionKey, "actionKey"),
    eventId: identifier(input.eventId, "eventId"),
    occurredAt: occurredAt.toISOString(),
    explicitOccurredAt: Boolean(rawTime),
  };
}

export function actionInputFingerprint(input: ReturnType<typeof parseActionInput>): string {
  // Default receipt-time timestamps change between retries. Only a timestamp the
  // caller actually supplied is part of the canonical client payload.
  return createHash("sha256").update(JSON.stringify({
    tool: input.tool, summary: input.summary, resource: input.resource,
    status: input.status, runId: input.runId, detail: input.detail,
    actionKey: input.actionKey, occurredAt: input.explicitOccurredAt ? input.occurredAt : null,
    // Preserve fingerprints for reports stored before optional approaches were
    // added, so an identical legacy eventId retry remains idempotent.
    ...(input.approach ? { approach: input.approach } : {}),
    ...(input.taskTitle ? { taskTitle: input.taskTitle } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.currentStep ? { currentStep: input.currentStep } : {}),
    ...(input.harness ? { harness: input.harness } : {}),
    ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
  })).digest("hex");
}

export interface ActionsQuery {
  id: string | null;
  q: string | null;
  agent: string | null;
  tool: string | null;
  status: string | null;
  resource: string | null;
  runId: string | null;
  limit: number;
  offset: number;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") throw new ActionError("Pagination must use integers");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ActionError("Pagination must use integers");
  return Math.min(max, Math.max(min, parsed));
}

export function parseActionsQuery(raw: unknown): ActionsQuery {
  const input = raw instanceof URLSearchParams ? Object.fromEntries(raw) : object(raw);
  const id = text(input.id, "id", 80);
  if (id && !/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|audit:[0-9]{1,20})$/i.test(id)) throw new ActionError("id must be an action UUID or observed audit identifier");
  const status = text(input.status, "status", 20);
  if (status && !STATUSES.has(status)) throw new ActionError("status must be completed, failed, or running");
  return {
    id,
    q: text(input.q, "q", 500),
    agent: text(input.agent, "agent", 500),
    tool: text(input.tool, "tool", 160),
    resource: text(input.resource, "resource", 2_000),
    runId: text(input.runId, "runId", 200),
    status,
    limit: boundedInt(input.limit, 40, 1, 100),
    offset: boundedInt(input.offset, 0, 0, 1_000_000),
  };
}

export function actionActorFor(token: TokenRecord, write: boolean): TokenRecord {
  const actor = normalizeToken(token);
  const org = currentOrg();
  if (org && org.id !== actor.orgId) throw new ActionError("Organization mismatch", 403);
  if (!hasOauthScope(actor, write ? "memory:write" : "memory:read") ||
      (write && (!actor.canWrite || !canUseTool(actor, "record_action", org?.policies ?? DEFAULT_POLICIES)))) {
    throw new ActionError("This token cannot " + (write ? "record actions" : "read actions"), 403);
  }
  return actor;
}

export function mapAction(row: any): Action {
  return {
    id: String(row.id), agent: String(row.agent), tool: String(row.tool),
    summary: redactSecrets(String(row.summary)),
    resource: row.resource ? redactSecrets(String(row.resource)) : null,
    status: row.status, evidence: row.evidence,
    runId: row.run_id ? redactSecrets(String(row.run_id)) : null,
    actionKey: row.action_key ? String(row.action_key) : null,
    eventId: row.event_id ? String(row.event_id) : null,
    occurredAt: new Date(row.occurred_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
    detail: row.detail ? redactSecrets(String(row.detail)) : null,
    approach: row.approach ? redactSecrets(String(row.approach)) : null,
    startedAt: new Date(row.started_at ?? row.occurred_at).toISOString(),
    taskTitle: row.task_title ? redactSecrets(String(row.task_title)) : null,
    outcome: row.outcome ? redactSecrets(String(row.outcome)) : null,
    currentStep: row.status === "running" && row.current_step ? redactSecrets(String(row.current_step)) : null,
    harness: row.harness ? String(row.harness) : null,
    sourceLabel: row.source_label ? redactSecrets(String(row.source_label)) : null,
    sourceKind: row.source_kind === "registered" || row.source_kind === "reported" ? row.source_kind : null,
  };
}

export async function recordAction(token: TokenRecord, raw: unknown, db: postgres.Sql = sql): Promise<{ action: Action }> {
  const actor = actionActorFor(token, true);
  const input = parseActionInput(raw);
  const fingerprint = actionInputFingerprint(input);
  const registered = actor.source?.kind === "registered" ? actor.source : null;
  const harness = registered?.harness ?? input.harness;
  const sourceLabel = registered ? registered.label : input.sourceLabel;
  const sourceKind = registered ? "registered" : (harness || sourceLabel) ? "reported" : null;
  return db.begin(async transaction => {
    // Serialize this authenticated agent's reports, including event-id retries
    // across different action keys. The database lock also spans app instances.
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([actor.orgId, actor.name])}, 0))`;
    if (input.eventId) {
      const existing = await transaction`
        SELECT * FROM action_events
        WHERE org_id = ${actor.orgId} AND agent = ${actor.name} AND event_id = ${input.eventId}`;
      if (existing[0]) {
        if (existing[0].payload_fingerprint !== fingerprint) throw new ActionError("eventId was already used for a different action report", 409);
        return { action: mapAction(existing[0]) };
      }
    }
    if (input.actionKey) {
      const previous = await transaction`
        SELECT tool, status, run_id, occurred_at FROM action_events
        WHERE org_id = ${actor.orgId} AND agent = ${actor.name} AND action_key = ${input.actionKey}
        ORDER BY occurred_at DESC, recorded_at DESC, (status <> 'running') DESC, id DESC LIMIT 1`;
      if (previous[0]) {
        if (previous[0].tool !== input.tool) throw new ActionError("An actionKey cannot change tools", 409);
        if ((previous[0].run_id ?? null) !== input.runId) throw new ActionError("An actionKey cannot change its runId", 409);
        if (previous[0].status !== "running") throw new ActionError("This action has ended; use a new actionKey for another attempt", 409);
        if (new Date(input.occurredAt).getTime() < new Date(previous[0].occurred_at).getTime()) {
          throw new ActionError("An action update cannot precede its latest event", 409);
        }
      }
    }
    const rows = await transaction`
      INSERT INTO action_events (id, org_id, agent, tool, summary, resource, status, evidence, run_id, occurred_at, detail, action_key, event_id, payload_fingerprint, approach, task_title, outcome, current_step, harness, source_label, source_kind, recorded_at)
      VALUES (${randomUUID()}, ${actor.orgId}, ${actor.name}, ${input.tool}, ${input.summary}, ${input.resource},
              ${input.status}, 'reported', ${input.runId}, ${input.occurredAt}, ${input.detail}, ${input.actionKey}, ${input.eventId}, ${fingerprint}, ${input.approach}, ${input.taskTitle}, ${input.outcome}, ${input.currentStep}, ${harness}, ${sourceLabel}, ${sourceKind}, clock_timestamp())
      RETURNING *`;
    return { action: mapAction(rows[0]) };
  }) as Promise<{ action: Action }>;
}

// Both the private history and public aggregates consume the latest logical
// action, while the underlying lifecycle events remain append-only. The boolean
// partition flag keeps a legacy event ID distinct from an identical action key.
export function actionLedger(db: postgres.Sql, orgId: number, options: { aggregate?: boolean } = {}) {
  const privateHistory = options.aggregate ? db`` : db`,
    first_value(nullif(approach, '')) OVER (
      PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
      ORDER BY (nullif(approach, '') IS NULL) ASC, occurred_at DESC, recorded_at DESC, id DESC
    ) AS effective_approach,
    first_value(summary) OVER (
      PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
      ORDER BY occurred_at ASC, recorded_at ASC, id ASC
    ) AS first_summary,
    first_value(nullif(task_title, '')) OVER (
      PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
      ORDER BY (nullif(task_title, '') IS NULL) ASC, occurred_at DESC, recorded_at DESC, id DESC
    ) AS effective_task_title,
    first_value(nullif(outcome, '')) OVER (
      PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
      ORDER BY (nullif(outcome, '') IS NULL) ASC, occurred_at DESC, recorded_at DESC, id DESC
    ) AS effective_outcome,
    first_value(nullif(current_step, '')) OVER (
      PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
      ORDER BY (nullif(current_step, '') IS NULL) ASC, occurred_at DESC, recorded_at DESC, id DESC
    ) AS effective_current_step,
    first_value(jsonb_build_object('harness', harness, 'source_label', source_label, 'source_kind', source_kind)) OVER (
      PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
      ORDER BY (harness IS NULL AND source_label IS NULL) ASC, occurred_at DESC, recorded_at DESC, id DESC
    ) AS effective_source`;
  const reports = db`
    SELECT * FROM (
      SELECT *, row_number() OVER (
        PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
        ORDER BY occurred_at DESC, recorded_at DESC, (status <> 'running') DESC, id DESC
      ) AS action_version, min(occurred_at) OVER (
        PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
      ) AS started_at ${privateHistory}
      FROM action_events WHERE org_id = ${orgId}
    ) latest_reports WHERE action_version = 1`;
  if (options.aggregate) return db`
    SELECT agent, lower(tool) AS tool, status, occurred_at, recorded_at FROM (${reports}) reports
    WHERE tool NOT IN ('list_actions', 'record_action', 'whoami')
    UNION ALL
    SELECT token_name, lower(tool), CASE WHEN outcome = 'ok' THEN 'completed' ELSE 'failed' END, ts, ts
    FROM audit_log WHERE org_id = ${orgId} AND tool NOT IN ('list_actions', 'record_action', 'whoami')`;
  return db`
    SELECT id, agent, tool, summary, resource, status, evidence, run_id, occurred_at, recorded_at, detail, action_key, event_id, effective_approach AS approach, started_at, first_summary,
           effective_task_title AS task_title, effective_outcome AS outcome,
           CASE WHEN status = 'running' THEN effective_current_step ELSE NULL END AS current_step,
           effective_source->>'harness' AS harness, effective_source->>'source_label' AS source_label, effective_source->>'source_kind' AS source_kind
    FROM (${reports}) reports
    UNION ALL
    SELECT 'audit:' || audit_log.id::text, token_name, tool,
           replace(tool, '_', ' ') || CASE WHEN outcome = 'ok' THEN '' ELSE ' (' || outcome || ')' END,
           CASE WHEN slug IS NOT NULL THEN 'engram://' || slug ELSE NULL END,
           CASE WHEN outcome = 'ok' THEN 'completed' ELSE 'failed' END,
           'observed', NULL, ts, ts, arg_summary, NULL, NULL, NULL, ts, NULL,
           NULL, NULL, NULL, registered_source.harness, registered_source.source_label,
           CASE WHEN registered_source.harness IS NOT NULL THEN 'registered' ELSE NULL END
    FROM audit_log LEFT JOIN tokens registered_source
      ON registered_source.org_id = audit_log.org_id AND registered_source.name = audit_log.token_name
    WHERE audit_log.org_id = ${orgId} AND tool NOT IN ('list_actions', 'record_action', 'whoami')`;
}

export async function listActions(token: TokenRecord, raw: unknown = {}, db: postgres.Sql = sql): Promise<{
  actions: Action[]; more: boolean; agents: string[]; tools: string[];
}> {
  const actor = actionActorFor(token, false);
  const query = parseActionsQuery(raw);
  // Audit records are direct evidence of Engram calls only. They do not imply
  // visibility into tools an agent executes elsewhere. Keep the two sources
  // distinct, without copying historical audit rows or manufacturing evidence.
  const ledger = actionLedger(db, actor.orgId);
  // strpos treats user input as literal text, including SQL wildcard characters.
  const [rows, facets] = await Promise.all([
    db`
      WITH ledger AS (${ledger}) SELECT * FROM ledger
      WHERE (${query.id}::text IS NULL OR id = ${query.id})
        AND (${query.agent}::text IS NULL OR agent = ${query.agent})
        AND (${query.tool}::text IS NULL OR tool = ${query.tool})
        AND (${query.status}::text IS NULL OR status = ${query.status})
        AND (${query.runId}::text IS NULL OR run_id = ${query.runId})
        AND (${query.resource}::text IS NULL OR strpos(lower(coalesce(resource, '')), lower(${query.resource})) > 0)
        AND (${query.q}::text IS NULL OR strpos(lower(concat_ws(' ', summary, task_title, outcome, current_step, resource, detail, approach, agent, tool, run_id)), lower(${query.q})) > 0)
      ORDER BY occurred_at DESC, recorded_at DESC, id DESC
      LIMIT ${query.limit + 1} OFFSET ${query.offset}`,
    db`
      WITH ledger AS (${ledger})
      SELECT array_agg(DISTINCT agent ORDER BY agent) AS agents,
             array_agg(DISTINCT tool ORDER BY tool) AS tools FROM ledger`,
  ]);
  return {
    actions: rows.slice(0, query.limit).map(mapAction), more: rows.length > query.limit,
    agents: facets[0]?.agents ?? [], tools: facets[0]?.tools ?? [],
  };
}
