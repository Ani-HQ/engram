import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
async function run(options: { enabled?: boolean; ready?: boolean; authority?: string; fail?: boolean; retried?: number; dryRun?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "engram-mail-job-"));
  const marker = join(directory, "closed"), calls = join(directory, "calls"), preload = join(directory, "preload.ts");
  const result = { enabled: true, dryRun: !!options.dryRun, blocked: false, due: 1, sent: options.retried ? 0 : 1, skipped: 0, retried: options.retried ?? 0, failed: 0, canceled: 0, pending: 0 };
  writeFileSync(preload, `import{mock}from'bun:test';import{writeFileSync,appendFileSync}from'node:fs';
    const record=(v)=>appendFileSync(${JSON.stringify(calls)},v+'\\n');
    mock.module(${JSON.stringify(join(repository, "gateway/src/config.ts"))},()=>({config:{deploymentMode:'hosted'},databaseSecurity:{authority:${JSON.stringify(options.authority ?? "runtime")}}}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/db.ts"))},()=>({migrate:async()=>record('schema'),closeDatabasePools:async()=>writeFileSync(${JSON.stringify(marker)},'closed')}));
    mock.module(${JSON.stringify(join(repository, "gateway/src/mail-series.ts"))},()=>({preflightMailSeries:()=>({enabled:${options.enabled !== false},ready:${options.ready !== false},missing:[]}),drainMailSeries:async(args)=>{record(JSON.stringify(args));${options.fail ? "throw new Error('private-recipient-and-provider-key')" : `return ${JSON.stringify(result)}`}}}));`);
  try {
    const child = Bun.spawn([process.execPath, "--preload", preload, "gateway/src/jobs/mail.ts", ...(options.dryRun ? ["--dry-run"] : [])], { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(readFileSync(marker, "utf8")).toBe("closed");
    let operations = "";
    try { operations = readFileSync(calls, "utf8"); } catch {}
    return { stdout, stderr, code, operations };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("mail worker verifies schema, bounds work and closes pools", async () => {
  const result = await run();
  expect(result.code).toBe(0);
  expect(result.operations).toBe('schema\n{"dryRun":false,"limit":25}\n');
  expect(JSON.parse(result.stdout).mail.sent).toBe(1);
});

test("dry run propagates without changing its sending policy", async () => {
  const result = await run({ dryRun: true });
  expect(result.operations).toContain('"dryRun":true');
});

test("disabled delivery never accesses the database or queue", async () => {
  const result = await run({ enabled: false });
  expect(result.code).toBe(0);
  expect(result.operations).toBe("");
  expect(JSON.parse(result.stdout).mail).toEqual({ enabled: false, sent: 0 });
});

test("privileged identity or incomplete configuration fails before schema access", async () => {
  for (const options of [{ authority: "provisioner" }, { ready: false }]) {
    const result = await run(options);
    expect(result.code).toBe(1);
    expect(result.operations).toBe("");
  }
});

test("provider failure is observable without leaking recipient or credentials", async () => {
  const result = await run({ fail: true });
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("[mail] delivery job failed; inspect aggregate delivery state\n");
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("private-recipient");
  expect((await run({ retried: 1 })).code).toBe(1);
});
