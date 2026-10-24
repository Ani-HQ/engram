import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/** Bun module mocks share one registry across test files. Run suites that mock
 * production modules in a fresh process, retaining every original assertion and
 * the nested runner's failure output without modifying other suites' imports.
 */
export function isolatedSuite(name: string, suite: URL): void {
  test(name, async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(suite)], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: process.env,
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 18_000);
    try {
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      // Keep per-case diagnostics visible in the full suite and CI logs.
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      expect(status, `${name} subprocess failed\n${stderr}\n${stdout}`).toBe(0);
      const plainDiagnostics = stderr.replace(/\u001b\[[0-9;]*m/g, "");
      expect(Number(/^\s+(\d+) pass\s*$/m.exec(plainDiagnostics)?.[1] ?? 0), "The isolated runner must execute its assertions").toBeGreaterThan(0);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
  }, 20_000);
}
