import { createHash } from "node:crypto";
import type postgres from "postgres";
import { currentOrg } from "./context";
import { sql } from "./db";
import { oauthActorName, parseScopes } from "./oauth";
import { hasOauthScope, isHuman, normalizeToken, type TokenRecord } from "./policies";
import { redactSecrets } from "./redact";

export type ConnectionStatus = "authorized" | "expired" | "revoked" | "membership_removed";
export interface Connection {
  id: string;
  kind: "token" | "oauth";
  name: string;
  displayName: string;
  agent: string;
  harness: string | null;
  sourceLabel: string | null;
  status: ConnectionStatus;
  canWrite: boolean;
  createdAt: string;
  lastAuthenticatedAt: string | null;
  lastContactAt: string | null;
  lastMemoryAt: string | null;
  lastSuccessfulContactAt: string | null;
  lastSuccessfulMemoryAt: string | null;
  lastTaskReportAt: string | null;
  memoryCalls: number;
  successfulMemoryCalls: number;
  taskReports: number;
}
export const CONNECTION_LIMIT = 200;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// Exact metadata labels only: these are display hints, never proof of the
// application, model, identity or current execution behind an authorization.
const CLIENT_SOURCES: Record<string, { harness: string; label: string }> = {
  "codex": { harness: "codex", label: "Codex" },
  "codex desktop": { harness: "codex", label: "Codex" },
  "codex cli": { harness: "codex", label: "Codex" },
  "openai codex": { harness: "codex", label: "Codex" },
  "claude": { harness: "claude", label: "Claude" },
  "claude code": { harness: "claude-code", label: "Claude Code" },
  "claude-code": { harness: "claude-code", label: "Claude Code" },
  "chatgpt": { harness: "chatgpt", label: "ChatGPT" },
  "cursor": { harness: "cursor", label: "Cursor" },
  "grok": { harness: "grok", label: "Grok" },
  "grokbot": { harness: "grok-bot", label: "GrokBot" },
  "grok-bot": { harness: "grok-bot", label: "GrokBot" },
  "openclaw": { harness: "openclaw", label: "OpenClaw" },
  "hermes": { harness: "hermes", label: "Hermes" },
  "hermes agent": { harness: "hermes", label: "Hermes" },
};
const HARNESS_LABELS: Record<string, string> = Object.fromEntries(Object.values(CLIENT_SOURCES).map(value => [value.harness, value.label]));
function safeText(value: unknown, max = 100): string | null { return typeof value === "string" && value.trim() ? redactSecrets(value.trim()).slice(0, max) : null; }
function date(value: unknown): string | null { if (!value) return null; const parsed = new Date(value as string); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null; }
function count(value: unknown): number { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
function authorize(token: TokenRecord) {
  const actor = normalizeToken(token), org = currentOrg();
  if (!isHuman(actor) || actor.kind === "oauth" || (org && org.id !== actor.orgId)) throw new ConnectionError("forbidden", 403);
  return actor;
}
export class ConnectionError extends Error { constructor(message: string, public status = 400) { super(message); } }

function mapConnection(row: any, orgId: number): Connection {
  const oauth = row.kind === "oauth";
  const agent = oauth ? oauthActorName({ sub: String(row.email), client_id: String(row.client_id) }) : String(row.name);
  const clientLabel = String(row.client_name ?? "").trim().toLowerCase();
  const source = oauth && Object.hasOwn(CLIENT_SOURCES, clientLabel) ? CLIENT_SOURCES[clientLabel] : undefined;
  const harness = oauth ? source?.harness ?? null : safeText(row.harness, 80);
  const sourceLabel = oauth ? safeText(row.client_name) : safeText(row.source_label);
  const name = oauth ? sourceLabel ?? "OAuth connection" : safeText(row.name, 200) ?? "API connection";
  const id = oauth ? `oauth:${createHash("sha256").update(JSON.stringify([orgId, row.email, row.client_id])).digest("hex")}` : `token:${row.id}`;
  const status: ConnectionStatus = ["authorized", "revoked", "membership_removed"].includes(row.status) ? row.status : "expired";
  const canWrite = oauth ? hasOauthScope(normalizeToken({ name: agent, orgId, kind: "oauth", scopes: parseScopes(row.scope) }), "memory:write") : row.can_write !== false;
  return {
    id, kind: oauth ? "oauth" : "token", name,
    displayName: oauth ? source?.label ?? "OAuth connection" : sourceLabel ?? (harness && Object.hasOwn(HARNESS_LABELS, harness) ? HARNESS_LABELS[harness] : null) ?? name,
    agent, harness, sourceLabel, status, canWrite,
    createdAt: date(row.created_at)!, lastAuthenticatedAt: oauth ? null : date(row.last_authenticated_at),
    lastContactAt: date(row.last_contact_at), lastMemoryAt: date(row.last_memory_at), lastTaskReportAt: date(row.last_task_report_at),
    lastSuccessfulContactAt: date(row.last_successful_contact_at), lastSuccessfulMemoryAt: date(row.last_successful_memory_at),
    memoryCalls: count(row.memory_calls), successfulMemoryCalls: count(row.successful_memory_calls), taskReports: count(row.task_reports),
  };
}

export async function listConnections(token: TokenRecord, db: postgres.Sql = sql, now = new Date()) {
  const actor = authorize(token);
  // Select only display/authorization metadata. Never fetch hashes, raw bearer
  // values, authorization codes, callback URLs or unrelated global clients.
  const rows = await db.begin("isolation level repeatable read read only", async tx => {
    const inventory = await tx`
    WITH token_connections AS (
      SELECT t.id::text AS id, 'token'::text AS kind, t.name,
        NULL::text AS email, NULL::text AS client_id, NULL::text AS client_name, NULL::text AS scope,
        t.harness, t.source_label, t.can_write, t.created_at, t.last_used_at AS last_authenticated_at,
        CASE WHEN t.issuer_kind = 'member' AND (m.id IS NULL OR m.role NOT IN ('owner', 'member')) THEN 'membership_removed'
          WHEN t.revoked_at IS NOT NULL THEN 'revoked' ELSE 'authorized' END AS status
      FROM tokens t LEFT JOIN org_members m ON m.id = t.issued_by_member_id
        AND m.org_id = t.org_id AND m.email = t.issued_by_email
      WHERE t.org_id = ${actor.orgId} AND left(t.name, 25) <> 'operator-candidate-smoke-'
    ), oauth_grants AS (
      SELECT r.id::text AS id, 'oauth'::text AS kind, NULL::text AS name,
        r.email, r.client_id, c.client_name, r.scope, NULL::text AS harness, NULL::text AS source_label,
        true AS can_write, r.created_at, NULL::timestamptz AS last_authenticated_at,
        CASE WHEN m.id IS NULL OR m.role NOT IN ('owner', 'member') THEN 'membership_removed'
          WHEN r.membership_id IS NULL THEN 'expired'
          WHEN m.id <> r.membership_id THEN 'membership_removed'
          WHEN r.revoked_at IS NOT NULL THEN 'revoked'
          WHEN r.expires_at <= ${now.toISOString()}::timestamptz THEN 'expired' ELSE 'authorized' END AS status
      FROM oauth_refresh_tokens r
      LEFT JOIN org_members m ON m.org_id = r.org_id AND m.email = r.email
      LEFT JOIN oauth_clients c ON c.client_id = r.client_id
      WHERE r.org_id = ${actor.orgId}
    ), oauth_ranked AS (
      SELECT *, row_number() OVER (PARTITION BY email, client_id ORDER BY (status = 'authorized') DESC, created_at DESC, id DESC) AS grant_rank
      FROM oauth_grants
    ), inventory AS (
      SELECT * FROM token_connections
      UNION ALL SELECT id, kind, name, email, client_id, client_name, scope, harness, source_label, can_write, created_at, last_authenticated_at, status
      FROM oauth_ranked WHERE grant_rank = 1
    )
    SELECT * FROM inventory ORDER BY created_at DESC, kind, id DESC LIMIT ${CONNECTION_LIMIT + 1}`;
    const page = inventory.slice(0, CONNECTION_LIMIT);
    // Use the same JS encoder as authentication for every UTF-8/punctuation
    // case. A fixed pair of batched receipt queries avoids N per-row queries.
    const agents = page.map(row => row.kind === "oauth" ? oauthActorName({ sub: String(row.email), client_id: String(row.client_id) }) : String(row.name));
    if (!agents.length) return inventory;
    const [observed, reported] = await Promise.all([
      tx`SELECT token_name AS agent, max(ts) AS contact_at,
          max(ts) FILTER (WHERE outcome = 'ok') AS successful_contact_at,
          max(ts) FILTER (WHERE tool NOT IN ('whoami', 'list_actions', 'record_action')) AS last_memory_at,
          count(*) FILTER (WHERE tool NOT IN ('whoami', 'list_actions', 'record_action')) AS memory_calls,
          max(ts) FILTER (WHERE outcome = 'ok' AND tool NOT IN ('whoami', 'list_actions', 'record_action')) AS last_successful_memory_at,
          count(*) FILTER (WHERE outcome = 'ok' AND tool NOT IN ('whoami', 'list_actions', 'record_action')) AS successful_memory_calls
        FROM audit_log WHERE org_id = ${actor.orgId} AND token_name = ANY(${agents}) GROUP BY token_name`,
      tx`SELECT agent, max(recorded_at) AS last_task_report_at, count(*) AS task_reports
        FROM action_events WHERE org_id = ${actor.orgId} AND agent = ANY(${agents}) GROUP BY agent`,
    ]);
    const memory = new Map(observed.map(row => [row.agent, row]));
    const reports = new Map(reported.map(row => [row.agent, row]));
    return inventory.map((row, index) => {
      const contact = memory.get(agents[index]), report = reports.get(agents[index]);
      const latest = [date(contact?.contact_at), date(report?.last_task_report_at)].filter((value): value is string => value !== null).sort().at(-1) ?? null;
      const successful = [date(contact?.successful_contact_at), date(report?.last_task_report_at)].filter((value): value is string => value !== null).sort().at(-1) ?? null;
      return { ...row, last_contact_at: latest, last_memory_at: contact?.last_memory_at,
        last_successful_contact_at: successful, last_successful_memory_at: contact?.last_successful_memory_at,
        memory_calls: contact?.memory_calls ?? 0, successful_memory_calls: contact?.successful_memory_calls ?? 0,
        last_task_report_at: report?.last_task_report_at, task_reports: report?.task_reports ?? 0 };
    });
  });
  return { connections: rows.slice(0, CONNECTION_LIMIT).map(row => mapConnection(row, actor.orgId)), more: rows.length > CONNECTION_LIMIT, limit: CONNECTION_LIMIT, checkedAt: now.toISOString(), recentWindowSeconds: 900 };
}

export interface AgentOnboardingChecks {
  agentConnected: boolean;
  memorySaved: boolean;
  memoryRecalled: boolean;
  taskReported: boolean;
}

// Progress comes from successful server receipts for currently usable agents,
// never credential issuance, existing pages, browser captures or a clicked CTA.
// Unlike the bounded Connections inventory this reads every eligible agent.
export async function agentOnboardingChecks(orgId: number, db: postgres.Sql = sql, now = new Date()): Promise<AgentOnboardingChecks> {
  if (!Number.isSafeInteger(orgId) || orgId < 1 || (currentOrg() && currentOrg()!.id !== orgId)) throw new ConnectionError("forbidden", 403);
  return db.begin("isolation level repeatable read read only", async tx => {
    const credentials = await tx`
      SELECT 'token' AS kind, t.name, NULL::text AS email, NULL::text AS client_id, t.created_at AS since
      FROM tokens t LEFT JOIN org_members m ON m.id = t.issued_by_member_id
        AND m.org_id = t.org_id AND m.email = t.issued_by_email
      WHERE t.org_id = ${orgId} AND t.role = 'agent' AND t.revoked_at IS NULL
        AND left(t.name, 25) <> 'operator-candidate-smoke-'
        AND (t.issuer_kind IN ('operator', 'legacy') OR
          (t.issuer_kind = 'member' AND m.id IS NOT NULL AND m.role IN ('owner', 'member')))
      UNION ALL
      SELECT 'oauth' AS kind, NULL::text AS name, r.email, r.client_id, m.created_at AS since
      FROM oauth_refresh_tokens r JOIN org_members m ON m.org_id = r.org_id AND m.email = r.email AND m.id = r.membership_id
      WHERE r.org_id = ${orgId} AND m.role IN ('owner', 'member')
        AND r.revoked_at IS NULL AND r.expires_at > ${now.toISOString()}::timestamptz
      GROUP BY r.email, r.client_id, m.created_at`;
    const empty = { agentConnected: false, memorySaved: false, memoryRecalled: false, taskReported: false };
    if (!credentials.length) return empty;
    const agents = credentials.map(row => row.kind === "oauth" ? oauthActorName({ sub: String(row.email), client_id: String(row.client_id) }) : String(row.name));
    const since = credentials.map(row => new Date(row.since).toISOString());
    // Historical receipts identify actors by name. If a browser session used
    // that same name during the receipt's lifetime, attribution is ambiguous:
    // conservatively exclude it rather than count console work as an agent.
    const [observed] = await tx`
      SELECT coalesce(bool_or(a.outcome = 'ok'), false) AS connected,
        coalesce(bool_or(a.outcome = 'ok' AND a.tool IN ('remember', 'put_page')), false) AS saved,
        coalesce(bool_or(a.outcome = 'ok' AND a.tool IN ('recall', 'search', 'get_page')), false) AS recalled
      FROM audit_log a JOIN unnest(${agents}::text[], ${since}::timestamptz[]) AS eligible(agent, since)
        ON a.token_name = eligible.agent AND a.ts >= eligible.since
      WHERE a.org_id = ${orgId} AND NOT EXISTS (
        SELECT 1 FROM sessions s WHERE s.org_id = a.org_id AND s.name = a.token_name
          AND a.ts >= s.created_at AND a.ts <= least(s.expires_at, coalesce(s.revoked_at, s.expires_at)))`;
    const [reported] = await tx`
      SELECT EXISTS (
        SELECT 1 FROM action_events a JOIN unnest(${agents}::text[], ${since}::timestamptz[]) AS eligible(agent, since)
          ON a.agent = eligible.agent AND a.recorded_at >= eligible.since
        WHERE a.org_id = ${orgId} AND NOT EXISTS (
          SELECT 1 FROM sessions s WHERE s.org_id = a.org_id AND s.name = a.agent
            AND a.recorded_at >= s.created_at AND a.recorded_at <= least(s.expires_at, coalesce(s.revoked_at, s.expires_at)))) AS reported`;
    const taskReported = reported?.reported === true;
    return { agentConnected: observed?.connected === true || taskReported, memorySaved: observed?.saved === true, memoryRecalled: observed?.recalled === true, taskReported };
  });
}

export async function handleConnectionsApi(req: Request, token: TokenRecord, db: postgres.Sql = sql): Promise<Response> {
  try {
    authorize(token);
    if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
    return Response.json(await listConnections(token, db), { headers: HEADERS });
  } catch (error) {
    if (error instanceof ConnectionError) return Response.json({ error: error.message }, { status: error.status, headers: HEADERS });
    return Response.json({ error: "Connection inventory is temporarily unavailable" }, { status: 503, headers: HEADERS });
  }
}
