import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("actual MCP routing records declared clients only after authentication and keeps display failures out of the RPC result", () => {
  const script = `
    import { mock } from 'bun:test';
    const calls = []; let fail = false;
    const db = Object.assign(async(parts,...values) => {
      const query = parts.join('?');
      if(query.includes('UPDATE tokens t SET client_names')) calls.push({query,values});
      else if(!query.includes('set_config')) throw new Error('Unexpected database query');
      return [];
    }, { json:value=>value, end:async()=>{}, begin:async work=>{if(fail)throw new Error('private storage failure');return work(db)} });
    const dbModule=await import('./gateway/src/db');
    mock.module('./gateway/src/db',()=>({...dbModule,sql:db,migrate:async()=>{}}));
    const {normalizeToken,DEFAULT_POLICIES}=await import('./gateway/src/policies');
    const agent=normalizeToken({name:'laptop',orgId:7,role:'agent',kind:'token',canWrite:false});
    const session=normalizeToken({...agent,name:'owner',kind:'session',role:'owner',email:'owner@example.test'});
    const oauth=normalizeToken({...agent,name:'oauth',kind:'oauth',scopes:['memory:unrelated']});
    const oauthRead=normalizeToken({...oauth,scopes:['memory:read']});
    const actors={'fixture-agent':agent,'fixture-session':session,'fixture-oauth':oauth,'fixture-oauth-read':oauthRead};
    const authModule=await import('./gateway/src/auth');
    mock.module('./gateway/src/auth',()=>({...authModule,authenticateRequest:async req=>actors[req.headers.get('authorization')?.replace(/^Bearer /,'')]??null}));
    const org={id:7,name:'Fixture',slug:'fixture',kind:'team',brainDb:'brain_org_7',dataDb:'brain_org_7',homeDir:'org-7',policies:DEFAULT_POLICIES};
    const orgModule=await import('./gateway/src/orgs');
    mock.module('./gateway/src/orgs',()=>({...orgModule,resolveOrg:async()=>org,withOrg:async(_org,_actor,work)=>work()}));
    const brain=await import('./gateway/src/brain');
    mock.module('./gateway/src/brain',()=>({...brain,ensureBrain:async()=>{throw new Error('Initialize/ping must not start a memory engine')},stopBrains:async()=>{}}));
    mock.module('./gateway/src/worker-preflight',()=>({verifyWorkerIsolation:async()=>{}}));
    const insights=await import('./gateway/src/insights');
    mock.module('./gateway/src/insights',()=>({...insights,startInsightWorker:()=>({close:async()=>{}})}));
    const serve=Bun.serve;let server;
    Bun.serve=options=>(server=serve({...options,hostname:'127.0.0.1'}));
    await import('./gateway/src/index');
    const results={};
    const modern=name=>({_meta:{'io.modelcontextprotocol/clientInfo':{name,version:'ignored-private-version'}}});
    async function call(key,credential,method,params,extra={}){
      const response=await fetch(new URL('/mcp',server.url),{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{}),...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      results[key]={status:response.status,body:await response.json()};
    }
    try {
      await call('anonymous',null,'initialize',{clientInfo:{name:'Codex'}});
      await call('legacy','fixture-agent','initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'OpenAI Codex',version:'discarded'}});
      await call('modern','fixture-agent','ping',modern('Cursor'));
      await call('missing','fixture-agent','ping',{});
      await call('malformed','fixture-agent',['tools/list'],modern('Goose'));
      await call('conflict','fixture-agent','ping',modern('Goose'),{'Mcp-Method':'tools/list'});
      await call('session','fixture-session','initialize',{clientInfo:{name:'Goose'}});
      await call('oauth','fixture-oauth-read','initialize',{clientInfo:{name:'Goose'}});
      await call('scope','fixture-oauth','initialize',{clientInfo:{name:'Goose'}});
      fail=true;
      await call('outage','fixture-agent','initialize',{clientInfo:{name:'Goose'}});
      process.stdout.write(JSON.stringify({results,calls}));
    } finally { await server.stop(true); process.emit('SIGTERM'); }
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20000,
    env: { ...process.env, PORT: "0", ENGRAM_DB_URL_TEMPLATE: "postgresql://unit:unit@127.0.0.1:1/__DB__", ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_WORKER_ISOLATION: "process", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "1" },
  });
  expect(child.status, child.stderr).toBe(0);
  const { results, calls } = JSON.parse(child.stdout);
  expect(results.anonymous.status).toBe(401);
  for (const key of ["legacy", "modern", "missing", "session", "oauth", "outage"]) expect(results[key]).toMatchObject({status:200,body:{jsonrpc:"2.0",id:1,result:{}}});
  expect(results.malformed.body.error.code).toBe(-32601);
  expect(results.conflict.body.error.code).toBe(-32600);
  expect(results.scope.status).toBe(403);
  expect(calls).toHaveLength(2);
  expect(calls.map((call:any)=>call.values[0])).toEqual([["Codex"],["Cursor"]]);
  expect(calls.every((call:any)=>call.values[1]===7 && /^[a-f0-9]{64}$/.test(call.values[2]) && call.values[3]==="laptop")).toBe(true);
  expect(JSON.stringify(calls)).not.toContain('fixture-agent');
  expect(JSON.stringify(results)).not.toContain('private storage failure');
});
