import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { agentOnboardingChecks, CONNECTION_LIMIT, handleConnectionsApi, listConnections, updateConnection } from "../gateway/src/connections";
import { normalizeToken, DEFAULT_POLICIES } from "../gateway/src/policies";
import { runWithContext } from "../gateway/src/context";
import { oauthActorName } from "../gateway/src/oauth";

const now = new Date("2026-10-24T12:00:00Z");
const owner = normalizeToken({ name:"owner",orgId:7,role:"owner",kind:"session",email:"owner@example.test" });
function database(extra = 0) {
  const calls:{query:string;values:any[]}[]=[];
  const email="a+b'é@example.test",client="https://chatgpt.com/client?a=b&v=(x)!";
  const oauthAgent=oauthActorName({sub:email,client_id:client});
  const rows=[
    {id:"1",kind:"token",name:"mac-codex",harness:"codex",source_label:"Laptop",status:"revoked",can_write:true,created_at:now,last_authenticated_at:"2026-10-23T10:00:00Z"},
    {id:"2",kind:"oauth",email,client_id:client,client_name:"Codex",scope:"memory:read",status:"authorized",created_at:now},
    ...Array.from({length:extra},(_,i)=>({id:String(3+i),kind:"token",name:`fixture-${i}`,status:"authorized",can_write:false,created_at:now})),
  ];
  const db=((parts:TemplateStringsArray,...values:any[])=>{
    const query=parts.join("?");calls.push({query,values});
    return Promise.resolve(query.includes("WITH token_connections")?rows:query.includes("FROM audit_log")?[
      {agent:"mac-codex",contact_at:"2026-10-24T11:00:00Z",last_memory_at:"2026-10-23T10:10:00Z",memory_calls:"3",successful_contact_at:"2026-10-23T10:05:00Z",last_successful_memory_at:"2026-10-23T10:05:00Z",successful_memory_calls:"1"},
      {agent:oauthAgent,contact_at:"2026-10-24T11:59:00Z",successful_contact_at:"2026-10-24T11:59:00Z",last_memory_at:null,memory_calls:0},
    ]:query.includes("FROM action_events")?[{agent:"mac-codex",last_task_report_at:"2026-10-24T11:30:00Z",task_reports:"2"}]:[]);
  }) as unknown as postgres.Sql;
  db.begin=(async(mode:string,work:(tx:postgres.Sql)=>unknown)=>{expect(mode).toBe("isolation level repeatable read read only");return work(db);}) as any;
  return {db,calls,rows,oauthAgent};
}

describe("workspace connection inventory",()=>{
  test("returns credential status and actual contact without treating authorization as running",async()=>{
    const store=database(), result=await listConnections(owner,store.db,now);
    expect(result).toMatchObject({more:false,limit:200,checkedAt:now.toISOString(),recentWindowSeconds:900});
    expect(result.connections[0]).toMatchObject({kind:"token",name:"mac-codex",displayName:"Laptop",agent:"mac-codex",harness:"codex",status:"revoked",lastAuthenticatedAt:"2026-10-23T10:00:00.000Z",lastContactAt:"2026-10-24T11:30:00.000Z",lastMemoryAt:"2026-10-23T10:10:00.000Z",lastTaskReportAt:"2026-10-24T11:30:00.000Z",memoryCalls:3,taskReports:2});
    expect(result.connections[1]).toMatchObject({kind:"oauth",displayName:"Codex",agent:store.oauthAgent,harness:"codex",status:"authorized",canWrite:false,lastAuthenticatedAt:null,lastContactAt:"2026-10-24T11:59:00.000Z",lastMemoryAt:null,memoryCalls:0,taskReports:0});
    expect(result.connections[0].client).toEqual({state:"unknown",label:null,harness:null});
    expect(result.connections[1].client).toEqual({state:"identified",label:"Codex",harness:"codex"});
    expect(result.connections[1].id).toMatch(/^oauth:[a-f0-9]{64}$/);
    expect(result.connections[0]).toMatchObject({ successfulMemoryCalls:1,lastSuccessfulMemoryAt:"2026-10-23T10:05:00.000Z",lastSuccessfulContactAt:"2026-10-24T11:30:00.000Z" });
    expect(result.connections[1]).toMatchObject({ successfulMemoryCalls:0,lastSuccessfulMemoryAt:null,lastSuccessfulContactAt:"2026-10-24T11:59:00.000Z" });
    expect(JSON.stringify(result)).not.toContain('"running"');
    expect(store.calls).toHaveLength(5);
    for (const index of [1,2,3,4]) expect(store.calls[index].values).toEqual([7,["mac-codex",store.oauthAgent]]);
    expect(store.calls[4].query).toContain("FROM agent_identities WHERE org_id =");
    expect(result.identities).toEqual([]);
    expect(result.connections[0].memoryUse).toMatchObject({available:false,responseBytes:null,estimatedTokens:null});
  });
  test("SQL scopes every grant and contact source and excludes temporary smoke credentials and private auth material",async()=>{
    const store=database();await listConnections(owner,store.db,now);
    const inventory=store.calls[0];
    expect(inventory.values).toEqual([7,now.toISOString(),7,CONNECTION_LIMIT+1]);
    expect(inventory.query).toContain("WHERE t.org_id =");
    expect(inventory.query).toContain("WHERE r.org_id =");
    expect(inventory.query).toContain("m.org_id = t.org_id AND m.email = t.issued_by_email");
    expect(inventory.query).toContain("m.org_id = r.org_id AND m.email = r.email");
    expect(inventory.query).toContain("m.id <> r.membership_id");
    expect(inventory.query).toContain("operator-candidate-smoke-");
    expect(inventory.query).toContain("PARTITION BY email, client_id");
    expect(inventory.query).toContain("status = 'authorized'");
    for(const call of store.calls){
      expect(call.query).not.toMatch(/sha256_hash|code_challenge|\bredirect_uri\b|c\.redirect_uris\s*(?:,|AS\b)/);
      expect(call.query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
    }
    expect(store.calls[1].query).toContain("tool NOT IN ('whoami', 'list_actions', 'record_action')");
  });
  test("bounds inventory and keeps unknown metadata generic without substring or prototype brand matches",async()=>{
    const store=database(205);
    store.rows[1].client_name="Codex-compatible unknown client";
    store.rows[0].harness="constructor";store.rows[0].source_label=null;
    const result=await listConnections(owner,store.db,now);
    expect(result.connections).toHaveLength(200);expect(result.more).toBe(true);
    expect(result.connections[1]).toMatchObject({displayName:"OAuth connection",harness:null});
    expect(result.connections[0].displayName).toBe("mac-codex");
    expect(store.calls[1].values[1]).toHaveLength(200);
  });
  test("client detection stays separate from manual credential source and stable identity",async()=>{
    const store=database();
    store.rows[0].client_names=["Cursor", "Codex"];
    store.rows[1].client_name="connector";
    const result=await listConnections(owner,store.db,now);
    expect(result.connections[0]).toMatchObject({id:"token:1",agent:"mac-codex",displayName:"Laptop",harness:"codex",sourceLabel:"Laptop",client:{state:"multiple",label:"Multiple clients",harness:null}});
    expect(result.connections[1].client).toEqual({state:"unknown",label:null,harness:null});
  });
  test("a hosted sign-in is named by the provider it finished on, not a mismatched self-reported name",async()=>{
    const cases:[string,string|null,string,string][]=[
      ["Cursor","grok","Grok","grok"],
      ["GrokBot","grok","GrokBot","grok-bot"],
      ["Codex","claude","Claude","claude"],
      ["Claude","claude","Claude","claude"],
      ["Cursor",null,"Cursor","cursor"],
    ];
    for(const [clientName,host,label,harness] of cases){
      const store=database();
      Object.assign(store.rows[1],{client_name:clientName,client_host:host});
      const connection=(await listConnections(owner,store.db,now)).connections[1];
      expect(connection).toMatchObject({displayName:label,harness,sourceLabel:label,name:label});
      expect(connection.client.label?.replace(/ /g,"")).toBe(label);
    }
  });
  test("denies non-human delegated and mismatched workspace access before querying",async()=>{
    const store=database();
    for(const actor of [normalizeToken({name:"agent",orgId:7}),normalizeToken({...owner,kind:"oauth"})]){
      await expect(listConnections(actor,store.db,now)).rejects.toMatchObject({status:403});
    }
    const foreign=normalizeToken({...owner,orgId:8});
    await runWithContext({org:{id:8,name:"Other",slug:"other",kind:"team",brainDb:"brain_org_8",dataDb:"brain_org_8",homeDir:"org-8",policies:DEFAULT_POLICIES},token:foreign,dataSql:store.db},async()=>{
      await expect(listConnections(owner,store.db,now)).rejects.toMatchObject({status:403});
    });
    expect(store.calls).toHaveLength(0);
  });
  test("read-only methods and private outage handling never expose storage errors",async()=>{
    const store=database();
    const method=await handleConnectionsApi(new Request("https://example.test/api/connections",{method:"PATCH"}),owner,store.db);
    expect(method.status).toBe(405);expect(method.headers.get("allow")).toBe("GET, POST");expect(store.calls).toHaveLength(0);
    store.db.begin=(async()=>{throw new Error("private credential details");}) as any;
    const failure=await handleConnectionsApi(new Request("https://example.test/api/connections"),owner,store.db);
    expect(failure.status).toBe(503);expect(failure.headers.get("cache-control")).toBe("no-store");expect(await failure.text()).not.toContain("private credential");
  });
  test("onboarding proof rejects invalid scopes and propagates storage outages",async()=>{
    const store=database();
    await expect(agentOnboardingChecks(0,store.db,now)).rejects.toMatchObject({status:403});
    expect(store.calls).toHaveLength(0);
    store.db.begin=(async()=>{throw new Error("proof storage unavailable");}) as any;
    await expect(agentOnboardingChecks(7,store.db,now)).rejects.toThrow("proof storage unavailable");
  });
  test("lifecycle rejects delegated credentials, non-owner roles and malformed identities before database access",async()=>{
    const store=database();
    for(const actor of [normalizeToken({...owner,role:"member"}),normalizeToken({...owner,kind:"token"}),normalizeToken({...owner,kind:"oauth"}),normalizeToken({...owner,email:null}),normalizeToken({name:"agent",orgId:7})]) {
      await expect(updateConnection(actor,{id:"token:1",action:"archive"},store.db)).rejects.toMatchObject({status:403});
    }
    for(const input of [null,[],{}, {id:"token:0",action:"archive"},{id:"token:2147483648",action:"archive"},{id:"token:1",action:["archive"]},{id:"oauth:bad",action:"delete"},{id:"token:1",action:"disconnect"}]) {
      await expect(updateConnection(owner,input,store.db)).rejects.toMatchObject({status:400});
    }
    expect(store.calls).toHaveLength(0);
  });
  test("lifecycle HTTP boundary requires console and exact workspace pin, rejects cross-origin and oversized requests",async()=>{
    const store=database(),body=JSON.stringify({id:"token:1",action:"archive"});
    const request=(headers:Record<string,string>,value=body)=>new Request("https://example.test/api/connections",{method:"POST",headers,body:value});
    for(const [headers,status] of [[{},403],[{"X-Engram-Console":"1"},409],[{"X-Engram-Console":"1","X-Engram-Workspace":"8"},409],[{"X-Engram-Console":"1","X-Engram-Workspace":"7","Origin":"https://foreign.test"},403]] as const){
      expect((await handleConnectionsApi(request(headers),owner,store.db)).status).toBe(status);
    }
    const headers={"X-Engram-Console":"1","X-Engram-Workspace":"7"};
    expect((await handleConnectionsApi(request(headers,"not json"),owner,store.db)).status).toBe(400);
    expect((await handleConnectionsApi(request(headers,"x".repeat(2049)),owner,store.db)).status).toBe(413);
    expect(store.calls).toHaveLength(0);
    store.db.begin=(async()=>{throw new Error("private database details");}) as any;
    const failure=await handleConnectionsApi(request(headers),owner,store.db);
    expect(failure.status).toBe(503);expect(await failure.text()).not.toContain("private database details");
  });
});
