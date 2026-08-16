// The security boundary: curated allowlist of gbrain tools, scope routing,
// write guards, and fan-out reads across the token's readable scopes.
// Nothing outside ALLOWED_READS/ALLOWED_WRITES ever reaches a gbrain child.
import { TokenRecord, canWrite, readableScopes } from "./auth";
import { scopeClient } from "./scopes";
import { audit } from "./audit";
import { SECRET_TOOL_DEFS, callSecretTool } from "./tools/secrets";
import { PROMOTE_TOOL_DEF, promoteTool } from "./tools/promote";

const ALLOWED_READS = new Set(["search", "get_page", "list_pages", "recall"]);
const ALLOWED_WRITES = new Set(["put_page", "remember", "add_tag", "add_link", "add_timeline_entry"]);

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

// 2026-07-28 requires Mcp-Method/Mcp-Name so upstream gateways can route without
// parsing bodies. engram parses the body regardless (it needs id + params), so the
// headers buy no parse savings here — they are assertions to VALIDATE, not authority
// to obey. Obeying a header that disagrees with the body would make engram execute
// something other than what the JSON-RPC message says, and would silently diverge
// from any upstream WAF or rate-limiter that inspects bodies instead. So: the body
// is authoritative, a header may fill in what the body omits, and disagreement is a
// malformed request. Headers stay optional for 2025-06-18 and older clients.
export function resolveMcpRouting(
  headers: { get(name: string): string | null },
  msg: { method?: unknown; params?: { name?: unknown } },
): { method: unknown; name: unknown; conflict: string | null } {
  const headerMethod = headers.get("mcp-method")?.trim();
  const headerName = headers.get("mcp-name")?.trim();
  const bodyMethod = msg.method;
  const bodyName = msg.params?.name;

  const conflict =
    headerMethod && bodyMethod !== undefined && headerMethod !== bodyMethod
      ? `Mcp-Method '${headerMethod}' disagrees with body method '${String(bodyMethod)}'`
      : headerName && bodyName !== undefined && headerName !== bodyName
        ? `Mcp-Name '${headerName}' disagrees with body tool name '${String(bodyName)}'`
        : null;

  return {
    method: bodyMethod ?? headerMethod,
    name: bodyName ?? headerName,
    conflict,
  };
}

// 2026-07-28 retired initialize; each request carries version, identity,
// and capabilities in params._meta. Older clients omit _meta entirely.
export function readClientMeta(params: any): {
  protocolVersion: string;
  clientInfo: unknown;
  clientCapabilities: unknown;
} {
  const meta = params?._meta;
  return {
    protocolVersion: negotiateProtocolVersion(meta?.["io.modelcontextprotocol/protocolVersion"]),
    clientInfo: meta?.["io.modelcontextprotocol/clientInfo"],
    clientCapabilities: meta?.["io.modelcontextprotocol/clientCapabilities"],
  };
}

// Extra args engram adds to every proxied tool schema.
const SCOPE_ARG = {
  scope: {
    type: "string",
    description: "Memory scope to target (e.g. 'shared'). Reads default to all scopes your token can read; writes require one writable scope (defaulted when unambiguous).",
  },
};

let cachedToolDefs: any[] | null = null;

// SEP-2549 (new in 2026-07-28) cacheScope is "public" | "private", and tools/list
// is token-dependent: reads/writes are filtered by scope, secret_get/secret_list
// need token.secrets, promote needs an "rw" scope. "public" would let a shared
// cache serve a secrets-capable list to a different token, so "private" — per
// credential, never shared — is the only safe value here. Emitted only to clients
// that declared 2026-07-28, so older ones aren't handed fields they can't read.
export function toolsListCacheHints(
  _token: TokenRecord,
  protocolVersion: string,
): { ttlMs: number; cacheScope: "private" } | Record<string, never> {
  if (protocolVersion !== "2026-07-28") return {};
  return { ttlMs: 300_000, cacheScope: "private" };
}

export async function listTools(token: TokenRecord): Promise<any[]> {
  if (!cachedToolDefs) {
    // Any scope's child serves the same tool schemas; use the first configured one.
    const first = readableScopes(token)[0] ?? "shared";
    const all = await scopeClient(first).listTools();
    cachedToolDefs = all.tools
      .filter(t => ALLOWED_READS.has(t.name) || ALLOWED_WRITES.has(t.name))
      .map(t => ({
        ...t,
        inputSchema: {
          ...t.inputSchema,
          properties: { ...(t.inputSchema as any).properties, ...SCOPE_ARG },
        },
      }));
  }
  // Only advertise what this token can actually invoke. Listing write tools to a
  // read-only token just invites a call that callTool() will deny anyway.
  const canReadAny = readableScopes(token).length > 0;
  const canWriteAny = Object.keys(token.scopes).some(s => canWrite(token, s));
  return [
    ...cachedToolDefs.filter(t =>
      ALLOWED_WRITES.has(t.name) ? canWriteAny : canReadAny),
    ...(token.secrets ? SECRET_TOOL_DEFS : []),
    ...(canWriteAny ? [PROMOTE_TOOL_DEF] : []),
    {
      name: "whoami",
      description: "Show this token's identity: name, readable/writable scopes, secrets access.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {}).slice(0, 200);
}

export async function callTool(
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const { scope: requestedScope, ...rest } = (args ?? {}) as Record<string, unknown> & { scope?: string };

  if (name === "whoami") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ token: token.name, scopes: token.scopes, secrets: token.secrets }, null, 2),
      }],
    };
  }

  if (name === "secret_get" || name === "secret_list") {
    return callSecretTool(token, name, args ?? {});
  }

  if (name === "promote") {
    return promoteTool(token, args ?? {});
  }

  const readable = readableScopes(token);

  if (ALLOWED_WRITES.has(name)) {
    const writable = Object.keys(token.scopes).filter(s => canWrite(token, s));
    const target = (requestedScope as string) ?? (writable.length === 1 ? writable[0] : undefined);
    if (!target || !canWrite(token, target)) {
      await audit(token.name, name, target ?? null, summarizeArgs(rest), "denied");
      return toolError(
        `Write denied. Token '${token.name}' can write to: [${writable.join(", ") || "none"}]` +
        (target ? `, requested scope '${target}'.` : ". Pass an explicit 'scope' argument."),
      );
    }
    const result = await scopeClient(target).callTool({ name, arguments: rest });
    await audit(token.name, name, target, summarizeArgs(rest), "ok");
    return result;
  }

  if (ALLOWED_READS.has(name)) {
    const targets = requestedScope ? [requestedScope as string] : readable;
    const denied = targets.filter(s => !readable.includes(s));
    if (denied.length > 0 || targets.length === 0) {
      await audit(token.name, name, targets.join(","), summarizeArgs(rest), "denied");
      return toolError(`Read denied. Token '${token.name}' can read: [${readable.join(", ") || "none"}].`);
    }
    const results = await Promise.all(targets.map(async scope => {
      try {
        const r = await scopeClient(scope).callTool({ name, arguments: rest });
        return { scope, r };
      } catch (e) {
        return { scope, r: toolError(`scope '${scope}' failed: ${String(e).slice(0, 200)}`) };
      }
    }));
    await audit(token.name, name, targets.join(","), summarizeArgs(rest), "ok");
    if (results.length === 1) return results[0].r;
    // Fan-out merge: label each scope's content block.
    return {
      content: results.flatMap(({ scope, r }) =>
        (r.content ?? []).map((c: any) =>
          c.type === "text" ? { ...c, text: `[scope: ${scope}]\n${c.text}` } : c)),
    };
  }

  await audit(token.name, name, null, summarizeArgs(rest), "denied_unknown_tool");
  return toolError(`Unknown or disallowed tool: ${name}`);
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}
