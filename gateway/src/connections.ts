import type postgres from "postgres";
import { lockConnection, oauthConnectionId } from "./connection-identity";
import { currentOrg } from "./context";
import { config } from "./config";
import { sql } from "./db";
import { oauthActorName, parseScopes } from "./oauth";
import { hasOauthScope, isHuman, normalizeToken, type TokenRecord } from "./policies";
import { redactSecrets } from "./redact";
import { mapMemoryUse, type MemoryUse } from "./memory-usage";
import { connectionClient, type ConnectionClient } from "./connection-client";
import { mapAgentIdentity, type AgentIdentity } from "./agent-identity";

export type ConnectionStatus = "authorized" | "expired" | "revoked" | "membership_removed";
export interface Connection {
  id: string;
  kind: "token" | "oauth";
  name: string;
  displayName: string;
  agent: string;
  harness: string | null;
  sourceLabel: string | null;
  client: ConnectionClient;
  status: ConnectionStatus;
  canWrite: boolean;
  createdAt: string;
  archivedAt: string | null;
  lastAuthenticatedAt: string | null;
  lastContactAt: string | null;
  lastMemoryAt: string | null;
  lastSuccessfulContactAt: string | null;
  lastSuccessfulMemoryAt: string | null;
  lastTaskReportAt: string | null;
  memoryCalls: number;
  successfulMemoryCalls: number;
  taskReports: number;
  memoryUse: MemoryUse;
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
// A hosted sign-in can only finish on its provider's site, so that site is
// stronger evidence than the self-reported client name (Grok Bot registers as
// "Cursor"). The name refines the label only within the same provider.
const HOSTED_PROVIDERS: Record<string, { harnesses: string[]; source: { harness: string; label: string } }> = {
  claude: { harnesses: ["claude", "claude-code"], source: { harness: "claude", label: "Claude" } },
  chatgpt: { harnesses: ["chatgpt", "codex"], source: { harness: "chatgpt", label: "ChatGPT" } },
  grok: { harnesses: ["grok", "grok-bot"], source: { harness: "grok", label: "Grok" } },
};
function oauthSource(clientName: unknown, clientHost: unknown) {
  const key = String(clientName ?? "").trim().toLowerCase();
  const named = Object.hasOwn(CLIENT_SOURCES, key) ? CLIENT_SOURCES[key] : undefined;
  const hosted = typeof clientHost === "string" && Object.hasOwn(HOSTED_PROVIDERS, clientHost) ? HOSTED_PROVIDERS[clientHost] : undefined;
  if (!hosted) return { source: named, overridden: false };
  if (named && hosted.harnesses.includes(named.harness)) return { source: named, overridden: false };
  return { source: hosted.source, overridden: true };
}
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
  const resolved = oauth ? oauthSource(row.client_name, row.client_host) : { source: undefined, overridden: false };
  const source = resolved.source;
  const harness = oauth ? source?.harness ?? null : safeText(row.harness, 80);
  const sourceLabel = oauth ? (resolved.overridden ? source!.label : safeText(row.client_name)) : safeText(row.source_label);
  const name = oauth ? sourceLabel ?? "OAuth connection" : safeText(row.name, 200) ?? "API connection";
  const id = oauth ? oauthConnectionId(orgId, row.email, row.client_id) : `token:${row.id}`;
  const status: ConnectionStatus = ["authorized", "revoked", "membership_removed"].includes(row.status) ? row.status : "expired";
  const canWrite = oauth ? hasOauthScope(normalizeToken({ name: agent, orgId, kind: "oauth", scopes: parseScopes(row.scope) }), "memory:write") : row.can_write !== false;
  return {
    id, kind: oauth ? "oauth" : "token", name,
    displayName: oauth ? source?.label ?? "OAuth connection" : sourceLabel ?? (harness && Object.hasOwn(HARNESS_LABELS, harness) ? HARNESS_LABELS[harness] : null) ?? name,
    agent, harness, sourceLabel, status, canWrite,
    client: connectionClient(oauth ? [resolved.overridden ? source!.label : row.client_name] : row.client_names),
    createdAt: date(row.created_at)!, archivedAt: date(row.archived_at), lastAuthenticatedAt: oauth ? null : date(row.last_authenticated_at),
    lastContactAt: date(row.last_contact_at), lastMemoryAt: date(row.last_memory_at), lastTaskReportAt: date(row.last_task_report_at),
    lastSuccessfulContactAt: date(row.last_successful_contact_at), lastSuccessfulMemoryAt: date(row.last_successful_memory_at),
    memoryCalls: count(row.memory_calls), successfulMemoryCalls: count(row.successful_memory_calls), taskReports: count(row.task_reports),
    memoryUse: mapMemoryUse(row.memory_use),
  };
}

export async function listConnections(token: TokenRecord, db: postgres.Sql = sql, now = new Date()) {
  const actor = authorize(token);
  // Select only display/authorization metadata. Never fetch hashes, raw bearer
  // values, authorization codes, callback URLs or unrelated global clients.
  let identities: AgentIdentity[] = [];
  const rows = await db.begin("isolation level repeatable read read only", async tx => {
    const inventory = await tx`
    WITH token_connections AS (
      SELECT t.id::text AS id, 'token'::text AS kind, t.name,
        NULL::text AS email, NULL::text AS client_id, NULL::text AS client_name, NULL::text AS scope,
        t.harness, t.source_label, t.client_names, t.can_write, t.created_at, t.last_used_at AS last_authenticated_at, l.archived_at,
        CASE WHEN t.issuer_kind = 'member' AND (m.id IS NULL OR m.role NOT IN ('owner', 'member')) THEN 'membership_removed'
          WHEN t.revoked_at IS NOT NULL THEN 'revoked' ELSE 'authorized' END AS status,
        NULL::text AS client_host
      FROM tokens t LEFT JOIN org_members m ON m.id = t.issued_by_member_id
        AND m.org_id = t.org_id AND m.email = t.issued_by_email
      LEFT JOIN connection_lifecycle l ON l.org_id = t.org_id AND l.kind = 'token' AND l.token_id = t.id
      WHERE t.org_id = ${actor.orgId} AND left(t.name, 25) <> 'operator-candidate-smoke-' AND l.deleted_at IS NULL
    ), oauth_grants AS (
      SELECT r.id::text AS id, 'oauth'::text AS kind, NULL::text AS name,
        r.email, r.client_id, c.client_name, r.scope, NULL::text AS harness, NULL::text AS source_label, NULL::jsonb AS client_names,
        true AS can_write, r.created_at, NULL::timestamptz AS last_authenticated_at, l.archived_at,
        CASE WHEN m.id IS NULL OR m.role NOT IN ('owner', 'member') THEN 'membership_removed'
          WHEN r.membership_id IS NULL THEN 'expired'
          WHEN m.id <> r.membership_id THEN 'membership_removed'
          WHEN r.revoked_at IS NOT NULL THEN 'revoked'
          WHEN r.expires_at <= ${now.toISOString()}::timestamptz THEN 'expired' ELSE 'authorized' END AS status,
        -- Only the hosted provider is derived here; callback URLs never leave the query.
        CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.redirect_uris) AS u(value) WHERE u.value ~ '^https://(www\.)?(claude\.ai|claude\.com)/') THEN 'claude'
          WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.redirect_uris) AS u(value) WHERE u.value ~ '^https://(chatgpt\.com|chat\.openai\.com)/') THEN 'chatgpt'
          WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.redirect_uris) AS u(value) WHERE u.value ~ '^https://(x\.ai|grok\.com|www\.grok\.com)/') THEN 'grok'
          END AS client_host
      FROM oauth_refresh_tokens r
      LEFT JOIN org_members m ON m.org_id = r.org_id AND m.email = r.email
      LEFT JOIN oauth_clients c ON c.client_id = r.client_id
      LEFT JOIN connection_lifecycle l ON l.org_id = r.org_id AND l.kind = 'oauth' AND l.email = r.email AND l.client_id = r.client_id
      WHERE r.org_id = ${actor.orgId} AND l.deleted_at IS NULL
    ), oauth_ranked AS (
      SELECT *, row_number() OVER (PARTITION BY email, client_id ORDER BY (status = 'authorized') DESC, created_at DESC, id DESC) AS grant_rank
      FROM oauth_grants
    ), inventory AS (
      SELECT * FROM token_connections
      UNION ALL SELECT id, kind, name, email, client_id, client_name, scope, harness, source_label, client_names, can_write, created_at, last_authenticated_at, archived_at, status, client_host
      FROM oauth_ranked WHERE grant_rank = 1
    )
    SELECT * FROM inventory ORDER BY (archived_at IS NOT NULL), created_at DESC, kind, id DESC LIMIT ${CONNECTION_LIMIT + 1}`;
    const page = inventory.slice(0, CONNECTION_LIMIT);
    // Use the same JS encoder as authentication for every UTF-8/punctuation
    // case. A fixed pair of batched receipt queries avoids N per-row queries.
    const agents = page.map(row => row.kind === "oauth" ? oauthActorName({ sub: String(row.email), client_id: String(row.client_id) }) : String(row.name));
    if (!agents.length) return inventory;
    const [observed, reported, measured, described] = await Promise.all([
      tx`SELECT token_name AS agent, max(ts) AS contact_at,
          max(ts) FILTER (WHERE outcome = 'ok') AS successful_contact_at,
          max(ts) FILTER (WHERE tool NOT IN ('whoami', 'list_actions', 'record_action')) AS last_memory_at,
          count(*) FILTER (WHERE tool NOT IN ('whoami', 'list_actions', 'record_action')) AS memory_calls,
          max(ts) FILTER (WHERE outcome = 'ok' AND tool NOT IN ('whoami', 'list_actions', 'record_action')) AS last_successful_memory_at,
          count(*) FILTER (WHERE outcome = 'ok' AND tool NOT IN ('whoami', 'list_actions', 'record_action')) AS successful_memory_calls
        FROM audit_log WHERE org_id = ${actor.orgId} AND token_name = ANY(${agents}) GROUP BY token_name`,
      tx`SELECT agent, max(recorded_at) AS last_task_report_at, count(*) AS task_reports
        FROM action_events WHERE org_id = ${actor.orgId} AND agent = ANY(${agents}) GROUP BY agent`,
      tx`SELECT actor_kind, actor_name, min(tracking_since) AS tracking_since,
          max(last_recall_at) AS last_recall_at, max(last_remember_at) AS last_remember_at,
          sum(recalls) AS recalls, sum(remembers) AS remembers,
          sum(response_bytes) AS response_bytes, sum(estimated_tokens) AS estimated_tokens,
          sum(duplicate_recalls) AS duplicate_recalls, sum(budget_stops) AS budget_stops,
          sum(truncated_responses) AS truncated_responses,
          sum(run_scoped_responses) AS run_scoped_responses, sum(response_scoped_responses) AS response_scoped_responses,
          max(updated_at) AS last_seen_at,
          (array_agg(jsonb_build_object('declaration', integration_declaration, 'declaredAt', integration_declared_at,
            'check', integration_check) ORDER BY updated_at DESC))[1] AS integration_data
        FROM memory_connection_usage WHERE org_id = ${actor.orgId} AND actor_name = ANY(${agents})
          AND actor_kind IN ('token', 'oauth') GROUP BY actor_kind, actor_name`,
      // Names and logos agents reported about themselves, or an owner chose.
      tx`SELECT * FROM agent_identities WHERE org_id = ${actor.orgId} AND actor_name = ANY(${agents})
        AND (reported_name IS NOT NULL OR reported_logo_png IS NOT NULL OR owner_name IS NOT NULL OR owner_logo_png IS NOT NULL OR locked)`,
    ]);
    identities = described.map(mapAgentIdentity);
    const memory = new Map(observed.map(row => [row.agent, row]));
    const reports = new Map(reported.map(row => [row.agent, row]));
    const usage = new Map(measured.map(row => [`${row.actor_kind}:${row.actor_name}`, row]));
    return inventory.map((row, index) => {
      const contact = memory.get(agents[index]), report = reports.get(agents[index]);
      const latest = [date(contact?.contact_at), date(report?.last_task_report_at)].filter((value): value is string => value !== null).sort().at(-1) ?? null;
      const successful = [date(contact?.successful_contact_at), date(report?.last_task_report_at)].filter((value): value is string => value !== null).sort().at(-1) ?? null;
      return { ...row, last_contact_at: latest, last_memory_at: contact?.last_memory_at,
        last_successful_contact_at: successful, last_successful_memory_at: contact?.last_successful_memory_at,
        memory_calls: contact?.memory_calls ?? 0, successful_memory_calls: contact?.successful_memory_calls ?? 0,
        last_task_report_at: report?.last_task_report_at, task_reports: report?.task_reports ?? 0,
        memory_use: usage.get(`${row.kind}:${agents[index]}`) };
    });
  });
  return { connections: rows.slice(0, CONNECTION_LIMIT).map(row => mapConnection(row, actor.orgId)), identities, more: rows.length > CONNECTION_LIMIT, limit: CONNECTION_LIMIT, checkedAt: now.toISOString(), recentWindowSeconds: 900 };
}

export type ConnectionAction = "archive" | "restore" | "delete";
export async function updateConnection(token: TokenRecord, input: unknown, db: postgres.Sql = sql) {
  const actor = authorize(token);
  if (actor.role !== "owner" || actor.kind !== "session" || !actor.email) throw new ConnectionError("Only a workspace owner can manage connections", 403);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConnectionError("A connection and action are required");
  const { id, action } = input as Record<string, unknown>;
  if (typeof id !== "string" || !/^(?:token:[1-9]\d{0,9}|oauth:[a-f0-9]{64})$/.test(id) || typeof action !== "string" || !["archive", "restore", "delete"].includes(action)) {
    throw new ConnectionError("Choose a connection and a valid action");
  }
  if (id.startsWith("token:") && Number(id.slice(6)) > 2147483647) throw new ConnectionError("Choose a valid connection");
  return db.begin(async tx => {
    // Re-check and lock live authority so a role change/removal cannot race a
    // console cookie authenticated just before that change.
    const owners = await tx`SELECT id FROM org_members WHERE org_id = ${actor.orgId} AND email = ${actor.email} AND role = 'owner' FOR SHARE`;
    if (!owners.length) throw new ConnectionError("Only a workspace owner can manage connections", 403);
    await lockConnection(tx as unknown as postgres.Sql, actor.orgId, id);
    let identity: { tokenId: number | null; email: string | null; clientId: string | null };
    if (id.startsWith("token:")) {
      const tokenId = Number(id.slice(6));
      const rows = await tx`SELECT id FROM tokens WHERE org_id = ${actor.orgId} AND id = ${tokenId} AND left(name, 25) <> 'operator-candidate-smoke-' FOR UPDATE`;
      if (!rows.length) throw new ConnectionError("Connection not found", 404);
      identity = { tokenId, email: null, clientId: null };
    } else {
      // The public ID is deliberately opaque. Resolve it only against this
      // workspace's distinct grant identities, never caller-supplied email.
      const rows = await tx`SELECT DISTINCT email, client_id FROM oauth_refresh_tokens WHERE org_id = ${actor.orgId}`;
      const row = rows.find(row => oauthConnectionId(actor.orgId, String(row.email), String(row.client_id)) === id);
      if (!row) throw new ConnectionError("Connection not found", 404);
      identity = { tokenId: null, email: String(row.email), clientId: String(row.client_id) };
    }
    const prior = await tx`SELECT archived_at, deleted_at FROM connection_lifecycle WHERE org_id = ${actor.orgId} AND connection_id = ${id} FOR UPDATE`;
    if (prior[0]?.deleted_at && action !== "delete") throw new ConnectionError("Connection not found", 404);
    if (action === "restore") {
      await tx`UPDATE connection_lifecycle SET archived_at = NULL WHERE org_id = ${actor.orgId} AND connection_id = ${id} AND deleted_at IS NULL`;
    } else {
      const deleting = action === "delete";
      await tx`INSERT INTO connection_lifecycle (org_id, connection_id, kind, token_id, email, client_id, generation, archived_at, deleted_at)
        VALUES (${actor.orgId}, ${id}, ${identity.tokenId === null ? "oauth" : "token"}, ${identity.tokenId}, ${identity.email}, ${identity.clientId}, 1,
          CASE WHEN ${!deleting} THEN now() ELSE NULL END, CASE WHEN ${deleting} THEN now() ELSE NULL END)
        ON CONFLICT (org_id, connection_id) DO UPDATE SET generation = connection_lifecycle.generation + 1,
          archived_at = CASE WHEN ${!deleting} THEN coalesce(connection_lifecycle.archived_at, now()) ELSE connection_lifecycle.archived_at END,
          deleted_at = CASE WHEN ${deleting} THEN coalesce(connection_lifecycle.deleted_at, now()) ELSE NULL END`;
      if (identity.tokenId !== null) {
        await tx`UPDATE tokens SET revoked_at = coalesce(revoked_at, now()) WHERE org_id = ${actor.orgId} AND id = ${identity.tokenId}`;
      } else {
        await tx`UPDATE oauth_refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE org_id = ${actor.orgId} AND email = ${identity.email} AND client_id = ${identity.clientId}`;
        await tx`UPDATE oauth_codes SET used_at = coalesce(used_at, now()) WHERE org_id = ${actor.orgId} AND email = ${identity.email} AND client_id = ${identity.clientId}`;
      }
    }
    const [state] = await tx`SELECT archived_at, deleted_at FROM connection_lifecycle WHERE org_id = ${actor.orgId} AND connection_id = ${id}`;
    return { ok: true, id, action, archivedAt: date(state?.archived_at), deletedAt: date(state?.deleted_at) };
  });
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
    const kinds = credentials.map(row => String(row.kind));
    const since = credentials.map(row => new Date(row.since).toISOString());
    // Historical receipts identify actors by name. If a browser session used
    // that same name during the receipt's lifetime, attribution is ambiguous:
    // conservatively exclude it rather than count console work as an agent.
    const [observed] = await tx`
      SELECT coalesce(bool_or(a.outcome = 'ok'), false) AS connected,
        coalesce(bool_or(a.outcome = 'ok' AND a.tool IN ('remember', 'put_page')
          AND a.ts < (SELECT memory_usage_started_at FROM engram_schema_state WHERE id = true)), false) AS saved,
        coalesce(bool_or(a.outcome = 'ok' AND a.tool IN ('recall', 'search', 'get_page')
          AND a.ts < (SELECT memory_usage_started_at FROM engram_schema_state WHERE id = true)), false) AS recalled
      FROM audit_log a JOIN unnest(${agents}::text[], ${since}::timestamptz[]) AS eligible(agent, since)
        ON a.token_name = eligible.agent AND a.ts >= eligible.since
      WHERE a.org_id = ${orgId} AND NOT EXISTS (
        SELECT 1 FROM sessions s WHERE s.org_id = a.org_id AND s.name = a.token_name
          AND a.ts >= s.created_at AND a.ts <= least(s.expires_at, coalesce(s.revoked_at, s.expires_at)))`;
    // New receipts are emitted after the final context boundary. A successful
    // upstream call followed by a duplicate/budget/error skip cannot advance
    // onboarding. Credential kind prevents console work with a reused display
    // name from being mistaken for a token or OAuth agent.
    const [delivered] = await tx`
      SELECT coalesce(bool_or(u.last_recall_at >= eligible.since), false) AS recalled,
        coalesce(bool_or(u.last_remember_at >= eligible.since), false) AS saved
      FROM memory_connection_usage u JOIN unnest(${agents}::text[], ${kinds}::text[], ${since}::timestamptz[]) AS eligible(agent, kind, since)
        ON u.actor_name = eligible.agent AND u.actor_kind = eligible.kind
      WHERE u.org_id = ${orgId}`;
    const [reported] = await tx`
      SELECT EXISTS (
        SELECT 1 FROM action_events a JOIN unnest(${agents}::text[], ${since}::timestamptz[]) AS eligible(agent, since)
          ON a.agent = eligible.agent AND a.recorded_at >= eligible.since
        WHERE a.org_id = ${orgId} AND NOT EXISTS (
          SELECT 1 FROM sessions s WHERE s.org_id = a.org_id AND s.name = a.agent
            AND a.recorded_at >= s.created_at AND a.recorded_at <= least(s.expires_at, coalesce(s.revoked_at, s.expires_at)))) AS reported`;
    const taskReported = reported?.reported === true;
    const memorySaved = observed?.saved === true || delivered?.saved === true;
    const memoryRecalled = observed?.recalled === true || delivered?.recalled === true;
    return { agentConnected: observed?.connected === true || memorySaved || memoryRecalled || taskReported, memorySaved, memoryRecalled, taskReported };
  });
}

export async function handleConnectionsApi(req: Request, token: TokenRecord, db: postgres.Sql = sql): Promise<Response> {
  try {
    authorize(token);
    if (req.method === "POST") {
      if (req.headers.get("x-engram-console") !== "1") throw new ConnectionError("forbidden", 403);
      if (req.headers.get("x-engram-workspace") !== String(normalizeToken(token).orgId)) throw new ConnectionError("The selected workspace changed. Refresh and try again.", 409);
      const origin = req.headers.get("origin");
      if (origin && origin !== new URL(config.publicUrl || req.url).origin) throw new ConnectionError("forbidden", 403);
      if (Number(req.headers.get("content-length")) > 2048) throw new ConnectionError("Connection request is too large", 413);
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > 2048) throw new ConnectionError("Connection request is too large", 413);
      let input: unknown;
      try { input = JSON.parse(raw); } catch { throw new ConnectionError("A connection and action are required"); }
      return Response.json(await updateConnection(token, input, db), { headers: HEADERS });
    }
    if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...HEADERS, Allow: "GET, POST" } });
    return Response.json(await listConnections(token, db), { headers: HEADERS });
  } catch (error) {
    if (error instanceof ConnectionError) return Response.json({ error: error.message }, { status: error.status, headers: HEADERS });
    return Response.json({ error: "Connection inventory is temporarily unavailable" }, { status: 503, headers: HEADERS });
  }
}
