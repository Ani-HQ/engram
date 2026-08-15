// One persistent `gbrain serve` stdio child per scope, supervised.
// Each child gets its own GBRAIN_HOME (config isolation) and GBRAIN_DATABASE_URL
// (data isolation — one Postgres database per scope; this is the privacy boundary).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config, dbUrl, scopeDb } from "./config";

interface ScopeChild {
  scope: string;
  client: Client;
  restarts: number;
}

const children = new Map<string, ScopeChild>();

function childEnv(scope: string): Record<string, string> {
  const home = `${config.gbrainHomesDir}/${scope.replace(/[^a-z0-9]+/g, "_")}`;
  mkdirSync(home, { recursive: true });
  return {
    ...(process.env as Record<string, string>),
    GBRAIN_HOME: home,
    GBRAIN_DATABASE_URL: dbUrl(scopeDb(scope)),
  };
}

// Idempotent: applies migrations and (re)writes the per-scope config.json.
function initScope(scope: string) {
  const r = spawnSync(config.gbrainBin, ["init", "--non-interactive", "--force", "--json"], {
    env: childEnv(scope),
    timeout: 120_000,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`gbrain init failed for scope ${scope}: ${r.stderr?.slice(-500)}`);
  }
}

async function spawnChild(scope: string): Promise<ScopeChild> {
  const transport = new StdioClientTransport({
    command: config.gbrainBin,
    args: ["serve"],
    env: childEnv(scope),
    stderr: "pipe",
  });
  const client = new Client({ name: "engram-gateway", version: "0.1.0" });
  await client.connect(transport);

  const child: ScopeChild = { scope, client, restarts: children.get(scope)?.restarts ?? 0 };
  transport.onclose = () => {
    child.restarts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(child.restarts, 5));
    console.error(`[scopes] gbrain child for '${scope}' exited; respawn in ${delay}ms`);
    setTimeout(() => {
      spawnChild(scope).then(c => children.set(scope, c)).catch(e =>
        console.error(`[scopes] respawn failed for '${scope}':`, e));
    }, delay);
  };
  return child;
}

export async function startScopes() {
  for (const scope of config.scopes) {
    initScope(scope);
    children.set(scope, await spawnChild(scope));
    console.error(`[scopes] '${scope}' ready (db=${scopeDb(scope)})`);
  }
}

export function scopeClient(scope: string): Client {
  const c = children.get(scope);
  if (!c) throw new Error(`unknown scope: ${scope}`);
  return c.client;
}

export async function scopesHealth(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [scope, c] of children) {
    try {
      await c.client.callTool({ name: "get_health", arguments: {} });
      out[scope] = "ok";
    } catch (e) {
      out[scope] = `error: ${String(e).slice(0, 120)}`;
    }
  }
  return out;
}
