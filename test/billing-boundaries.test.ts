import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run request integration in a separate module registry: mock.module is global in
// Bun, and payment-boundary mocks must never replace auth in unrelated suites.
test("expired hosted workspaces reject direct and indirect writes while retaining data control", () => {
  const script = `
    import { mock } from "bun:test";
    const dbModule = await import("./gateway/src/db");
    const policies = await import("./gateway/src/policies");
    const context = await import("./gateway/src/context");
    const actor = policies.normalizeToken({ name: "owner", orgId: 7, role: "owner", kind: "session", email: "owner@example.com" });
    const org = { id: 7, name: "Private", slug: "private", kind: "personal", brainDb: "brain_org_7", dataDb: "brain_org_7", homeDir: "org-7", policies: policies.DEFAULT_POLICIES, createdAt: "2020-01-01T00:00:00Z" };
    const db = Object.assign(async (strings, ...values) => {
      const query = strings.join("?");
      if (query.includes("INSERT INTO workspace_billing")) return [];
      if (query.includes("FROM workspace_billing")) return [{ org_id: 7, trial_ends_at: "2020-01-15T00:00:00Z", status: "trial" }];
      if (query.includes("FROM action_profiles")) return [];
      if (query.includes("INSERT INTO action_profiles") || query.includes("INSERT INTO audit_log")) return [];
      if (query.includes("WITH ledger")) return [{}];
      // SQL fragments for the public aggregate used by a permitted unpublish.
      if (!query.trim() || query.includes("AS action_version") || query.includes("SELECT agent, lower(tool) AS tool")) return [];
      if (query.includes("UPDATE tokens")) return Object.assign([], { count: 1 });
      throw new Error("Unexpected data query after payment boundary: " + query);
    }, { json: value => value });
    mock.module("./gateway/src/db", () => ({ ...dbModule, sql: db, dataSql: () => db, poolFor: () => db }));
    const realAuth = await import("./gateway/src/auth");
    mock.module("./gateway/src/auth", () => ({ ...realAuth, authenticateSecret: async () => actor, authenticateRequest: async () => actor }));
    const realOrgs = await import("./gateway/src/orgs");
    mock.module("./gateway/src/orgs", () => ({ ...realOrgs, resolveOrg: async () => org,
      withOrg: async (current, token, callback) => context.runWithContext({ org: current, token, dataSql: db }, callback),
      updatePolicies: async (_id, value) => ({ ...org, policies: value }),
    }));
    const realBrain = await import("./gateway/src/brain");
    const coordination = await import("./gateway/src/write-coordination");
    mock.module("./gateway/src/write-coordination", () => ({ ...coordination, withMemoryWriteLock: async work => work() }));
    const brainCalls = [];
    const brain = { callTool: async request => { brainCalls.push(request.name); return { content: [{ type: "text", text: JSON.stringify({ status: "soft_deleted", slug: "notes/private" }) }] }; } };
    mock.module("./gateway/src/brain", () => ({ ...realBrain, brainClient: () => brain, ensureBrain: async () => brain }));
    const { handleWeb } = await import("./gateway/src/web");
    const { callTool } = await import("./gateway/src/proxy");
    const results = {};
    async function request(key, method, path, body = {}, bearer = false) {
      const response = await handleWeb(new Request("https://engram.example" + path, {
        method, headers: { Cookie: "engram_session=unit-test", "X-Engram-Console": "1", ...(bearer ? { Authorization: "Bearer unit-test" } : {}) },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      }));
      results[key] = { status: response.status, body: await response.json() };
    }
    await request("capture", "POST", "/api/capture", { text: "new private memory" });
    await request("actions", "POST", "/api/actions", { tool: "code.build", summary: "Build" });
    await request("bearerActions", "POST", "/api/actions", { tool: "code.build", summary: "Build" }, true);
    await request("trails", "POST", "/api/trails", {});
    await request("bearerTrails", "POST", "/api/trails", {}, true);
    await request("token", "POST", "/api/tokens", { name: "new-agent" });
    await request("invite", "POST", "/api/invites", { email: "teammate@example.com" });
    await request("share", "POST", "/api/trails/private-trail/share", { targetOrgId: 8 });
    await request("rulePatch", "PATCH", "/api/share/rules/9", { level: "transcript" });
    await request("ruleResume", "POST", "/api/share/rules/9/resume");
    await request("billing", "GET", "/api/billing");
    await request("delete", "DELETE", "/api/page?slug=notes/private");
    await request("revoke", "POST", "/api/tokens/revoke", { name: "old-agent" });
    await request("privacy", "PUT", "/api/policies", { externalAiProcessing: false });
    await request("unpublish", "PUT", "/api/showcase", { slug: "private-agent", displayName: "Ada", bio: "", published: false });
    await request("publish", "PUT", "/api/showcase", { slug: "private-agent", displayName: "Ada", bio: "", published: true });
    results.mcp = await context.runWithContext({ org, token: actor, dataSql: db }, () => callTool(actor, "remember", { text: "new private memory", topic: "private" }));
    results.brainCalls = brainCalls;
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_DATABASE_AUTHORITY: "runtime", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_TENANT_CREDENTIAL_KEY: "unit-only-tenant-credential-key-32-bytes", ENGRAM_DB_URL_TEMPLATE: "postgresql://unit:unit@127.0.0.1:1/__DB__", ENGRAM_PUBLIC_URL: "https://engram.example", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", STRIPE_CLOUD_MONTHLY_PRICE_ID: "" },
  });
  expect(result.status, result.stderr).toBe(0);
  const responses = JSON.parse(result.stdout);
  for (const key of ["capture", "actions", "bearerActions", "trails", "bearerTrails", "token", "invite", "share", "rulePatch", "ruleResume", "publish"]) {
    expect(responses[key].status, key).toBe(402);
  }
  expect(responses.billing).toMatchObject({ status: 200, body: { status: "trial_expired", canWrite: false } });
  for (const key of ["delete", "revoke", "privacy", "unpublish"]) expect(responses[key].status, key).toBe(200);
  expect(responses.mcp.isError).toBe(true);
  expect(responses.mcp.content[0].text).toContain("subscription");
  expect(responses.brainCalls).toEqual(["delete_page"]);
});
