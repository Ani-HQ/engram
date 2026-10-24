import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const fakeWorker = fileURLToPath(new URL("./fixtures/fake-brain-worker.mjs", import.meta.url));
// The suite launches several real subprocesses per case. Its outer deadline
// must exceed the child watchdog so the fixture owns cleanup on a slow Linux
// filesystem. Behavioral timing assertions below remain independent of startup.
const testTimeout = 15_000;
async function scenario(code: string, controls: Record<string, unknown> = {}, maxWorkers = 2, timeout = 12_000) {
  const directory = mkdtempSync(join(tmpdir(), "engram-runtime-")), events = join(directory, "events.jsonl");
  writeFileSync(events, "");
  for (const id of [7, 8, 9]) { const home = join(directory, `org-${id}`); mkdirSync(home); writeFileSync(join(home, "control.json"), JSON.stringify({ ...controls, events })); }
  const bootstrap = `
    import { readFileSync, appendFileSync } from 'node:fs';
    import { mock } from 'bun:test';
    const eventsFile = ${JSON.stringify(events)};
    const events = () => readFileSync(eventsFile, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
    // Only coordination is replaced. SDK Client and StdioClientTransport remain
    // real and launch the executable test process. Real PostgreSQL advisory-lock
    // serialization is covered by integration-tenant-security.ts separately.
    mock.module('./gateway/src/write-coordination', () => ({
      isMemoryMutation: name => name === 'put_page',
      withMemoryWriteLock: async work => { appendFileSync(eventsFile, JSON.stringify({kind:'lock-start',at:Date.now()})+'\\n'); try { return await work(); } finally { appendFileSync(eventsFile, JSON.stringify({kind:'lock-end',at:Date.now()})+'\\n'); } },
    }));
    const { ensureBrain, evictBrain, stopBrains, runningBrainCount } = await import('./gateway/src/brain');
    const { runWithContext } = await import('./gateway/src/context');
    const { DEFAULT_POLICIES, normalizeToken } = await import('./gateway/src/policies');
    const org = id => ({id,name:'test',slug:'test-'+id,kind:'personal',brainDb:'brain_org_'+id,dataDb:'brain_org_'+id,homeDir:'org-'+id,policies:DEFAULT_POLICIES});
    const inOrg = (id, work) => runWithContext({ org:org(id), token:normalizeToken({name:'test',orgId:id}), dataSql:() => {} },work);
    const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
    const waitFor = async predicate => { const until=Date.now()+2000; while(!predicate()) { if(Date.now()>until) throw new Error('Fixture event did not arrive'); await pause(5); } };
    try { ${code} } finally { await stopBrains(); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", bootstrap], { cwd: repository, env: {
    ...process.env, ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "1",
    ENGRAM_DB_URL_TEMPLATE: "postgresql://runtime-test:unit@127.0.0.1:1/__DB__",
    GBRAIN_BIN: fakeWorker, GBRAIN_HOMES_DIR: directory, ENGRAM_WORKER_ISOLATION: "process", ENGRAM_MAX_BRAIN_WORKERS: String(maxWorkers), ENGRAM_BRAIN_IDLE_MS: "60000",
  }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const records = readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { stdout, stderr, exitCode, records };
  } finally { clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); }
}

describe("real MCP worker lifecycle", () => {
  test("shares one initialization across concurrent requests for the same workspace", async () => {
    const result = await scenario(`
      const clients=await Promise.all([ensureBrain(org(7)),ensureBrain(org(7)),ensureBrain(org(7))]);
      console.log(JSON.stringify({same:clients.every(client=>client===clients[0]),count:runningBrainCount()}));
    `, { initDelay: 70 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ same: true, count: 1 });
    expect(result.records.filter(row => row.kind === "init-start")).toHaveLength(1);
    expect(result.records.filter(row => row.kind === "serve-start")).toHaveLength(1);
  }, testTimeout);

  test("keeps SDK close propagation so an exited child promptly rejects pending requests", async () => {
    const result = await scenario(`
      const client=await ensureBrain(org(7)); const pid=events().find(row=>row.kind==='serve-start').pid;
      const started=Date.now(); const pending=inOrg(7,()=>client.callTool({name:'search',arguments:{}},undefined,{timeout:2000})).then(()=>({rejected:false}),()=>({rejected:true,elapsed:Date.now()-started}));
      await waitFor(()=>events().some(row=>row.kind==='call-start')); process.kill(pid,'SIGKILL');
      console.log(JSON.stringify(await pending));
    `, { toolDelay: 1500 });
    expect(result.exitCode, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout);
    expect(outcome.rejected).toBe(true);
    expect(outcome.elapsed).toBeLessThan(700);
  }, testTimeout);

  test("does not start a replacement or exceed capacity while the previous child is closing", async () => {
    const result = await scenario(`
      await ensureBrain(org(7));
      await Promise.all([evictBrain(7),ensureBrain(org(7)),ensureBrain(org(8))]);
      console.log(JSON.stringify({count:runningBrainCount()}));
    `, { eofDelay: 100 }, 1);
    expect(result.exitCode, result.stderr).toBe(0);
    const live = new Set<number>(); let maximum = 0;
    for (const row of result.records) { if (row.kind === "serve-start") { live.add(row.pid); maximum = Math.max(maximum, live.size); } else if (row.kind === "exit") live.delete(row.pid); }
    expect(maximum).toBe(1);
    expect(JSON.parse(result.stdout).count).toBeLessThanOrEqual(1);
  }, testTimeout);

  test("fences in-progress startup during shutdown and rejects later starts", async () => {
    const result = await scenario(`
      const pending=ensureBrain(org(7)).catch(error=>error.message); await pause(20); await stopBrains(); await pending;
      let rejected=false; try { await ensureBrain(org(8)); } catch { rejected=true; }
      console.log(JSON.stringify({count:runningBrainCount(),rejected}));
    `, { initDelay: 120 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ count: 0, rejected: true });
    const started = result.records.filter(row => row.kind === "serve-start");
    for (const row of started) expect(result.records.some(event => event.pid === row.pid && event.kind === "exit")).toBe(true);
  }, testTimeout);

  test("drains initialization stderr before waiting for the handshake", async () => {
    const result = await scenario(`await ensureBrain(org(7)); console.log('connected');`, { stderrBytes: 256_000 }, 2, 3500);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("connected");
  }, testTimeout);

  test("terminates a timed-out mutation before releasing its write lock", async () => {
    const result = await scenario(`
      const client=await ensureBrain(org(7)); let rejected=false;
      try { await inOrg(7,()=>client.callTool({name:'put_page',arguments:{}},undefined,{timeout:35})); } catch { rejected=true; }
      await pause(250); console.log(JSON.stringify({rejected}));
    `, { toolDelay: 160 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).rejected).toBe(true);
    expect(result.records.some(row => row.kind === "mutation-end")).toBe(false);
    const unlock = result.records.findIndex(row => row.kind === "lock-end");
    const exit = result.records.findIndex(row => row.kind === "exit" && result.records.some(start => start.kind === "serve-start" && start.pid === row.pid));
    expect(exit).toBeGreaterThanOrEqual(0);
    expect(unlock).toBeGreaterThan(exit);
  }, testTimeout);
});
