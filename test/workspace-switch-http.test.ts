import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("authenticated workspace switching stays metadata-only and preserves onboarding isolation", () => {
  // Isolate Bun's process-global module mocks. Keep the real context and
  // onboarding guard; fake storage and credentials are local fixtures only.
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    const realDb = await import('./gateway/src/db');
    const realAuth = await import('./gateway/src/auth');
    const realOrgs = await import('./gateway/src/orgs');
    const realBrain = await import('./gateway/src/brain');
    const { currentContext } = await import('./gateway/src/context');
    const { normalizeToken, DEFAULT_POLICIES } = await import('./gateway/src/policies');
    let minted = 0, tenantContexts = 0, engineStarts = 0, failOnboarding = false;
    const db = async () => [];
    db.begin = async (...args) => { if (failOnboarding) throw new Error('fixture metadata unavailable'); return args.at(-1)(db); };
    db.json = value => value;
    const org = (id, kind = 'team', status = 'ready') => ({id,name:'Fixture workspace '+id,slug:'fixture-'+id,kind,brainDb:'brain_org_'+id,dataDb:'brain_org_'+id,homeDir:'org-'+id,policies:DEFAULT_POLICIES,createdAt:new Date().toISOString(),provisioningStatus:status});
    const workspaces = new Map([[2,org(2)],[3,org(3,'personal')],[4,org(4)],[5,org(5,'personal','pending')]]);
    const actor = orgId => normalizeToken({name:'fixture-owner@example.test',email:'fixture-owner@example.test',orgId,role:'owner',kind:'session'});
    const sessions = new Map([['ens_source_fixture_never_real',actor(2)],['ens_delegated_fixture_never_real',normalizeToken({...actor(2),kind:'oauth'})]]);
    mock.module('./gateway/src/db',()=>({...realDb,sql:db,usingOrgPool:async(_name,run)=>{tenantContexts++;return run(db);}}));
    mock.module('./gateway/src/auth',()=>({...realAuth,authenticateSecret:async raw=>sessions.get(raw)||null,createSession:async input=>{const raw='ens_destination_fixture_never_real_'+(++minted);sessions.set(raw,actor(input.orgId));return raw;}}));
    mock.module('./gateway/src/orgs',()=>({...realOrgs,resolveOrg:async token=>workspaces.get(token.orgId),getOrg:async id=>workspaces.get(id)||null,memberInOrg:async(id,email)=>id===4?null:{orgId:id,email,role:'owner'},listMemberships:async()=>[...workspaces.values()].filter(row=>row.id!==4).map(row=>({...row,role:'owner'}))}));
    mock.module('./gateway/src/brain',()=>({...realBrain,ensureBrain:async()=>{engineStarts++;throw new Error('Switching must not start an engine');}}));
    const { handleWeb } = await import('./gateway/src/web');
    const { onboardingState } = await import('./gateway/src/org-api');
    const request = (target, raw='ens_source_fixture_never_real', extra={}) => new Request('https://engram.example/api/session/switch',{method:'POST',headers:{Cookie:'engram_session='+raw,'X-Engram-Console':'1','Content-Type':'application/json',...extra},body:JSON.stringify({orgId:target})});
    assert.equal(currentContext(),undefined);
    const response = await handleWeb(request(3));
    assert.equal(response.status,200);
    const body = await response.json();
    assert.equal(body.org.id,3); assert.equal(body.org.provisioningStatus,'ready');
    assert.equal(body.onboarding.step,'connect');
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie?.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
    const destination = cookie.split(';')[0];
    const me = await handleWeb(new Request('https://engram.example/api/me',{headers:{Cookie:destination,'X-Engram-Console':'1','X-Engram-Workspace':'3'}}));
    assert.equal((await me.json()).org.id,3);
    assert.equal(currentContext(),undefined);
    assert.equal(tenantContexts,0); assert.equal(engineStarts,0);
    assert.equal((await handleWeb(request(4))).status,404);
    assert.equal((await handleWeb(request(3,'ens_source_fixture_never_real',{'X-Engram-Workspace':'99'}))).status,409);
    assert.equal((await handleWeb(request(3,'ens_delegated_fixture_never_real'))).status,403);
    assert.equal((await handleWeb(request(3,'ens_unknown_fixture_never_real'))).status,404);
    assert.equal(minted,1);
    const pending = await handleWeb(request(5));
    assert.equal(pending.status,200); assert.equal((await pending.json()).onboarding.step,'provisioning');
    assert.equal(tenantContexts,0); assert.equal(engineStarts,0);
    // Reading target onboarding must finish before a new session is minted.
    const beforeFailure = minted; failOnboarding=true;
    await assert.rejects(()=>handleWeb(request(3)),/fixture metadata unavailable/);
    assert.equal(minted,beforeFailure); failOnboarding=false;
    // The scope guard still rejects genuinely mismatched tenant operations.
    await realOrgs.withOrg(workspaces.get(2),actor(2),async()=>{
      assert.equal(currentContext().org.id,2);
      await assert.rejects(()=>onboardingState(workspaces.get(3)),error=>error.status===403);
      assert.equal(currentContext().org.id,2);
    });
    assert.equal(currentContext(),undefined);
    assert.equal(engineStarts,0);
    process.stdout.write(JSON.stringify({ok:true,minted,engineStarts,guardPreserved:true,contextRestored:true}));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "1", ENGRAM_DATABASE_AUTHORITY: "inline", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_DB_URL_TEMPLATE: "postgresql://unit:unit@127.0.0.1:1/__DB__" } });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, minted: 2, engineStarts: 0, guardPreserved: true, contextRestored: true });
});
