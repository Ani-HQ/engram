import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, AuthError, workspaceApi } from "./api.js";

const originalFetch = globalThis.fetch;
const calls: { url: string; options: RequestInit }[] = [];
beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (url: any, options: RequestInit) => { calls.push({ url: String(url), options }); return Response.json({ ok: true }); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("private workspace API requests", () => {
  test("uses scoped operator routes and keeps invite codes in the signup body only", async () => {
    const selected = workspaceApi(1);
    await selected.signupInvites(); await selected.issueSignupInvite({ email: "friend@example.com" }); await selected.revokeSignupInvite("invite/opaque");
    expect(calls.map(call => call.url)).toEqual(["/api/admin/signup-invites", "/api/admin/signup-invites", "/api/admin/signup-invites/invite%2Fopaque/revoke"]);
    for (const call of calls) { expect(new Headers(call.options.headers).get("X-Engram-Workspace")).toBe("1"); expect(new Headers(call.options.headers).get("X-Engram-Console")).toBe("1"); }
    await api.createOrg({ email: "friend@example.com", inviteCode: "example-code" });
    expect(calls[3].url).toBe("/api/orgs"); expect(JSON.parse(String(calls[3].options.body))).toEqual({ email: "friend@example.com", inviteCode: "example-code" });
    await api.signupPolicy(); expect(calls[4].url).toBe("/api/signup-policy"); expect(calls[4].options.cache).toBe("no-store");
  });
  test("reads getting started evidence with the originating workspace and no mutation", async () => {
    await workspaceApi(7).onboarding();
    expect(calls[0].url).toBe("/api/onboarding");
    expect(new Headers(calls[0].options.headers).get("X-Engram-Workspace")).toBe("7");
    expect(new Headers(calls[0].options.headers).get("X-Engram-Console")).toBe("1");
    expect(calls[0].options.method).toBeUndefined();
    expect(calls[0].options.body).toBeUndefined();
  });
  test("pins the private connection inventory to the human console workspace", async () => {
    await workspaceApi(7).connections();
    expect(calls[0].url).toBe("/api/connections");
    expect(new Headers(calls[0].options.headers).get("X-Engram-Workspace")).toBe("7");
    expect(new Headers(calls[0].options.headers).get("X-Engram-Console")).toBe("1");
    expect(calls[0].options.credentials).toBe("same-origin");
  });
  test("pins asynchronous analysis and review reads and writes to their originating workspace", async () => {
    const selected = workspaceApi(7);
    await selected.runInsights({ q: "deployment intent" });
    await selected.insights({ jobId: "sample-job" });
    await selected.review(42);
    await selected.resolveReview(42, "approve");
    await selected.savePolicies({ externalAiProcessing: false });
    expect(calls.map(call => call.url)).toEqual(["/api/insights", "/api/insights?jobId=sample-job", "/api/review/item?id=42", "/api/review/approve", "/api/policies"]);
    for (const call of calls) {
      expect(new Headers(call.options.headers).get("X-Engram-Workspace")).toBe("7");
      expect(new Headers(call.options.headers).get("X-Engram-Console")).toBe("1");
      expect(call.options.credentials).toBe("same-origin");
    }
    expect(calls[0].options.method).toBe("POST");
    expect(JSON.parse(String(calls[3].options.body))).toEqual({ id: 42 });
    expect(calls[4].options.method).toBe("PUT");
  });

  test("encodes opaque activity IDs and carries scope through memory search and capture", async () => {
    await api.activity("run:client/task?private#name", 11);
    await api.search({ q: "a & b" }, 11);
    await api.capture({ text: "Remember" }, 11);
    expect(calls[0].url).toBe("/api/activities/run%3Aclient%2Ftask%3Fprivate%23name");
    expect(calls[1].url).toBe("/api/search?q=a+%26+b");
    for (const call of calls) expect(new Headers(call.options.headers).get("X-Engram-Workspace")).toBe("11");
  });

  test("distinguishes an expired session from a workspace conflict", async () => {
    globalThis.fetch = (async () => Response.json({ error: "Selected workspace changed" }, { status: 409 })) as typeof fetch;
    await expect(api.insights({}, 7)).rejects.toThrow("Selected workspace changed");
    globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
    await expect(api.insights({}, 7)).rejects.toBeInstanceOf(AuthError);
  });
  test("polls pending provisioning using the originating workspace and accepts202", async () => {
    globalThis.fetch = (async (url, options) => { calls.push({ url: String(url), options: options! }); return Response.json({ org: { id: 7, provisioningStatus: "pending" } }, { status: 202 }); }) as typeof fetch;
    expect((await workspaceApi(7).provisioning()).org.provisioningStatus).toBe("pending");
    expect(calls[0].url).toBe("/api/provisioning");
    expect(new Headers(calls[0].options.headers).get("X-Engram-Workspace")).toBe("7");
  });
});
