// engram gateway: stateless MCP-over-HTTP endpoint at /mcp.
// Each POST is authenticated, handled, answered with application/json — no
// server-side session state, so Cloud Run can recycle instances freely.
import { config } from "./config";
import { migrate } from "./db";
import { authenticate } from "./auth";
import { startScopes, scopesHealth } from "./scopes";
import { listTools, callTool } from "./proxy";

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

async function handleMcp(req: Request): Promise<Response> {
  const token = await authenticate(req.headers.get("authorization"));
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

  // Notifications and responses get 202 with no body per streamable HTTP spec.
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202 });
  }

  try {
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "engram", version: "0.1.0" },
        });
      }
      case "ping":
        return rpcResult(msg.id, {});
      case "tools/list":
        return rpcResult(msg.id, { tools: await listTools(token) });
      case "tools/call": {
        const { name, arguments: args } = msg.params ?? {};
        if (typeof name !== "string") return rpcError(msg.id, -32602, "missing tool name");
        return rpcResult(msg.id, await callTool(token, name, args ?? {}));
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
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
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok", scopes: await scopesHealth() });
    }
    if (url.pathname === "/mcp") {
      if (req.method === "POST") return handleMcp(req);
      // No SSE stream support in stateless mode.
      return new Response("Method Not Allowed", { status: 405 });
    }
    return new Response("Not Found", { status: 404 });
  },
});
console.error(`[engram] listening on :${config.port}`);
