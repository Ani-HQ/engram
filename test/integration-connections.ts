import assert from "node:assert/strict";
import type postgres from "postgres";
import { issueToken, authenticateStoredSecret } from "../gateway/src/auth";
import { recordAction } from "../gateway/src/actions";
import { agentOnboardingChecks, listConnections } from "../gateway/src/connections";
import { oauthActorName } from "../gateway/src/oauth";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { onboardingStep } from "../gateway/src/orgs";
import { recordMcpUsage } from "../gateway/src/memory-usage";
import { listAgentIdentities, setAgentIdentity } from "../gateway/src/agent-identity";
import { deflateSync } from "node:zlib";

// Invoked only by integration-postgres.ts after its disposable-database guard.
export async function checkConnections(db: postgres.Sql): Promise<number> {
  let checks=0;
  function equal(actual:unknown,expected:unknown,message:string){assert.deepEqual(actual,expected,message);checks++;}
  const now=new Date(),past=new Date(now.getTime()-86400000),future=new Date(now.getTime()+86400000);
  const owner=normalizeToken({name:"inventory-owner",orgId:2,role:"owner",kind:"session",email:"inventory-owner@example.test"});
  const email="inventory+é@example.test";
  const members=await db`INSERT INTO org_members(org_id,email,role) VALUES(2,${email},'member'),(3,${email},'member') RETURNING id,org_id`;
  const memberId=members.find(row=>row.org_id===2)!.id,otherMemberId=members.find(row=>row.org_id===3)!.id;
  const raw=await issueToken(2,"inventory-api",true,null,db,{harness:"codex",label:"Development laptop"});
  const agent=(await authenticateStoredSecret(raw,db))!;
  await issueToken(3,"inventory-api",true,null,db);
  await issueToken(2,"inventory-revoked",false,null,db);
  await db`UPDATE tokens SET revoked_at=now() WHERE org_id=2 AND name='inventory-revoked'`;
  await issueToken(2,"operator-candidate-smoke-inventory-fixture",false,null,db);
  const memberRaw=await issueToken(2,"inventory-removed-member",true,email,db);
  // A mismatched binding must fail even before a cleanup revocation is written.
  await db`UPDATE tokens SET issued_by_member_id=${Number(memberId)+1000000} WHERE org_id=2 AND name='inventory-removed-member'`;
  equal(await authenticateStoredSecret(memberRaw,db),null,"Inventory status tracks the same exact-membership boundary as authentication");
  await recordAction(agent,{tool:"files.write",summary:"Inventory fixture starts",actionKey:"inventory:step",eventId:"inventory:start",status:"running"});
  await recordAction(agent,{tool:"files.write",summary:"Inventory fixture completes",actionKey:"inventory:step",eventId:"inventory:done",status:"completed"});
  for(const orgId of [2,3])await db`INSERT INTO audit_log(token_name,tool,arg_summary,outcome,org_id) VALUES('inventory-api','remember','fixture','ok',${orgId})`;
  await db`INSERT INTO audit_log(token_name,tool,arg_summary,outcome,org_id) VALUES('inventory-api','remember','failed fixture','error',2)`;
  await db`INSERT INTO audit_log(token_name,tool,arg_summary,outcome,org_id) VALUES('inventory-api','search','fixture','ok',3)`;

  const clients=[
    ["https://chatgpt.com/inventory-client?a=(b)!&v='x'","Codex"],
    ["inventory-expired-client","Cursor"],
    ["inventory-revoked-client","Hermes"],
    ["inventory-member-client","OpenClaw"],
    ["inventory-unbound-client","Unknown custom client"],
    ["inventory-foreign-global-client","Foreign global private label"],
  ];
  for(const [clientId,name] of clients)await db`INSERT INTO oauth_clients(client_id,redirect_uris,client_name) VALUES(${clientId},${db.json(["https://private-callback.example/secret-redirect"])},${name})`;
  let serial=0;
  const grant=async(orgId:number,clientId:string,binding:number|null,createdAt:Date,expiresAt:Date,revokedAt:Date|null=null)=>{
    await db`INSERT INTO oauth_refresh_tokens(sha256_hash,client_id,email,org_id,membership_id,resource,scope,created_at,expires_at,revoked_at)
      VALUES(${`inventory-secret-hash-${serial++}`},${clientId},${email},${orgId},${binding},'https://integration.example/mcp','memory:read',${createdAt},${expiresAt},${revokedAt})`;
  };
  await grant(2,clients[0][0],memberId,past,future);
  await grant(2,clients[0][0],memberId,now,future,now);
  await grant(3,clients[0][0],otherMemberId,now,future);
  await grant(2,clients[1][0],memberId,now,past);
  await grant(2,clients[2][0],memberId,now,future,now);
  await grant(2,clients[3][0],Number(memberId)+1000000,now,future);
  await grant(2,clients[4][0],null,now,future);
  await grant(3,clients[5][0],otherMemberId,now,future);
  const oauthAgent=oauthActorName({sub:email,client_id:clients[0][0]});
  await db`INSERT INTO audit_log(token_name,tool,arg_summary,outcome,org_id) VALUES(${oauthAgent},'whoami','{}','ok',2)`;
  await db`INSERT INTO audit_log(token_name,tool,arg_summary,outcome,org_id) VALUES(${oauthAgent},'remember','foreign private content','ok',3)`;

  const result=await listConnections(owner,db,now),api=result.connections.find(value=>value.name==='inventory-api')!;
  equal([api.memoryCalls,api.successfulMemoryCalls,api.taskReports,api.status,api.harness],[2,1,2,"authorized","codex"],"Connection attempts and successful memory receipts stay distinct and workspace scoped");
  equal(api.lastSuccessfulMemoryAt!==null,true,"Successful memory timestamps come from successful receipts");
  equal(api.lastAuthenticatedAt!==null,true,"Only recorded token use populates the authentication timestamp");
  equal(result.connections.find(value=>value.name==='inventory-revoked')?.status,"revoked","Retired credentials remain visible with their reconnect reason");
  equal(result.connections.find(value=>value.name==='inventory-removed-member')?.status,"membership_removed","Stale member-issued credentials cannot appear authorized");
  equal(result.connections.some(value=>value.name.startsWith('operator-candidate-smoke-')),false,"Temporary operator smoke credentials are omitted");
  // Self-described identity: stored per workspace and actor, shown only to that workspace, refused when locked.
  const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  const crc=(b:Buffer)=>{let c=0xffffffff;for(const x of b)c=crcTable[(c^x)&255]^(c>>>8);return(c^0xffffffff)>>>0;};
  const chunk=(k:string,c:Buffer)=>{const body=Buffer.concat([Buffer.from(k,"ascii"),c]),out=Buffer.alloc(body.length+8);out.writeUInt32BE(c.length,0);body.copy(out,4);out.writeUInt32BE(crc(body),out.length-4);return out;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(64,0);ihdr.writeUInt32BE(64,4);ihdr[8]=8;ihdr[9]=6;
  const logo="data:image/png;base64,"+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(Buffer.concat(Array.from({length:64},()=>Buffer.concat([Buffer.from([0]),Buffer.alloc(256,200)]))))),chunk("IEND",Buffer.alloc(0))]).toString("base64");
  const saved=await setAgentIdentity(agent,{name:"Fleet VM",logo},db);
  equal(saved.shown,{name:"Fleet VM",logo:true,source:"agent"},"A connected agent can describe itself with a name and logo");
  const described=(await listConnections(owner,db,now)).identities.find(value=>value.agent==='inventory-api');
  equal([described?.name,described?.source,described?.logo?.startsWith("data:image/png;base64,")],["Fleet VM","agent",true],"The workspace inventory returns the self-described identity");
  equal((await listAgentIdentities(normalizeToken({name:"other-owner",orgId:3,role:"owner",kind:"session",email:"o@example.test"}),db)).length,0,"Another workspace never sees the identity, even with the same agent name");
  await db`UPDATE agent_identities SET locked=true WHERE org_id=2 AND actor_name='inventory-api'`;
  let refused="";try{await setAgentIdentity(agent,{name:"Renamed"},db);}catch(error){refused=(error as Error).message;}
  equal(refused.includes("locked"),true,"A locked identity refuses agent changes");
  equal((await listAgentIdentities(owner,db))[0]?.name,"Fleet VM","A refused change leaves the stored identity unchanged");
  await db`DELETE FROM agent_identities WHERE org_id=2`;
  const oauth=result.connections.filter(value=>value.kind==='oauth');
  equal(oauth.length,5,"OAuth clients are bound to workspace grants and duplicate refresh credentials become one connection");
  const codex=oauth.find(value=>value.agent===oauthAgent)!;
  equal([codex.displayName,codex.harness,codex.status,codex.canWrite],["Codex","codex","authorized",false],"A live grant remains authorized when a later duplicate was revoked, with its actual scopes");
  equal([codex.lastAuthenticatedAt,codex.memoryCalls,codex.taskReports,codex.lastMemoryAt],[null,0,0,null],"OAuth grants do not invent authentication timestamps or cross-tenant memory activity");
  equal(codex.lastContactAt!==null,true,"A directly observed whoami counts as contact without implying a memory operation");
  equal(oauth.find(value=>value.harness==='cursor')?.status,"expired","Expired refresh grants are identified");
  equal(oauth.find(value=>value.harness==='hermes')?.status,"revoked","Revoked OAuth grants are identified");
  equal(oauth.find(value=>value.harness==='openclaw')?.status,"membership_removed","Rejoined or removed memberships cannot reactivate a historical grant");
  equal(oauth.find(value=>value.sourceLabel==='Unknown custom client')?.harness,null,"Unknown metadata labels do not imply a known harness");
  equal(oauth.find(value=>value.sourceLabel==='Unknown custom client')?.status,"expired","Legacy unbound authorizations require reconnection");
  const foreign=await listConnections(normalizeToken({...owner,orgId:3}),db,now);
  equal(foreign.connections.find(value=>value.name==='inventory-api')?.memoryCalls,2,"Same-named credentials in another tenant retain separate counters");
  equal(foreign.connections.find(value=>value.agent===oauthAgent)?.memoryCalls,1,"The same OAuth identity string in another tenant has independent contact");
  const body=JSON.stringify(result);
  equal(["inventory-secret-hash","private-callback","secret-redirect","Foreign global private label","foreign private content"].some(value=>body.includes(value)),false,"No hashes, callbacks, unrelated global client labels or private call contents are returned");

  // Dedicated workspaces make progress assertions independent of all earlier
  // integration fixtures. These are real stored receipts, not SQL mocks.
  const progressOrgs=[40,41,42];
  for(const id of progressOrgs)await db`INSERT INTO orgs(id,name,slug,kind,brain_db,data_db,home_dir,policies,provisioning_status)
    VALUES(${id},'Onboarding fixture',${`onboarding-${id}`},'team',${`brain_org_${id}`},${`brain_org_${id}`},${`org-${id}`},${db.json(DEFAULT_POLICIES)},'ready')`;
  const empty={agentConnected:false,memorySaved:false,memoryRecalled:false,taskReported:false};
  const proof=(id:number)=>agentOnboardingChecks(id,db);
  const receipt=async(id:number,name:string,tool:string,outcome='ok',kind:'token'|'oauth'|'session'='token')=>{
    await db`INSERT INTO audit_log(org_id,token_name,tool,arg_summary,outcome) VALUES(${id},${name},${tool},'test fixture',${outcome})`;
    if(outcome==='ok'&&['remember','put_page','recall','search','get_page'].includes(tool)) {
      await recordMcpUsage(normalizeToken({name,orgId:id,kind}),tool,{content:[{type:'text',text:'{"ok":true}'}]},{db});
    }
  };
  const freshRaw=await issueToken(40,'onboarding-agent',true,null,db);
  await issueToken(41,'onboarding-agent',true,null,db);
  equal(await proof(40),empty,"Issuing an unused agent key does not activate onboarding");
  for(const [tool,outcome] of [['whoami','error'],['remember','denied'],['recall','error']])await receipt(40,'onboarding-agent',tool,outcome);
  equal(await proof(40),empty,"Failed or denied receipts never count as contact, save or recall");
  for(const tool of ['whoami','remember','recall'])await receipt(41,'onboarding-agent',tool);
  equal(await proof(40),empty,"Identically named agents in another workspace cannot complete onboarding");
  equal(onboardingStep({checks:await proof(41)}),'done',"A team's proved core flow completes without inviting anyone");
  await receipt(40,'onboarding-agent','whoami');
  equal(await proof(40),{...empty,agentConnected:true},"Successful identity contact advances an unused key to remember");
  await receipt(40,'onboarding-agent','remember');
  equal(onboardingStep({checks:await proof(40)}),'recall',"A successful agent save asks for an actual memory read");
  await receipt(40,'onboarding-agent','get_page');
  equal(await proof(40),{...empty,agentConnected:true,memorySaved:true,memoryRecalled:true},"A successful memory read proves core activation without a task report");
  const freshAgent=(await authenticateStoredSecret(freshRaw,db))!;
  await recordAction(freshAgent,{tool:'code.test',summary:'Optional report fixture',status:'failed'});
  equal((await proof(40)).taskReported,true,"Persisted reports of failed work still prove successful task reporting");
  await db`UPDATE tokens SET revoked_at=now() WHERE org_id=40 AND name='onboarding-agent'`;
  equal(await proof(40),empty,"Revoked agents cannot continue to claim a usable onboarding connection");

  const oauthEmail='onboarding-oauth@example.test',clientId='onboarding-oauth-only-client';
  const [oauthMember]=await db`INSERT INTO org_members(org_id,email,role) VALUES(42,${oauthEmail},'member') RETURNING id`;
  await db`INSERT INTO oauth_clients(client_id,redirect_uris,client_name) VALUES(${clientId},${db.json(['https://example.test/callback'])},'Codex')`;
  await db`INSERT INTO oauth_refresh_tokens(sha256_hash,client_id,email,org_id,membership_id,scope,expires_at)
    VALUES('onboarding-oauth-fixture-hash',${clientId},${oauthEmail},42,${oauthMember.id},'memory:read memory:write',now()+interval '1day')`;
  const oauthName=oauthActorName({sub:oauthEmail,client_id:clientId});
  equal(await proof(42),empty,"Unused OAuth authorization alone does not count as a connected agent");
  for(const tool of ['whoami','put_page','recall'])await receipt(42,oauthName,tool,'ok','oauth');
  equal(await proof(42),{...empty,agentConnected:true,memorySaved:true,memoryRecalled:true},"An OAuth-only current member can prove all core steps without an API key");
  await db`DELETE FROM org_members WHERE id=${oauthMember.id}`;
  equal(await proof(42),empty,"Removing an OAuth member removes that agent from current progress proof");
  const [rejoined]=await db`INSERT INTO org_members(org_id,email,role) VALUES(42,${oauthEmail},'member') RETURNING id`;
  equal(await proof(42),empty,"Rejoining with the same email does not revive the old OAuth grant");
  await db`UPDATE oauth_refresh_tokens SET membership_id=${rejoined.id} WHERE client_id=${clientId} AND org_id=42`;
  equal(await proof(42),empty,"A new current membership cannot inherit pre-membership receipts");
  await db`UPDATE oauth_refresh_tokens SET revoked_at=now() WHERE client_id=${clientId} AND org_id=42`;
  await issueToken(42,'same-as-browser',true,null,db);
  await db`INSERT INTO sessions(org_id,name,role,email,sha256_hash,expires_at) VALUES(42,'same-as-browser','member',${oauthEmail},'onboarding-session-fixture-hash',now()+interval '1hour')`;
  for(const tool of ['whoami','remember','recall'])await receipt(42,'same-as-browser',tool,'ok','session');
  equal(await proof(42),empty,"Ambiguous browser-session actor names never count manual console work as agent success");
  return checks;
}
