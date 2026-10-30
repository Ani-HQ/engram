import { createHmac } from "node:crypto";
import type postgres from "postgres";
import { resourceService, RESOURCE_SERVICES } from "../../web/resource-model.js";

export interface PublicActivityEvent {
  id: string;
  agent: { product: string; label: string };
  service: string;
  action: string;
  status: "running" | "completed" | "failed" | "stale";
  evidence: "observed" | "reported";
  updatedAt: string;
}

export const PRODUCTS: Record<string, string> = {
  codex: "Codex", "claude-code": "Claude Code", claude: "Claude", cursor: "Cursor", chatgpt: "ChatGPT",
  "grok-bot": "Grok Bot", grok: "Grok", "gemini-cli": "Gemini CLI", opencode: "OpenCode", cline: "Cline",
  windsurf: "Windsurf", aider: "Aider", goose: "Goose", amp: "Amp", "github-copilot": "GitHub Copilot",
  openclaw: "OpenClaw", hermes: "Hermes", other: "Agent",
};
const SERVICES = new Set(RESOURCE_SERVICES);
const ACTIONS: Record<string, string> = {
  github: "GitHub activity", gitlab: "GitLab activity", googledrive: "Google Drive activity",
  googledocs: "Google Docs activity", googlesheets: "Google Sheets activity", figma: "Figma activity",
  slack: "Slack activity", notion: "Notion activity", linear: "Linear activity", gmail: "Gmail activity",
  googlecalendar: "Google Calendar activity", microsoftoutlook: "Outlook activity", dropbox: "Dropbox activity",
  postgresql: "PostgreSQL activity", supabase: "Supabase activity", vercel: "Vercel activity",
  git: "Git activity", code: "Code activity", cloud: "Cloud activity", data: "Data activity", browser: "Browser activity",
  calendar: "Calendar activity", email: "Email activity", memory: "Memory activity", files: "File activity", other: "Agent activity",
};
const MEMORY_TOOLS = new Set(["search", "get_page", "list_pages", "put_page", "remember", "recall", "add_tag", "add_link", "add_timeline_entry"]);
type Operation = { category: string; running: string; completed: string; failed: string };
const OPERATIONS = new Map<string, Operation>();
function operation(namespaces: string[], names: string[], category: string, running: string, completed: string, failed: string) {
  const template = { category, running, completed, failed };
  for (const namespace of namespaces) for (const name of names) OPERATIONS.set(`${namespace}.${name}`, template);
}
operation(["memory", "engram", ""], ["search", "recall"], "memory", "Searching memory", "Searched memory", "Attempted to search memory");
operation(["memory", "engram", ""], ["get_page", "list_pages"], "memory", "Reading memory", "Read memory", "Attempted to read memory");
operation(["memory", "engram", ""], ["remember", "put_page", "add_tag", "add_link", "add_timeline_entry"], "memory", "Saving memory", "Saved memory", "Attempted to save memory");
operation(["files", "file", "filesystem", "fs"], ["read", "read_file", "read_text", "read_text_file"], "files", "Reading a file", "Read a file", "Attempted to read a file");
operation(["files", "file", "filesystem", "fs"], ["write", "write_file", "write_text", "write_text_file", "edit_file"], "files", "Writing a file", "Wrote a file", "Attempted to write a file");
operation(["browser", "playwright"], ["navigate", "open", "goto"], "browser", "Browsing a page", "Browsed a page", "Attempted to browse a page");
operation(["browser", "playwright"], ["screenshot", "take_screenshot"], "browser", "Taking a screenshot", "Took a screenshot", "Attempted to take a screenshot");
operation(["terminal", "shell", "functions", ""], ["execute", "run", "exec", "exec_command"], "code", "Running a command", "Ran a command", "Attempted to run a command");
operation(["github", "gitlab"], ["create_pull_request", "create_pr", "create_merge_request"], "code", "Creating a pull request", "Created a pull request", "Attempted to create a pull request");
operation(["github", "gitlab"], ["get_pull_request", "read_pull_request", "list_pull_requests", "get_merge_request"], "code", "Reading a pull request", "Read a pull request", "Attempted to read a pull request");
operation(["github", "gitlab"], ["review_pull_request"], "code", "Reviewing a pull request", "Reviewed a pull request", "Attempted to review a pull request");
operation(["github", "gitlab"], ["merge_pull_request", "merge_merge_request"], "code", "Merging a pull request", "Merged a pull request", "Attempted to merge a pull request");
operation(["github", "gitlab", "linear"], ["create_issue"], "code", "Creating an issue", "Created an issue", "Attempted to create an issue");
operation(["github", "gitlab", "linear"], ["get_issue", "read_issue", "list_issues", "search_issues"], "code", "Reading issues", "Read issues", "Attempted to read issues");
operation(["github", "gitlab", "linear"], ["update_issue", "close_issue"], "code", "Updating an issue", "Updated an issue", "Attempted to update an issue");
operation(["email", "mail", "gmail", "outlook", "microsoftoutlook"], ["draft", "create_draft", "draft_email"], "email", "Drafting an email", "Drafted an email", "Attempted to draft an email");
operation(["email", "mail", "gmail", "outlook", "microsoftoutlook"], ["send", "send_email", "send_message"], "email", "Sending an email", "Sent an email", "Attempted to send an email");
operation(["calendar", "gcal", "googlecalendar"], ["read", "get_event", "list_events"], "calendar", "Reading calendar events", "Read calendar events", "Attempted to read calendar events");
operation(["calendar", "gcal", "googlecalendar"], ["create_event", "insert_event"], "calendar", "Creating a calendar event", "Created a calendar event", "Attempted to create a calendar event");
operation(["cloud", "deployment", "aws", "vercel", "kubernetes"], ["deploy", "create_deployment"], "cloud", "Deploying a service", "Deployed a service", "Attempted to deploy a service");
operation(["cloud", "deployment", "aws", "vercel", "kubernetes"], ["restart", "restart_service"], "cloud", "Restarting a service", "Restarted a service", "Attempted to restart a service");
operation(["docs", "googledocs", "google_docs", "notion"], ["read", "get_document", "read_document", "get_page"], "files", "Reading a document", "Read a document", "Attempted to read a document");
operation(["docs", "googledocs", "google_docs", "notion"], ["edit", "edit_document", "update_document", "update_page"], "files", "Editing a document", "Edited a document", "Attempted to edit a document");
operation(["database", "postgres", "postgresql", "sql", "supabase"], ["query", "execute_query"], "data", "Querying a database", "Queried a database", "Attempted to query a database");
function knownOperation(tool: unknown): Operation | undefined {
  if (typeof tool !== "string" || tool.length > 256 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(tool) || tool.includes("://")) return;
  const name = tool.toLowerCase();
  if (name.startsWith("mcp__")) {
    const match = /^mcp__([a-z0-9_-]+)__([a-z0-9_]+)$/.exec(name);
    return match ? OPERATIONS.get(`${match[1]}.${match[2]}`) : undefined;
  }
  const direct = OPERATIONS.get(`.${name}`);
  if (direct) return direct;
  const match = /^([a-z][a-z0-9_-]*)[.:/]([a-z][a-z0-9_]*)$/.exec(name);
  return match ? OPERATIONS.get(`${match[1]}.${match[2]}`) : undefined;
}
function genericToolService(tool: unknown): string {
  if (typeof tool !== "string") return "other";
  const name = tool.toLowerCase();
  if (MEMORY_TOOLS.has(name) || /^memory[._]/.test(name)) return "memory";
  for (const [prefix, service] of [["files", "files"], ["file", "files"], ["browser", "browser"], ["calendar", "calendar"], ["email", "email"], ["cloud", "cloud"], ["deployment", "cloud"], ["database", "data"], ["terminal", "code"], ["code", "code"]]) {
    if (name.startsWith(`${prefix}.`) || name.startsWith(`${prefix}_`)) return service;
  }
  return name === "exec_command" ? "code" : "other";
}

/** A closed public projection. Free-form descriptions and identities never become labels. */
export function publicActivityEvents(rows: unknown, { enabled, scope, key, now = new Date() }: { enabled: boolean; scope: string; key: string; now?: Date }): PublicActivityEvent[] {
  if (!enabled || !scope || !key || !Array.isArray(rows)) return [];
  const events: PublicActivityEvent[] = [];
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const identity = typeof row.agent === "string" ? row.agent : "";
    const actionKey = typeof row.action_key === "string" && row.action_key ? row.action_key : null;
    if (!(row.recorded_at instanceof Date) && (typeof row.recorded_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(row.recorded_at))) continue;
    const timestamp = new Date(row.recorded_at as string);
    if (!id || !Number.isFinite(timestamp.getTime()) || !["running", "completed", "failed"].includes(String(row.status)) || !["observed", "reported"].includes(String(row.evidence))) continue;
    const product = typeof row.harness === "string" && Object.hasOwn(PRODUCTS, row.harness) ? row.harness : "other";
    const resource = typeof row.resource === "string" ? row.resource : "";
    const classified = resourceService(resource, typeof row.tool === "string" ? row.tool : "");
    const known = SERVICES.has(classified) ? classified : "other";
    const service = ({ deployment: "cloud", database: "data" } as Record<string, string>)[known] || known;
    const template = knownOperation(row.tool);
    const publicService = service === "other" ? template?.category || genericToolService(row.tool) : service;
    const age = now.getTime() - timestamp.getTime();
    const status = row.status === "running" ? age >= 0 && age <= 900_000 ? "running" : "stale" : row.status as "completed" | "failed";
    const publicId = createHmac("sha256", key).update(JSON.stringify(["engram-public-activity-v1", scope, row.evidence, identity, actionKey ? "action" : "event", actionKey || id])).digest("hex").slice(0, 32);
    const action = template ? template[status === "stale" ? "running" : status] : ACTIONS[publicService] || ACTIONS.other;
    events.push({ id: publicId, agent: { product, label: PRODUCTS[product] }, service: Object.hasOwn(ACTIONS, publicService) ? publicService : "other", action, status, evidence: row.evidence as "observed" | "reported", updatedAt: timestamp.toISOString() });
  }
  const unique = new Map<string, PublicActivityEvent>();
  for (const event of events.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))) if (!unique.has(event.id)) unique.set(event.id, event);
  return [...unique.values()].slice(0, 20);
}

/** Latest logical reports plus observed calls; intentionally never select free-form content. */
export function publicActivityLedger(db: postgres.Sql, orgId: number) {
  return db`
    WITH latest_reports AS (
      SELECT id, agent, action_key, tool, resource, status, evidence, recorded_at,
        first_value(harness) OVER (
          PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
          ORDER BY (harness IS NULL AND source_label IS NULL) ASC, occurred_at DESC, recorded_at DESC, id DESC
        ) AS effective_harness,
        row_number() OVER (
          PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)
          ORDER BY occurred_at DESC, recorded_at DESC, (status <> 'running') DESC, id DESC
        ) AS action_version
      FROM action_events WHERE org_id = ${orgId}
    ), report_events AS (
      SELECT id, agent, action_key, tool, resource, status, evidence, recorded_at, effective_harness AS harness
      FROM latest_reports WHERE action_version = 1 AND tool NOT IN ('list_actions', 'record_action', 'whoami')
      ORDER BY recorded_at DESC, id DESC LIMIT 20
    ), observed_events AS (
      SELECT 'audit:' || audit_log.id::text, token_name, NULL, tool,
        CASE WHEN slug IS NOT NULL THEN 'engram://' || slug ELSE NULL END,
        CASE WHEN outcome = 'ok' THEN 'completed' ELSE 'failed' END, 'observed', ts, registered_source.harness
      FROM audit_log LEFT JOIN tokens registered_source
        ON registered_source.org_id = audit_log.org_id AND registered_source.name = audit_log.token_name
      WHERE audit_log.org_id = ${orgId} AND tool NOT IN ('list_actions', 'record_action', 'whoami')
      ORDER BY audit_log.ts DESC, audit_log.id DESC LIMIT 20
    ), events AS (
      SELECT * FROM report_events UNION ALL SELECT * FROM observed_events
    ) SELECT id, agent, action_key, tool, resource, status, evidence, recorded_at, harness
      FROM events ORDER BY recorded_at DESC, id DESC LIMIT 20`;
}
