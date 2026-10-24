import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const entrypointSource = readFileSync(join(repository, "deploy/worker-entrypoint.sh"), "utf8");
const secret = "worker-db-sentinel-$(must-not-execute)-quote'\nsecond-line";
const token = "worker-sql-token-sentinel";

async function completed(child: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "engram-bootstrap-"));
  const entrypoint = join(directory, "worker-entrypoint"), engine = join(directory, "fake-engine"), credential = join(directory, `.engram-worker-env-${randomUUID()}.json`);
  // Exercise the actual production shell/bootstrap, substituting only fixed
  // filesystem locations that exist inside the production container image.
  writeFileSync(entrypoint, entrypointSource.replaceAll("/gbrain-work", directory).replaceAll("/usr/local/bin/bun", process.execPath).replaceAll("/usr/local/bin/gbrain", engine), { mode: 0o700 });
  writeFileSync(engine, `#!${process.execPath}\nimport {existsSync} from 'node:fs'; console.log(JSON.stringify({stdin:await Bun.stdin.text(),args:process.argv.slice(2),database:process.env.GBRAIN_DATABASE_URL,provider:process.env.VOYAGE_API_KEY,parent:process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE,credentialExists:existsSync(${JSON.stringify(credential)})}));`, { mode: 0o700 });
  const env = { HOME: directory, GBRAIN_HOME: directory, TMPDIR: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", GBRAIN_DATABASE_URL: secret, VOYAGE_API_KEY: "provider-sentinel" };
  const run = () => Bun.spawn(["/bin/sh", entrypoint, "--engram-env-file", credential, "serve", "--stdio"], { env: { PATH: "/usr/bin:/bin", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "parent-admin-sentinel" }, stdin: new Blob(["mcp-message\n"]), stdout: "pipe", stderr: "pipe" });
  return { directory, credential, env, run, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("sandbox credential bootstrap", () => {
  test("keeps all credential values out of sandbox argv and launcher environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "engram-command-"));
    try {
      const script = `
        import {readFileSync,statSync,unlinkSync} from 'node:fs';
        const {workerCommand}=await import('./gateway/src/worker-command');
        const first=workerCommand('org-7',['init','--yes'],${JSON.stringify({ GBRAIN_DATABASE_URL: secret, ENGRAM_WORKER_CLOUDSQL_TOKEN: token, ENGRAM_WORKER_CLOUDSQL_INSTANCE: "test:region:instance", VOYAGE_API_KEY: "provider-sentinel" })});
        const second=workerCommand('org-7',['serve'],{});
        console.log(JSON.stringify({args:first.args,env:first.env,file:first.cleanupFiles[0],secondFile:second.cleanupFiles[0],mode:statSync(first.cleanupFiles[0]).mode&511,uid:statSync(first.cleanupFiles[0]).uid,homeUid:statSync(first.cwd).uid,parentUid:process.getuid(),scoped:JSON.parse(readFileSync(first.cleanupFiles[0],'utf8'))}));
        for(const spec of [first,second]) for(const file of spec.cleanupFiles) unlinkSync(file);
      `;
      const result = await completed(Bun.spawn([process.execPath, "--eval", script], { cwd: repository, env: { ...process.env, ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_DATABASE_AUTHORITY: "runtime", ENGRAM_DB_URL_TEMPLATE: "postgresql://bootstrap_runtime:dummy@127.0.0.1:1/__DB__", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_TENANT_CREDENTIAL_KEY: "bootstrap-unit-only-key-32-characters", ENGRAM_WORKER_ISOLATION: "cloudrun", GBRAIN_HOMES_DIR: directory }, stdout: "pipe", stderr: "pipe" }));
      expect(result.code, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      const launcher = JSON.stringify({ args: value.args, env: value.env });
      for (const sentinel of [secret, token, "provider-sentinel", "parent-admin-sentinel"]) expect(launcher).not.toContain(sentinel);
      expect(value.args).not.toContain("--env");
      expect(value.args.slice(value.args.indexOf("/usr/local/bin/cloudrun-worker"), value.args.indexOf("/usr/local/bin/worker-entrypoint"))).toEqual(["/usr/local/bin/cloudrun-worker"]);
      expect(value.args).not.toContain("/usr/bin/setpriv");
      for (const path of ["/root", "/home", "/run", "/tmp", "/app"]) expect(value.args).toContain(`type=bind,source=/sandbox-empty,destination=${path},readonly`);
      expect(value.env).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin" });
      expect(value.mode).toBe(0o600);
      expect(value.uid).toBe(value.parentUid);
      expect(value.homeUid).toBe(value.parentUid);
      expect(value.file).not.toBe(value.secondFile);
      expect(value.scoped.GBRAIN_DATABASE_URL).toBe(secret);
      expect(value.scoped.ENGRAM_WORKER_CLOUDSQL_TOKEN).toBe(token);
      expect(value.scoped.HOME).toBe("/gbrain-work");
      expect(value.scoped.TMPDIR).toBe("/gbrain-work/.tmp");
      expect(existsSync(value.file)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("consumes and removes exact JSON values before the engine while preserving stdin", async () => {
    const f = fixture();
    try {
      writeFileSync(f.credential, JSON.stringify(f.env), { mode: 0o600 });
      const result = await completed(f.run());
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ stdin: "mcp-message\n", args: ["serve", "--stdio"], database: secret, provider: "provider-sentinel", credentialExists: false });
      expect(existsSync(f.credential)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("rejects a malformed or non-allowlisted environment without logging its contents", async () => {
    for (const malformed of [true, false]) {
      const f = fixture();
      try {
        const data = malformed ? secret : JSON.stringify({ ...f.env, ENGRAM_PROVISIONER_DB_URL_TEMPLATE: secret });
        writeFileSync(f.credential, data, { mode: 0o600 });
        const result = await completed(f.run());
        expect(result.code).toBe(70);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("Worker environment bootstrap failed\n");
        expect(existsSync(f.credential)).toBe(false);
      } finally { f.cleanup(); }
    }
  });

  test("refuses symlinks and group-readable credential files", async () => {
    for (const symlink of [false, true]) {
      const f = fixture();
      try {
        if (symlink) { const target = join(f.directory, "target"); writeFileSync(target, JSON.stringify(f.env), { mode: 0o600 }); symlinkSync(target, f.credential); }
        else { writeFileSync(f.credential, JSON.stringify(f.env), { mode: 0o600 }); chmodSync(f.credential, 0o640); }
        const result = await completed(f.run());
        expect(result.code).toBe(70);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("Worker environment bootstrap failed\n");
      } finally { f.cleanup(); }
    }
  });

  test("cleans an unconsumed credential only after runtime deletion succeeds", async () => {
    const f = fixture(), attempts = join(f.directory, "attempts");
    try {
      writeFileSync(f.credential, JSON.stringify(f.env), { mode: 0o600 });
      const script = `
        import {cleanupWorker} from './gateway/src/worker-transport';
        import {existsSync,readFileSync} from 'node:fs';
        const file=${JSON.stringify(f.credential)}, attempts=${JSON.stringify(attempts)};
        const cleanupCode=${JSON.stringify(`import {existsSync,readFileSync,writeFileSync} from 'node:fs'; const file=${JSON.stringify(f.credential)},attempts=${JSON.stringify(attempts)}; const previous=existsSync(attempts)?readFileSync(attempts,'utf8'):''; writeFileSync(attempts,previous+(existsSync(file)?'present':'missing')+'\\n'); process.exit(previous?0:1);`)};
        const spec={command:'unused',args:[],env:{PATH:'/usr/bin:/bin'},cwd:${JSON.stringify(f.directory)},cleanup:{command:process.execPath,args:['--eval',cleanupCode]},cleanupFiles:[file]};
        await cleanupWorker(spec);
        console.log(JSON.stringify({exists:existsSync(file),attempts:readFileSync(attempts,'utf8')}));
        await cleanupWorker(spec);
      `;
      const result = await completed(Bun.spawn([process.execPath, "--eval", script], { cwd: repository, stdout: "pipe", stderr: "pipe" }));
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ exists: false, attempts: "present\npresent\n" });
      expect(existsSync(f.credential)).toBe(false);
    } finally { f.cleanup(); }
  });
});
