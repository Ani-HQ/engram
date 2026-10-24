import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { complimentaryFailure, complimentarySettings, manageComplimentaryAccess } from "../deploy/complimentary-access";
import { BILLING_SCHEMA_VERSION } from "../gateway/src/billing-schema";
import { OwnerCheckError } from "../deploy/check-owners";

const now = new Date("2026-10-24T09:00:00.000Z");
const targetArgs = ["--project", "ani-hq", "--org", "1", "--workspace-name", "Ani HQ", "--owner-email", "owner@example.test"];
const options = (operation = "grant", extra: string[] = []) => complimentarySettings([operation, ...targetArgs, ...(operation === "inspect" ? [] : ["--request-id", "launch-owner-access-v1", "--reason", "Owner-authorized launch access"]), ...extra, "--run"], now);

function fixture() {
  let current: any = null;
  const events = new Map<string, any>();
  const state = { owner: "owner@example.test", ready: true, schema: BILLING_SCHEMA_VERSION, failAudit: false };
  const calls: { query: string; values: any[] }[] = [];
  let mutex = Promise.resolve();
  const tx = async (parts: TemplateStringsArray, ...values: any[]) => {
    const query = parts.join("?"); calls.push({ query, values });
    if (query.includes("SET LOCAL") || query.includes("pg_advisory_xact_lock")) return [];
    if (query.includes("engram_schema_state")) return [{ billing_version: state.schema }];
    if (query.includes("JOIN public.org_members")) return values[2] === state.owner ? [{ id: 1, name: "Ani HQ", member_id: 9, brain_db: "brain_shared", data_db: "engram_gateway", home_dir: "brain", provisioning_status: state.ready ? "ready" : "pending" }] : [];
    if (query.startsWith("SELECT") && query.includes("workspace_complimentary_access")) return current ? [{ ...current }] : [];
    if (query.startsWith("SELECT") && query.includes("complimentary_access_events")) return events.has(values[1]) ? [{ ...events.get(values[1]) }] : [];
    if (query.startsWith("INSERT INTO public.workspace_complimentary_access")) {
      current = { id: values[0], org_id: values[1], owner_member_id: values[2], granted_at: now.toISOString(), expires_at: values[3], revoked_at: null };
      return [];
    }
    if (query.startsWith("UPDATE public.workspace_complimentary_access")) {
      if (current?.org_id !== values[0] || current?.id !== values[1] || current.revoked_at !== null) return [];
      current.revoked_at = now.toISOString(); return [{ id: current.id }];
    }
    if (query.startsWith("INSERT INTO public.complimentary_access_events")) {
      if (state.failAudit) throw new Error("audit storage failure");
      events.set(values[5], { grant_id: values[2], operation: values[4], payload_hash: values[6], reason: values[7], expires_at: values[8] });
      return [];
    }
    throw new Error("Unexpected operator query");
  };
  const db = { begin: (...args: any[]) => {
    const work = args.at(-1);
    const pending = mutex.then(async () => {
      const previous = current ? { ...current } : null, priorEvents = new Map(events);
      try { return await work(tx); }
      catch (error) { current = previous; events.clear(); priorEvents.forEach((event, key) => events.set(key, event)); throw error; }
    });
    mutex = pending.then(() => {}, () => {});
    return pending;
  } } as unknown as postgres.Sql;
  return { db, calls, state, events, current: () => current };
}

describe("operator-only complimentary workspace access", () => {
  test("prints only a sanitized SQLSTATE from an operator diagnostic", () => {
    const privateError = Object.assign(new OwnerCheckError("database_unavailable", { errorName: "PostgresError", sqlState: "55P03" }), { query: "private query", parameters: ["private identity"] });
    expect(complimentaryFailure(privateError)).toEqual({ ok: false, operation: "complimentary_access", reason: "database_unavailable", diagnostic: { sqlState: "55P03" } });
    expect(complimentaryFailure(new OwnerCheckError("database_unavailable", { sqlState: "private identity" }))).toEqual({ ok: false, operation: "complimentary_access", reason: "database_unavailable" });
    expect(complimentaryFailure(Object.assign(new Error("private identity"), { code: "42501", query: "private query" }))).toEqual({ ok: false, operation: "complimentary_access", reason: "complimentary_unavailable" });
  });

  test("requires an explicit reviewed target, normalized owner and audited execution", async () => {
    expect(complimentarySettings(["grant", ...targetArgs, "--request-id", "launch-request-1", "--reason", "Authorized"], now)).toMatchObject({ run: false, expiresAt: null });
    for (const bad of [targetArgs.filter((_, i) => i !== 2 && i !== 3), targetArgs.map(value => value === "1" ? "2" : value), targetArgs.map(value => value === "Ani HQ" ? "Other workspace" : value), targetArgs.map(value => value === "owner@example.test" ? "Owner@example.test" : value)]) {
      expect(() => complimentarySettings(["grant", ...bad, "--request-id", "launch-request-1", "--reason", "Authorized"], now)).toThrow();
    }
    expect(() => complimentarySettings(["grant", ...targetArgs], now)).toThrow();
    expect(() => options("grant", ["--expires-at", "2026-10-23T00:00:00.000Z"])).toThrow();
    expect(() => options("grant", ["--expires-at", "2026-02-30T00:00:00.000Z"])).toThrow();
    const f = fixture();
    await expect(manageComplimentaryAccess(f.db, { ...options(), run: false }, now)).rejects.toMatchObject({ code: "explicit_execution_required" });
    expect(f.calls).toHaveLength(0);
  });

  test("verifies exact current owner and storage before any grant, never creates membership", async () => {
    for (const change of [{ owner: "someone-else@example.test" }, { ready: false }, { schema: BILLING_SCHEMA_VERSION - 1 }]) {
      const f = fixture(); Object.assign(f.state, change);
      await expect(manageComplimentaryAccess(f.db, options(), now)).rejects.toThrow();
      expect(f.current()).toBeNull(); expect(f.events.size).toBe(0);
      expect(f.calls.some(call => /^(?:INSERT|UPDATE|DELETE)\b/.test(call.query))).toBe(false);
    }
  });

  test("commits a genuine non-expiring grant and audit together, with no billing or identity mutation", async () => {
    const f = fixture(), result = await manageComplimentaryAccess(f.db, options(), now);
    expect(result).toMatchObject({ ok: true, ownerVerified: true, workspaceVerified: true, replayed: false, stripeBillingChanged: false, complimentary: { active: true, expiresAt: null, revokedAt: null } });
    expect(f.events.size).toBe(1);
    expect(f.calls.some(call => call.query.includes("FOR UPDATE OF o, m"))).toBe(true);
    expect(f.calls.some(call => call.query.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(f.calls.some(call => /(?:INSERT INTO|UPDATE|DELETE FROM) (?:public\.)?(workspace_billing|org_members|tokens)\b/.test(call.query))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("owner@example.test");
    expect(JSON.stringify(result)).not.toContain("Owner-authorized");
  });

  test("exact concurrent retries produce one grant/audit; changed retries cannot extend access", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([manageComplimentaryAccess(f.db, options(), now), manageComplimentaryAccess(f.db, options(), now)]);
    expect(a.grantId).toBe(b.grantId); expect(b.replayed).toBe(true); expect(f.events.size).toBe(1);
    await expect(manageComplimentaryAccess(f.db, { ...options(), reason: "A different authorization" }, now)).rejects.toMatchObject({ code: "complimentary_request_conflict" });
    await expect(manageComplimentaryAccess(f.db, { ...options(), requestId: "different-launch-request" }, now)).rejects.toMatchObject({ code: "complimentary_grant_already_active" });
    expect(f.events.size).toBe(1);
  });

  test("failed audit rolls the grant back rather than allowing unaudited access", async () => {
    const f = fixture(); f.state.failAudit = true;
    await expect(manageComplimentaryAccess(f.db, options(), now)).rejects.toThrow("audit storage failure");
    expect(f.current()).toBeNull(); expect(f.events.size).toBe(0);
  });

  test("revokes only the exact grant and preserves history, including retry and regrant safety", async () => {
    const f = fixture(), granted = await manageComplimentaryAccess(f.db, options(), now);
    const revoke = { ...options(), operation: "revoke" as const, requestId: "launch-owner-revoke-v1", grantId: granted.grantId! };
    await expect(manageComplimentaryAccess(f.db, { ...revoke, grantId: "a553749f-8cfa-4fb0-ae93-ddbdb11518e6" }, now)).rejects.toMatchObject({ code: "complimentary_grant_mismatch" });
    expect((await manageComplimentaryAccess(f.db, revoke, now)).complimentary?.active).toBe(false);
    expect((await manageComplimentaryAccess(f.db, revoke, now)).replayed).toBe(true);
    expect(f.events.size).toBe(2);
    const next = await manageComplimentaryAccess(f.db, { ...options(), requestId: "launch-owner-regrant-v2" }, now);
    expect(next.grantId).not.toBe(granted.grantId);
    await expect(manageComplimentaryAccess(f.db, { ...revoke, requestId: "launch-stale-revoke-v2" }, now)).rejects.toMatchObject({ code: "complimentary_grant_mismatch" });
    expect(f.current().revoked_at).toBeNull();
  });

  test("supports an explicit finite expiration and read-only bound inspection", async () => {
    const f = fixture();
    const expiration = "2026-11-01T00:00:00.000Z";
    await manageComplimentaryAccess(f.db, options("grant", ["--expires-at", expiration]), now);
    const result = await manageComplimentaryAccess(f.db, options("inspect"), now);
    expect(result).toMatchObject({ operation: "inspect", complimentary: { active: true, expiresAt: expiration } });
    expect(f.events.size).toBe(1);
  });
});
