import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseCredentials, inspectOwners, OwnerCheckError, settings } from "../deploy/check-owners";

const repository = fileURLToPath(new URL("..", import.meta.url));
function fakeDatabase(rows: unknown[], tables = { orgs: true, members: true }, readonly = true) {
  const queries: string[] = [];
  const tx = async (parts: TemplateStringsArray) => {
    const query = parts.join("?"); queries.push(query);
    if (query.startsWith("SHOW")) return [{ transaction_read_only: readonly ? "on" : "off" }];
    if (query.includes("to_regclass")) return [tables];
    return rows;
  };
  const db = { begin: async (mode: string, work: (tx: any) => unknown) => { expect(mode).toBe("isolation level repeatable read read only"); return work(tx); } };
  return { db: db as any, queries };
}

describe("read-only production owner prerequisite", () => {
  test("default invocation is an offline plan and validates its explicit target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "engram-owner-plan-")), called = join(directory, "called");
    try {
      writeFileSync(join(directory, "gcloud"), `#!/bin/sh\ntouch '${called}'\nexit 99\n`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, "deploy/check-owners.ts", "--project", "ani-hq"], { cwd: repository, env: { PATH: directory }, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, error).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ mode: "plan", transaction: "READ ONLY", mutations: false });
      expect(existsSync(called)).toBe(false);
      expect(settings(["--project", "ani-hq", "--run"]).run).toBe(true);
      for (const args of [[], ["--project", "ani-hq", "--secret", "unreviewed"], ["--project", "ani-hq", "--instance", "db?address=0.0.0.0"], ["--project", "ani-hq", "--run", "--run"]]) expect(() => settings(args)).toThrow(OwnerCheckError);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("parses userinfo only without carrying remote URL options into the local connection", () => {
    expect(databaseCredentials("postgresql://operator:p%27%5C%40ss@remote.example/__DB__?host=/cloudsql/ignored&sslmode=require")).toEqual({ username: "operator", password: "p'\\@ss" });
    for (const value of ["postgresql://operator:secret@remote/other", "https://operator:secret@remote/__DB__", "postgresql://operator:secret@remote/__DB__?password=override"]) {
      try { databaseCredentials(value); throw new Error("Accepted invalid URL"); }
      catch (error) { expect(error).toBeInstanceOf(OwnerCheckError); expect(String(error)).not.toContain("secret"); }
    }
  });

  test("counts only membership prerequisites and never emits email or token fields", async () => {
    const fixture = fakeDatabase([{ org_id: 1, owner_rows: 1, login_owners: 1, email: "must-not-emit@example.com", token: "must-not-emit" }, { org_id: 7, owner_rows: 2, login_owners: 1 }]);
    const result = await inspectOwners(fixture.db);
    expect(result).toEqual({ ok: true, gate: "owner_membership", reason: "owners_present", orgs: [{ orgId: 1, ownerRows: 1, loginOwners: 1 }, { orgId: 7, ownerRows: 2, loginOwners: 1 }] });
    expect(JSON.stringify(result)).not.toContain("must-not-emit");
    expect(fixture.queries.every(query => /^(SHOW|SELECT)/.test(query.trim()))).toBe(true);
    expect(fixture.queries.join(" ")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
  });

  test("fails closed before querying membership when read-only mode or tables are absent", async () => {
    const writable = fakeDatabase([], undefined, false);
    await expect(inspectOwners(writable.db)).rejects.toMatchObject({ code: "readonly_not_enforced" });
    expect(writable.queries).toHaveLength(1);
    const missing = fakeDatabase([], { orgs: true, members: false });
    expect(await inspectOwners(missing.db)).toMatchObject({ ok: false, reason: "schema_missing", orgs: [] });
    expect(missing.queries).toHaveLength(2);
    expect(await inspectOwners(fakeDatabase([{ org_id: 1, owner_rows: 1, login_owners: 0 }]).db)).toMatchObject({ ok: false, reason: "owners_missing" });
    expect(await inspectOwners(fakeDatabase([{ org_id: 7, owner_rows: 1, login_owners: 1 }]).db)).toMatchObject({ ok: false, reason: "org1_missing" });
  });

  test("sends OAuth only through proxy environment and hides database credentials on failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "engram-owner-proxy-")), called = join(directory, "called");
    const proxy = `#!${process.execPath}\nconst leaked=JSON.stringify({args:process.argv,env:process.env}); if(process.env.CSQL_PROXY_TOKEN!=='oauth-unit-sentinel' || leaked.includes('database-password-sentinel'))process.exit(90); import{writeFileSync}from'node:fs'; writeFileSync(${JSON.stringify(called)},'checked'); process.exit(0);`;
    try {
      writeFileSync(join(directory, "gcloud"), "#!/bin/sh\ncase \"$1\" in auth) printf oauth-unit-sentinel;; secrets) printf 'postgresql://operator:database-password-sentinel@remote/__DB__';; *) exit 99;; esac\n", { mode: 0o700 });
      writeFileSync(join(directory, "cloud-sql-proxy"), proxy, { mode: 0o700 });
      const code = `const {checkOwners}=await import('./deploy/check-owners');try{await checkOwners({project:'ani-hq',region:'us-central1',instance:'engram-pg',run:true})}catch(error){console.log(JSON.stringify({code:error.code}))}`;
      const child = Bun.spawn([process.execPath, "--eval", code], { cwd: repository, env: { PATH: directory }, stdout: "pipe", stderr: "pipe" });
      const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(status, error).toBe(0);
      expect(error).toBe("");
      expect(JSON.parse(output)).toEqual({ code: "sql_proxy_unavailable" });
      expect(output).not.toContain("sentinel");
      expect(readFileSync(called, "utf8")).toBe("checked");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
