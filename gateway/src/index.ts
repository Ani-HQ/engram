// engram gateway: stateless MCP-over-HTTP endpoint at /mcp.
// Each POST is authenticated, handled, answered with application/json — no
// server-side session state, so Cloud Run can recycle instances freely.
import { authenticateRequest } from "./auth";
import { brainHealth, ensureBrain } from "./brain";
import { config } from "./config";
import { migrate } from "./db";
import {
  insufficientScope,
  isAuthorizationServerPath,
  isProtectedResourcePath,
  loadAuthorizationServerMetadata,
  oauthEnabled,
  protectedResourceMetadata,
  resourceHost,
  unauthorizedResponse,
} from "./oauth";
import { resolveOrg, withOrg } from "./orgs";
import { hasOauthScope, normalizeToken } from "./policies";
import {
  listTools,
  callTool,
  negotiateProtocolVersion,
  resolveMcpRouting,
  readClientMeta,
  toolsListCacheHints,
  SERVER_INSTRUCTIONS,
} from "./proxy";
import { handleWeb } from "./web";

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

async function handleMcp(req: Request): Promise<Response> {
  const token = await authenticateRequest(req);
  if (!token) return unauthorizedResponse(req);

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(msg)) {
    return rpcError(null, -32600, "Batching not supported", 400);
  }

  // 2026-07-28: protocol version / client identity / capabilities travel in
  // params._meta so a tools/call needs no prior initialize. Older clients omit it.
  const clientMeta = readClientMeta(msg.params);
  const { method, name, conflict } = resolveMcpRouting(req.headers, msg);

  // Notifications and responses get 202 with no body per streamable HTTP spec.
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202 });
  }

  // Routing headers that contradict the body are malformed, not a routing hint.
  if (conflict) return rpcError(msg.id, -32600, conflict, 400);

  const actor = normalizeToken(token);
  if (actor.kind === "oauth" && !hasOauthScope(actor, "memory:read")) {
    return insufficientScope(req);
  }

  const org = await resolveOrg(actor);
  await ensureBrain(org);

  return withOrg(org, actor, async () => {
    try {
      switch (method) {
        case "initialize": {
          const requested = msg.params?.protocolVersion;
          return rpcResult(msg.id, {
            protocolVersion: negotiateProtocolVersion(requested),
            capabilities: { tools: {} },
            serverInfo: { name: "engram", version: "0.1.0" },
            instructions: SERVER_INSTRUCTIONS,
          });
        }
        case "ping":
          return rpcResult(msg.id, {});
        case "tools/list":
          return rpcResult(msg.id, {
            tools: await listTools(actor),
            ...toolsListCacheHints(actor, clientMeta.protocolVersion),
          });
        case "tools/call": {
          const args = msg.params?.arguments ?? {};
          if (typeof name !== "string") return rpcError(msg.id, -32602, "missing tool name");
          return rpcResult(msg.id, await callTool(actor, name, args ?? {}));
        }
        default:
          return rpcError(msg.id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      console.error("[mcp] handler error:", e);
      return rpcError(msg.id, -32603, `Internal error: ${String(e).slice(0, 300)}`);
    }
  });
}

async function wellKnown(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (isProtectedResourcePath(url.pathname)) {
    return Response.json(protectedResourceMetadata(resourceHost(req)));
  }
  if (isAuthorizationServerPath(url.pathname)) {
    if (!oauthEnabled()) return new Response("Not Found", { status: 404 });
    try {
      const metadata = await loadAuthorizationServerMetadata(url.pathname);
      if (!metadata) return new Response("Not Found", { status: 404 });
      return Response.json(metadata);
    } catch (e) {
      console.error("[oauth] as metadata failed:", String(e).slice(0, 160));
      return Response.json({ error: "authorization server unavailable" }, { status: 502 });
    }
  }
  return null;
}

console.error("[engram] migrating gateway db...");
await migrate();
console.error("[engram] brains start on first use");

Bun.serve({
  port: config.port,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const metadata = await wellKnown(req);
    if (metadata) return metadata;
    // /health, not /healthz: Google's frontend reserves /healthz on run.app
    // domains and answers 404 before the request reaches the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        brain: await brainHealth(),
        oauth: oauthEnabled(),
      });
    }
    if (url.pathname === "/mcp") {
      if (req.method === "POST") return handleMcp(req);
      // No SSE stream support in stateless mode.
      return new Response("Method Not Allowed", { status: 405 });
    }
    return handleWeb(req);
  },
});
console.error(`[engram] listening on :${config.port}`);
