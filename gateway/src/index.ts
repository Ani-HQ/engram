// engram gateway: stateless MCP-over-HTTP endpoint at /mcp.
// Each POST is authenticated, handled, answered with application/json — no
// server-side session state, so Cloud Run can recycle instances freely.
import { authenticateRequest } from "./auth";
import { brainHealth, ensureBrain, stopBrains } from "./brain";
import { config, databaseSecurity } from "./config";
import { connectorBranding } from "../../shim/branding.js";
import { migrate, closeDatabasePools } from "./db";
import { closeWriteCoordinator } from "./write-coordination";
import { startInsightWorker } from "./insights";
import { verifyWorkerIsolation } from "./worker-preflight";
import {
  insufficientScope,
  isAuthorizationServerPath,
  isProtectedResourcePath,
  corsHeaders,
  oauthEnabled,
  protectedResourceMetadata,
  resourceHost,
  unauthorizedResponse,
} from "./oauth";
import { authorizationServerMetadata, handleOauth } from "./oauth-as";
import { resolveOrg, withOrg } from "./orgs";
import { mcpMethodNotAllowed } from "./mcp-http";
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
import { processingOrg } from "./privacy";
import { handleSharedContextMcp } from "./shared-context-mcp";
import { isSharedContextSlug } from "./shared-context-read";
import { parseMcpMemoryContext } from "./mcp-request-context";
import { sha256 } from "./hash";
import { observeConnectionClient } from "./connection-client";

if (config.deploymentMode === "hosted" && databaseSecurity.authority !== "runtime") {
  throw new Error("Hosted HTTP requires the restricted runtime database identity");
}

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

  let memoryContext: import("./mcp-context").McpCallContext = {};
  try { if (method === "tools/call") memoryContext = parseMcpMemoryContext(msg.params?._meta); }
  catch (error) { return rpcError(msg.id, -32602, error instanceof Error ? error.message : "Invalid Engram context metadata.", 400); }
  if (memoryContext.verification && name !== "whoami") return rpcError(msg.id, -32602, "Verification control is available only through whoami.", 400);
  // The bearer is authenticated above. Its digest scopes checks to this exact
  // credential without putting a secret or client-chosen authority in storage.
  memoryContext.credentialKey = sha256(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "");

  const actor = normalizeToken(token);
  if (actor.kind === "oauth" && !hasOauthScope(actor, "memory:read")) {
    return insufficientScope(req);
  }

  const org = await processingOrg(await resolveOrg(actor), actor);

  return withOrg(org, actor, async () => {
    try {
      // Display metadata is best-effort and never changes credential authority.
      await observeConnectionClient(actor, memoryContext.credentialKey!, method, msg.params).catch(() => {});
      const snapshotRead = name === "get_page" && isSharedContextSlug(msg.params?.arguments?.slug);
      if (method === "tools/list" || (method === "tools/call" && !snapshotRead && !["record_action", "list_actions", "whoami", "checkpoint_task", "find_tasks", "resume_task"].includes(name ?? ""))) await ensureBrain(org);
      switch (method) {
        case "initialize": {
          const requested = msg.params?.protocolVersion;
          const protocolVersion = negotiateProtocolVersion(requested);
          const serverInfo = connectorBranding(resourceHost(req));
          return rpcResult(msg.id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo,
            ...(protocolVersion === "2026-07-28" ? { _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } } : {}),
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
          return rpcResult(msg.id, await callTool(actor, name, args ?? {}, memoryContext));
        }
        default:
          return rpcError(msg.id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      console.error("[mcp] request failed");
      return rpcError(msg.id, -32603, "Memory is temporarily unavailable. Please retry.");
    }
  });
}

async function wellKnown(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const cors = corsHeaders();
  if (req.method === "OPTIONS" && (isProtectedResourcePath(url.pathname) || isAuthorizationServerPath(url.pathname))) {
    return new Response(null, { status: 204, headers: cors });
  }
  if (isProtectedResourcePath(url.pathname)) {
    return Response.json(protectedResourceMetadata(resourceHost(req)), { headers: cors });
  }
  if (isAuthorizationServerPath(url.pathname)) {
    if (!oauthEnabled()) return new Response("Not Found", { status: 404, headers: cors });
    return Response.json(authorizationServerMetadata(resourceHost(req)), { headers: cors });
  }
  return null;
}

console.error("[engram] migrating gateway db...");
await verifyWorkerIsolation();
await migrate();
console.error("[engram] brains start on first use");

const insights = startInsightWorker();
const server = Bun.serve({
  port: config.port,
  idleTimeout: 120,
  maxRequestBodySize: 1024 * 1024,
  error() { console.error("[http] request failed"); return Response.json({error:"Temporarily unavailable"},{status:503}); },
  async fetch(req) {
    const url = new URL(req.url);
    const metadata = await wellKnown(req);
    if (metadata) return metadata;
    const oauth = await handleOauth(req, url);
    if (oauth) return oauth;
    // /health, not /healthz: Google's frontend reserves /healthz on run.app
    // domains and answers 404 before the request reaches the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        brain: await brainHealth(),
        oauth: oauthEnabled(),
      });
    }
    if (url.pathname === "/mcp/shared") return handleSharedContextMcp(req);
    if (url.pathname === "/mcp") {
      if (req.method === "POST") return handleMcp(req);
      // No SSE stream. Browsers get a short hint; MCP clients still see 405.
      return mcpMethodNotAllowed(req);
    }
    return handleWeb(req);
  },
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(0),8500);
  deadline.unref?.();
  const draining = server.stop();
  await Promise.race([draining,new Promise(resolve => setTimeout(resolve,1000))]);
  await server.stop(true);
  await Promise.allSettled([insights.close(), stopBrains()]);
  await closeWriteCoordinator();
  await closeDatabasePools();
  clearTimeout(deadline);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
console.error(`[engram] listening on :${config.port}`);
