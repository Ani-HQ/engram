import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { sha256 } from "../gateway/src/hash";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import type { Org } from "../gateway/src/orgs";
import { authenticateContextShareToken, listApprovedTeamItems } from "../gateway/src/context-sharing-access";
import { commitContextShare, getContextSharing, handleContextSharingApi, parseContextCommit, parseContextPreview, previewContextShare, revokeContextShare, rotateContextShareToken, type ContextSource } from "../gateway/src/context-sharing";
import type { ReflexClient } from "../gateway/src/reflex/types";
import { currentContext, runWithContext } from "../gateway/src/context";
import { requireHostedWriteAccess } from "../gateway/src/billing";

const now = new Date("2026-10-25T12:00:00Z");
const actor = normalizeToken({name:"private-owner@example.test",email:"private-owner@example.test",kind:"session",role:"owner",orgId:7});
const org = {id:7,name:"Personal",kind:"personal",slug:"personal",brainDb:"brain_org_7",dataDb:"brain_org_7",homeDir:"org-7",policies:{...DEFAULT_POLICIES}} as Org;
const readerEmail = "team-reader@example.test";
const teamOrg = {...org,id:8,name:"Startup team",kind:"team",slug:"startup-team",brainDb:"brain_org_8",dataDb:"brain_org_8",homeDir:"org-8"} as Org;
const teamReader = normalizeToken({name:readerEmail,email:readerEmail,kind:"session",role:"member",orgId:8});
function store() {
  const calls: {query:string;values:any[]}[] = [], previews = new Map<string,any>(), shares = new Map<string,any>(), items:any[]=[];
  const state = {memberId:71,owner:true,targetMemberId:81,targetMember:true,accept:true,consent:false,kind:"personal",entitled:true,modelCalls:0,readerMember:true,readerRole:"member",teamKind:"team"};
  let sources:ContextSource[] = [{kind:"entry",id:"private-source-id",text:"Our startup launch uses a staged rollout.\n\nPrivate health appointment details should stay personal.",version:"original-version"}];
  const execute = (query:string,v:any[]):any[] => {
    calls.push({query,values:v});
    if (query.includes("FROM org_members m JOIN orgs o")) {
      if (state.owner && v[0]===7 && v[1]===actor.email) return [{id:state.memberId,role:"owner",kind:state.kind,policies:{...DEFAULT_POLICIES,jevProcessing:state.consent}}];
      return query.includes("m.role IN") && state.readerMember && v[0]===8 && v[1]===readerEmail ? [{id:91,role:state.readerRole,kind:state.teamKind,policies:{...DEFAULT_POLICIES,acceptShares:state.accept}}] : [];
    }
    if (query.includes("SELECT o.id, o.name, o.policies")) return state.targetMember && v[0]===8 && state.accept ? [{id:8,name:"Startup team",policies:{...DEFAULT_POLICIES,acceptShares:state.accept},member_id:state.targetMemberId,member_role:"member"}] : [];
    if (query.includes("SELECT * FROM orgs WHERE id")) return v[0]===8 ? [{id:8,name:"Startup team",slug:"startup-team",kind:"team",brain_db:"brain_org_8",data_db:"brain_org_8",home_dir:"org-8",policies:DEFAULT_POLICIES,provisioning_status:"ready",created_at:now.toISOString()}] : [];
    if (query.includes("SELECT o.id, o.name FROM orgs")) return state.targetMember && state.accept ? [{id:8,name:"Startup team"}] : [];
    if (query.includes("DELETE FROM context_share_previews")) {for (const [id,row] of previews) if(new Date(row.expires_at)<now)previews.delete(id); return [];}
    if (query.includes("count(*)::integer AS n FROM context_share_previews")) return [{n:previews.size}];
    if (query.includes("INSERT INTO context_share_previews")) {
      previews.set(v[0],{id:v[0],source_org:v[1],owner_member_id:v[2],recipient_kind:v[3],target_org:v[4],target_member_id:v[5],agent_name:v[6],instruction:v[7],candidates:structuredClone(v[8]),source_hash:v[9],method:v[10],expires_at:v[11],created_at:now.toISOString(),consumed_at:null});return [];
    }
    if (query.includes("SELECT * FROM context_share_previews")) {const p=previews.get(v[0]);return p&&p.source_org===v[1]&&p.owner_member_id===v[2]?[p]:[];}
    if (query.includes("INSERT INTO context_shares")) {const row={id:v[0],source_org:v[1],owner_member_id:v[2],recipient_kind:v[3],target_org:v[4],target_member_id:v[5],agent_name:v[6],instruction:v[7],token_hash:v[8],created_at:now.toISOString(),revoked_at:null};shares.set(row.id,row);return [row];}
    if (query.includes("INSERT INTO context_share_items")) {items.push({id:v[0],share_id:v[1],ordinal:v[2],title:v[3],text:v[4],source_kind:v[5],source_id:v[6],source_hash:v[7]});return [];}
    if (query.includes("UPDATE context_share_previews")) {Object.assign(previews.get(v[1]),{consumed_at:now.toISOString(),candidates:[],source_hash:v[0]});return [];}
    if (query.includes("UPDATE context_shares SET token_hash")) {const row=shares.get(v[1]);if (!row||row.source_org!==v[2]||row.owner_member_id!==v[3]||row.revoked_at||row.recipient_kind!=="agent")return [];row.token_hash=v[0];return [{id:row.id}];}
    if (query.includes("UPDATE context_shares SET revoked_at")) {const row=shares.get(v[0]);if (!row||row.source_org!==v[1]||row.owner_member_id!==v[2])return [];row.revoked_at??=now.toISOString();return [{id:row.id}];}
    if (query.includes("SELECT s.*, o.name AS target_name")) return [...shares.values()].filter(s=>s.source_org===v[0]&&s.owner_member_id===v[1]).map(s=>({...s,target_name:"Startup team",items:items.filter(i=>i.share_id===s.id).map(({id,title,text})=>({id,title,text}))}));
    if (query.includes("FROM context_share_items i")) {
      if (v[1] !== null && (v[1] !== readerEmail || !state.readerMember)) return [];
      const rows=[...shares.values()].filter(s=>s.recipient_kind==="team"&&s.target_org===v[0]&&!s.revoked_at&&state.owner&&s.owner_member_id===state.memberId&&state.targetMember&&s.target_member_id===state.targetMemberId&&state.accept)
        .sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id)).flatMap(s=>items.filter(i=>i.share_id===s.id).sort((a,b)=>a.ordinal-b.ordinal||a.id.localeCompare(b.id)));
      return rows.slice(v[4],v[3]===null?undefined:v[4]+v[3]);
    }
    if (query.includes("FROM context_shares s")) return [...shares.values()].filter(s=>s.recipient_kind==="agent"&&s.token_hash===v[0]&&!s.revoked_at&&state.owner&&s.owner_member_id===state.memberId).flatMap(s=>items.filter(i=>i.share_id===s.id));
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const db = ((strings:TemplateStringsArray,...values:any[])=>Promise.resolve(execute(strings.join("?"),values))) as unknown as postgres.Sql;
  db.json=((value:any)=>structuredClone(value)) as any;
  let queue=Promise.resolve();
  db.begin=((fn:any)=>{
    const operation=queue.then(async()=>{
      const before={previews:structuredClone(previews),shares:structuredClone(shares),items:structuredClone(items)};
      try{return await fn(db);}catch(error){previews.clear();for(const [k,v]of before.previews)previews.set(k,v);shares.clear();for(const [k,v]of before.shares)shares.set(k,v);items.splice(0,items.length,...before.items);throw error;}
    });queue=operation.then(()=>{},()=>{});return operation;
  }) as any;
  const client:ReflexClient={enabled:()=>true,available:()=>true,evaluate:async()=>{state.modelCalls++;return null;}};
  const deps={db,client,now:()=>now,sources:async()=>({sources:structuredClone(sources),truncated:false}),source:async(kind:string,id:string)=>sources.find(s=>s.kind===kind&&s.id===id)??null,entitlement:async(..._args:any[])=>{if(!state.entitled)throw Object.assign(new Error("private billing"),{status:402});},withWorkspace:async<T>(target:Org,actor:ReturnType<typeof normalizeToken>,work:()=>Promise<T>)=>runWithContext({org:target,token:actor,dataSql:db},work)};
  return {db,calls,previews,shares,items,state,deps,setSources:(value:ContextSource[])=>{sources=value;}};
}
const request = (path:string,method="GET",body?:unknown,headers:Record<string,string>={})=>new Request(`https://engram.example${path}`,{method,headers:{"X-Engram-Console":"1","X-Engram-Workspace":"7",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function draft(s:ReturnType<typeof store>,recipient:any={kind:"agent",name:"Startup assistant"}) {return previewContextShare(actor,org,{instruction:"Share startup launch decisions, excluding personal health",recipient},s.deps);}
async function commit(s:ReturnType<typeof store>,preview:Awaited<ReturnType<typeof draft>>,text="Our startup launch uses a staged rollout.") {return commitContextShare(actor,org,{previewId:preview.previewId,selections:[{id:preview.candidates[0].id,text}],acknowledged:true},"https://engram.example",s.deps);}

describe("reviewed selective context sharing",()=>{
  test("strict request parsing never treats missing, malformed or unrecognized instructions as consent",()=>{
    for(const input of [null,{},[],{instruction:"only work",recipient:{kind:"team",orgId:"8"}},{instruction:"only work",recipient:{kind:"agent",name:"Agent",orgId:8}},{instruction:"only work",recipient:{kind:"agent",name:"Agent"},matchAll:true},{instruction:"x".repeat(1001),recipient:{kind:"agent",name:"Agent"}}])expect(()=>parseContextPreview(input)).toThrow();
    expect(parseContextPreview({instruction:"  only startup work  ",recipient:{kind:"team",orgId:8}})).toEqual({instruction:"only startup work",recipient:{kind:"team",orgId:8}});
    expect(()=>parseContextCommit({previewId:"not-id",selections:[],acknowledged:true})).toThrow();
  });
  test("preview is private and creates no grant; nonsemantic fallback is truthful and metadata-free",async()=>{
    const s=store(),preview=await draft(s);
    expect(preview.method).toBe("text");expect(preview.notice).toContain("not been semantically evaluated");expect(preview.candidates[0].text).toContain("startup");expect(preview.candidates).toHaveLength(1);expect(JSON.stringify(preview)).not.toContain("appointment");
    expect(JSON.stringify(preview)).not.toContain("private-source-id");expect(JSON.stringify(preview)).not.toContain(actor.email!);expect(s.shares.size).toBe(0);expect(s.items).toHaveLength(0);expect(s.state.modelCalls).toBe(0);
    expect((await getContextSharing(actor,org,s.deps)).modelAvailable).toBe(false);
    expect(await authenticateContextShareToken("egs_"+"a".repeat(32),s.db)).toBeNull();
  });
  test("semantic proposals use consented bounded closed decisions, never provider-generated text or implicit approval",async()=>{
    const s=store();s.state.consent=true;
    s.deps.client.evaluate=async input=>{s.state.modelCalls++;expect(JSON.stringify(input)).not.toContain("private-source-id");expect(Object.keys(input.questions).length).toBeLessThanOrEqual(16);return {model:"jev-test",answers:{excerpt_0:{type:"choice",choice:"include",confidence:.99},excerpt_1:{type:"choice",choice:"include",confidence:.6}}};};
    const preview=await draft(s);expect(preview.method).toBe("model");expect(preview.candidates).toHaveLength(1);expect(preview.candidates[0].text).toBe("Our startup launch uses a staged rollout.");expect(s.shares.size).toBe(0);expect(s.state.modelCalls).toBe(1);
  });
  test("provider failure keeps a narrow lexical fallback and outbound instructions redact credentials",async()=>{
    const s=store();s.state.consent=true;
    s.deps.client.evaluate=async input=>{expect(JSON.stringify(input.state)).not.toContain("egs_"+"a".repeat(32));expect(JSON.stringify(input.state)).not.toContain("sk-"+"b".repeat(32));throw new Error("private provider message");};
    const preview=await previewContextShare(actor,org,{instruction:"Share startup launch decisions excluding health. egs_"+"a".repeat(32)+" sk-"+"b".repeat(32),recipient:{kind:"agent",name:"Helper"}},s.deps);
    expect(preview.method).toBe("text");expect(preview.candidates).toHaveLength(1);expect(JSON.stringify(preview)).not.toContain("appointment");expect(s.shares.size).toBe(0);
    const empty=await previewContextShare(actor,org,{instruction:"Only unrelated gardening",recipient:{kind:"agent",name:"Helper"}}, {...s.deps,client:{enabled:()=>false,available:()=>false,evaluate:async()=>null}});
    expect(empty.candidates).toEqual([]);
  });
  test("consented semantic evaluation can propose a zero-overlap synonym while every unavailable fallback stays empty",async()=>{
    const input={instruction:"Share release resilience",recipient:{kind:"agent",name:"Release assistant"}};
    for(const mode of ["include","null","throw","no-consent"] as const){
      const s=store();s.state.consent=mode!=="no-consent";s.setSources([{kind:"entry",id:"private-synonym-source",text:"Use rollbacks and staged launches.",version:"synonym-version"}]);
      let evaluated=0;
      s.deps.client.evaluate=async value=>{evaluated++;expect((value.state as any).excerpts).toEqual([{id:"excerpt_0",text:"Use rollbacks and staged launches."}]);
        if(mode==="throw")throw new Error("provider unavailable");
        return mode==="null"?null:{model:"jev-test",answers:{excerpt_0:{type:"choice",choice:"include",confidence:.99}}};};
      const preview=await previewContextShare(actor,org,input,s.deps);
      expect(preview.method).toBe(mode==="include"?"model":"text");
      expect(preview.candidates.map(item=>item.text)).toEqual(mode==="include"?["Use rollbacks and staged launches."]:[]);
      expect(evaluated).toBe(mode==="no-consent"?0:1);expect(s.shares.size).toBe(0);expect(s.items).toHaveLength(0);
    }
  });
  test("only exact acknowledged excerpts commit; credentials are hashed and source changes never append private text",async()=>{
    const s=store(),preview=await draft(s),candidate=preview.candidates[0];
    await expect(commitContextShare(actor,org,{previewId:preview.previewId,selections:[{id:candidate.id,text:candidate.text}],acknowledged:false},"https://engram.example",s.deps)).rejects.toMatchObject({status:400});
    await expect(commit(s,preview,"Invented startup launch information")).rejects.toMatchObject({status:400});expect(s.shares.size).toBe(0);
    const result=await commit(s,preview,"startup launch uses a staged rollout.");
    expect(result.share.items[0].text).toBe("startup launch uses a staged rollout.");expect(result.credential?.mcpUrl).toBe("https://engram.example/mcp/shared");expect(result.credential?.token).toMatch(/^egs_[A-Za-z0-9_-]{32}$/);
    expect([...s.shares.values()][0].token_hash).toBe(sha256(result.credential!.token));expect(JSON.stringify([...s.shares.values()])).not.toContain(result.credential!.token);
    expect(s.previews.get(preview.previewId).candidates).toEqual([]);
    s.setSources([{kind:"entry",id:"private-source-id",text:"NEW PRIVATE HEALTH DETAILS",version:"new-version"}]);
    const access=await authenticateContextShareToken(result.credential!.token,s.db);expect(access?.items.map(i=>i.text)).toEqual(["startup launch uses a staged rollout."]);expect(JSON.stringify(access)).not.toContain("private-source-id");expect(JSON.stringify(access)).not.toContain("HEALTH");
    await expect(commit(s,preview)).rejects.toMatchObject({code:"preview_changed"});
    const listing=await getContextSharing(actor,org,s.deps);expect(JSON.stringify(listing)).not.toContain(result.credential!.token);expect(JSON.stringify(listing)).not.toContain("source_hash");
  });
  test("expired, changed, foreign and already-consumed previews cannot create grants",async()=>{
    const s=store(),preview=await draft(s);
    s.setSources([{kind:"entry",id:"private-source-id",text:"Changed source",version:"changed"}]);await expect(commit(s,preview)).rejects.toMatchObject({code:"preview_changed"});expect(s.items).toHaveLength(0);
    s.previews.get(preview.previewId).expires_at=new Date(now.getTime()-1).toISOString();await expect(commit(s,preview)).rejects.toMatchObject({code:"preview_expired"});
    s.state.memberId=72;await expect(commit(s,preview)).rejects.toMatchObject({code:"not_found"});
    const fresh=await draft(s);expect(s.previews.has(preview.previewId)).toBe(false);expect(fresh.candidates).toHaveLength(0);
  });
  test("simultaneous commits consume a preview exactly once",async()=>{
    const s=store(),preview=await draft(s);const results=await Promise.allSettled([commit(s,preview),commit(s,preview)]);expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(s.shares.size).toBe(1);expect(s.items).toHaveLength(1);
  });
  test("team snapshots require exact current memberships and acceptance at approval and on every read",async()=>{
    const s=store(),preview=await draft(s,{kind:"team",orgId:8});
    s.state.targetMemberId=82;await expect(commit(s,preview)).rejects.toMatchObject({code:"preview_changed"});s.state.targetMemberId=81;
    const result=await commit(s,preview);expect(result.credential).toBeUndefined();expect((await listApprovedTeamItems(8,s.db)).map(item=>item.text)).toEqual(["Our startup launch uses a staged rollout."]);
    expect(await listApprovedTeamItems(9,s.db)).toEqual([]);
    s.state.accept=false;expect(await listApprovedTeamItems(8,s.db)).toEqual([]);s.state.accept=true;
    s.state.targetMember=false;expect(await listApprovedTeamItems(8,s.db)).toEqual([]);s.state.targetMember=true;
    s.state.owner=false;expect(await listApprovedTeamItems(8,s.db)).toEqual([]);s.state.owner=true;
    await revokeContextShare(actor,org,result.share.id,s.deps);expect(await listApprovedTeamItems(8,s.db)).toEqual([]);
  });
  test("real billing context checks use the target member role and restore source authorization before reading source versions",async()=>{
    const s=store(),seen:{orgId:number;context:number|undefined;role:string}[]=[];
    const billing={mode:"self-hosted" as const,publicUrl:"https://engram.example",secretKey:"",webhookSecret:"",cloudMonthlyPriceId:""};
    s.deps.entitlement=async(token:ReturnType<typeof normalizeToken>,db:postgres.Sql)=>{seen.push({orgId:token.orgId,context:currentContext()?.org.id,role:token.role});await requireHostedWriteAccess(token,{db,settings:billing});};
    const original=s.deps.source;s.deps.source=async(kind,id)=>{expect(currentContext()?.org.id).toBe(7);expect(currentContext()?.token.role).toBe("owner");return original(kind,id);};
    await runWithContext({org,token:actor,dataSql:s.db},async()=>{const preview=await draft(s,{kind:"team",orgId:8});await commit(s,preview);expect(currentContext()?.org.id).toBe(7);});
    expect(seen).toEqual([{orgId:7,context:7,role:"owner"},{orgId:7,context:7,role:"owner"},{orgId:8,context:8,role:"member"}]);
    const denied=store(),preview=await draft(denied,{kind:"team",orgId:8});
    denied.deps.entitlement=async(token:ReturnType<typeof normalizeToken>,db:postgres.Sql)=>{await requireHostedWriteAccess(token,{db,settings:billing});if(token.orgId===8)throw Object.assign(new Error("Target access expired"),{status:402});};
    await runWithContext({org,token:actor,dataSql:denied.db},async()=>{await expect(commit(denied,preview)).rejects.toMatchObject({status:402});expect(currentContext()?.org.id).toBe(7);});
    expect(denied.shares.size).toBe(0);expect(denied.items).toHaveLength(0);
  });
  test("explicit rotation invalidates the old isolated credential; revocation and membership loss stop every new read",async()=>{
    const s=store(),result=await commit(s,await draft(s));
    const rotated=await rotateContextShareToken(actor,org,result.share.id,"https://engram.example",s.deps);expect(rotated.credential.token).not.toBe(result.credential!.token);
    expect(await authenticateContextShareToken(result.credential!.token,s.db)).toBeNull();expect(await authenticateContextShareToken(rotated.credential.token,s.db)).not.toBeNull();
    s.state.owner=false;expect(await authenticateContextShareToken(rotated.credential.token,s.db)).toBeNull();s.state.owner=true;
    s.state.entitled=false;await revokeContextShare(actor,org,result.share.id,s.deps);expect(await authenticateContextShareToken(rotated.credential.token,s.db)).toBeNull();
    await expect(rotateContextShareToken(actor,org,result.share.id,"https://engram.example",s.deps)).rejects.toMatchObject({status:402});
  });
  test("HTTP authority, workspace pinning, no-store and generic storage errors are retained",async()=>{
    const s=store();
    for(const denied of [normalizeToken({...actor,kind:"token"}),normalizeToken({...actor,kind:"oauth"}),normalizeToken({...actor,role:"member"}),normalizeToken({...actor,orgId:8})])expect((await handleContextSharingApi(request("/api/sharing"),denied,org,s.deps)).status).toBe(403);
    for(const [headers,status]of [[{"X-Engram-Console":"0"},403],[{"X-Engram-Workspace":""},400],[{"X-Engram-Workspace":"8"},409]] as const){const response=await handleContextSharingApi(request("/api/sharing","GET",undefined,headers),actor,org,s.deps);expect(response.status).toBe(status);expect(response.headers.get("cache-control")).toBe("no-store");}
    expect((await handleContextSharingApi(request("/api/sharing/preview","POST",{instruction:"only startup",recipient:{kind:"agent",name:"Agent"}}),actor,org,s.deps)).status).toBe(200);
    s.state.entitled=false;const denied=await handleContextSharingApi(request("/api/sharing/preview","POST",{instruction:"only startup",recipient:{kind:"agent",name:"Agent"}}),actor,org,s.deps);expect(denied.status).toBe(402);expect(await denied.text()).not.toContain("private billing");
    s.state.kind="team";expect((await getContextSharing(actor,org,s.deps)).sourceKind).toBe("team");await expect(draft(s)).rejects.toMatchObject({status:403});
  });
  test("team owner and member sessions read only received approved text without hosted write access",async()=>{
    const s=store(),approved=await commit(s,await draft(s,{kind:"team",orgId:8}));
    s.state.entitled=false;
    s.setSources([{kind:"entry",id:"private-source-id",text:"New private medical material",version:"new"}]);
    for (const role of ["owner","member"] as const) {
      s.state.readerRole=role;
      const response=await handleContextSharingApi(request("/api/sharing","GET",undefined,{"X-Engram-Workspace":"8"}),normalizeToken({...teamReader,role}),teamOrg,s.deps);
      expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body=await response.json();
      expect(body.sourceKind).toBe("team");expect(body.more).toBe(false);
      expect(body.received).toEqual(approved.share.items.map(item=>({id:item.id,shareId:approved.share.id,title:item.title,text:item.text})));
      for (const hidden of ["instruction","source_id","source_hash","private-source-id",actor.email,"medical","token_hash"]) expect(JSON.stringify(body)).not.toContain(hidden!);
    }
    expect(s.state.modelCalls).toBe(0);
  });
  test("team reads require the current human membership, database kind, context and workspace pin",async()=>{
    const s=store();
    const call=(token=teamReader,headers:Record<string,string>={})=>handleContextSharingApi(request("/api/sharing","GET",undefined,{"X-Engram-Workspace":"8",...headers}),token,teamOrg,s.deps);
    for (const denied of [normalizeToken({...teamReader,kind:"token"}),normalizeToken({...teamReader,kind:"oauth"}),normalizeToken({...teamReader,orgId:7}),normalizeToken({...teamReader,email:"not-a-member@example.test"})]) expect((await call(denied)).status).toBe(403);
    expect((await call(teamReader,{"X-Engram-Console":"0"})).status).toBe(403);
    expect((await call(teamReader,{"X-Engram-Workspace":""})).status).toBe(400);
    expect((await call(teamReader,{"X-Engram-Workspace":"7"})).status).toBe(409);
    s.state.readerMember=false;expect((await call()).status).toBe(403);s.state.readerMember=true;
    s.state.teamKind="personal";expect((await call()).status).toBe(403);s.state.teamKind="team";
    await runWithContext({org,token:actor,dataSql:s.db},async()=>expect((await call()).status).toBe(403));
    expect((await handleContextSharingApi(request("/api/sharing"),normalizeToken({...actor,role:"member"}),org,s.deps)).status).toBe(403);
  });
  test("team readers gain no preview, approval, revocation or credential replacement authority",async()=>{
    const s=store(),approved=await commit(s,await draft(s,{kind:"team",orgId:8}));
    const before={shares:s.shares.size,items:s.items.length,previews:s.previews.size};
    for (const [path,method,body] of [["/api/sharing/preview","POST",{instruction:"Share everything",recipient:{kind:"agent",name:"Reader"}}],["/api/sharing/commit","POST",{acknowledged:true}],[`/api/sharing/${approved.share.id}`,"DELETE",undefined],[`/api/sharing/${approved.share.id}/agent-token`,"POST",{}]] as const) {
      const response=await handleContextSharingApi(request(path,method,body,{"X-Engram-Workspace":"8"}),teamReader,teamOrg,s.deps);expect(response.status).toBe(403);
    }
    expect({shares:s.shares.size,items:s.items.length,previews:s.previews.size}).toEqual(before);expect([...s.shares.values()][0].revoked_at).toBeNull();
  });
  test("received catalog uses the same revocation, linked memberships and team policy checks as Memory",async()=>{
    const s=store(),approved=await commit(s,await draft(s,{kind:"team",orgId:8}));
    const read=async()=>(await getContextSharing(teamReader,teamOrg,s.deps)).received;
    expect(await read()).toHaveLength(1);
    for (const key of ["owner","targetMember","accept"] as const) {s.state[key]=false;expect(await read()).toEqual([]);s.state[key]=true;}
    s.state.targetMemberId++;expect(await read()).toEqual([]);s.state.targetMemberId--;
    await revokeContextShare(actor,org,approved.share.id,s.deps);expect(await read()).toEqual([]);
  });
  test("received catalog has bounded stable pages while existing Memory reads remain unpaginated",async()=>{
    const s=store(),approved=await commit(s,await draft(s,{kind:"team",orgId:8})),template=[...s.items][0];
    s.items.splice(0,s.items.length,...Array.from({length:55},(_,index)=>({...template,id:`approved-item-${String(index).padStart(3,"0")}`,ordinal:index,text:`Approved text ${index}`})));
    const all=await listApprovedTeamItems(8,s.db);expect(all).toHaveLength(55);
    const first=await getContextSharing(teamReader,teamOrg,s.deps),second=await getContextSharing(teamReader,teamOrg,s.deps,new URLSearchParams({offset:"25"})),last=await getContextSharing(teamReader,teamOrg,s.deps,new URLSearchParams({offset:"50"}));
    expect(first.received).toEqual(all.slice(0,25));expect(first.more).toBe(true);expect(second.received).toEqual(all.slice(25,50));expect(second.more).toBe(true);expect(last.received).toEqual(all.slice(50));expect(last.more).toBe(false);
    const maximum=await getContextSharing(teamReader,teamOrg,s.deps,new URLSearchParams({limit:"50"}));expect(maximum.received).toHaveLength(50);expect(maximum.more).toBe(true);
    const query=s.calls.find(call=>call.query.includes("FROM context_share_items i")&&call.values[1]===readerEmail)!;
    expect(query.values.slice(3)).toEqual([26,0]);expect(query.query).toContain("s.id DESC, i.ordinal, i.id");expect(query.query).toContain("reader.email");
    for (const search of ["limit=0","limit=51","limit=-1","limit=1.5","limit=1e2","limit=NaN","limit=","limit=2&limit=3","offset=-1","offset=1.5","offset=1000001","offset=9007199254740992","offset=1&offset=2"]) {
      const response=await handleContextSharingApi(request(`/api/sharing?${search}`,"GET",undefined,{"X-Engram-Workspace":"8"}),teamReader,teamOrg,s.deps);expect(response.status).toBe(400);
    }
    expect((await getContextSharing(teamReader,teamOrg,s.deps,new URLSearchParams({offset:"1000000"}))).received).toEqual([]);
    expect(approved.share.id).toBeTruthy();
  });
});
