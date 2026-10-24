import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Each mode gets a fresh module registry and configuration. All credentials and
// storage are local fixtures; no database, mail provider or engine is contacted.
async function checkMode(mode: "hosted" | "self-hosted") {
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    const { normalizeToken, DEFAULT_POLICIES } = await import('./gateway/src/policies');
    const actors = {
      eng_fixture: normalizeToken({ name: 'legacy owner', orgId: 7, role: 'owner', kind: 'token' }),
      jwt_fixture: normalizeToken({ name: 'delegated', orgId: 7, role: 'owner', kind: 'oauth', email: 'owner@example.test' }),
      ens_fixture: normalizeToken({ name: 'email owner', orgId: 7, role: 'owner', kind: 'session', email: 'owner@example.test' }),
      no_email: normalizeToken({ name: 'unbound', orgId: 7, role: 'owner', kind: 'session' }),
    };
    let authentications = 0, engineStarts = 0;
    const auth = await import('./gateway/src/auth');
    mock.module('./gateway/src/auth', () => ({ ...auth,
      authenticateSecret: async raw => { authentications++; return actors[raw] ?? null; },
      authenticateRequest: async req => actors[req.headers.get('authorization')?.slice(7)] ?? null,
    }));
    const org = { id: 7, name: 'Private', slug: 'private', kind: 'personal', brainDb: 'brain_org_7', dataDb: 'brain_org_7', homeDir: 'org-7', policies: DEFAULT_POLICIES, provisioningStatus: 'ready' };
    const orgs = await import('./gateway/src/orgs');
    mock.module('./gateway/src/orgs', () => ({ ...orgs, resolveOrg: async () => org, withOrg: async (_org, _actor, work) => work() }));
    const orgApi = await import('./gateway/src/org-api');
    mock.module('./gateway/src/org-api', () => ({ ...orgApi,
      onboardingState: async () => ({ step: 'connect', hasToken: true, hasPage: false }),
      sessionActor: async actor => ({ role: actor.role, email: actor.email, kind: actor.kind, org: { id: 7 } }),
    }));
    const activities = await import('./gateway/src/activities');
    mock.module('./gateway/src/activities', () => ({ ...activities, handleActivitiesApi: async (_req, actor) => Response.json({ kind: actor.kind, activities: [] }) }));
    const brain = await import('./gateway/src/brain');
    mock.module('./gateway/src/brain', () => ({ ...brain, ensureBrain: async () => { engineStarts++; throw new Error('No engine required'); } }));
    const { handleWeb } = await import('./gateway/src/web');
    const hosted = process.env.ENGRAM_DEPLOYMENT_MODE === 'hosted';
    let checks = 0;
    const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
    const policy = await handleWeb(new Request('https://example.test/api/signup-policy'));
    eq(policy.status, 200); eq((await policy.json()).tokenSignInAllowed, !hosted);
    eq(policy.headers.get('cache-control'), 'no-store');
    const headers = { 'X-Engram-Console': '1', 'Content-Type': 'application/json' };
    if (hosted) {
      // Even a valid email credential cannot use the removed exchange endpoint.
      // Rejected request streams remain unread and the authenticator is untouched.
      for (const body of ['{malformed', JSON.stringify({token: 'eng_fixture'}), JSON.stringify({token: 'jwt_fixture'}), JSON.stringify({token: 'ens_fixture'})]) {
        const req = new Request('https://example.test/api/session', { method: 'POST', headers, body });
        const response = await handleWeb(req);
        eq(response.status, 403); eq((await response.json()).code, 'token_sign_in_disabled');
        eq(response.headers.get('set-cookie'), null); eq(req.bodyUsed, false); eq(authentications, 0);
      }
    } else {
      const response = await handleWeb(new Request('https://example.test/api/session', { method: 'POST', headers, body: JSON.stringify({token: 'eng_fixture'}) }));
      eq(response.status, 200); eq(authentications, 1);
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /^engram_session=eng_fixture;/); checks++;
      assert.ok(cookie.includes('HttpOnly; Secure; SameSite=Strict; Path=/')); checks++;
    }
    const get = (raw, workspace = '7', consoleHeader = true) => handleWeb(new Request('https://example.test/api/me', { headers: { Cookie: 'engram_session=' + raw, ...(consoleHeader ? {'X-Engram-Console': '1'} : {}), 'X-Engram-Workspace': workspace } }));
    for (const raw of ['eng_fixture', 'jwt_fixture', 'no_email']) {
      const response = await get(raw);
      eq(response.status, hosted ? 401 : 200); eq(response.headers.get('set-cookie'), null);
    }
    const email = await get('ens_fixture'); eq(email.status, 200);
    eq((await email.json()).email, 'owner@example.test');
    eq((await get('ens_fixture', '8')).status, 409);
    const beforeCsrf = authentications;
    eq((await get('ens_fixture', '7', false)).status, 403); eq(authentications, beforeCsrf);
    const logout = await handleWeb(new Request('https://example.test/api/session', { method: 'DELETE', headers: { 'X-Engram-Console': '1', Cookie: 'engram_session=eng_fixture' } }));
    eq(logout.status, 204); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/); checks++;
    eq(authentications, beforeCsrf);
    // Bearer agent API calls bypass browser cookie authentication as before.
    const bearer = await handleWeb(new Request('https://example.test/api/activities', { headers: { Authorization: 'Bearer eng_fixture', 'X-Engram-Workspace': '7' } }));
    eq(bearer.status, 200); eq((await bearer.json()).kind, 'token'); eq(engineStarts, 0);
    process.stdout.write(JSON.stringify({ ok: true, checks }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      ENGRAM_DEPLOYMENT_MODE: mode,
      ENGRAM_SIGNUP_MODE: mode === "hosted" ? "invite-only" : "open",
      ENGRAM_DATABASE_AUTHORITY: mode === "hosted" ? "runtime" : "inline",
      ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: mode === "hosted" ? "0" : "1",
      ENGRAM_DB_URL_TEMPLATE: "postgresql://runtime:unit-runtime@127.0.0.1:1/__DB__",
      ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "",
      ENGRAM_TENANT_CREDENTIAL_KEY: "unit-only-derivation-key-at-least-32-bytes",
      ENGRAM_INSECURE_COOKIE: "0",
    },
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
    expect(JSON.parse(stdout).checks).toBeGreaterThanOrEqual(mode === "hosted" ? 40 : 20);
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); }
}

test("hosted console rejects token exchange and old token cookies while email and bearer agents continue", () => checkMode("hosted"));
test("self-hosted console preserves token recovery independently of hosted sign-in policy", () => checkMode("self-hosted"));
