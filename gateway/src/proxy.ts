// Nothing outside the curated gbrain allowlist ever reaches the child.
import type { TokenRecord } from "./auth";
import { brainClient } from "./brain";
import { audit } from "./audit";

const FORWARDED_TOOLS = [
  "search",
  "get_page",
  "list_pages",
  "put_page",
  "add_tag",
  "add_link",
  "add_timeline_entry",
] as const;
const ALLOWED_TOOLS = new Set<string>(FORWARDED_TOOLS);

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

let cachedToolDefs: any[] | null = null;

// 2026-07-28 clients can share tools/list now: every token sees the same eight tools.
export function toolsListCacheHints(
  _token: TokenRecord,
  protocolVersion: string,
): Record<string, unknown> {
  if (protocolVersion !== "2026-07-28") return {};
  return { ttlMs: 300_000, cacheScope: "public" };
}

export async function listTools(_token: TokenRecord): Promise<any[]> {
  if (!cachedToolDefs) {
    const all = await brainClient().listTools();
    const byName = new Map(all.tools
      .filter(t => ALLOWED_TOOLS.has(t.name))
      .map(t => [t.name, t]));
    cachedToolDefs = [
      ...FORWARDED_TOOLS.map(name => byName.get(name)).filter(Boolean),
      {
        name: "whoami",
        description: "Show this token's identity.",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  }
  return cachedToolDefs;
}

function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {}).slice(0, 200);
}

export async function callTool(
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const forwardedArgs = args ?? {};

  if (name === "whoami") {
    await audit(token.name, name, summarizeArgs(forwardedArgs), "ok");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ token: token.name }),
      }],
    };
  }

  if (!ALLOWED_TOOLS.has(name)) {
    await audit(token.name, name, summarizeArgs(forwardedArgs), "denied");
    return toolError(`Unknown or disallowed tool: ${name}`);
  }

  try {
    const result = await brainClient().callTool({ name, arguments: forwardedArgs });
    await audit(token.name, name, summarizeArgs(forwardedArgs), "ok");
    return result;
  } catch (e) {
    await audit(token.name, name, summarizeArgs(forwardedArgs), "error");
    throw e;
  }
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}
