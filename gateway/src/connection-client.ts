import type postgres from "postgres";
import { sql } from "./db";
import { currentOrg } from "./context";
import { normalizeToken, type TokenRecord } from "./policies";
import { redactSecrets } from "./redact";

export type ConnectionClient = { state: "identified" | "multiple" | "unknown"; label: string | null; harness: string | null };
export const CONNECTION_CLIENT_LIMIT = 4;
const UNKNOWN: ConnectionClient = { state: "unknown", label: null, harness: null };
// Exact declared names only. These are display hints, not authenticated app or
// model identities. Bridges must not inherit the identity of a downstream app.
const names = new Map<string, { label: string; harness: string }>();
for (const [label, harness, aliases] of [
  ["Codex", "codex", ["codex", "codex desktop", "codex cli", "openai codex", "codex-mcp-client"]],
  ["Claude Code", "claude-code", ["claude code", "claude-code"]],
  ["Claude", "claude", ["claude", "claude desktop"]],
  ["ChatGPT", "chatgpt", ["chatgpt"]],
  ["Grok", "grok", ["grok"]],
  ["Grok Bot", "grok-bot", ["grok bot", "grok-bot", "grokbot"]],
  ["Cursor", "cursor", ["cursor"]],
  ["Gemini CLI", "gemini-cli", ["gemini cli", "gemini-cli"]],
  ["GitHub Copilot", "github-copilot", ["github copilot", "github copilot cli", "github-copilot", "github-copilot-cli"]],
  ["OpenCode", "opencode", ["opencode", "open code"]],
  ["OpenClaw", "openclaw", ["openclaw", "openclaw gateway"]],
  ["Windsurf", "windsurf", ["windsurf"]],
  ["VS Code", "vscode", ["vscode", "vs code", "visual studio code"]],
  ["Cline", "cline", ["cline"]],
  ["Goose", "goose", ["goose"]],
  ["Amp", "amp", ["amp"]],
  ["Hermes Agent", "hermes", ["hermes", "hermes agent", "hermesagent"]],
  ["Aider", "aider", ["aider"]],
] as [string, string, string[]][]) for (const alias of aliases) names.set(alias, { label, harness });

const generic = new Set(["client", "connector", "unknown", "unknown client", "other", "mcp", "mcp client", "mcp-client", "mcp_client", "fastmcp", "python mcp client", "python-mcp-client", "mcp javascript sdk", "mcp typescript sdk", "engram", "engram-mcp", "engram-mcp-client"]);
export function declaredConnectionClient(value: unknown): { label: string; harness: string | null } | null {
  if (typeof value !== "string" || value.length > 80 || /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value)) return null;
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u.test(label) || redactSecrets(label) !== label || /^(?:Bearer|Basic)\s/i.test(label) || /(?:eng_|egs_|sk[-_]|gh[pousr]_|AKIA|ya29\.|eyJ)/i.test(label) || /[A-Za-z0-9_-]{40,}/.test(label)) return null;
  const key = label.toLowerCase();
  if (generic.has(key) || /^(?:mcp[-_ ](?:client|remote|proxy|bridge|javascript sdk|typescript sdk|python sdk)|python[-_ ]mcp[-_ ]client|fastmcp|engram[-_ ](?:proxy|bridge|shim|mcp(?:[-_ ](?:client|proxy|bridge|shim))?))(?:[-_ ].*)?$/.test(key)) return null;
  const known = names.get(key);
  return known ? { ...known } : { label, harness: null };
}

export function connectionClient(value: unknown): ConnectionClient {
  const candidates = Array.isArray(value) ? value.slice(0, CONNECTION_CLIENT_LIMIT) : [];
  const clients = new Map<string, { label: string; harness: string | null }>();
  for (const name of candidates) {
    const client = declaredConnectionClient(name);
    if (client) clients.set(client.label.toLowerCase(), client);
  }
  if (clients.size > 1) return { state: "multiple", label: "Multiple clients", harness: null };
  if (!clients.size) return { ...UNKNOWN };
  return { state: "identified", ...[...clients.values()][0] };
}

function clientName(info: unknown): unknown {
  return info && typeof info === "object" && !Array.isArray(info) ? (info as Record<string, unknown>).name : undefined;
}
export function mcpConnectionClients(method: unknown, params: unknown): string[] {
  if (typeof method !== "string" || !["initialize", "ping", "tools/list", "tools/call"].includes(method) || !params || typeof params !== "object" || Array.isArray(params)) return [];
  const input = params as Record<string, unknown>, meta = input._meta;
  const modern = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>)["io.modelcontextprotocol/clientInfo"] : undefined;
  const labels = [clientName(modern), ...(method === "initialize" ? [clientName(input.clientInfo)] : [])]
    .map(declaredConnectionClient).filter((client): client is { label: string; harness: string | null } => client !== null).map(client => client.label);
  return [...new Set(labels)];
}

// Only the authenticated bearer digest can select a credential. No client
// identifier, product name, token display name, or request workspace can do so.
// This bookkeeping adds at most four client-name writes per key. Atomic UPDATE
// predicates are rechecked after concurrent row locks, preserving both names.
export async function observeConnectionClient(token: TokenRecord, credentialKey: string, method: unknown, params: unknown, db: postgres.Sql = sql): Promise<void> {
  const actor = normalizeToken(token);
  if (actor.kind !== "token" || !/^[a-f0-9]{64}$/.test(credentialKey) || (currentOrg() && currentOrg()!.id !== actor.orgId)) return;
  const labels = mcpConnectionClients(method, params);
  if (!labels.length) return;
  try {
    await db.begin(async tx => {
      // Optional display bookkeeping must not wait behind a long credential
      // mutation. LOCAL settings are reset before this pool connection returns.
      await tx`SELECT set_config('lock_timeout', '200ms', true), set_config('statement_timeout', '500ms', true)`;
      for (const label of labels) {
        const entry = tx.json([label]);
        await tx`UPDATE tokens t SET client_names = t.client_names || ${entry}
          WHERE t.org_id = ${actor.orgId} AND t.sha256_hash = ${credentialKey} AND t.name = ${actor.name}
            AND t.revoked_at IS NULL AND jsonb_array_length(t.client_names) < ${CONNECTION_CLIENT_LIMIT}
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.client_names) AS prior(name) WHERE lower(prior.name) = lower(${label}))
            AND (t.issuer_kind IN ('operator', 'legacy') OR (t.issuer_kind = 'member' AND EXISTS (
              SELECT 1 FROM org_members m WHERE m.id = t.issued_by_member_id
                AND m.org_id = t.org_id AND m.email = t.issued_by_email AND m.role IN ('owner', 'member'))))`;
      }
    });
  } catch { /* Client display metadata never makes an MCP request fail. */ }
}
