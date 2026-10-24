import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const mode of ["hosted", "self-hosted"] as const) {
  test(mode + " workspace names require a pinned live owner session and no tenant engine", async () => {
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { mock } from 'bun:test';
      const { normalizeToken, DEFAULT_POLICIES } = await import('./gateway/src/policies');
      const row = { id: 7, name: 'Original', slug: 'stable-slug', kind: 'personal', brain_db: 'brain_org_7', data_db: 'brain_org_7', home_dir: 'org-7', policies: DEFAULT_POLICIES, created_at: '2026-10-01T00:00:00Z', provisioning_status: 'ready' };
      let liveRole = 'owner', updates = 0, membershipReads = 0, tenantPools = 0, engineStarts = 0, entitlementCalls = 0, failStorage = false;
      const db = async (parts, ...values) => {
        const query = parts.join('?');
        if (query.includes('FROM org_members')) {
          membershipReads++;
          assert.ok(query.includes('FOR SHARE')); assert.deepEqual(values, [7, 'owner@example.test']);
          return liveRole === 'owner' ? [{ id: 19 }] : [];
        }
        if (query.includes('UPDATE orgs SET name')) {
          if (failStorage) throw new Error('fixture unavailable');
          assert.equal(values[1], 7); assert.ok(query.includes("provisioning_status = 'ready'"));
          updates++; row.name = values[0]; return [{ ...row }];
        }
        throw new Error('Unexpected metadata operation');
      };
      db.begin = async work => work(db);
      const realDb = await import('./gateway/src/db');
      mock.module('./gateway/src/db', () => ({ ...realDb, sql: db, usingOrgPool: async () => { tenantPools++; throw new Error('Naming must not open a tenant pool'); } }));
      const owner = normalizeToken({ name: 'owner', orgId: 7, role: 'owner', kind: 'session', email: 'owner@example.test' });
      const actors = {
        ens_owner: owner,
        ens_member: normalizeToken({ ...owner, role: 'member' }),
        ens_reader: normalizeToken({ ...owner, canWrite: false }),
        ens_unbound: normalizeToken({ ...owner, email: null }),
        eng_owner: normalizeToken({ ...owner, kind: 'token' }),
        eng_agent: normalizeToken({ ...owner, role: 'agent', kind: 'token', email: null }),
        jwt_owner: normalizeToken({ ...owner, kind: 'oauth' }),
        ens_foreign: normalizeToken({ ...owner, orgId: 8 }),
      };
      const realAuth = await import('./gateway/src/auth');
      mock.module('./gateway/src/auth', () => ({ ...realAuth, authenticateSecret: async raw => actors[raw] ?? null }));
      const realOrgs = await import('./gateway/src/orgs');
      const org = actor => ({ id: actor.orgId, name: row.name, slug: row.slug, kind: row.kind, brainDb: 'brain_org_' + actor.orgId, dataDb: 'brain_org_' + actor.orgId, homeDir: 'org-' + actor.orgId, policies: row.policies, createdAt: row.created_at, provisioningStatus: row.provisioning_status });
      mock.module('./gateway/src/orgs', () => ({ ...realOrgs, resolveOrg: async actor => org(actor) }));
      const realBrain = await import('./gateway/src/brain');
      mock.module('./gateway/src/brain', () => ({ ...realBrain, ensureBrain: async () => { engineStarts++; throw new Error('No engine'); } }));
      const realBilling = await import('./gateway/src/billing');
      mock.module('./gateway/src/billing', () => ({ ...realBilling, requireHostedWriteAccess: async () => { entitlementCalls++; throw new Error('Naming must work after a trial'); } }));
      const { handleWeb } = await import('./gateway/src/web');
      let checks = 0;
      const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
      const request = (body, raw = 'ens_owner', overrides = {}, method = 'PUT') => new Request('https://example.test/api/workspace', { method, headers: { ...(raw ? { Cookie: 'engram_session=' + raw } : {}), 'X-Engram-Console': '1', 'X-Engram-Workspace': '7', 'Content-Type': 'application/json', ...overrides }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      const rename = body => handleWeb(request(body));
      const before = { ...row };
      const response = await rename({ name: '  Shared studio  ' });
      eq(response.status, 200); eq(response.headers.get('cache-control'), 'no-store');
      const payload = await response.json();
      eq(payload, { org: { id: 7, name: 'Shared studio', slug: 'stable-slug', kind: 'personal', policies: DEFAULT_POLICIES, provisioningStatus: 'ready', provisioningError: null } });
      eq({ ...row, name: before.name }, before); eq(updates, 1); eq(membershipReads, 1);
      for (const name of ['Unicode 工作区', 'x'.repeat(100)]) eq((await rename({ name })).status, 200);
      const validUpdates = updates;
      const invalid = [{}, [], null, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 12 }, { name: 'bad\nname' }, { name: '\ttrimmed' }, { name: 'bad\u0000name' }, { name: 'bad\u0085name' }, { name: 'safe', slug: 'override' }, { name: 'safe', orgId: 8 }];
      for (const body of invalid) eq((await rename(body)).status, 400);
      eq((await rename('{broken')).status, 400); eq(updates, validUpdates);
      const beforeDenied = membershipReads;
      for (const raw of ['ens_member', 'ens_reader', 'ens_unbound', 'eng_owner', 'eng_agent', 'jwt_owner']) {
        const denied = await handleWeb(request({ name: 'Denied' }, raw));
        assert.ok([401, 403].includes(denied.status)); checks++; eq(denied.headers.get('set-cookie'), null);
      }
      eq(membershipReads, beforeDenied); eq((await handleWeb(request({ name: 'Denied' }, ''))).status, 401);
      eq((await handleWeb(request({ name: 'Denied' }, 'ens_owner', { 'X-Engram-Console': '0' }))).status, 403);
      eq((await handleWeb(request({ name: 'Denied' }, 'ens_owner', { 'X-Engram-Workspace': '' }))).status, 400);
      eq((await handleWeb(request({ name: 'Denied' }, 'ens_owner', { 'X-Engram-Workspace': '8' }))).status, 409);
      eq((await handleWeb(request({ name: 'Denied' }, 'ens_foreign'))).status, 409);
      eq((await handleWeb(request({ name: 'Denied' }, '', { Authorization: 'Bearer eng_owner' }))).status, 401);
      eq(membershipReads, beforeDenied); eq(updates, validUpdates);
      liveRole = 'member'; eq((await rename({ name: 'Stale owner' })).status, 403); eq(updates, validUpdates);
      liveRole = 'removed'; eq((await rename({ name: 'Removed owner' })).status, 403); eq(updates, validUpdates);
      liveRole = 'owner'; row.provisioning_status = 'pending';
      const pending = await rename({ name: 'Not ready' }); eq(pending.status, 202); eq((await pending.json()).code, 'workspace_provisioning'); eq(updates, validUpdates);
      row.provisioning_status = 'ready';
      eq((await handleWeb(request(undefined, 'ens_owner', {}, 'GET'))).status, 405);
      failStorage = true; eq((await rename({ name: 'Storage failure' })).status, 503); eq(updates, validUpdates);
      eq(tenantPools, 0); eq(engineStarts, 0); eq(entitlementCalls, 0);
      process.stdout.write(JSON.stringify({ ok: true, checks }));
`;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ENGRAM_DEPLOYMENT_MODE: mode, ENGRAM_SIGNUP_MODE: mode === "hosted" ? "invite-only" : "open", ENGRAM_DATABASE_AUTHORITY: mode === "hosted" ? "runtime" : "inline", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: mode === "hosted" ? "0" : "1", ENGRAM_DB_URL_TEMPLATE: "postgresql://runtime:unit-runtime@127.0.0.1:1/__DB__", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_TENANT_CREDENTIAL_KEY: "unit-only-derivation-key-at-least-32-bytes" },
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(status, stderr).toBe(0); expect(JSON.parse(stdout).ok).toBe(true); expect(JSON.parse(stdout).checks).toBeGreaterThanOrEqual(50);
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); }
  });
}

