import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("OAuth access, code and refresh credentials remain bound across removal and rejoining", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/oauth-membership-flow.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, fixture], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status, stderr).toBe(0);
  expect(JSON.parse(stdout).checks).toBeGreaterThanOrEqual(20);
}, 10_000);
