import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverOwner, recoverySettings } from "../deploy/recover-owner";
import { OwnerCheckError, withOperatorDatabase } from "../deploy/check-owners";

const repository = fileURLToPath(new URL("..", import.meta.url));
const options = { project: "ani-hq" as const, orgId: 1 as const, email: "verified-owner@example.com", run: true };
function fixture(members: Array<{ id: number; email: string; role: string }> = [], validBinding = true, verify = true) {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const tx = async (parts: TemplateStringsArray, ...args: unknown[]) => {
    const sql = parts.join("?"); queries.push({ sql, args });
    if (sql.includes("FROM public.orgs")) return validBinding ? [{ id: 1, brain_db: "brain_shared", data_db: "engram_gateway", home_dir: "brain" }] : [{ id: 1, brain_db: "brain_org_7", data_db: "brain_org_7", home_dir: "org-7" }];
    if (sql.startsWith("SELECT id, email")) return members.filter(member => member.role === "owner" || member.email === args[0]);
    if (sql.startsWith("INSERT")) { members.push({ id: 31, email: String(args[0]), role: "owner" }); return [{ id: 31 }]; }
    if (sql.startsWith("SELECT id, role")) return verify ? members.filter(member => member.role === "owner").map(({ id, role }) => ({ id, role })) : [];
    return [];
  };
  return { db: { begin: (work: (tx: any) => unknown) => work(tx) } as any, queries, members };
}

describe("explicit operator owner recovery", () => {
  test("only accepts the exact target and an already normalized explicit email", () => {
    expect(recoverySettings(["--project", "ani-hq", "--org", "1", "--email", options.email])).toEqual({ ...options, run: false });
    for (const args of [
      ["--project", "different-project", "--org", "1", "--email", options.email],
      ["--project", "ani-hq", "--org", "2", "--email", options.email],
      ["--project", "ani-hq", "--org", "01", "--email", options.email],
      ["--project", "ani-hq", "--org", "1", "--email", "Owner@example.com"],
      ["--project", "ani-hq", "--org", "1", "--email", " owner@example.com"],
      ["--project", "ani-hq", "--org", "1"],
      ["--project", "ani-hq", "--org", "1", "--email", options.email, "--promote"],
    ]) expect(() => recoverySettings(args)).toThrow(OwnerCheckError);
  });

  test("default CLI is an offline plan that does not print the email or access credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "engram-recovery-plan-")), called = join(directory, "called");
    try {
      writeFileSync(join(directory, "gcloud"), `#!/bin/sh\ntouch '${called}'\nexit 99\n`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, "deploy/recover-owner.ts", "--project", "ani-hq", "--org", "1", "--email", options.email], { cwd: repository, env: { PATH: directory }, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, error).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ mode: "plan", orgId: 1, execute: false, existingMemberPromotion: false, migrations: false });
      expect(output).not.toContain(options.email);
      expect(existsSync(called)).toBe(false);
      await expect(withOperatorDatabase({ project: "ani-hq", region: "us-central1", instance: "engram-pg", run: false }, "write", async () => true)).rejects.toMatchObject({ code: "explicit_execution_required" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("locks the exact workspace and membership writes before inserting one new owner", async () => {
    const f = fixture();
    expect(await recoverOwner(f.db, options)).toEqual({ ok: true, operation: "owner_created", orgId: 1, memberId: 31, ownerRows: 1 });
    const sql = f.queries.map(query => query.sql);
    expect(sql.findIndex(query => query.includes("FROM public.orgs") && query.includes("WHERE id = 1 FOR UPDATE"))).toBeLessThan(sql.findIndex(query => query.startsWith("LOCK TABLE")));
    expect(sql.findIndex(query => query.startsWith("LOCK TABLE public.org_members IN SHARE ROW EXCLUSIVE MODE"))).toBeLessThan(sql.findIndex(query => query.startsWith("INSERT")));
    expect(f.queries.find(query => query.sql.startsWith("INSERT"))?.args).toEqual([options.email]);
    expect(sql.filter(query => query.startsWith("INSERT"))).toHaveLength(1);
    expect(sql.some(query => /^(UPDATE|DELETE|ALTER|CREATE|DROP)/.test(query))).toBe(false);
  });

  test("is idempotent only for the selected existing owner", async () => {
    const selected = fixture([{ id: 17, email: options.email, role: "owner" }]);
    expect(await recoverOwner(selected.db, options)).toMatchObject({ ok: true, operation: "already_owner", memberId: 17 });
    expect(selected.queries.some(query => query.sql.startsWith("INSERT"))).toBe(false);
    const otherOwner = fixture([{ id: 18, email: "someone-else@example.com", role: "owner" }]);
    await expect(recoverOwner(otherOwner.db, options)).rejects.toMatchObject({ code: "recovery_owners_already_exist" });
    expect(otherOwner.queries.some(query => query.sql.startsWith("INSERT"))).toBe(false);
  });

  test("refuses existing member promotion, unexpected binding, and missing execution authorization", async () => {
    const member = fixture([{ id: 20, email: options.email, role: "member" }]);
    await expect(recoverOwner(member.db, options)).rejects.toMatchObject({ code: "existing_member_promotion_not_authorized" });
    expect(member.members[0].role).toBe("member");
    expect(member.queries.some(query => query.sql.startsWith("INSERT"))).toBe(false);
    const invalid = fixture([], false);
    await expect(recoverOwner(invalid.db, options)).rejects.toMatchObject({ code: "recovery_workspace_binding_invalid" });
    expect(invalid.queries.some(query => query.sql.startsWith("INSERT"))).toBe(false);
    const unapproved = fixture();
    await expect(recoverOwner(unapproved.db, { ...options, run: false })).rejects.toMatchObject({ code: "explicit_execution_required" });
    expect(unapproved.queries).toHaveLength(0);
  });

  test("throws inside the transaction if inserted ownership does not verify", async () => {
    await expect(recoverOwner(fixture([], true, false).db, options)).rejects.toMatchObject({ code: "recovery_verification_failed" });
  });
});
