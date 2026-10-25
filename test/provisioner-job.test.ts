import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
async function job(result: { ready: number; failed: number; pending: number }, migrationFailure = false, operatorReason?: string) {
  const directory = mkdtempSync(join(tmpdir(), "engram-provisioner-job-"));
  const closed = join(directory, "closed"), preload = join(directory, "preload.ts");
  const source = `import {mock} from 'bun:test';import{writeFileSync}from'node:fs';
    ${operatorReason ? "process.env.ENGRAM_JEV_OPERATOR_EMAIL='private-operator@example.test';" : "delete process.env.ENGRAM_JEV_OPERATOR_EMAIL;"}
    mock.module(${JSON.stringify(join(repository,"gateway/src/jev.ts"))},()=>({configureJevOperatorDefault:async()=>({applied:${operatorReason === 'applied'},reason:${JSON.stringify(operatorReason ?? 'already-configured')}})}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/config.ts"))},()=>({databaseSecurity:{authority:'provisioner'}}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/db.ts"))},()=>({sql:{},migrate:async()=>{${migrationFailure ? "throw Object.assign(new Error('private-password-and-tenant-content'),{code:'42501',detail:'private-password-and-tenant-content'})" : ""}},closeDatabasePools:async()=>{writeFileSync(${JSON.stringify(closed)},'closed')}}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/provisioning.ts"))},()=>({provisionPendingWorkspaces:async()=>(${JSON.stringify(result)})}));`;
  try {
    writeFileSync(preload, source);
    const child = Bun.spawn([process.execPath, "--preload", preload, "gateway/src/jobs/provision.ts"], { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(readFileSync(closed, "utf8")).toBe("closed");
    return { stdout, stderr, code };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("provisioner job completion", () => {
  test("explicit operator target fails closed when absent or ambiguous, but reruns honor optout", async () => {
    for (const reason of ['owner-not-found','ambiguous-owner']) {
      const result = await job({ready:0,failed:0,pending:0},false,reason);
      expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('private-operator');
    }
    expect((await job({ready:0,failed:0,pending:0},false,'already-configured')).code).toBe(0);
  });
  test("succeeds only when every queued workspace is ready", async () => {
    const result = await job({ ready: 2, failed: 0, pending: 0 });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ provisioning: { ready: 2, failed: 0, pending: 0 } });
    expect(result.stderr).toBe("");
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
  });
});
