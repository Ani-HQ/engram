import { describe, expect, test } from "bun:test";

describe("signup access provisioner authority", () => {
  test("runtime cannot grant access or process a workspace queue, even with a supplied database", async () => {
    const script = `
      const { applySignupInviteAccess, provisionPendingWorkspaces } = await import('./gateway/src/provisioning.ts');
      let databaseCalls = 0, rejected = 0;
      const db = { begin() { databaseCalls++; throw new Error('database must not be touched'); } };
      for (const run of [() => applySignupInviteAccess(db), () => provisionPendingWorkspaces()]) {
        try { await run(); } catch (error) { if (error.message === 'This identity cannot provision workspaces') rejected++; }
      }
      console.log(JSON.stringify({ rejected, databaseCalls }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        ENGRAM_DEPLOYMENT_MODE: "hosted",
        ENGRAM_DATABASE_AUTHORITY: "runtime",
        ENGRAM_DB_URL_TEMPLATE: "postgresql://runtime:unit-runtime@127.0.0.1:1/__DB__",
        ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "",
        ENGRAM_TENANT_CREDENTIAL_KEY: "unit-only-derivation-key-at-least-32-bytes",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ rejected: 2, databaseCalls: 0 });
  });
});
