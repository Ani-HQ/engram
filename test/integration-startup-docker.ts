/** Mandatory built-image startup check: no database, credentials or providers.
 * Runs only the real entrypoint and an ordinary Python command override in
 * network-disabled disposable containers; never starts the product server.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const image = process.env.ENGRAM_TEST_WORKER_IMAGE ?? "engram:hardening";
if (!/^engram:hardening(?:-arm|-startup-test)?$/.test(image)) throw new Error("Use a locally built Engram hardening test image");
let checks = 0;
const probe = 'import json,os; s=open("/proc/self/status").read(); print(json.dumps({"uid":os.getuid(),"gid":os.getgid(),"groups":os.getgroups(),"noNewPrivileges":"NoNewPrivs:\\t1" in s}))';
async function inspect(env: Record<string, string>, user?: string) {
  const name = `engram-startup-test-${randomUUID()}`;
  const child = Bun.spawn(["docker", "run", "--rm", "--name", name, "--network", "none", "--security-opt", "no-new-privileges", ...(user ? ["--user", user] : []), ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]), image, "/usr/bin/python3", "-c", probe], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(deadline);
    const cleanup = Bun.spawn(["docker", "rm", "--force", name], { stdout: "ignore", stderr: "ignore" });
    const cleanupDeadline = setTimeout(() => cleanup.kill("SIGKILL"), 10_000);
    await cleanup.exited;
    clearTimeout(cleanupDeadline);
  }
}
for (const [name, env, expected] of [
  ["default self-hosted process", {}, 1000],
  ["self-hosted dream", { ENGRAM_JOB: "dream" }, 1000],
  ["hosted Docker", { ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_WORKER_ISOLATION: "docker" }, 1000],
  ["hosted provisioner", { ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_JOB: "provision" }, 1000],
  ["explicit Cloud Run provisioner", { ENGRAM_WORKER_ISOLATION: "cloudrun", ENGRAM_JOB: "provision" }, 1000],
  ["hosted Cloud Run HTTP", { ENGRAM_DEPLOYMENT_MODE: "hosted" }, 0],
  ["hosted Cloud Run dream", { ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_JOB: "dream" }, 0],
  ["explicit self-hosted Cloud Run", { ENGRAM_WORKER_ISOLATION: "cloudrun" }, 0],
] as const) {
  const result = await inspect(env);
  assert.equal(result.code, 0, `${name}: ${result.stderr}`); checks++;
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.uid, expected, `${name}: final Linux UID`); checks++;
  assert.equal(actual.gid, expected, `${name}: final Linux GID`); checks++;
  if (expected === 1000) {
    assert.deepEqual(actual.groups, [], `${name}: inherited supplementary groups cleared`); checks++;
    assert.equal(actual.noNewPrivileges, true, `${name}: cannot regain privilege`); checks++;
  }
}
const alreadyNonRoot = await inspect({}, "1000:1000");
assert.equal(alreadyNonRoot.code, 0, alreadyNonRoot.stderr); checks++;
assert.equal(JSON.parse(alreadyNonRoot.stdout).uid, 1000); checks++;
const unsupported = await inspect({ ENGRAM_DEPLOYMENT_MODE: "hosted" }, "1000:1000");
assert.equal(unsupported.code, 78, "An unsupported non-root Cloud Run launcher fails before running a command"); checks++;
assert.equal(unsupported.stdout, ""); checks++;
for (const env of [{ ENGRAM_DEPLOYMENT_MODE: "" }, { ENGRAM_WORKER_ISOLATION: "" }, { ENGRAM_JOB: "invalid" }]) {
  const invalid = await inspect(env);
  assert.equal(invalid.code, 64, "Invalid authority settings fail before command execution"); checks++;
  assert.equal(invalid.stdout, ""); checks++;
}
console.log(`Actual Docker startup authority passed (${checks} checks).`);
