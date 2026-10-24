import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { config } from "./config";
import { currentContext, currentOrg } from "./context";
import { type Org } from "./orgs";
import { brainEnvironment } from "./privacy";
import { isMemoryMutation, withMemoryWriteLock } from "./write-coordination";
import { workerCommand, workerSettings } from "./worker-command";
import { workerConnectorEnvironment } from "./worker-credentials";
import { WorkerTransport, cleanupWorker } from "./worker-transport";

type BrainOrg = Pick<Org, "id" | "brainDb" | "homeDir"> & Partial<Pick<Org, "policies">>;
interface BrainChild {
  raw: Client; client: Client; orgId: number; active: number; waiting: number;
  idleTimer: ReturnType<typeof setTimeout> | null; lifetimeTimer: ReturnType<typeof setTimeout> | null; externalAi: boolean; lastUsed: number; reservation: symbol; closed: boolean;
}
const running = new Map<number, BrainChild>();
const starting = new Map<number, Promise<Client>>();
const occupied = new Map<number, symbol>();
const closing = new Map<number, Promise<void>>();
let stopping = false;
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Engine stderr may contain private page text or credential URLs, so command
// output is never reflected into HTTP errors or shared application logs.
export async function runBrainCommand(org: BrainOrg, args: string[], timeoutMs = 120_000): Promise<void> {
  const spec = workerCommand(org.homeDir, args, { ...brainEnvironment(org), ...(workerSettings.isolation === "cloudrun" ? await workerConnectorEnvironment() : {}) });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "ignore", "ignore"], detached:process.platform !== "win32" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid!,"SIGKILL"); } catch {} }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Memory worker could not start")); });
    child.once("close", async code => { clearTimeout(timer); await cleanupWorker(spec); code === 0 && !timedOut ? resolve() : reject(new Error("Memory worker command failed")); });
  });
}

function touchIdle(child: BrainChild) {
  child.lastUsed = Date.now();
  if (child.idleTimer) clearTimeout(child.idleTimer);
  child.idleTimer = setTimeout(() => {
    if (child.active || child.waiting) touchIdle(child);
    else void evictBrain(child.orgId);
  }, config.brainIdleMs);
  child.idleTimer.unref?.();
}
async function reserveWorker(orgId: number) {
  const deadline = Date.now() + 10_000;
  while (occupied.size >= workerSettings.maxWorkers) {
    const idle = [...running.values()].filter(c => !c.active && !c.waiting).sort((a,b) => a.lastUsed-b.lastUsed)[0];
    if (idle) { await evictBrain(idle.orgId); continue; }
    if (Date.now() >= deadline) throw new Error("Memory workers are busy. Please retry shortly.");
    await pause(50);
  }
  if (stopping) throw new Error("Memory workers are shutting down");
  const reservation = Symbol();
  occupied.set(orgId, reservation);
  return reservation;
}
function checkContext(orgId: number) {
  const ctx = currentContext();
  if (!ctx || ctx.org.id !== orgId || ctx.token.orgId !== orgId) throw new Error("A matching workspace context is required to access memory");
}
async function useChild<T>(child: BrainChild, work: () => Promise<T>): Promise<T> {
  checkContext(child.orgId);
  if (child.waiting >= 16) throw new Error("This workspace has too many pending memory requests");
  child.waiting++;
  try {
    const deadline = Date.now() + 10_000;
    while (child.active >= workerSettings.maxCalls) {
      if (Date.now() >= deadline) throw new Error("This workspace's memory worker is busy");
      await pause(20);
    }
    if (running.get(child.orgId) !== child) throw new Error("Memory worker changed. Please retry.");
    child.active++;
    try { return await work(); }
    finally { child.active--; touchIdle(child); }
  } finally { child.waiting--; }
}
async function spawnBrain(org: BrainOrg, reservation: symbol): Promise<BrainChild> {
  const spec = workerCommand(org.homeDir, ["serve"], { ...brainEnvironment(org), ...(workerSettings.isolation === "cloudrun" ? await workerConnectorEnvironment() : {}) });
  const transport = new WorkerTransport(spec);
  const raw = new Client({ name: "engram-gateway", version: "0.1.0" });
  const child: BrainChild = { raw, client: raw, orgId: org.id, active: 0, waiting: 0, idleTimer: null, lifetimeTimer: null, externalAi: org.policies?.externalAiProcessing === true, lastUsed: Date.now(), reservation, closed: false };
  raw.onclose = () => {
    child.closed = true;
    if (running.get(org.id) !== child) return;
    running.delete(org.id);
    if (occupied.get(org.id) === reservation) occupied.delete(org.id);
    if (child.idleTimer) clearTimeout(child.idleTimer);
    if (child.lifetimeTimer) clearTimeout(child.lifetimeTimer);
  };
  child.client = new Proxy(raw, { get(target, prop) {
    if (prop === "callTool") return (request: any, schema?: any, options?: any) => {
      const call = () => useChild(child, async () => {
        try { return await target.callTool(request, schema, { ...options, timeout: Math.min(120_000, options?.timeout ?? 60_000), maxTotalTimeout: 120_000 }); }
        catch (error) {
          // MCP cancellation settles the request before an engine necessarily
          // stops. Retire its process while the write lock is still held.
          if (isMemoryMutation(request.name)) await evictBrain(child.orgId);
          throw error;
        }
      });
      return isMemoryMutation(request.name) ? withMemoryWriteLock(call) : call();
    };
    if (prop === "listTools") return (...args: any[]) => useChild(child, () => (target.listTools as any)(...args));
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  const timer = setTimeout(() => { void raw.close(); }, 30_000);
  try { await raw.connect(transport); }
  catch { await transport.close(); throw new Error("Memory worker could not initialize"); }
  finally { clearTimeout(timer); }
  return child;
}
export async function ensureBrain(org: BrainOrg): Promise<Client> {
  if (stopping) throw new Error("Memory workers are shutting down");
  if (!Number.isSafeInteger(org.id) || org.id < 1) throw new Error("Invalid workspace binding");
  await closing.get(org.id);
  const existing = running.get(org.id);
  if (existing && existing.externalAi === (org.policies?.externalAiProcessing === true)) { touchIdle(existing); return existing.client; }
  if (existing) await evictBrain(org.id);
  const inflight = starting.get(org.id);
  if (inflight) { await inflight; return ensureBrain(org); }
  if (starting.size >= 16) throw new Error("Memory worker startup queue is full");
  const pending = (async () => {
    const reservation = await reserveWorker(org.id);
    try {
      const args = ["init", "--non-interactive", "--force", "--json"];
      if (org.policies?.externalAiProcessing === true && config.voyage.apiKey && workerSettings.isolation !== "docker") args.push("--embedding-model", config.voyage.model, "--embedding-dimensions", String(config.voyage.dimensions));
      else args.push("--no-embedding");
      await runBrainCommand(org, args);
      const child = await spawnBrain(org, reservation);
      if (stopping || child.closed) { await child.raw.close().catch(() => {}); throw new Error("Memory worker startup was interrupted"); }
      running.set(org.id, child); touchIdle(child);
      // Connector credentials last one hour; retire well before expiry. In-flight
      // calls fail explicitly if this deadline is reached, then retry lazily.
      child.lifetimeTimer = setTimeout(() => { void evictBrain(org.id); },45 * 60_000);
      child.lifetimeTimer.unref?.();
      return child.client;
    } catch (error) { if (occupied.get(org.id) === reservation) occupied.delete(org.id); throw error; }
  })().finally(() => starting.delete(org.id));
  starting.set(org.id, pending);
  return pending;
}
export function evictBrain(orgId: number): Promise<void> {
  const pendingClose = closing.get(orgId);
  if (pendingClose) return pendingClose;
  const child = running.get(orgId);
  if (!child) return Promise.resolve();
  running.delete(orgId);
  if (child.idleTimer) clearTimeout(child.idleTimer);
  if (child.lifetimeTimer) clearTimeout(child.lifetimeTimer);
  const pending = child.raw.close().catch(() => {}).then(() => {
    if (occupied.get(orgId) === child.reservation) occupied.delete(orgId);
  }).finally(() => { if (closing.get(orgId) === pending) closing.delete(orgId); });
  closing.set(orgId,pending);
  return pending;
}
export async function stopBrains() { stopping = true; await Promise.allSettled([...starting.values()]); await Promise.all([...running.keys()].map(evictBrain)); await Promise.all([...closing.values()]); }
export async function startBrain() { /* workers start lazily */ }
export function brainClient(): Client {
  const org = currentOrg();
  if (!org) throw new Error("A workspace context is required to access memory");
  checkContext(org.id);
  const child = running.get(org.id);
  if (!child) throw new Error("Memory worker is not ready");
  return child.client;
}
export function runningBrainCount() { return running.size; }
export async function brainHealth(): Promise<string> {
  // Probes must not execute a random tenant's tools or disclose its errors.
  return running.size ? "ok" : "idle";
}
