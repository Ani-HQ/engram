import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config, dbUrl } from "./config";

interface BrainChild {
  client: Client;
  restarts: number;
}

let running: BrainChild | null = null;

function childEnv(): Record<string, string> {
  const home = `${config.gbrainHomesDir}/brain`;
  mkdirSync(home, { recursive: true });
  return {
    ...(process.env as Record<string, string>),
    GBRAIN_HOME: home,
    GBRAIN_DATABASE_URL: dbUrl(config.brainDb),
  };
}

function initBrain() {
  const r = spawnSync(config.gbrainBin, ["init", "--non-interactive", "--force", "--json"], {
    env: childEnv(),
    timeout: 120_000,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `gbrain init failed for ${config.brainDb} (status=${r.status}, ` +
      `error=${r.error ? String(r.error) : "none"}): ` +
      `stderr=${r.stderr?.slice(-400) ?? "none"} stdout=${r.stdout?.slice(-200) ?? "none"}`,
    );
  }
}

async function spawnBrain(restarts = running?.restarts ?? 0): Promise<BrainChild> {
  const transport = new StdioClientTransport({
    command: config.gbrainBin,
    args: ["serve"],
    env: childEnv(),
    stderr: "pipe",
  });
  const client = new Client({ name: "engram-gateway", version: "0.1.0" });
  await client.connect(transport);

  const child: BrainChild = { client, restarts };
  transport.onclose = () => {
    child.restarts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(child.restarts, 5));
    console.error(`[brain] gbrain child exited; respawn in ${delay}ms`);
    setTimeout(() => {
      spawnBrain(child.restarts).then(c => running = c).catch(e =>
        console.error("[brain] respawn failed:", e));
    }, delay);
  };
  return child;
}

export async function startBrain() {
  initBrain();
  running = await spawnBrain();
  console.error(`[brain] ready (db=${config.brainDb})`);
}

export function brainClient(): Client {
  if (!running) throw new Error("brain child is not ready");
  return running.client;
}

export async function brainHealth(): Promise<string> {
  try {
    await brainClient().callTool({ name: "get_health", arguments: {} });
    return "ok";
  } catch (e) {
    return `error: ${String(e).slice(0, 120)}`;
  }
}
