import { describe, expect, test } from "bun:test";

const strictEnv = {
  ...process.env,
  ENGRAM_DEPLOYMENT_MODE: "hosted",
  ENGRAM_DATABASE_AUTHORITY: "provisioner",
  ENGRAM_DB_URL_TEMPLATE: "postgresql://gateway:unit-runtime@127.0.0.1:1/__DB__",
  ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "postgresql://provisioner:unit-admin@127.0.0.1:1/__DB__",
  ENGRAM_TENANT_CREDENTIAL_KEY: "unit-only-derivation-key-at-least-32-bytes",
  ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "1",
};
async function evaluate(script: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...strictEnv, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

describe("tenant database credential configuration", () => {
  test("hosted cannot fall back to legacy administrator credentials", async () => {
    const result = await evaluate('await import("./gateway/src/config.ts")', { ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ENGRAM_PROVISIONER_DB_URL_TEMPLATE");
    const weak = await evaluate('await import("./gateway/src/config.ts")', { ENGRAM_TENANT_CREDENTIAL_KEY: "too-short" });
    expect(weak.code).not.toBe(0);
    expect(weak.stderr).toContain("at least 32 bytes");
    const sameRole = await evaluate('await import("./gateway/src/config.ts")', { ENGRAM_PROVISIONER_DB_URL_TEMPLATE: strictEnv.ENGRAM_DB_URL_TEMPLATE });
    expect(sameRole.code).not.toBe(0);
    expect(sameRole.stderr).toContain("different PostgreSQL roles");
  });

  test("only explicit self-hosted compatibility preserves a single shared credential", async () => {
    const result = await evaluate('const { databaseSecurity } = await import("./gateway/src/config.ts"); const { tenantDbUrl } = await import("./gateway/src/tenant-db.ts"); console.log(databaseSecurity.legacy, new URL(tenantDbUrl("brain_org_7")).username)', {
      ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_TENANT_CREDENTIAL_KEY: "",
      ENGRAM_DATABASE_AUTHORITY: "inline",
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("true gateway");
    const disabled = await evaluate('await import("./gateway/src/config.ts")', {
      ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "0", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "",
      ENGRAM_DATABASE_AUTHORITY: "inline",
    });
    expect(disabled.code).not.toBe(0);
  });

  test("hosted runtime loads without any provisioner secret and rejects accidental authority injection", async () => {
    const script = 'const { databaseSecurity, provisionerDbUrl } = await import("./gateway/src/config.ts"); let denied = false; try { provisionerDbUrl("postgres"); } catch { denied = true; } console.log(databaseSecurity.authority, denied)';
    const runtime = await evaluate(script, { ENGRAM_DATABASE_AUTHORITY: "runtime", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "" });
    expect(runtime.code).toBe(0);
    expect(runtime.stdout.trim()).toBe("runtime true");
    const leaked = await evaluate(script, { ENGRAM_DATABASE_AUTHORITY: "runtime" });
    expect(leaked.code).not.toBe(0);
    expect(leaked.stderr).toContain("must not receive a provisioner credential");
  });

  test("the hosted HTTP entrypoint rejects a provisioner identity before any database or sandbox startup", async () => {
    const result = await evaluate('await import("./gateway/src/index.ts")', {
      ENGRAM_WORKER_ISOLATION: "cloudrun", ENGRAM_SANDBOX_BIN: "/unavailable-engram-test-sandbox",
      ENGRAM_OAUTH_PRIVATE_KEY: "", ENGRAM_BRIEF_API_KEY: "", REFLEX_API_KEY: "", VOYAGE_API_KEY: "",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Hosted HTTP requires the restricted runtime database identity");
    expect(result.stderr).not.toContain("[engram] migrating gateway db");
    expect(result.stderr).not.toContain("Worker isolation");
    expect(result.stdout).toBe("");
  });

  test("credentials stay stable per tenant while worker endpoints can differ", async () => {
    const result = await evaluate(`
      const { tenantDbUrl } = await import("./gateway/src/tenant-db.ts");
      const a = new URL(tenantDbUrl("brain_org_7")), again = new URL(tenantDbUrl("brain_org_7"));
      const b = new URL(tenantDbUrl("brain_org_8"));
      const worker = new URL(tenantDbUrl("brain_org_7", "postgresql://ignored:ignored@10.0.0.2:5432/__DB__?sslmode=require"));
      let rejected = 0;
      for (const name of ["engram_gateway", "brain_org_1", "brain_org_07", "brain_org_7/../brain_org_8", "brain_org_9007199254740992"]) { try { tenantDbUrl(name); } catch { rejected++; } }
      console.log(JSON.stringify({ stable: a.href === again.href, separate: a.username !== b.username && a.password !== b.password, workerSameIdentity: worker.username === a.username && worker.password === a.password, workerHost: worker.hostname, tls: worker.searchParams.get("sslmode"), rejected }));
    `);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ stable: true, separate: true, workerSameIdentity: true, workerHost: "10.0.0.2", tls: "require", rejected: 5 });
    expect(result.stdout).not.toContain("unit-runtime");
    expect(result.stdout).not.toContain("unit-admin");
  });
});
