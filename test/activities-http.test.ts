import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("private activity routes require valid credentials, the console boundary and matching workspace without starting a brain", () => {
  const script = `
    import { mock } from "bun:test";
    const auth = await import("./gateway/src/auth");
    const orgs = await import("./gateway/src/orgs");
    const brain = await import("./gateway/src/brain");
    const activities = await import("./gateway/src/activities");
    const { normalizeToken, DEFAULT_POLICIES } = await import("./gateway/src/policies");
    const actor = normalizeToken({ name: "authenticated-agent", orgId: 7 });
    const org = { id: 7, name: "Private", slug: "private", kind: "team", brainDb: "brain_org_7", dataDb: "brain_org_7", homeDir: "org-7", policies: DEFAULT_POLICIES };
    let calls = 0;
    mock.module("./gateway/src/auth", () => ({ ...auth,
      authenticateSecret: async raw => raw === "valid" ? actor : null,
      authenticateRequest: async req => req.headers.get("authorization") === "Bearer valid" ? actor : null,
    }));
    mock.module("./gateway/src/orgs", () => ({ ...orgs, resolveOrg: async () => org, withOrg: async (_org, _actor, callback) => callback() }));
    mock.module("./gateway/src/brain", () => ({ ...brain, ensureBrain: async () => { throw new Error("Grouped activity must not initialize a memory engine"); } }));
    mock.module("./gateway/src/activities", () => ({ ...activities, handleActivitiesApi: async (req, current) => { calls++; return Response.json({ actor: current.name, orgId: current.orgId, path: new URL(req.url).pathname }); } }));
    const { handleWeb } = await import("./gateway/src/web");
    const results = {};
    async function call(key, path, headers) { const response = await handleWeb(new Request("https://engram.example" + path, { headers })); results[key] = { status: response.status, body: await response.json() }; }
    await call("cookie", "/api/activities", { Cookie: "engram_session=valid", "X-Engram-Console": "1", "X-Engram-Workspace": "7" });
    await call("detail", "/api/activities/run%3Arelease%2Fone", { Cookie: "engram_session=valid", "X-Engram-Console": "1", "X-Engram-Workspace": "7" });
    await call("csrf", "/api/activities", { Cookie: "engram_session=valid" });
    await call("anonymous", "/api/activities", { "X-Engram-Console": "1" });
    await call("changedCookie", "/api/activities/event%3Aone", { Cookie: "engram_session=valid", "X-Engram-Console": "1", "X-Engram-Workspace": "8" });
    await call("bearer", "/api/activities", { Authorization: "Bearer valid", "X-Engram-Workspace": "7" });
    await call("changedBearer", "/api/activities/run%3Arelease", { Authorization: "Bearer valid", "X-Engram-Workspace": "8" });
    await call("invalidBearer", "/api/activities", { Authorization: "Bearer invalid" });
    process.stdout.write(JSON.stringify({ results, calls }));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ENGRAM_DB_URL_TEMPLATE: "postgresql://unit:unit@127.0.0.1:1/__DB__", ENGRAM_DEPLOYMENT_MODE: "self-hosted" },
  });
  expect(child.status, child.stderr).toBe(0);
  const { results, calls } = JSON.parse(child.stdout);
  for (const key of ["cookie", "detail", "bearer"]) expect(results[key]).toMatchObject({ status: 200, body: { actor: "authenticated-agent", orgId: 7 } });
  expect(results.csrf.status).toBe(403); expect(results.anonymous.status).toBe(401); expect(results.invalidBearer.status).toBe(401);
  expect(results.changedCookie.status).toBe(409); expect(results.changedBearer.status).toBe(409);
  expect(calls).toBe(3);
});
