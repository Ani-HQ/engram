import { describe, expect, test } from "bun:test";
import { devFetch } from "./dev-server";
import { renderAsync } from "@resvg/resvg-js";

const request = (path: string, options?: RequestInit) => devFetch(new Request(`http://localhost:8099${path}`, options));

describe("local static branding", () => {
  test("matches public asset MIME and empty HEAD semantics without cross-origin app access", async () => {
    const assets = [
      ["/brand/engram-mark.svg", "image/svg+xml; charset=utf-8"],
      ["/brand/engram-mark.png", "image/png"],
      ["/brand/engram-192.png", "image/png"],
      ["/favicon.svg", "image/svg+xml; charset=utf-8"],
      ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/site.webmanifest", "application/manifest+json"],
    ];
    for (const [path, type] of assets) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(path, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(type);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        const bytes = (await response.arrayBuffer()).byteLength;
        if (method === "HEAD") expect(bytes).toBe(0);
        else expect(bytes).toBeGreaterThan(0);
      }
    }
    for (const path of ["/oauth.css", "/brand%2f..%2fstyle.css"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    const missing = await request("/brand/missing.svg", { method: "HEAD" });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    const page = await request("/app", { method: "HEAD" });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("");
  });
});

describe("local activity demo", () => {
  test("simulates isolated Jev consent without pricing approval, provider keys, or usage charges", async () => {
    await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) });
    const headers = { "X-Engram-Workspace": "2", "X-Engram-Console": "1" };
    const get = () => request("/api/jev", { headers });
    const put = (body: any, custom = headers) => request("/api/jev", { method: "PUT", headers: custom, body: JSON.stringify(body) });
    const before = await (await get()).json();
    const policies = (await (await request("/api/policies")).json()).policies;
    expect(before).toMatchObject({ enabled: false, eligibility: "operator-funded", pricing: { inputPerMillionUsd: null, rateVersion: null }, usage: { calls: 0 }, demo: true });
    expect((await get()).headers.get("cache-control")).toBe("no-store");
    expect((await request("/api/jev")).status).toBe(400);
    expect((await put({ enabled: true, monthlyBudgetUsd: "1" }, { "X-Engram-Workspace": "2" } as any)).status).toBe(403);
    expect((await put({ enabled: true, monthlyBudgetUsd: "0" })).status).toBe(400);
    expect((await put({ enabled: true, monthlyBudgetUsd: "1", apiKey: "not-a-key" })).status).toBe(400);
    try {
      const enabled = await (await put({ enabled: true, monthlyBudgetUsd: "1.25" })).json();
      expect(enabled).toMatchObject({ enabled: true, available: true, budget: { monthlyUsd: "1.25", spentUsd: "0" }, usage: { calls: 0 } });
      expect((await (await request("/api/policies")).json()).policies).toEqual({ ...policies, jevProcessing: true });
      const external = (await (await request("/api/insights")).json()).external;
      expect(external.jevConsented).toBe(true); expect(external.consented).toBe(policies.externalAiProcessing);
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) });
      expect((await get()).status).toBe(409);
      const otherHeaders = { "X-Engram-Workspace": "1", "X-Engram-Console": "1" };
      const other = await (await request("/api/jev", { headers: otherHeaders })).json();
      expect(other).toMatchObject({ enabled: false, eligibility: "subscription-required" });
      expect((await put({ enabled: true, monthlyBudgetUsd: "1" }, otherHeaders)).status).toBe(409);
      const catalog = await (await request("/api/plans")).json();
      expect(catalog.addons.jev).toMatchObject({ inputPerMillionUsd: null, outputPerMillionUsd: null, markupBps: null, rateVersion: null });
    } finally {
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) });
      await put({ enabled: before.enabled, monthlyBudgetUsd: before.budget.monthlyUsd });
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) });
    }
  });
  test("renames the pinned workspace display name and preserves it across switches", async () => {
    const before = (await (await request("/api/me")).json()).org;
    const rename = (name: string, headers: Record<string, string> = { "X-Engram-Workspace": "1", "X-Engram-Console": "1" }) => request("/api/workspace", { method: "PUT", headers, body: JSON.stringify({ name }) });
    expect((await rename("Unscoped", { "X-Engram-Console": "1" })).status).toBe(400);
    expect((await rename("No console", { "X-Engram-Workspace": "1" })).status).toBe(403);
    expect((await rename("Wrong workspace", { "X-Engram-Workspace": "2", "X-Engram-Console": "1" })).status).toBe(409);
    expect((await rename("Invalid\nname")).status).toBe(400);
    try {
      const response = await rename("  Shared decisions  "); expect(response.status).toBe(200);
      const result = await response.json(); expect(result.org).toEqual({ ...before, name: "Shared decisions" });
      const current = await (await request("/api/me")).json(); expect(current.org.name).toBe("Shared decisions"); expect(current.orgs.find((org: any) => org.id === 1).name).toBe("Shared decisions");
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) });
      const other = await (await request("/api/me")).json(); expect(other.org.name).not.toBe("Shared decisions");
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) });
      expect((await (await request("/api/me")).json()).org.name).toBe("Shared decisions");
    } finally { await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) }); await rename(before.name); }
  });
  test("previews email-bound signup and operator-only code management without sending mail", async () => {
    const policy = await (await request("/api/signup-policy", { headers: { Cookie: "engram_dev=0" } })).json();
    expect(policy).toMatchObject({ mode: "invite-only", inviteCodeRequired: true, verificationRequired: true, complimentary: true, tokenSignInAllowed: false });
    expect((await request("/api/invites/accept", { method: "POST", body: JSON.stringify({ token: "svf_demo_expired" }) })).status).toBe(400);
    expect((await (await request("/api/me")).json()).capabilities.manageSignupInvites).toBe(true);
    const issue = await request("/api/admin/signup-invites", { method: "POST", headers: { "X-Engram-Workspace": "1" }, body: JSON.stringify({ email: "beta-demo@example.com" }) });
    const issued = await issue.json(); expect(issue.status).toBe(201); expect(issued.inviteCode).toMatch(/^demo_signup_/);
    const metadata = await (await request("/api/admin/signup-invites")).json();
    expect(metadata.invites.find((item: any) => item.id === issued.invite.id)).toEqual(issued.invite);
    expect(JSON.stringify(metadata)).not.toContain(issued.inviteCode);
    expect((await request("/api/orgs", { method: "POST", body: JSON.stringify({ email: "beta-demo@example.com" }) })).status).toBe(400);
    expect((await request("/api/orgs", { method: "POST", body: JSON.stringify({ email: "different@example.com", inviteCode: issued.inviteCode }) })).status).toBe(400);
    const verification = await (await request("/api/orgs", { method: "POST", body: JSON.stringify({ email: "beta-demo@example.com", inviteCode: issued.inviteCode }) })).json();
    expect(verification.sent).toBe(false); expect(verification.demo).toBe(true); expect(verification.url).not.toContain(issued.inviteCode);
    expect((await (await request("/api/admin/signup-invites")).json()).invites.find((item: any) => item.id === issued.invite.id).redeemedAt).toBeNull();
    const revoked = await (await request(`/api/admin/signup-invites/${issued.invite.id}/revoke`, { method: "POST", body: "{}" })).json(); expect(revoked.revocationPending).toBe(false);
    expect((await request("/api/invites/accept", { method: "POST", body: JSON.stringify({ token: new URL(verification.url).hash.slice(6) }) })).status).toBe(400);
    try {
      const other = await (await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) })).json();
      expect(other.capabilities.manageSignupInvites).toBe(false);
      expect((await request("/api/admin/signup-invites")).status).toBe(403);
      expect((await request("/api/admin/signup-invites", { headers: { "X-Engram-Workspace": "1" } })).status).toBe(409);
    } finally { await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) }); }
  });
  test("copies a listed invitation as a stable alias without replacing its original code or terms", async () => {
    const issued = await (await request("/api/admin/signup-invites", { method: "POST", body: JSON.stringify({ email: "copy-demo@example.com" }) })).json();
    const path = `/api/admin/signup-invites/${issued.invite.id}/link`;
    const options = { method: "POST", headers: { "X-Engram-Console": "1", "X-Engram-Workspace": "1" }, body: "{}" };
    const before = (await (await request("/api/admin/signup-invites")).json()).invites;
    const response = await request(path, options), copied = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(copied)).toEqual(["inviteUrl"]);
    const alias = new URL(copied.inviteUrl).hash.slice("#invite=".length);
    expect(alias).toMatch(new RegExp(`^eg_link_v1_${issued.invite.id}_[A-Za-z0-9_-]{43}$`));
    expect(copied.inviteUrl).not.toContain("copy-demo@example.com");
    expect((await (await request(path, options)).json()).inviteUrl).toBe(copied.inviteUrl);
    const after = (await (await request("/api/admin/signup-invites")).json()).invites;
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(alias); expect(JSON.stringify(after)).not.toContain(issued.inviteCode);
    const verify = (inviteCode: string, email = "copy-demo@example.com") => request("/api/orgs", { method: "POST", body: JSON.stringify({ email, inviteCode }) });
    expect((await verify(`${alias.slice(0, -1)}!`)).status).toBe(400);
    expect((await verify(alias, "different@example.com")).status).toBe(400);
    const originalProof = await (await verify(issued.inviteCode)).json();
    const aliasProof = await (await verify(alias)).json();
    expect(originalProof.demo).toBe(true); expect(aliasProof.demo).toBe(true);
    try {
      const accepted = await request("/api/invites/accept", { method: "POST", body: JSON.stringify({ token: new URL(aliasProof.url).hash.slice("#join=".length) }) });
      expect(accepted.status).toBe(200);
    } finally { await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) }); }
    expect((await verify(issued.inviteCode)).status).toBe(400); expect((await verify(alias)).status).toBe(400);
    expect((await request("/api/invites/accept", { method: "POST", body: JSON.stringify({ token: new URL(originalProof.url).hash.slice("#join=".length) }) })).status).toBe(400);
    const unavailable = await request(path, options);
    expect(unavailable.status).toBe(409); expect((await unavailable.json()).code).toBe("invite_unavailable");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  });
  test("invitation-link retrieval requires the operator console workspace and rejects inactive invites", async () => {
    const issued = await (await request("/api/admin/signup-invites", { method: "POST", body: "{}" })).json();
    const path = `/api/admin/signup-invites/${issued.invite.id}/link`;
    const headers = { "X-Engram-Console": "1", "X-Engram-Workspace": "1" };
    const copy = (changes: RequestInit = {}) => request(path, { method: "POST", headers, body: "{}", ...changes });
    for (const [changes, status] of [
      [{ headers: { ...headers, Cookie: "engram_dev=0" } }, 401],
      [{ headers: { "X-Engram-Workspace": "1" } }, 403],
      [{ headers: { "X-Engram-Console": "1" } }, 400],
      [{ headers: { ...headers, "X-Engram-Workspace": "2" } }, 409],
      [{ method: "GET", body: undefined }, 404],
    ] as [RequestInit, number][]) {
      const response = await copy(changes);
      expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const id of ["not-an-id", "%ZZ", crypto.randomUUID()]) {
      const response = await request(`/api/admin/signup-invites/${id}/link`, { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    try {
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) });
      expect((await copy({ headers: { ...headers, "X-Engram-Workspace": "2" } })).status).toBe(403);
      expect((await copy()).status).toBe(409);
    } finally { await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) }); }
    const now = Date.now;
    try {
      Date.now = () => Date.parse(issued.invite.expiresAt);
      const expired = await copy(); expect(expired.status).toBe(409); expect((await expired.json()).code).toBe("invite_unavailable");
    } finally { Date.now = now; }
    const active = await (await copy()).json();
    const alias = new URL(active.inviteUrl).hash.slice("#invite=".length);
    await request(`/api/admin/signup-invites/${issued.invite.id}/revoke`, { method: "POST", body: "{}" });
    const revoked = await copy(); expect(revoked.status).toBe(409); expect((await revoked.json()).code).toBe("invite_unavailable");
    for (const inviteCode of [alias, issued.inviteCode]) expect((await request("/api/orgs", { method: "POST", body: JSON.stringify({ email: "revoked-copy@example.com", inviteCode }) })).status).toBe(400);
  });
  test("exposes simulated getting started evidence with workspace scoping", async () => {
    const response = await request("/api/onboarding", { headers: { "X-Engram-Workspace": "1" } });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.demo).toBe(true);
    expect(data.provisioning).toBe(false);
    expect(Object.keys(data.checks).sort()).toEqual(["agentConnected", "memoryRecalled", "memorySaved", "taskReported"]);
    expect(Object.values(data.checks).every(value => typeof value === "boolean")).toBe(true);
    expect((await (await request("/api/me")).json()).onboarding).toEqual(data);
    expect((await request("/api/onboarding", { headers: { "X-Engram-Workspace": "2" } })).status).toBe(409);
  });
  test("unbound preview invites bind only after inbox verification and grant an exact 60-day personal benefit", async () => {
    const issued = await (await request("/api/admin/signup-invites", { method: "POST", headers: { "X-Engram-Workspace": "1" }, body: "{}" })).json();
    expect(issued.invite.email).toBeNull(); expect(issued.invite.emailBound).toBe(false); expect(issued.invite.accessDurationDays).toBe(60);
    expect(new URL(issued.inviteUrl).hash).toBe(`#invite=${issued.inviteCode}`);
    const verify = async (email: string) => (await request("/api/orgs", { method: "POST", body: JSON.stringify({ email, inviteCode: issued.inviteCode }) })).json();
    const first = await verify("first@example.com"), second = await verify("second@example.com");
    const pending = (await (await request("/api/admin/signup-invites")).json()).invites.find((item: any) => item.id === issued.invite.id);
    expect(pending.email).toBeNull(); expect(pending.redeemedAt).toBeNull();
    const accept = (link: string) => request("/api/invites/accept", { method: "POST", body: JSON.stringify({ token: new URL(link).hash.slice(6) }) });
    try {
      const result = await accept(second.url); expect(result.status).toBe(200);
      const session = await result.json(); expect(session.org.kind).toBe("personal");
      const benefit = session.access.complimentary;
      expect(benefit).toMatchObject({ source: "invite", durationDays: 60, active: true, unlimitedKnowledgeTransfers: true, extensionUrl: "https://x.com/anirudh_twt" });
      expect(Date.parse(benefit.expiresAt) - Date.parse(benefit.grantedAt)).toBe(60 * 86_400_000);
      expect((await accept(first.url)).status).toBe(400);
    } finally { await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) }); }
    const redeemed = (await (await request("/api/admin/signup-invites")).json()).invites.find((item: any) => item.id === issued.invite.id);
    expect(redeemed.email).toBe("second@example.com"); expect(redeemed.emailBound).toBe(true);
    expect(JSON.stringify(redeemed)).not.toContain(issued.inviteCode); expect(JSON.stringify(redeemed)).not.toContain(issued.inviteUrl);
  });
  test("marks the initial session and activity as demo data", async () => {
    const session = await (await request("/api/me")).json();
    const data = await (await request("/api/actions")).json();
    expect(session.demo).toBe(true);
    expect(data.demo).toBe(true);
    expect(data.actions).toHaveLength(16);
    expect(data.more).toBe(false);
    expect(data.agents).toContain("codex");
    expect(data.tools).toContain("email.create_draft");
  });

  test("lists scoped connection metadata and derives contact only from recorded receipts", async () => {
    const response = await request("/api/connections", { headers: { "X-Engram-Workspace": "1" } });
    const data = await response.json();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(data).toMatchObject({ demo: true, more: false, limit: 200, recentWindowSeconds: 900 });
    expect(Number.isFinite(Date.parse(data.checkedAt))).toBe(true);
    expect(data.connections).toHaveLength(5);
    expect(data.identities).toEqual([expect.objectContaining({ agent: "fleet-vm", name: "Fleet VM", source: "agent", locked: false })]);
    const receipts = (await (await request("/api/actions")).json()).actions;
    const codex = data.connections.find((row: any) => row.agent === "codex");
    const own = receipts.filter((row: any) => row.agent === "codex");
    const memory = own.filter((row: any) => row.evidence === "observed" && !["whoami", "list_actions", "record_action"].includes(row.tool));
    const reports = own.filter((row: any) => row.evidence === "reported");
    expect(codex).toMatchObject({ kind: "token", name: "codex", displayName: "Codex", harness: "codex", status: "authorized", canWrite: true, memoryCalls: memory.length, taskReports: reports.length });
    expect(codex.client).toEqual({ state: "identified", label: "Codex", harness: "codex" });
    // This shared-key fixture stays ambiguous despite its chosen source label.
    expect(data.connections.find((row: any) => row.name === "mac-claude")).toMatchObject({ harness: "claude-code", client: { state: "multiple", label: null, harness: null } });
    expect(codex.lastContactAt).toBe(own.map((row: any) => row.recordedAt).sort().at(-1));
    expect(codex.lastMemoryAt).toBe(memory.map((row: any) => row.recordedAt).sort().at(-1) || null);
    expect(codex.lastTaskReportAt).toBe(reports.map((row: any) => row.recordedAt).sort().at(-1));
    expect(codex.lastAuthenticatedAt).toBe("2026-10-21T09:42:00.000Z");
    const oauth = data.connections.find((row: any) => row.kind === "oauth");
    expect(oauth).toMatchObject({ name: "ChatGPT", displayName: "ChatGPT", harness: "chatgpt", status: "authorized", lastAuthenticatedAt: null, lastContactAt: null, lastMemoryAt: null, lastTaskReportAt: null, memoryCalls: 0, taskReports: 0 });
    expect(oauth.client).toEqual({ state: "identified", label: "ChatGPT", harness: "chatgpt" });
    expect(oauth.id).toMatch(/^oauth:[a-f0-9]{64}$/);
    expect(oauth.agent).toBe("oauth:ada%40example.com:demo-chatgpt");
    expect(data.connections.find((row: any) => row.name === "old-laptop")).toMatchObject({ status: "revoked", canWrite: false, lastContactAt: null, memoryCalls: 0, taskReports: 0, client: { state: "unknown", label: null, harness: null } });
    for (const row of data.connections) for (const field of ["token", "sha256_hash", "refresh_token", "clientId", "email", "running", "workingActions"]) expect(row).not.toHaveProperty(field);
    expect(data.connections.map((row: any) => row.createdAt)).toEqual(data.connections.map((row: any) => row.createdAt).sort().reverse());
    expect((await request("/api/connections", { headers: { Cookie: "engram_dev=0" } })).status).toBe(401);
    expect((await request("/api/connections", { headers: { "X-Engram-Workspace": "2" } })).status).toBe(409);
    const method = await request("/api/connections", { method: "DELETE" });
    expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET, POST");
  });

  test("combines search, exact filters, and pagination", async () => {
    const first = await (await request("/api/actions?agent=codex&q=action&limit=1")).json();
    const second = await (await request("/api/actions?agent=codex&q=action&limit=1&offset=1")).json();
    expect(first.actions).toHaveLength(1);
    expect(first.more).toBe(true);
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0].id).not.toBe(first.actions[0].id);
    expect(first.actions[0].agent).toBe("codex");
    expect(first.agents).toContain("baymax");
    const failure = await (await request("/api/actions?tool=cloud.restart_service&status=failed&runId=run-job-check&resource=cloud%3A%2F%2Fengram%2Fpreview%2Fworker")).json();
    expect(failure.actions).toHaveLength(1);
    expect(failure.actions[0].agent).toBe("baymax");
    expect(failure.more).toBe(false);
  });

  test("groups fresh sample runs with all contributors, tools, and reported approaches", async () => {
    const response = await request("/api/activities");
    const data = await response.json();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(data.demo).toBe(true);
    expect(data.activities).toHaveLength(8);
    expect(data.stats).toEqual({ running: 1, completed: 6, failed: 1, total: 8 });
    expect(data.freshnessSeconds).toBe(900);
    const working = data.activities.find((activity: any) => activity.id === "run:run-engram-ui");
    expect(working.summary).toBe("Design and build the Engram activity experience");
    expect(working.agents.map((agent: any) => agent.name)).toEqual(["baymax", "codex", "mac-claude"]);
    expect(working.workingActions).toBe(2);
    expect(working.staleActions).toBe(1);
    expect(working.approaches).toHaveLength(3);
    expect(working.approaches.every((approach: any) => approach.evidence === "reported")).toBe(true);
    expect(Date.now() - Date.parse(working.updatedAt)).toBeLessThan(60_000);
    expect(working).not.toHaveProperty("actions");
    const detail = await (await request(`/api/activities/${encodeURIComponent(working.id)}`)).json();
    expect(detail.activity.actions).toHaveLength(4);
    expect(detail.activity.tools).toContain("browser.screenshot");
    expect(detail.activity.runId).toBe("run-engram-ui");
  });

  test("separates tasks from memory receipts without dropping nested task steps", async () => {
    const tasks = await (await request("/api/activities?kind=tasks")).json();
    const memories = await (await request("/api/activities?kind=memory")).json();
    expect(tasks.activities).toHaveLength(5);
    expect(memories.activities).toHaveLength(3);
    expect(tasks.activities.find((row: any) => row.runId === "run-action-capture").actionCount).toBe(5);
    expect(memories.activities.every((row: any) => row.evidence === "observed")).toBe(true);
    expect(memories.agents).toEqual(["grokbot"]);
    expect((await request("/api/activities?kind=invalid")).status).toBe(400);
  });

  test("filters complete activity groups and keeps status totals before status selection", async () => {
    const data = await (await request("/api/activities?agent=codex&tool=browser.screenshot&q=keyboard&limit=1")).json();
    expect(data.activities).toHaveLength(1);
    expect(data.activities[0].actionCount).toBe(4);
    expect(data.activities[0].agents).toHaveLength(3);
    expect(data.activities[0].tools).toContain("files.write");
    expect(data.more).toBe(false);
    expect(data.tools).toContain("email.create_draft");
    const failures = await (await request("/api/activities?status=failed")).json();
    expect(failures.activities).toHaveLength(1);
    expect(failures.activities[0].summary).toBe("Investigate and recover the preview worker");
    expect(failures.stats).toEqual({ running: 1, completed: 6, failed: 1, total: 8 });
    expect((await request("/api/activities?status=unknown")).status).toBe(400);
    expect((await request("/api/activities/run%3Amissing")).status).toBe(404);
    expect((await request("/api/activities/%ZZ")).status).toBe(400);
    expect((await request("/api/activities", { headers: { Cookie: "engram_dev=0" } })).status).toBe(401);
    expect((await request("/api/activities/run%3Arun-engram-ui", { headers: { Cookie: "engram_dev=0" } })).status).toBe(401);
  });

  test("keeps a signed-out preview signed out", async () => {
    const response = await request("/api/me", { headers: { Cookie: "engram_dev=0" } });
    expect(response.status).toBe(401);
    const tokenLogin = await request("/api/session", { method: "POST", body: JSON.stringify({ token: "demo" }) });
    expect(tokenLogin.status).toBe(403); expect(tokenLogin.headers.get("set-cookie")).toBeNull();
    expect((await tokenLogin.json()).code).toBe("token_sign_in_disabled");
    const email = await (await request("/api/login/email", { method: "POST", body: JSON.stringify({ email: "ada@example.com" }) })).json();
    const login = await request("/api/invites/accept", { method: "POST", body: JSON.stringify({ token: new URL(email.url).hash.slice(6) }) });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("engram_dev=1");
    const malformed = await request("/api/session", { method: "POST", body: JSON.stringify({ token: 123 }) });
    expect(malformed.status).toBe(403);
  });

  test("uses the session identity and reports unverified agent submissions honestly", async () => {
    const spoofed = await request("/api/actions", { method: "POST", body: JSON.stringify({ agent: "forged-agent", evidence: "observed", tool: "files.write", summary: "Saved a test file" }) });
    expect(spoofed.status).toBe(400);
    const response = await request("/api/actions", { method: "POST", body: JSON.stringify({ tool: "files.write", summary: "Saved a test file", resource: "file://demo-test", runId: "demo-test-run" }) });
    expect(response.status).toBe(201);
    const { action } = await response.json();
    const session = await (await request("/api/me")).json();
    expect(action.agent).toBe(session.name);
    expect(action.evidence).toBe("reported");
    const query = await (await request("/api/actions?runId=demo-test-run")).json();
    expect(query.actions[0].id).toBe(action.id);
    const malformed = await request("/api/actions", { method: "POST", body: JSON.stringify({ summary: "No tool" }) });
    expect(malformed.status).toBe(400);
  });

  test("supports the memory capture and reader flow", async () => {
    const response = await request("/api/capture", { method: "POST", body: JSON.stringify({ title: "Demo verification", text: "Preserve the originating task.", scope: "shared" }) });
    const { slug } = await response.json();
    const data = await (await request(`/api/page?slug=${slug}`)).json();
    expect(data.page.body).toBe("Preserve the originating task.");
    const results = await (await request("/api/search?q=originating&scope=shared")).json();
    expect(results.results.some((row: any) => row.slug === slug)).toBe(true);
    expect((await request(`/api/page?slug=${slug}`, { method: "DELETE" })).status).toBe(200);
    expect((await request(`/api/page?slug=${slug}`)).status).toBe(404);
    expect((await request("/api/page/restore", { method: "POST", body: JSON.stringify({ slug }) })).status).toBe(200);
  });

  test("previews real aggregate counts privately before explicit publication", async () => {
    const settings = await (await request("/api/showcase")).json();
    expect(settings.profile).toEqual({ slug: "", displayName: "", bio: "", published: false, showActivity: false, layout: "studio", highlights: [], photo: null });
    expect(settings.urls.page).toBeNull();
    const data = await (await request("/api/actions?limit=100")).json();
    const expected = data.actions.filter((row: any) => !["list_actions", "record_action", "whoami"].includes(row.tool));
    expect(settings.preview.stats.totalActions).toBe(expected.length);
    expect(settings.preview.stats.completedActions).toBe(expected.filter((row: any) => row.status === "completed").length);
    expect(settings.preview.stats.activeAgents).toBe(new Set(expected.map((row: any) => row.agent)).size);
    expect(settings.preview.daily).toHaveLength(84);
    expect((await request("/u/demo-agents")).status).toBe(404);
    expect((await request("/api/showcase", { headers: { Cookie: "engram_dev=0" } })).status).toBe(401);
  });

  test("publishes only broad counts with shareable HTML, SVG and PNG cards, then removes all public access", async () => {
    const profile = { slug: "demo-agents", displayName: "Ada", bio: "Agent activity", published: true };
    const invalid = await request("/api/showcase", { method: "PUT", body: JSON.stringify({ ...profile, slug: "../private" }) });
    expect(invalid.status).toBe(400);
    const saved = await (await request("/api/showcase", { method: "PUT", body: JSON.stringify(profile) })).json();
    expect(saved.profile).toEqual({ ...profile, showActivity: false, layout: "studio", highlights: [], photo: null });
    expect(saved.urls.card).toBe("http://localhost:8099/api/public/activity/demo-agents/card.png");
    const dataResponse = await request("/api/public/activity/demo-agents", { headers: { Cookie: "engram_dev=0" } });
    expect(dataResponse.status).toBe(200);
    expect(dataResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(dataResponse.headers.get("cache-control")).toBe("no-store");
    const data = await dataResponse.json();
    expect(data.stats.totalActions).toBe(saved.preview.stats.totalActions);
    expect(data.profile).toEqual({ slug: profile.slug, displayName: profile.displayName, bio: profile.bio, layout: "studio", highlights: [], photoUrl: null });
    expect(data).not.toHaveProperty("actions");
    expect(data).not.toHaveProperty("agents");
    for (const value of ["ada@example.com", "github.create_pull_request", "file://demo-test", "run-job-check"]) expect(JSON.stringify(data)).not.toContain(value);
    const page = await (await request("/u/demo-agents")).text();
    expect(page).toContain('property="og:image"');
    expect(page).toContain("/card.png");
    expect(page).toContain('src="/showcase.js"');
    expect(page).toContain('href="/showcase.css"');
    expect(page).toContain('name="engram-demo"');
    const svg = await request("/api/public/activity/demo-agents/card.svg");
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain('width="1200" height="630"');
    const png = await request("/api/public/activity/demo-agents/card.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await png.arrayBuffer()).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    await request("/api/showcase", { method: "PUT", body: JSON.stringify({ ...profile, published: false }) });
    for (const path of ["/u/demo-agents", "/api/public/activity/demo-agents", "/api/public/activity/demo-agents/card.svg", "/api/public/activity/demo-agents/card.png"]) expect((await request(path)).status).toBe(404);
  });

  test("persists owner-written layouts and highlights through legacy updates and public JSON/SSE", async () => {
    const previous = (await (await request("/api/showcase")).json()).profile;
    const profile = { slug: "layout-demo", displayName: "Public notes", bio: "Written for this page", published: true, layout: "field-notes", highlights: [{ title: "Public release", body: "An owner-approved note.", url: "https://example.com/releases" }] };
    const put = (value: unknown) => request("/api/showcase", { method: "PUT", body: JSON.stringify(value) });
    try {
      const result = await (await put(profile)).json();
      expect(result.profile).toEqual({ ...profile, showActivity: false, photo: null });
      expect((await (await request("/api/public/activity/layout-demo")).json()).profile).toEqual({ slug: profile.slug, displayName: profile.displayName, bio: profile.bio, layout: profile.layout, highlights: profile.highlights, photoUrl: null });
      const stream = await request("/api/public/activity/layout-demo/stream"), reader = stream.body!.getReader();
      try { expect(JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1].trim()).profile.highlights).toEqual(profile.highlights); }
      finally { await reader.cancel(); }
      const legacy = { slug: profile.slug, displayName: profile.displayName, bio: "Changed in an older client", published: true };
      expect((await (await put(legacy)).json()).profile).toMatchObject({ layout: "field-notes", highlights: profile.highlights });
      expect((await put({ ...profile, highlights: [{ ...profile.highlights[0], url: "javascript:alert(1)" }] })).status).toBe(400);
      expect((await (await request("/api/showcase")).json()).profile.highlights).toEqual(profile.highlights);
      expect((await (await put({ ...legacy, layout: "studio", highlights: [] })).json()).profile).toMatchObject({ layout: "studio", highlights: [] });
    } finally { await put(previous); }
  });

  test("stages a private profile photo, publishes only its URL and revokes removed images", async () => {
    await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) });
    const headers = { "X-Engram-Workspace": "1", "X-Engram-Console": "1" };
    const previous = (await (await request("/api/showcase", { headers })).json()).profile;
    const put = (value: unknown) => request("/api/showcase", { method: "PUT", headers, body: JSON.stringify(value) });
    const rendered = await renderAsync('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#77d9ad"/></svg>');
    const photo = "data:image/png;base64," + Buffer.from(rendered.asPng()).toString("base64");
    const profile = { slug: "photo-demo-review", displayName: "Photo review", bio: "", published: false, showActivity: false, photo };
    try {
      const saved = await (await put(profile)).json();
      expect(saved.profile.photo).toStartWith("data:image/png;base64,");
      expect(saved.preview.profile.photoUrl).toBe(saved.profile.photo);
      expect((await request(`/api/public/activity/${profile.slug}`)).status).toBe(404);
      const { photo: omitted, ...legacy } = profile;
      const legacySaved = await (await put(legacy)).json();
      expect(legacySaved.profile.photo).toBe(saved.profile.photo);
      await put({ ...profile, published: true });
      const publicData = await (await request(`/api/public/activity/${profile.slug}`)).json();
      const photoUrl = publicData.profile.photoUrl;
      expect(photoUrl).toMatch(/^\/api\/public\/activity\/photo-demo-review\/photo\.png\?v=[a-f0-9]{64}$/);
      expect(JSON.stringify(publicData)).not.toContain("data:image");
      expect((await request(photoUrl)).headers.get("content-type")).toBe("image/png");
      const head = await request(photoUrl, { method: "HEAD" });
      expect(head.status).toBe(200); expect(await head.text()).toBe("");
      expect((await request(photoUrl.replace(/v=./, "v=z"))).status).toBe(404);
      const invalid = await put({ ...profile, published: true, photo: "data:image/png;base64,bm90LWFuLWltYWdl" });
      expect(invalid.status).toBe(400); expect((await request(photoUrl)).status).toBe(200);
      await put({ ...profile, published: false });
      expect((await request(photoUrl)).status).toBe(404);
      await put({ ...profile, published: true, photo: null });
      expect((await request(photoUrl)).status).toBe(404);
      expect((await (await request(`/api/public/activity/${profile.slug}`)).json()).profile.photoUrl).toBeNull();
    } finally {
      await put(previous.slug ? previous : { ...profile, published: false, photo: null });
    }
  });

  test("streams working to completed as one logical action and closes the stream when unpublished", async () => {
    const profile = { slug: "live-demo", displayName: "Live demo", bio: "A public example", published: true, showActivity: true };
    const publication = await (await request("/api/showcase", { method: "PUT", body: JSON.stringify(profile) })).json();
    const workingBefore = publication.preview.live.workingAgents;
    const report = { tool: "github.create_pull_request", harness: "codex", summary: "PRIVATE build details", resource: "https://github.com/private-build-owner/private-build-repo/pull/9", actionKey: "stream-demo-build", eventId: "stream-demo-start", status: "running" };
    const started = await (await request("/api/actions", { method: "POST", body: JSON.stringify(report) })).json();
    const abort = new AbortController();
    const response = await request("/api/public/activity/live-demo/stream", { signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const reader = response.body!.getReader();
    const decode = (chunk: any) => new TextDecoder().decode(chunk.value);
    try {
      const first = decode(await reader.read());
      expect(first).toContain("event: snapshot");
      const initial = JSON.parse(first.split("data: ")[1].trim());
      expect(initial.live.workingAgents).toBe(workingBefore + 1);
      expect(first).not.toContain("PRIVATE build details");
      expect(first).not.toContain("private-build-owner");
      expect(first).not.toContain("private-build-repo");
      expect(initial.activity.enabled).toBe(true);
      const liveEvent = initial.activity.events.find((event: any) => event.service === "github" && event.status === "running");
      expect(liveEvent.agent).toEqual({ product: "codex", label: "Codex" });
      expect(liveEvent.action).toBe("Creating a pull request");
      const complete = { ...report, status: "completed", eventId: "stream-demo-end" };
      const finished = await (await request("/api/actions", { method: "POST", body: JSON.stringify(complete) })).json();
      const next = decode(await reader.read());
      const snapshot = JSON.parse(next.split("data: ")[1].trim());
      expect(snapshot.live.workingAgents).toBe(workingBefore);
      const finalEvent = snapshot.activity.events.find((event: any) => event.id === liveEvent.id);
      expect(finalEvent.status).toBe("completed");
      expect(finalEvent.action).toBe("Created a pull request");
      expect(next).not.toContain("PRIVATE build details");
      expect(snapshot.stats.totalActions).toBe(initial.stats.totalActions);
      expect(snapshot.stats.completedActions).toBe(initial.stats.completedActions + 1);
      const retry = await (await request("/api/actions", { method: "POST", body: JSON.stringify(complete) })).json();
      expect(retry.action.id).toBe(finished.action.id);
      expect(finished.action.id).not.toBe(started.action.id);
      await request("/api/showcase", { method: "PUT", body: JSON.stringify({ ...profile, published: false }) });
      expect(decode(await reader.read())).toContain("event: closed");
      expect((await reader.read()).done).toBe(true);
      expect((await request("/api/public/activity/live-demo/stream")).status).toBe(404);
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  });

  test("scopes private activity and public aggregates to their owning workspace", async () => {
    const profile = { slug: "workspace-one", displayName: "Workspace one", bio: "Demo data", published: true };
    const published = await (await request("/api/showcase", { method: "PUT", body: JSON.stringify(profile) })).json();
    try {
      expect((await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) })).status).toBe(200);
      const empty = await (await request("/api/activities")).json();
      expect(empty.activities).toEqual([]);
      expect(empty.agents).toEqual([]);
      expect((await (await request("/api/actions")).json()).actions).toEqual([]);
      expect((await request("/api/activities/run%3Arun-engram-ui")).status).toBe(404);
      const publicData = await (await request("/api/public/activity/workspace-one", { headers: { Cookie: "engram_dev=0" } })).json();
      expect(publicData.stats.totalActions).toBe(published.preview.stats.totalActions);
      const reported = await request("/api/actions", { method: "POST", body: JSON.stringify({ tool: "demo.private", summary: "Only in workspace two", runId: "workspace-two-run", approach: "Keep this reported method within the selected workspace." }) });
      expect(reported.status).toBe(201);
      const own = await (await request("/api/activities")).json();
      expect(own.activities).toHaveLength(1);
      expect(own.activities[0].approaches[0].text).toContain("selected workspace");
      expect((await (await request("/api/public/activity/workspace-one")).json()).stats.totalActions).toBe(published.preview.stats.totalActions);
    } finally {
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) });
    }
    expect((await request("/api/activities/run%3Aworkspace-two-run")).status).toBe(404);
    const home = await (await request("/api/activities?q=Only%20in%20workspace%20two")).json();
    expect(home.activities).toEqual([]);
    expect(home.tools).not.toContain("demo.private");
  });

  test("retains a reported approach across lifecycle updates and detects changed retries", async () => {
    const report = { tool: "demo.lifecycle", summary: "Build a stable activity", actionKey: "demo-method-lifecycle", eventId: "demo-method-start", runId: "demo-method-run", status: "running", approach: "Validate the data contract before the interface." };
    const started = await (await request("/api/actions", { method: "POST", body: JSON.stringify(report) })).json();
    expect(started.action.approach).toBe(report.approach);
    const changed = await request("/api/actions", { method: "POST", body: JSON.stringify({ ...report, approach: "A different method" }) });
    expect(changed.status).toBe(409);
    const finished = await request("/api/actions", { method: "POST", body: JSON.stringify({ ...report, approach: undefined, eventId: "demo-method-end", status: "completed" }) });
    expect(finished.status).toBe(201);
    const detail = await (await request("/api/activities/run%3Ademo-method-run")).json();
    expect(detail.activity.status).toBe("completed");
    expect(detail.activity.actionCount).toBe(1);
    expect(detail.activity.approaches).toEqual([{ text: report.approach, agent: started.action.agent, evidence: "reported" }]);
    expect(detail.activity.startedAt).toBe(started.action.occurredAt);
    const tooLong = await request("/api/actions", { method: "POST", body: JSON.stringify({ tool: "demo.long", summary: "Too long", approach: "x".repeat(1001) }) });
    expect(tooLong.status).toBe(400);
  });

  test("rejects run changes for a logical action, including adding a run to an ungrouped action", async () => {
    const report = { tool: "demo.run-lock", summary: "Keep a logical action in its original activity", actionKey: "demo-locked-run", runId: "original-run", status: "running" };
    expect((await request("/api/actions", { method: "POST", body: JSON.stringify(report) })).status).toBe(201);
    for (const runId of ["different-run", null]) {
      expect((await request("/api/actions", { method: "POST", body: JSON.stringify({ ...report, runId, status: "completed" }) })).status).toBe(409);
    }
    const unchanged = await (await request("/api/activities/run%3Aoriginal-run")).json();
    expect(unchanged.activity.status).toBe("running");
    expect(unchanged.activity.actionCount).toBe(1);
    expect((await request("/api/activities/run%3Adifferent-run")).status).toBe(404);
    expect((await request("/api/actions", { method: "POST", body: JSON.stringify({ ...report, status: "completed" }) })).status).toBe(201);

    const standalone = { ...report, actionKey: "demo-runless-lock", runId: null };
    expect((await request("/api/actions", { method: "POST", body: JSON.stringify(standalone) })).status).toBe(201);
    expect((await request("/api/actions", { method: "POST", body: JSON.stringify({ ...standalone, runId: "newly-added-run", status: "completed" }) })).status).toBe(409);
    expect((await request("/api/activities/run%3Anewly-added-run")).status).toBe(404);
    expect((await request("/api/actions", { method: "POST", body: JSON.stringify({ ...standalone, status: "completed" }) })).status).toBe(201);
  });

  test("runs the shared rule engine with cited evidence, extractive briefs, and honest text search", async () => {
    const initial = await (await request("/api/insights")).json();
    expect(initial.job).toBeNull();
    expect(initial.external).toEqual({ consented: false, configured: false, generativeConsented: false, jevConsented: false, jevConfigured: false, embeddingConfigured: false, generativeConfigured: false });
    const invalid = await request("/api/insights", { method: "POST", body: JSON.stringify({ model: "pretend-model" }) });
    expect(invalid.status).toBe(400);
    const submitted = await request("/api/insights", { method: "POST", body: JSON.stringify({ q: "schema" }), headers: { "X-Engram-Workspace": "1" } });
    expect(submitted.status).toBe(202);
    const queued = await submitted.json();
    expect(queued.job.status).toBe("queued");
    const retry = await (await request("/api/insights", { method: "POST", body: JSON.stringify({ q: "schema" }) })).json();
    expect(retry.job.id).toBe(queued.job.id);
    expect((await request("/api/insights", { method: "POST", body: JSON.stringify({ q: "a different query" }) })).status).toBe(409);
    await Bun.sleep(275);
    const response = await request(`/api/insights?jobId=${queued.job.id}`);
    const result = await response.json();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(result.job.status).toBe("completed");
    expect(result.result.insights.map((finding: any) => finding.kind)).toContain("stalled");
    expect(result.result.insights.map((finding: any) => finding.kind)).toContain("duplicate");
    expect(result.result.insights.every((finding: any) => finding.method === "rule")).toBe(true);
    expect(result.result.brief.method).toBe("extractive");
    expect(result.result.search.method).toBe("lexical");
    expect(result.result.search.matches.length).toBeGreaterThan(0);
    const cited = new Set(result.result.sourceActions.map((source: any) => source.id));
    for (const finding of result.result.insights) {
      expect(finding.sources.every((id: string) => cited.has(id))).toBe(true);
      expect(finding.activityIds.length).toBeGreaterThan(0);
      for (const activityId of finding.activityIds) expect((await request(`/api/activities/${encodeURIComponent(activityId)}`)).status).toBe(200);
    }
    const publicData = await (await request("/api/public/activity/workspace-one")).json();
    for (const privateValue of ["sourceActions", "handoff", "schema", "Similar work reported by two agents"]) expect(JSON.stringify(publicData)).not.toContain(privateValue);
    expect((await request(`/api/insights?jobId=${queued.job.id}`, { headers: { Cookie: "engram_dev=0" } })).status).toBe(401);
  });

  test("keeps jobs, memory reviews, and AI consent isolated while changing workspaces", async () => {
    const current = await (await request("/api/insights")).json();
    try {
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) });
      expect((await request(`/api/insights?jobId=${current.job.id}`)).status).toBe(404);
      expect((await (await request("/api/insights")).json()).job).toBeNull();
      expect((await (await request("/api/review")).json()).items).toEqual([]);
      expect((await request("/api/review/item?id=1")).status).toBe(404);
      expect((await request("/api/review/approve", { method: "POST", body: JSON.stringify({ id: 1 }) })).status).toBe(404);
      expect((await request("/api/page?slug=action-evidence")).status).toBe(404);
      const changed = await (await request("/api/policies", { method: "PUT", body: JSON.stringify({ policies: { externalAiProcessing: true } }) })).json();
      expect(changed.policies.externalAiProcessing).toBe(true);
      expect((await (await request("/api/insights")).json()).external).toEqual({ consented: true, configured: true, generativeConsented: true, jevConsented: false, jevConfigured: true, embeddingConfigured: false, generativeConfigured: false });
      expect((await request("/api/insights", { headers: { "X-Engram-Workspace": "1" } })).status).toBe(409);
    } finally { await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) }); }
    expect((await (await request("/api/insights")).json()).external.consented).toBe(false);
  });

  test("previews and applies memory review operations while defer and reject preserve the source", async () => {
    const pending = await (await request("/api/review")).json();
    expect(pending.items).toHaveLength(3);
    const preview = await (await request("/api/review/item?id=1")).json();
    expect(preview.entry.slug).toBe("action-evidence");
    const before = await (await request("/api/page?slug=action-evidence")).json();
    const approved = await (await request("/api/review/approve", { method: "POST", body: JSON.stringify({ id: 1 }) })).json();
    expect(approved.item.state).toBe("applied");
    const after = await (await request("/api/page?slug=action-evidence")).json();
    expect(after.page.body).toBe(before.page.body);
    expect(after.links.some((link: any) => link.target === "engram-direction" && link.relation === "refine")).toBe(true);
    expect((await request("/api/review/approve", { method: "POST", body: JSON.stringify({ id: 1 }) })).status).toBe(400);
    const deployment = await (await request("/api/page?slug=deployment-approvals")).json();
    const deferred = await (await request("/api/review/defer", { method: "POST", body: JSON.stringify({ id: 2 }) })).json();
    expect(deferred.item.state).toBe("deferred");
    expect((await (await request("/api/page?slug=deployment-approvals")).json()).page).toEqual(deployment.page);
    const rejected = await (await request("/api/review/reject", { method: "POST", body: JSON.stringify({ id: 3 }) })).json();
    expect(rejected.item.state).toBe("rejected");
    expect((await request("/api/page?slug=meta%2Fclusters%2Fagent-observability")).status).toBe(404);
    expect((await (await request("/api/review?state=pending")).json()).items).toEqual([]);
    expect((await (await request("/api/review?state=applied")).json()).items).toHaveLength(1);
  });

  test("pins every demo token operation to its workspace and retains revoked metadata", async () => {
    const home = (await (await request("/api/tokens")).json()).tokens;
    const original = home.find((token: any) => token.name === "codex");
    const mutate = (path: string, body: any, workspace = "2") => request(path, { method: "POST", headers: { "X-Engram-Workspace": workspace }, body: JSON.stringify(body) });
    try {
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 2 }) });
      expect((await (await request("/api/tokens")).json()).tokens).toEqual([]);
      expect((await (await request("/api/connections")).json()).connections).toEqual([]);
      expect((await request("/api/tokens", { headers: { "X-Engram-Workspace": "1" } })).status).toBe(409);
      for (const path of ["/api/tokens", "/api/tokens/source", "/api/tokens/write", "/api/tokens/revoke"]) expect((await mutate(path, { name: "codex" }, "1")).status).toBe(409);
      for (const path of ["/api/tokens/source", "/api/tokens/write", "/api/tokens/revoke"]) expect((await mutate(path, { name: "mac-claude", harness: "hermes" })).status).toBe(404);
      expect((await mutate("/api/tokens", { name: "no-source", sourceLabel: "A label without a harness" })).status).toBe(400);
      // Generic keys need no product choice. A same-named key in another
      // workspace must not inherit the Codex fixture's client or contact.
      const minted = await mutate("/api/tokens", { name: "codex", orgId: 1 });
      expect(minted.status).toBe(200);
      expect(await minted.json()).toMatchObject({ token: "eng_demo_token_not_valid_in_production", harness: null, sourceLabel: null });
      const generic = (await (await request("/api/connections")).json()).connections;
      expect(generic).toHaveLength(1);
      expect(generic[0]).toMatchObject({ name: "codex", harness: null, sourceLabel: null, client: { state: "unknown", label: null, harness: null }, memoryCalls: 0, taskReports: 0, lastContactAt: null, lastAuthenticatedAt: null });
      expect((await mutate("/api/tokens", { name: "codex" })).status).toBe(400);
      expect((await mutate("/api/tokens/write", { name: "codex", canWrite: false })).status).toBe(200);
      expect((await mutate("/api/tokens/source", { name: "codex", harness: "openclaw", sourceLabel: "Personal helper" })).status).toBe(200);
      const own = (await (await request("/api/connections")).json()).connections;
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ agent: "codex", displayName: "Personal helper", harness: "openclaw", status: "authorized", canWrite: false, memoryCalls: 0, taskReports: 0, lastContactAt: null, lastAuthenticatedAt: null, client: { state: "unknown", label: null, harness: null } });
      expect((await mutate("/api/tokens/revoke", { name: "codex" })).status).toBe(200);
      const revoked = (await (await request("/api/tokens")).json()).tokens;
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatchObject({ name: "codex", canWrite: false, harness: "openclaw", sourceLabel: "Personal helper" });
      expect(Number.isFinite(Date.parse(revoked[0].revokedAt))).toBe(true);
      expect((await (await request("/api/connections")).json()).connections[0].status).toBe("revoked");
      for (const path of ["/api/tokens/source", "/api/tokens/write", "/api/tokens/revoke"]) expect((await mutate(path, { name: "codex", harness: "hermes" })).status).toBe(404);
    } finally {
      await request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId: 1 }) });
    }
    const restored = (await (await request("/api/tokens")).json()).tokens;
    expect(restored).toEqual(home);
    expect(restored.find((token: any) => token.name === "codex")).toEqual(original);
    expect((await (await request("/api/connections")).json()).connections.find((row: any) => row.agent === "codex").status).toBe("authorized");
  });

  test("counts raw demo report receipts instead of logical actions or client timestamps", async () => {
    const session = await (await request("/api/me")).json();
    expect((await request("/api/tokens", { method: "POST", body: JSON.stringify({ name: session.name, harness: "other", sourceLabel: "Demo reporter" }) })).status).toBe(200);
    const inventory = async () => (await (await request("/api/connections")).json()).connections.find((row: any) => row.agent === session.name);
    const before = await inventory();
    const report = { tool: "demo.connection-receipts", summary: "An isolated demo lifecycle", actionKey: "connection-raw-receipts", occurredAt: new Date(Date.now() - 86_400_000).toISOString() };
    const post = (status: string, eventId: string) => request("/api/actions", { method: "POST", body: JSON.stringify({ ...report, status, eventId }) });
    expect((await post("running", "connection-start")).status).toBe(201);
    expect((await post("running", "connection-heartbeat")).status).toBe(201);
    const completion = await (await post("completed", "connection-end")).json();
    const retry = await (await post("completed", "connection-end")).json();
    expect(retry.action.id).toBe(completion.action.id);
    const after = await inventory();
    expect(after.taskReports).toBe(before.taskReports + 3);
    expect(after.memoryCalls).toBe(before.memoryCalls);
    expect(after.lastAuthenticatedAt).toBeNull();
    expect(after.lastTaskReportAt).toBe(completion.action.recordedAt);
    expect(after.lastContactAt).toBe(completion.action.recordedAt);
    expect(after.lastTaskReportAt).not.toBe(report.occurredAt);
    const logical = await (await request("/api/actions?tool=demo.connection-receipts")).json();
    expect(logical.actions).toHaveLength(1);
    expect(logical.actions[0].status).toBe("completed");
  });

  test("archives, restores and deletes demo connections without removing saved history", async () => {
    const headers = { "X-Engram-Workspace": "1", "X-Engram-Console": "1", "Content-Type": "application/json" };
    const list = async () => (await (await request("/api/connections", { headers })).json()).connections;
    const mutate = (id: string, action: string, custom: HeadersInit = headers) => request("/api/connections", { method: "POST", headers: custom, body: JSON.stringify({ id, action }) });
    const historyBefore = await (await request("/api/actions?agent=codex")).json();
    const pagesBefore = await (await request("/api/pages")).json();
    await request("/api/tokens", { method: "POST", body: JSON.stringify({ name: "lifecycle-preview", harness: "claude-code" }) });
    const key = (await list()).find((row: any) => row.name === "lifecycle-preview");
    expect(key).toMatchObject({ status: "authorized", archivedAt: null });
    expect((await mutate(key.id, "archive", { "X-Engram-Workspace": "1" })).status).toBe(403);
    expect((await mutate(key.id, "archive", { "X-Engram-Console": "1" })).status).toBe(400);
    expect((await mutate(key.id, "archive", { ...headers, Origin: "https://foreign.example" })).status).toBe(403);
    expect((await mutate(key.id, "archive", { ...headers, "X-Engram-Workspace": "2" })).status).toBe(409);
    expect((await mutate("token:99999999", "archive")).status).toBe(404);
    expect((await mutate(key.id, "erase")).status).toBe(400);
    expect((await mutate(key.id, "archive")).status).toBe(200);
    const archived = (await list()).find((row: any) => row.id === key.id);
    expect(archived.status).toBe("revoked");
    expect(Number.isFinite(Date.parse(archived.archivedAt))).toBe(true);
    const rows = await list();
    expect(rows.at(-1).id).toBe(key.id);
    expect((await mutate(key.id, "restore")).status).toBe(200);
    expect((await list()).find((row: any) => row.id === key.id)).toMatchObject({ archivedAt: null, status: "revoked" });
    expect((await mutate(key.id, "delete")).status).toBe(200);
    expect((await list()).some((row: any) => row.id === key.id)).toBe(false);
    expect((await mutate(key.id, "delete")).status).toBe(200);
    expect((await mutate(key.id, "restore")).status).toBe(404);
    const oauth = (await list()).find((row: any) => row.kind === "oauth");
    expect((await mutate(oauth.id, "archive")).status).toBe(200);
    expect((await list()).find((row: any) => row.id === oauth.id).status).toBe("revoked");
    expect((await mutate(oauth.id, "restore")).status).toBe(200);
    expect((await list()).find((row: any) => row.id === oauth.id)).toMatchObject({ archivedAt: null, status: "revoked" });
    expect((await mutate(oauth.id, "delete")).status).toBe(200);
    expect((await list()).some((row: any) => row.id === oauth.id)).toBe(false);
    expect(await (await request("/api/actions?agent=codex")).json()).toEqual(historyBefore);
    expect(await (await request("/api/pages")).json()).toEqual(pagesBefore);
  });
});

describe("local reviewed-sharing lifecycle", () => {
  test("approves exact team/agent snapshots, keeps credentials out of inventory, rotates and revokes reads", async () => {
    const use = async (orgId: number) => request("/api/session/switch", { method: "POST", body: JSON.stringify({ orgId }) });
    const headers = { "X-Engram-Workspace": "2", "X-Engram-Console": "1" };
    const post = (path: string, value: unknown) => request(path, { method: "POST", headers, body: JSON.stringify(value) });
    const instruction = "Share project architecture and deployment decisions. Exclude personal health details.";
    const created: string[] = [];
    try {
      await use(1);
      const teamState = await (await request("/api/sharing", { headers: { ...headers, "X-Engram-Workspace": "1" } })).json();
      expect(teamState.sourceKind).toBe("team");
      await use(2);
      expect((await request("/api/sharing")).status).toBe(400);
      const state = await (await request("/api/sharing", { headers })).json();
      expect(state).toMatchObject({ sourceKind: "personal", modelAvailable: false });
      expect(state.targets.some((target: any) => target.id === 1)).toBe(true);
      const prepare = async (recipient: unknown) => (await (await post("/api/sharing/preview", { instruction, recipient })).json());
      const preview = await prepare({ kind: "team", orgId: 1 });
      expect(preview.method).toBe("text"); expect(preview.candidates.length).toBeGreaterThan(0);
      expect(JSON.stringify(preview)).not.toContain("Personal health appointment");
      const candidate = preview.candidates[0], selected = candidate.text.split(".")[0] + ".";
      expect((await post("/api/sharing/commit", { previewId: preview.previewId, acknowledged: false, selections: [{ id: candidate.id, text: selected }] })).status).toBe(400);
      expect((await post("/api/sharing/commit", { previewId: preview.previewId, acknowledged: true, selections: [{ id: candidate.id, text: "Unrelated material" }] })).status).toBe(400);
      const committed = await (await post("/api/sharing/commit", { previewId: preview.previewId, acknowledged: true, selections: [{ id: candidate.id, text: selected }] })).json();
      created.push(committed.share.id); expect(committed.share.items[0].text).toBe(selected); expect(committed.credential).toBeUndefined();
      expect((await post("/api/sharing/commit", { previewId: preview.previewId, acknowledged: true, selections: [{ id: candidate.id, text: selected }] })).status).toBe(409);
      await use(1);
      const teamHeaders = { ...headers, "X-Engram-Workspace": "1" };
      const teamPages = await (await request("/api/pages", { headers: teamHeaders })).json();
      const page = teamPages.pages.find((page: any) => page.type === "shared-context" && page.body === selected);
      expect(page).toBeDefined();
      const direct = await (await request("/api/page?slug=" + encodeURIComponent(page.slug), { headers: teamHeaders })).json();
      expect(direct.page.body).toBe(selected);
      await use(2);
      const agentPreview = await prepare({ kind: "agent", name: "Synthetic reviewer" });
      const agentCandidate = agentPreview.candidates[0];
      const agentResult = await (await post("/api/sharing/commit", { previewId: agentPreview.previewId, acknowledged: true, selections: [{ id: agentCandidate.id, text: agentCandidate.text }] })).json();
      created.push(agentResult.share.id);
      const token = agentResult.credential.token;
      expect(token).toMatch(/^egs_[A-Za-z0-9_-]{32}$/);
      const inventory = await (await request("/api/sharing", { headers })).json();
      expect(JSON.stringify(inventory)).not.toContain(token);
      const call = (credential: string, name = "recall") => request("/mcp/shared", { method: "POST", headers: { Authorization: "Bearer " + credential }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { query: "stable" } } }) });
      const read = await (await call(token)).json();
      expect(JSON.stringify(read)).toContain(agentCandidate.text);
      expect((await request("/api/pages", { headers: { Authorization: "Bearer " + token } })).status).toBe(401);
      expect((await (await call(token, "remember")).json()).result.isError).toBe(true);
      const replacement = await (await post("/api/sharing/" + agentResult.share.id + "/agent-token", {})).json();
      expect((await call(token)).status).toBe(401); expect((await call(replacement.credential.token)).status).toBe(200);
      await request("/api/sharing/" + agentResult.share.id, { method: "DELETE", headers });
      expect((await call(replacement.credential.token)).status).toBe(401);
      await request("/api/sharing/" + committed.share.id, { method: "DELETE", headers });
      await use(1);
      expect((await request("/api/page?slug=" + encodeURIComponent(page.slug), { headers: teamHeaders })).status).toBe(404);
    } finally {
      await use(2);
      for (const id of created) await request("/api/sharing/" + id, { method: "DELETE", headers });
      await use(1);
    }
  });
});
