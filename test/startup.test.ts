import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../deploy/entrypoint.sh", import.meta.url)), "utf8");

async function startup(env: Record<string, string> = {}, uid = "0", args = ["/usr/bin/printf", "%s", "started"]) {
  const directory = mkdtempSync(join(tmpdir(), "engram-startup-"));
  try {
    const setpriv = join(directory, "setpriv"), runtime = join(directory, "runtime"), wrapper = join(directory, "entrypoint");
    writeFileSync(join(directory, "id"), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_UID"\n', { mode: 0o700 });
    writeFileSync(setpriv, `#!${process.execPath}\nconsole.log(JSON.stringify({drop:process.argv.slice(2)}));`, { mode: 0o700 });
    writeFileSync(runtime, '#!/bin/sh\nprintf "runtime"\n', { mode: 0o700 });
    // Substitute image-only executable locations, keeping the production shell
    // conditions and argument handling intact. Actual Linux UIDs have a separate
    // mandatory Docker gate against the built image.
    writeFileSync(wrapper, source.replaceAll("/usr/bin/setpriv", setpriv).replaceAll("/usr/local/bin/engram-runtime", runtime), { mode: 0o700 });
    const child = Bun.spawn(["/bin/sh", wrapper, ...args], { env: { PATH: `${directory}:/usr/bin:/bin`, FIXTURE_UID: uid, ...env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr, runtime };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("container startup authority", () => {
  test("drops process, Docker and every provisioner path before command execution", async () => {
    for (const env of [{}, { ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_JOB: "dream" }, { ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_WORKER_ISOLATION: "docker" }, { ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_JOB: "provision" }, { ENGRAM_WORKER_ISOLATION: "cloudrun", ENGRAM_JOB: "provision" }]) {
      const result = await startup(env);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).drop).toEqual(["--reuid=1000", "--regid=1000", "--clear-groups", "--no-new-privs", "--", "/usr/bin/printf", "%s", "started"]);
    }
  }, 15_000);

  test("retains root only for explicit or hosted-default Cloud Run launchers", async () => {
    for (const env of [{ ENGRAM_DEPLOYMENT_MODE: "hosted" }, { ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_JOB: "dream" }, { ENGRAM_WORKER_ISOLATION: "cloudrun" }]) {
      const result = await startup(env);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("started");
    }
    const unsupported = await startup({ ENGRAM_DEPLOYMENT_MODE: "hosted" }, "1000");
    expect(unsupported.code).toBe(78);
    expect(unsupported.stdout).toBe("");
  }, 15_000);

  test("fails closed on invalid modes and preserves already non-root command arguments", async () => {
    for (const env of [{ ENGRAM_DEPLOYMENT_MODE: "" }, { ENGRAM_WORKER_ISOLATION: "" }, { ENGRAM_WORKER_ISOLATION: "unknown" }, { ENGRAM_JOB: "unknown" }]) {
      const result = await startup(env);
      expect(result.code).toBe(64);
      expect(result.stdout).toBe("");
    }
    const literal = "literal $(must-not-execute) ' quoted";
    const result = await startup({}, "1000", ["/usr/bin/printf", "%s", literal]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(literal);
    const defaultCommand = await startup({}, "1000", []);
    expect(defaultCommand.code, defaultCommand.stderr).toBe(0);
    expect(defaultCommand.stdout).toBe("runtime");
  }, 15_000);
});
