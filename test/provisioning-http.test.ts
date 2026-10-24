import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("pending workspaces expose progress without opening a tenant database or engine", () => {
  const script = `
    import { mock } from 'bun:test';
    const realAuth = await import('./gateway/src/auth');
    const realOrg = await import('./gateway/src/orgs');
    const realOrgApi = await import('./gateway/src/org-api');
    const policies = await import('./gateway/src/policies');
    const actor = policies.normalizeToken({name:'owner',orgId:7,role:'owner',kind:'session'});
    const org = {id:7,name:'Preparing',slug:'preparing',kind:'team',brainDb:'brain_org_7',dataDb:'brain_org_7',homeDir:'org-7',policies:policies.DEFAULT_POLICIES,createdAt:new Date().toISOString(),provisioningStatus:'pending'};
    let contexts=0;
    mock.module('./gateway/src/auth',()=>({...realAuth,authenticateSecret:async()=>actor,authenticateRequest:async()=>actor}));
    mock.module('./gateway/src/orgs',()=>({...realOrg,resolveOrg:async()=>org,withOrg:async()=>{contexts++;throw new Error('Tenant storage must not open')}}));
    mock.module('./gateway/src/org-api',()=>({...realOrgApi,onboardingState:async()=>({step:'provisioning',provisioning:true,hasToken:false,hasPage:false}),sessionActor:async()=>({name:actor.name,role:actor.role,org:{id:org.id,name:org.name,provisioningStatus:org.provisioningStatus},orgs:[]})}));
    const {handleWeb}=await import('./gateway/src/web');
    const results=[];
    for(const path of ['/api/me','/api/provisioning','/api/activities']){
      const res=await handleWeb(new Request('https://engram.example'+path,{headers:{Cookie:'engram_session=fixture','X-Engram-Console':'1','X-Engram-Workspace':'7'}}));
      results.push({status:res.status,retry:res.headers.get('retry-after'),body:await res.json()});
    }
    const stale=await handleWeb(new Request('https://engram.example/api/provisioning',{headers:{Cookie:'engram_session=fixture','X-Engram-Console':'1','X-Engram-Workspace':'8'}}));
    process.stdout.write(JSON.stringify({results,stale:stale.status,contexts}));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "1", ENGRAM_DATABASE_AUTHORITY: "inline", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_DB_URL_TEMPLATE: "postgresql://unit:unit@127.0.0.1:1/__DB__" } });
  expect(result.status, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.contexts).toBe(0); expect(data.stale).toBe(409);
  for (const response of data.results) { expect(response.status).toBe(202); expect(response.retry).toBe("4"); }
  expect(data.results[0].body.org.provisioningStatus).toBe("pending");
  expect(data.results[2].body.code).toBe("workspace_provisioning");
});
