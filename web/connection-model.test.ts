import { describe, expect, test } from "bun:test";
import { activityKind, connectionState, connectionSummary, currentConnections, withConnectionIdentity } from "./connection-model.js";
import { agentVisual } from "./tooling.js";

const now=Date.parse("2026-10-24T10:00:00Z");
describe("connection evidence and activity defaults",()=>{
 test("unknown OAuth clients cannot acquire a known mark through client-name inference",()=>{
  for (const name of ["oauth:private:Claude%20custom%20connector", "oauth:private:https%3A%2F%2Fclaude.ai.example.test"]) {
   const result=withConnectionIdentity({agents:[{name}]},[{agent:name,kind:"oauth",harness:null,sourceLabel:"Claude custom connector",displayName:"OAuth connection"}]);
   expect(result.agents[0].harness).toBe("other");
   expect(agentVisual(name,result.agents[0]).brand).toBeNull();
  }
 });
 test("opens the complete stream while preserving explicit task and memory links",()=>{
  for(const value of [null,undefined,"","all","unknown"])expect(activityKind(value)).toBe("all");
  expect(activityKind("tasks")).toBe("tasks");expect(activityKind("memory")).toBe("memory");
 });
 test("does not confuse issued credentials, sign-in, recent contact and running work",()=>{
  expect(connectionState({kind:"token",status:"authorized"},now).label).toBe("Key issued");
  expect(connectionState({kind:"oauth",status:"authorized"},now).label).toBe("Signed in");
  expect(connectionState({status:"authorized",lastContactAt:"2026-10-24T09:58:00Z"},now).state).toBe("recent");
  expect(connectionState({status:"authorized",lastMemoryAt:"2026-10-23T09:58:00Z"},now).state).toBe("quiet");
  expect(connectionState({status:"authorized",lastContactAt:"2099-01-01T00:00:00Z"},now).state).toBe("ready");
  for(const status of ["revoked","expired","membership_removed"])expect(connectionState({status,lastContactAt:"2026-10-24T09:59:00Z"},now).state).toBe("reconnect");
  expect(connectionState({},now).state).toBe("unknown");
 });
 test("summarizes actual contact and keeps revoked actors out of authorized totals",()=>{
  const rows=[{status:"authorized",lastAuthenticatedAt:"2026-10-24T09:59:00Z"},{status:"revoked",lastContactAt:"2026-10-24T09:59:30Z"},{status:"authorized",kind:"oauth"}];
  expect(connectionSummary(rows,now)).toEqual({total:3,authorized:2,reconnect:1,recent:1,lastContactAt:"2026-10-24T09:59:30.000Z"});
 });
 test("archived connections leave attention and presence totals while retaining historical identity",()=>{
  const archived={agent:"old-client",displayName:"Old laptop",status:"revoked",archivedAt:"2026-10-24T09:00:00Z",lastContactAt:"2026-10-24T09:59:30Z",harness:"codex"};
  const current={agent:"current-client",status:"authorized",kind:"oauth"};
  expect(currentConnections([archived,current,{...archived,archivedAt:null,deletedAt:"2026-10-24T09:00:00Z"}])).toEqual([current]);
  expect(connectionState(archived,now)).toMatchObject({state:"archived",label:"Archived"});
  expect(connectionState({...archived,status:"authorized"},now).state).toBe("archived");
  expect(connectionSummary([archived,current],now)).toMatchObject({total:1,authorized:1,reconnect:0,recent:0,lastContactAt:null});
  expect(withConnectionIdentity({agents:[{name:"old-client"}]},[archived]).agents[0]).toMatchObject({name:"old-client",displayName:"Old laptop",harness:"codex"});
 });
 test("uses bound display metadata without changing authenticated filters or stored reports",()=>{
  const source={id:"run:1",agents:[{name:"oauth:private:client",harness:null}],actions:[{agent:"oauth:private:client",harness:"claude-code",sourceLabel:"Reported source"}]};
  const next=withConnectionIdentity(source,[{agent:"oauth:private:client",displayName:"Codex",harness:"codex"},{agent:"unrelated",displayName:"Other",harness:"grok-bot"}]);
  expect(next.agents[0]).toMatchObject({name:"oauth:private:client",displayName:"Codex",harness:"codex"});
  expect(next.actions[0]).toMatchObject({agent:"oauth:private:client",displayName:"Codex",harness:"claude-code",sourceLabel:"Reported source"});
  expect(source.agents[0]).not.toHaveProperty("displayName");
 });
});
