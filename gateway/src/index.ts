// engram gateway: stateless MCP-over-HTTP endpoint at /mcp.
// Each POST is authenticated, handled, answered with application/json — no
// server-side session state, so Cloud Run can recycle instances freely.
import { config } from "./config";
import { migrate } from "./db";
import { authenticate, type TokenRecord } from "./auth";
import { startScopes, scopesHealth } from "./scopes";
import {
  listTools,
  callTool,
  negotiateProtocolVersion,
  resolveMcpRouting,
  readClientMeta,
  toolsListCacheHints,
} from "./proxy";
import { isPathTokenAllowed } from "./tools/pathtoken";

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

async function handleMcp(req: Request, authenticatedToken?: TokenRecord): Promise<Response> {
  const token = authenticatedToken ?? await authenticate(req.headers.get("authorization"));
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

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

  try {
    switch (method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: negotiateProtocolVersion(requested),
          capabilities: { tools: {} },
          serverInfo: { name: "engram", version: "0.1.0" },
        });
      }
      case "ping":
        return rpcResult(msg.id, {});
      case "tools/list":
        return rpcResult(msg.id, {
          tools: await listTools(token),
          ...toolsListCacheHints(token, clientMeta.protocolVersion),
        });
      case "tools/call": {
        const args = msg.params?.arguments ?? {};
        if (typeof name !== "string") return rpcError(msg.id, -32602, "missing tool name");
        return rpcResult(msg.id, await callTool(token, name, args ?? {}));
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    console.error("[mcp] handler error:", e);
    return rpcError(msg.id, -32603, `Internal error: ${String(e).slice(0, 300)}`);
  }
}

console.error("[engram] migrating gateway db...");
await migrate();
console.error("[engram] starting scope children:", config.scopes.join(", "));
await startScopes();

Bun.serve({
  port: config.port,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    // /health, not /healthz: Google's frontend reserves /healthz on run.app
    // domains and answers 404 before the request reaches the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return Response.json({ status: "ok", scopes: await scopesHealth() });
    }
    if (url.pathname === "/mcp") {
      if (req.method === "POST") return handleMcp(req);
      // No SSE stream support in stateless mode.
      return new Response("Method Not Allowed", { status: 405 });
    }
    const pathToken = url.pathname.match(/^\/t\/([^/]+)\/mcp$/);
    if (pathToken) {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      let rawToken: string;
      try {
        rawToken = decodeURIComponent(pathToken[1]);
      } catch {
        return Response.json({ error: "bad path token" }, { status: 400 });
      }
      const token = await authenticate(`Bearer ${rawToken}`);
      if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (!isPathTokenAllowed(token)) return Response.json({ error: "forbidden" }, { status: 403 });
      return handleMcp(req, token);
    }
    return new Response("Not Found", { status: 404 });
  },
});
console.error(`[engram] listening on :${config.port}`);
