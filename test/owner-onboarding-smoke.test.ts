import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { settings } from "../deploy/smoke-candidate";
import { ownerOnboardingSettings, ownerSmokeRequest, ownerSmokeState, secureOwnerCookie, withOwnerSmokeSession } from "../deploy/smoke-owner-onboarding";

function database(failRevoke = false, unknownCommit = false) {
  let row: any, revocations: any[] = [];
  const db: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join("?");
    if (sql.includes("FROM public.orgs")) return [{ brain_db: "brain_shared", data_db: "engram_gateway", home_dir: "brain", provisioning_status: "ready", policies: {} }];
    if (sql.includes("FROM public.org_members")) return [{ id: 9 }];
    if (sql.includes("SELECT nextval")) return [{ id: 71 }];
    if (sql.includes("INSERT INTO public.sessions")) { row = { id: values[0], name: values[1], email: values[2], hash: values[3], revoked: false }; if (unknownCommit) throw new Error("unknown commit"); }
    if (sql.includes("FROM public.workspace_billing")) return [{ stripe_customer_id: null }];
    if (sql.includes("UPDATE public.sessions")) { revocations.push(values); if (failRevoke) throw new Error("revoke unavailable"); if (row && values[0] === row.id && values[1] === row.hash && values[2] === row.name) row.revoked = true; }
    if (sql.includes("SELECT NOT EXISTS")) return [{ confirmed: !row || row.revoked }];
    return [];
  };
  db.begin = async (work: any) => work(db);
  return { db, row: () => row, revocations: () => revocations };
}

describe("operator owner onboarding smoke", () => {
  test("uses fixed-host certificate-verified IPv4 with bounded bodies, abort and no redirects", async () => {
    let selected: any, sent: unknown, destroyed = false;
    function transport(status: number, payload: Buffer, hang = false): any {
      return (options: any, receive: any) => {
        selected = options;
        const req: any = new EventEmitter();
        req.destroy = () => { destroyed = true; };
        req.end = (body: unknown) => { sent = body; if (hang) return; queueMicrotask(() => {
          const res: any = new EventEmitter(); res.statusCode = status; res.headers = { "set-cookie": ["opaque-cookie"] }; res.destroy = () => {}; res.resume = () => {};
          receive(res); res.emit("data", payload); res.emit("end");
        }); };
        return req;
      };
    }
    const signal = new AbortController().signal;
    const value = await ownerSmokeRequest("/api/session", "POST", { token: "PRIVATE" }, "", "1", signal, transport(200, Buffer.from('{"ok":true}')));
    expect(value).toEqual({ status: 200, data: { ok: true }, setCookie: "opaque-cookie" });
    expect(selected).toMatchObject({ hostname: "candidate---engram-l4ewh6u7va-uc.a.run.app", protocol: "https:", family: 4, rejectUnauthorized: true, path: "/api/session", method: "POST" });
    expect(selected.headers["X-Engram-Console"]).toBe("1"); expect(selected.headers.Authorization).toBeUndefined(); expect(sent).toBe('{"token":"PRIVATE"}');
    await expect(ownerSmokeRequest("/api/me", "GET", undefined, "", "1", signal, transport(302, Buffer.from("{}")))).rejects.toThrow();
    await expect(ownerSmokeRequest("/api/me", "GET", undefined, "", "1", signal, transport(200, Buffer.alloc(1_000_001)))).rejects.toThrow();
    expect(destroyed).toBe(true);
    const controller = new AbortController(); destroyed = false;
    const pending = ownerSmokeRequest("/api/me", "GET", undefined, "", "1", controller.signal, transport(200, Buffer.from("{}"), true)); controller.abort();
    await expect(pending).rejects.toThrow(); expect(destroyed).toBe(true);
    expect(() => ownerSmokeRequest("/api/login/email", "POST", {}, "", "1", signal)).toThrow();
  });
  test("requires a normalized operator-supplied owner identity", () => {
    const args = ["--project", "ani-hq", "--image", "gcr.io/ani-hq/engram:immutable-build", "--state-file", "/tmp/metadata-only.json"];
    expect(() => ownerOnboardingSettings(args)).toThrow();
    expect(() => ownerOnboardingSettings([...args, "--owner-email", "Owner@example.com"])).toThrow();
    expect(ownerOnboardingSettings([...args, "--owner-email", "owner@example.com"]).ownerEmail).toBe("owner@example.com");
  });
  test("requires a fresh local release state pinned to the sole authorized candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-owner-plan-")), path = join(dir, "state.json");
    const options = settings(["--project", "ani-hq", "--image", "gcr.io/ani-hq/engram:immutable-build", "--state-file", path]);
    const state = { project: "ani-hq", region: "us-central1", service: "engram", image: options.image, tag: "candidate", candidateRevision: "engram-r-test", candidateURL: "https://candidate---engram-l4ewh6u7va-uc.a.run.app" };
    try {
      writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
      expect(ownerSmokeState(options).candidateRevision).toBe(state.candidateRevision);
      writeFileSync(path, JSON.stringify({ ...state, candidateURL: "https://evil.example" }));
      expect(() => ownerSmokeState(options)).toThrow();
      writeFileSync(path, JSON.stringify(state)); utimesSync(path, new Date(0), new Date(0));
      expect(() => ownerSmokeState(options)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("accepts only the exact secure host cookie without domain widening", () => {
    const raw = "ens_" + "x".repeat(32), cookie = `engram_session=${raw}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1209600`;
    expect(secureOwnerCookie(cookie, raw)).toBe(`engram_session=${raw}`);
    for (const invalid of [cookie.replace("HttpOnly; ", ""), cookie.replace("Secure; ", ""), cookie.replace("Strict", "Lax"), cookie + "; Domain=.run.app", cookie.replace(raw, "wrong")]) expect(() => secureOwnerCookie(invalid, raw)).toThrow();
  });

  test("revokes exactly the issued owner session after success, HTTP failure and unknown issuance commit", async () => {
    for (const failure of [false, true]) {
      const fixture = database(), signal = new AbortController().signal;
      let raw = "";
      const result = await withOwnerSmokeSession(fixture.db, "owner@example.com", async value => { raw = value; expect(value).toMatch(/^ens_[A-Za-z0-9_-]{32}$/); if (failure) throw new Error("HTTP unavailable"); return { ownerMatches: true }; }, signal);
      expect(result.ok).toBe(!failure); expect(result.sessionRevoked).toBe(true); expect(result.cleanupRequired).toBe(false);
      expect(fixture.row().revoked).toBe(true); expect(fixture.revocations()).toEqual([[71, fixture.row().hash, fixture.row().name]]);
      expect(JSON.stringify(result)).not.toContain(raw); expect(JSON.stringify(result)).not.toContain("owner@example.com");
    }
    const unknown = database(false, true);
    const result = await withOwnerSmokeSession(unknown.db, "owner@example.com", async () => { throw new Error("must not transmit"); }, new AbortController().signal);
    expect(result.ok).toBe(false); expect(result.sessionRevoked).toBe(true); expect(unknown.row().revoked).toBe(true);
    const failed = database(true);
    expect(await withOwnerSmokeSession(failed.db, "owner@example.com", async () => ({ ownerMatches: true }), new AbortController().signal)).toMatchObject({ ok: false, sessionRevoked: false, cleanupRequired: true });
  });
});
