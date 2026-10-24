import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { COMMON_HARNESSES, parseReportedSource } from "../gateway/src/agent-source";
import { authenticateStoredSecret, issueToken, setTokenSource } from "../gateway/src/auth";
import { handleOrgApi } from "../gateway/src/org-api";
import { normalizeToken, DEFAULT_POLICIES } from "../gateway/src/policies";

function database() {
  const calls: {query:string;values:any[]}[] = [];
  const db = ((strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?"); calls.push({ query, values });
    return Promise.resolve(query.includes("FROM tokens") ? [{name:"release-agent",org_id:7,role:"agent",can_write:false,harness:"grok-bot",source_label:"Release reviewer"}]
      : query.includes("UPDATE tokens SET harness") ? [{name:values[3],harness:values[0],source_label:values[1]}] : []);
  }) as unknown as postgres.Sql;
  db.begin = (async (work: (tx:postgres.Sql)=>unknown)=>work(db)) as any;
  db.json = ((value:unknown)=>value) as any;
  return {db,calls};
}

describe("connection source registration",()=>{
  test("accepts explicit product IDs without treating an arbitrary label as a model or URL",()=>{
    for(const harness of COMMON_HARNESSES) expect(parseReportedSource(harness,null).harness).toBe(harness);
    expect(parseReportedSource(" future-agent ","Laptop")).toEqual({harness:"future-agent",sourceLabel:"Laptop"});
    for(const value of ["https://example.com/icon", "with spaces", [], "x".repeat(81)]) expect(()=>parseReportedSource(value,null)).toThrow();
  });
  test("persists source separately from credential identity, permissions and live membership",async()=>{
    const {db,calls}=database();
    await issueToken(7,"release-agent",false,null,db,{harness:"grok-bot",label:"Release reviewer"});
    expect(calls[0].query).toContain("issued_by_member_id, harness, source_label");
    expect(calls[0].values.slice(-2)).toEqual(["grok-bot","Release reviewer"]);
    const actor=await authenticateStoredSecret("eng_test_only",db);
    expect(actor).toMatchObject({name:"release-agent",orgId:7,canWrite:false,source:{harness:"grok-bot",label:"Release reviewer",kind:"registered"}});
    expect(calls.find(value=>value.query.includes("FROM tokens"))!.query).toContain("m.id = t.issued_by_member_id");
  });
  test("source updates bind the org and active connection without modifying auth or permissions",async()=>{
    const {db,calls}=database();
    expect(await setTokenSource(7," release-agent ",{harness:"codex",sourceLabel:"Laptop"},db)).toEqual({name:"release-agent",harness:"codex",sourceLabel:"Laptop"});
    expect(calls[0].values).toEqual(["codex","Laptop",7,"release-agent"]);
    expect(calls[0].query).toContain("revoked_at IS NULL");
    expect(calls[0].query).not.toMatch(/SET (?:name|role|can_write|sha256_hash)/);
    const count=calls.length;
    await expect(setTokenSource(7,"release-agent",{sourceLabel:"Missing product"},db)).rejects.toThrow();
    expect(calls).toHaveLength(count);
  });
  test("only owner console sessions can edit a connection source",async()=>{
    const org={id:7,name:"Team",slug:"team",kind:"team" as const,brainDb:"brain_org_7",dataDb:"brain_org_7",homeDir:"org-7",policies:DEFAULT_POLICIES};
    const req=()=>new Request("https://engram.example/api/tokens/source",{method:"POST",body:JSON.stringify({name:"release-agent",harness:"codex"})});
    for(const actor of [normalizeToken({name:"member",orgId:7,role:"member",kind:"session",email:"member@example.test"}),normalizeToken({name:"agent",orgId:7}),normalizeToken({name:"oauth",orgId:7,role:"owner",kind:"oauth"})]){
      expect((await handleOrgApi(req(),new URL(req().url),actor,org))?.status).toBe(403);
    }
    const owner=normalizeToken({name:"owner",orgId:7,role:"owner",kind:"session",email:"owner@example.test"});
    const bad=new Request(req().url,{method:"POST",body:JSON.stringify({name:"release-agent",harness:"https://example.com"})});
    expect((await handleOrgApi(bad,new URL(bad.url),owner,org))?.status).toBe(400);
  });
});
