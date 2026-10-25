import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
async function job(result: { ready: number; failed: number; pending: number }, migrationFailure = false, operatorReason?: string, workspaceId?: string, reprovisionAll = false) {
  const directory = mkdtempSync(join(tmpdir(), "engram-provisioner-job-"));
  const closed = join(directory, "closed"), configured = join(directory, "configured"), migrated = join(directory, "migrated"), eventsFile = join(directory, "events"), preload = join(directory, "preload.ts");
  const source = `import {mock} from 'bun:test';import{writeFileSync}from'node:fs';
    const events=[];const record=value=>{events.push(value);writeFileSync(${JSON.stringify(eventsFile)},JSON.stringify(events))};
    const runtimeClient=async()=>{record('runtime-write-denied');throw Object.assign(new Error('request role cannot write operator grants'),{code:'42501'})};
    const provisionerClient=Object.assign(async statements=>{record(statements.join('').includes('jev_operator_access')?'operator-write':'maintenance-write');return[]},{end:async options=>{if(options.timeout!==2)throw new Error('Unexpected pool shutdown');record('provisioner-close')}});
    ${operatorReason ? "process.env.ENGRAM_JEV_OPERATOR_EMAIL='private-operator@example.test';" : "delete process.env.ENGRAM_JEV_OPERATOR_EMAIL;"}
    ${workspaceId === undefined ? "delete process.env.ENGRAM_JEV_OPERATOR_WORKSPACE_ID;" : `process.env.ENGRAM_JEV_OPERATOR_WORKSPACE_ID=${JSON.stringify(workspaceId)};`}
    mock.module(${JSON.stringify(join(repository,"gateway/src/jev.ts"))},()=>({configureJevOperatorDefault:async(db,input)=>{record('configure');writeFileSync(${JSON.stringify(configured)},JSON.stringify(input));await db\`INSERT INTO jev_operator_access DEFAULT VALUES\`;${operatorReason === 'throw' ? "throw Object.assign(new Error('private-bootstrap-query-detail'),{code:'42501'});" : ""}return {applied:${operatorReason === 'applied'},reason:${JSON.stringify(operatorReason ?? 'already-configured')}}}}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/config.ts"))},()=>({databaseSecurity:{authority:'provisioner'}}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/db.ts"))},()=>({sql:runtimeClient,migrate:async()=>{record('migrate');writeFileSync(${JSON.stringify(migrated)},'yes');${migrationFailure ? "throw Object.assign(new Error('private-password-and-tenant-content'),{code:'42501',detail:'private-password-and-tenant-content'})" : ""}},closeDatabasePools:async()=>{record('request-close');writeFileSync(${JSON.stringify(closed)},'closed')}}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/tenant-db.ts"))},()=>({provisionerPool:name=>{if(name!=='engram_gateway')throw new Error('Unexpected provisioner database');record('provisioner-open:'+name);return provisionerClient}}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/provisioning.ts"))},()=>({provisionPendingWorkspaces:async()=>{record('provision-workspaces');return ${JSON.stringify(result)}}}));`;
  try {
    writeFileSync(preload, source);
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, "gateway/src/jobs/provision.ts", ...(reprovisionAll ? ['--reprovision-all'] : [])], { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(readFileSync(closed, "utf8")).toBe("closed");
    const optionalFile = (path: string) => { try { return readFileSync(path,'utf8'); } catch { return undefined; } };
    return { stdout, stderr, code, configured: optionalFile(configured), migrated: optionalFile(migrated), events: JSON.parse(optionalFile(eventsFile) ?? '[]') as string[] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("provisioner job completion", () => {
  test("explicit operator target fails closed when absent or ambiguous, but reruns honor optout", async () => {
    for (const reason of ['owner-not-found','ambiguous-owner','configuration-conflict']) {
      const result = await job({ready:0,failed:0,pending:0},false,reason);
      expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('private-operator');
      expect(result.events.slice(-2)).toEqual(['provisioner-close','request-close']);
      expect(result.events).not.toContain('provision-workspaces');
    }
    expect((await job({ready:0,failed:0,pending:0},false,'already-configured')).code).toBe(0);
  });
  test("uses the provisioner client and closes it before normal provisioning on successful bootstrap", async () => {
    const result = await job({ready:1,failed:0,pending:0},false,'applied','123');
    expect(result.code).toBe(0);
    expect(result.events).toEqual(['migrate','provisioner-open:engram_gateway','configure','operator-write','provisioner-close','provision-workspaces','request-close']);
  });
  test("closes both clients after a bootstrap query failure and withholds private details", async () => {
    const result = await job({ready:0,failed:0,pending:0},false,'throw','123');
    expect(result.code).toBe(1);
    expect(result.events).toEqual(['migrate','provisioner-open:engram_gateway','configure','operator-write','provisioner-close','request-close']);
    expect(result.stderr).toBe('[provision] setup failed: 42501\n');
    expect(result.stderr).not.toContain('private-bootstrap-query-detail');
  });
  test("maintenance reprovisioning uses a scoped provisioner client without bootstrapping an operator", async () => {
    const result = await job({ready:0,failed:0,pending:0},false,undefined,undefined,true);
    expect(result.code).toBe(0);
    expect(result.events).toEqual(['migrate','provisioner-open:engram_gateway','maintenance-write','provisioner-close','provision-workspaces','request-close']);
  });
  test("passes an explicit workspace only to the bootstrap and rejects malformed selectors before migration", async () => {
    const explicit = await job({ready:0,failed:0,pending:0},false,'applied','123');
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.configured!)).toEqual({email:'private-operator@example.test',workspaceId:123});
    const implicit = await job({ready:0,failed:0,pending:0},false,'already-configured');
    expect(JSON.parse(implicit.configured!)).toEqual({email:'private-operator@example.test'});
    for (const invalid of ['0','-1','01','1.5','1e2','2147483648','NaN']) {
      const result = await job({ready:0,failed:0,pending:0},false,'applied',invalid);
      expect(result.code).toBe(1); expect(result.configured).toBeUndefined(); expect(result.migrated).toBeUndefined();
    }
    const missingEmail = await job({ready:0,failed:0,pending:0},false,undefined,'123');
    expect(missingEmail.code).toBe(1); expect(missingEmail.migrated).toBeUndefined();
  });
  test("succeeds only when every queued workspace is ready", async () => {
    const result = await job({ ready: 2, failed: 0, pending: 0 });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ provisioning: { ready: 2, failed: 0, pending: 0 } });
    expect(result.stderr).toBe("");
    expect(result.events).toEqual(['migrate','provision-workspaces','request-close']);
  });
  test("a backoff retry with no new failure still fails while storage is pending", async () => {
    const result = await job({ ready: 0, failed: 0, pending: 1 });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).provisioning.pending).toBe(1);
  });
  test("reports a claimed storage failure as a failed execution", async () => {
    expect((await job({ ready: 0, failed: 1, pending: 1 })).code).toBe(1);
  });
  test("migration failure logs only its safe category and still closes pools", async () => {
    const result = await job({ ready: 0, failed: 0, pending: 0 }, true);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("[provision] setup failed: 42501\n");
    expect(result.stderr).not.toContain("private-password-and-tenant-content");
    expect(result.events).toEqual(['migrate','request-close']);
  });
});
