import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("connection inventory requires a human console credential, CSRF boundary and matching workspace without an engine",()=>{
  const script=`
    import {mock} from 'bun:test';
    const dbModule=await import('./gateway/src/db');
    let selects=0;
    const db=Object.assign(async(parts,...values)=>{const query=parts.join('?');if(!query.includes('WITH token_connections'))throw new Error('Unexpected query');selects++;return [];},{begin:async(mode,work)=>{if(mode!=='isolation level repeatable read read only')throw new Error('Not read only');return work(db)}});
    mock.module('./gateway/src/db',()=>({...dbModule,sql:db}));
    const {normalizeToken,DEFAULT_POLICIES}=await import('./gateway/src/policies');
    const owner=normalizeToken({name:'owner',orgId:7,role:'owner',kind:'session',email:'owner@example.test'});
    const member=normalizeToken({...owner,name:'member',role:'member'});
    const agent=normalizeToken({name:'agent',orgId:7});
    const delegated=normalizeToken({...owner,name:'oauth',kind:'oauth',scopes:['memory:read']});
    const actors={owner,member,agent,delegated};
    const auth=await import('./gateway/src/auth');
    mock.module('./gateway/src/auth',()=>({...auth,authenticateSecret:async raw=>actors[raw]??null,authenticateRequest:async req=>actors[req.headers.get('authorization')?.slice(7)]??null}));
    const org={id:7,name:'Private',slug:'private',kind:'team',brainDb:'brain_org_7',dataDb:'brain_org_7',homeDir:'org-7',policies:DEFAULT_POLICIES};
    const orgs=await import('./gateway/src/orgs');
    mock.module('./gateway/src/orgs',()=>({...orgs,resolveOrg:async()=>org,withOrg:async(_org,_actor,work)=>work()}));
    const brain=await import('./gateway/src/brain');
    mock.module('./gateway/src/brain',()=>({...brain,ensureBrain:async()=>{throw new Error('Inventory must not initialize an engine')}}));
    const {handleWeb}=await import('./gateway/src/web');
    const results={};
    async function call(key,headers,method='GET'){const res=await handleWeb(new Request('https://example.test/api/connections',{method,headers}));results[key]={status:res.status,body:await res.json(),cache:res.headers.get('cache-control')};}
    await call('owner',{Cookie:'engram_session=owner','X-Engram-Console':'1','X-Engram-Workspace':'7'});
    await call('member',{Cookie:'engram_session=member','X-Engram-Console':'1','X-Engram-Workspace':'7'});
    await call('anonymous',{'X-Engram-Console':'1'});
    await call('csrf',{Cookie:'engram_session=owner'});
    await call('foreignPin',{Cookie:'engram_session=owner','X-Engram-Console':'1','X-Engram-Workspace':'8'});
    await call('agent',{Cookie:'engram_session=agent','X-Engram-Console':'1'});
    await call('oauth',{Cookie:'engram_session=delegated','X-Engram-Console':'1'});
    await call('write',{Cookie:'engram_session=owner','X-Engram-Console':'1'},'POST');
    process.stdout.write(JSON.stringify({results,selects}));
  `;
  const child=spawnSync(process.execPath,["--eval",script],{cwd:fileURLToPath(new URL("..",import.meta.url)),encoding:"utf8",timeout:20000,env:{...process.env,ENGRAM_DB_URL_TEMPLATE:"postgresql://unit:unit@127.0.0.1:1/__DB__",ENGRAM_DEPLOYMENT_MODE:"self-hosted"}});
  expect(child.status,child.stderr).toBe(0);
  const {results,selects}=JSON.parse(child.stdout);
  for(const key of ["owner","member"]){expect(results[key]).toMatchObject({status:200,body:{connections:[],more:false,limit:200,recentWindowSeconds:900},cache:"no-store"});}
  expect(results.anonymous.status).toBe(401);expect(results.csrf.status).toBe(403);expect(results.foreignPin.status).toBe(409);
  expect(results.agent.status).toBe(403);expect(results.oauth.status).toBe(403);expect(results.write.status).toBe(409);expect(selects).toBe(2);
});
