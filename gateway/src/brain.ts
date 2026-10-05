import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config, dbUrl } from "./config";
import { currentOrg } from "./context";
import { ANI_HQ_ORG, type Org } from "./orgs";

interface BrainChild {
  client: Client;
  orgId: number;
  restarts: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const running = new Map<number, BrainChild>();

function childEnv(org: Pick<Org, "brainDb" | "homeDir">): Record<string, string> {
  const home = `${config.gbrainHomesDir}/${org.homeDir}`;
  mkdirSync(home, { recursive: true });
  return {
    ...(process.env as Record<string, string>),
    GBRAIN_HOME: home,
    GBRAIN_DATABASE_URL: dbUrl(org.brainDb),
  };
}

function initBrain(org: Pick<Org, "brainDb" | "homeDir">) {
  const args = ["init", "--non-interactive", "--force", "--json"];
  if (config.voyage.apiKey) {
    args.push(
      "--embedding-model",
      config.voyage.model,
      "--embedding-dimensions",
      String(config.voyage.dimensions),
    );
  }
  const r = spawnSync(config.gbrainBin, args, {
    env: childEnv(org),
    timeout: 120_000,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `gbrain init failed for ${org.brainDb} (status=${r.status}, ` +
      `error=${r.error ? String(r.error) : "none"}): ` +
      `stderr=${r.stderr?.slice(-400) ?? "none"} stdout=${r.stdout?.slice(-200) ?? "none"}`,
    );
  }
}

function touchIdle(child: BrainChild) {
  if (child.idleTimer) clearTimeout(child.idleTimer);
  child.idleTimer = setTimeout(() => {
    evictBrain(child.orgId);
  }, config.brainIdleMs);
}

async function spawnBrain(org: Pick<Org, "id" | "brainDb" | "homeDir">, restarts = 0): Promise<BrainChild> {
  const transport = new StdioClientTransport({
    command: config.gbrainBin,
    args: ["serve"],
    env: childEnv(org),
    stderr: "pipe",
  });
  const client = new Client({ name: "engram-gateway", version: "0.1.0" });
  await client.connect(transport);

  const child: BrainChild = { client, orgId: org.id, restarts, idleTimer: null };
  transport.onclose = () => {
    if (!running.has(org.id) || running.get(org.id) !== child) return;
    child.restarts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(child.restarts, 5));
    console.error(`[brain] gbrain child for org ${org.id} exited; respawn in ${delay}ms`);
    setTimeout(() => {
      spawnBrain(org, child.restarts).then(next => {
        running.set(org.id, next);
        touchIdle(next);
      }).catch(e => console.error("[brain] respawn failed:", e));
    }, delay);
  };
  touchIdle(child);
  return child;
}

export async function ensureBrain(org: Pick<Org, "id" | "brainDb" | "homeDir">): Promise<Client> {
  const existing = running.get(org.id);
  if (existing) {
    touchIdle(existing);
    return existing.client;
  }
  initBrain(org);
  const child = await spawnBrain(org);
  running.set(org.id, child);
  console.error(`[brain] ready org=${org.id} db=${org.brainDb}`);
  return child.client;
}

export function evictBrain(orgId: number) {
  const child = running.get(orgId);
  if (!child) return;
  running.delete(orgId);
  if (child.idleTimer) clearTimeout(child.idleTimer);
  child.client.close().catch(() => {});
}

// Boot used to start the single Ani HQ child. Children now start on first use so
// an idle org does not hold a process. Kept as a no-op so existing call sites
// (the dream job, index) stay valid.
export async function startBrain() {
  return;
}

export function brainClient(): Client {
  const org = currentOrg() ?? ANI_HQ_ORG;
  const child = running.get(org.id);
  if (!child) throw new Error(`brain child is not ready for org ${org.id}`);
  return child.client;
}

export function runningBrainCount(): number {
  return running.size;
}

export async function brainHealth(): Promise<string> {
  if (running.size === 0) return "idle";
  try {
    const first = running.values().next().value;
    if (!first) return "idle";
    await first.client.callTool({ name: "get_health", arguments: {} });
    return "ok";
  } catch (e) {
    return `error: ${String(e).slice(0, 120)}`;
  }
}
