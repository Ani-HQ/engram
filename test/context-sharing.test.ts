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
function store() {
  const calls: {query:string;values:any[]}[] = [], previews = new Map<string,any>(), shares = new Map<string,any>(), items:any[]=[];
  const state = {memberId:71,owner:true,targetMemberId:81,targetMember:true,accept:true,consent:false,kind:"personal",entitled:true,modelCalls:0};
  let sources:ContextSource[] = [{kind:"entry",id:"private-source-id",text:"Our startup launch uses a staged rollout.\n\nPrivate health appointment details should stay personal.",version:"original-version"}];
  const execute = (query:string,v:any[]):any[] => {
    calls.push({query,values:v});
    if (query.includes("FROM org_members m JOIN orgs o")) return state.owner && v[0]===7 && v[1]===actor.email ? [{id:state.memberId,kind:state.kind,policies:{...DEFAULT_POLICIES,jevProcessing:state.consent}}] : [];
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
    if (query.includes("FROM context_share_items i")) return [...shares.values()].filter(s=>s.recipient_kind==="team"&&s.target_org===v[0]&&!s.revoked_at&&state.owner&&s.owner_member_id===state.memberId&&state.targetMember&&s.target_member_id===state.targetMemberId&&state.accept).flatMap(s=>items.filter(i=>i.share_id===s.id));
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
});
