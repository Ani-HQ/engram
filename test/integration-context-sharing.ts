// Called only by the marked disposable PostgreSQL integration runner.
// All proposal evaluation is local: this suite makes no provider calls.
import assert from "node:assert/strict";
import type postgres from "postgres";
import { closeOrgPool, ensureDatabase, migrateOrgDataTables, poolFor } from "../gateway/src/db";
import { getOrg, withOrg } from "../gateway/src/orgs";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { upsertMemoryEntry } from "../gateway/src/memory-entries";
import { authenticateStoredSecret } from "../gateway/src/auth";
import { authenticateContextShareToken, listApprovedTeamItems } from "../gateway/src/context-sharing-access";
import { commitContextShare, getContextSharing, previewContextShare, revokeContextShare, rotateContextShareToken } from "../gateway/src/context-sharing";
import { handleSharedContextMcp } from "../gateway/src/shared-context-mcp";

export async function checkContextSharing(db:postgres.Sql):Promise<number> {
  assert.equal((await db`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose,"engram-disposable-integration-v1");
  let checks=1;
  const equal=(a:unknown,b:unknown,message:string)=>{assert.deepEqual(a,b,message);checks++;};
  const reject=async(fn:()=>Promise<unknown>,code:string)=>{await assert.rejects(fn,(error:any)=>error.code===code);checks++;};
  const sourceId=840001,targetId=840002,otherId=840003,email="context-sharing-owner@example.test";
  const sourceDb=`brain_org_${sourceId}`;
  const client={enabled:()=>false,available:()=>false,evaluate:async()=>{throw new Error("No provider request is permitted in this suite");}};
  const deps={db,client};
  try {
    equal(Number((await db`SELECT count(*) AS n FROM orgs WHERE id IN (${sourceId},${targetId},${otherId})`)[0].n),0,"Context-sharing fixtures must not replace an existing workspace");
    for(const [id,kind]of [[sourceId,"personal"],[targetId,"team"],[otherId,"team"]]as const)await db`INSERT INTO orgs(id,name,slug,kind,brain_db,data_db,home_dir,policies,provisioning_status) VALUES (${id},${`Context fixture ${id}`},${`context-sharing-${id}`},${kind},${`brain_org_${id}`},${`brain_org_${id}`},${`org-${id}`},${db.json(DEFAULT_POLICIES)},'ready')`;
    const ownerMember=Number((await db`INSERT INTO org_members(org_id,email,role) VALUES (${sourceId},${email},'owner') RETURNING id`)[0].id);
    const targetMember=Number((await db`INSERT INTO org_members(org_id,email,role) VALUES (${targetId},${email},'member') RETURNING id`)[0].id);
    await db`INSERT INTO org_members(org_id,email,role) VALUES (${otherId},'different-person@example.test','owner')`;
    const source=(await getOrg(sourceId,db))!,actor=normalizeToken({orgId:sourceId,name:email,email,kind:"session",role:"owner"});
    await ensureDatabase(sourceDb);await migrateOrgDataTables(poolFor(sourceDb));
    await ensureDatabase(`brain_org_${targetId}`);await migrateOrgDataTables(poolFor(`brain_org_${targetId}`));
    await poolFor(sourceDb)`TRUNCATE memory_entries, trails, reflex_decisions, review_items, dream_runs RESTART IDENTITY CASCADE`;
    const original="Startup launches use staged rollouts.\n\nPersonal medical appointment: private detail.";
    const entry=await withOrg(source,actor,()=>upsertMemoryEntry({slug:"private/health-and-work",topicHint:"private-topic-name",rawText:original,repo:"private-repository",harness:"private-agent-alias"}));
    assert.ok(entry);checks++;
    const preview=()=>withOrg(source,actor,()=>previewContextShare(actor,source,{instruction:"Share startup launch decisions; exclude personal health details",recipient:{kind:"team",orgId:targetId}},deps));
    const commit=(draft:Awaited<ReturnType<typeof preview>>,text="Startup launches use staged rollouts.")=>withOrg(source,actor,()=>commitContextShare(actor,source,{previewId:draft.previewId,selections:[{id:draft.candidates[0].id,text}],acknowledged:true},"https://integration.example",deps));
    const settings=await getContextSharing(actor,source,deps);
    equal(settings.targets.map(target=>target.id),[targetId],"Only currently joined accepting teams are offered");
    await reject(()=>withOrg(source,actor,()=>previewContextShare(actor,source,{instruction:"Share startup decisions",recipient:{kind:"team",orgId:otherId}},deps)),"forbidden");
    const draft=await preview();equal(draft.method,"text","No model is claimed when evaluation is unavailable");
    equal(Number((await db`SELECT count(*) AS n FROM context_shares WHERE source_org = ${sourceId}`)[0].n),0,"Previewing creates no recipient grant");
    equal(JSON.stringify(draft).includes(entry!.id)||JSON.stringify(draft).includes("private-repository")||JSON.stringify(draft).includes(email),false,"Preview projections never add source IDs, repository metadata or attribution");
    await reject(()=>commit(draft,"New invented context"),"invalid_request");
    await poolFor(sourceDb)`UPDATE memory_entries SET raw_text = ${original+"\nNew private content"} WHERE id = ${entry!.id}`;
    await reject(()=>commit(draft),"preview_changed");
    equal(Number((await db`SELECT count(*) AS n FROM context_share_items`)[0].n),0,"Changed-source refusal is atomic and creates no recipient snapshot");
    await poolFor(sourceDb)`UPDATE memory_entries SET raw_text = ${entry!.rawText} WHERE id = ${entry!.id}`;
    const approved=await commit(draft);equal(approved.credential,undefined,"A team grant never creates an agent capability");
    equal(approved.share.items.map(item=>item.text),["Startup launches use staged rollouts."],"The exact reviewed excerpt survives PostgreSQL jsonb canonical key ordering");
    equal((await db`SELECT candidates FROM context_share_previews WHERE id = ${draft.previewId}`)[0].candidates,[],"Consumed draft content is scrubbed immediately");
    await reject(()=>commit(draft),"preview_changed");
    await poolFor(sourceDb)`UPDATE memory_entries SET raw_text = ${original+"\nPrivate source revision"} WHERE id = ${entry!.id}`;
    const visible=await listApprovedTeamItems(targetId,db);
    equal(visible.map(item=>item.text),["Startup launches use staged rollouts."],"Source revisions cannot expose new personal text through a committed team snapshot");
    equal(JSON.stringify(visible).includes("source_id")||JSON.stringify(visible).includes("private-repository")||JSON.stringify(visible).includes("medical"),false,"Recipient projection has only approved text and synthetic identity");
    equal(await listApprovedTeamItems(otherId,db),[],"Other tenants receive none of the approved team snapshot");
    await db`UPDATE orgs SET policies = ${db.json({...DEFAULT_POLICIES,acceptShares:false})} WHERE id = ${targetId}`;
    equal(await listApprovedTeamItems(targetId,db),[],"Disabling target acceptance stops already issued team reads");
    await db`UPDATE orgs SET policies = ${db.json(DEFAULT_POLICIES)} WHERE id = ${targetId}`;
    await db`DELETE FROM org_members WHERE id = ${targetMember}`;
    equal(await listApprovedTeamItems(targetId,db),[],"Removing the source owner's target membership revokes access");
    await db`INSERT INTO org_members(org_id,email,role) VALUES (${targetId},${email},'member')`;
    equal(await listApprovedTeamItems(targetId,db),[],"Rejoining cannot resurrect a grant from the removed membership");

    const agentPreview=await withOrg(source,actor,()=>previewContextShare(actor,source,{instruction:"Share startup launch decisions, excluding personal details",recipient:{kind:"agent",name:"Startup helper"}},deps));
    const agentGrant=await withOrg(source,actor,()=>commitContextShare(actor,source,{previewId:agentPreview.previewId,selections:[{id:agentPreview.candidates[0].id,text:"Startup launches use staged rollouts."}],acknowledged:true},"https://integration.example",deps));
    assert.ok(agentGrant.credential);checks++;
    equal(await authenticateStoredSecret(agentGrant.credential!.token),null,"An isolated context capability cannot authenticate as a general workspace credential");
    equal((await authenticateContextShareToken(agentGrant.credential!.token,db))?.items.map(item=>item.text),["Startup launches use staged rollouts."],"The isolated credential reads only its exact committed excerpt");
    const rpc=(token:string,name:string,args={})=>handleSharedContextMcp(new Request("https://integration.example/mcp/shared",{method:"POST",headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}));
    equal((await rpc(agentGrant.credential!.token,"list_pages")).status,200,"The restricted MCP endpoint authenticates the real PostgreSQL grant");
    assert.ok((await (await rpc(agentGrant.credential!.token,"remember",{text:"must never write"})).json()).error);checks++;
    const rotated=await rotateContextShareToken(actor,source,agentGrant.share.id,"https://integration.example",deps);
    equal(await authenticateContextShareToken(agentGrant.credential!.token,db),null,"Explicit rotation invalidates the earlier credential immediately");
    equal((await authenticateContextShareToken(rotated.credential.token,db))?.items.length,1,"Rotation preserves the approved snapshot");
    const inventory=await getContextSharing(actor,source,deps);
    equal(JSON.stringify(inventory).includes(rotated.credential.token)||JSON.stringify(inventory).includes("token_hash"),false,"Owner inventory never recovers capabilities or hashes");
    await revokeContextShare(actor,source,agentGrant.share.id,deps);
    equal(await authenticateContextShareToken(rotated.credential.token,db),null,"Revocation stops new isolated-agent reads");
    equal((await rpc(rotated.credential.token,"list_pages")).status,401,"The endpoint rechecks revocation for each request");
    const another=await withOrg(source,actor,()=>previewContextShare(actor,source,{instruction:"Share startup decisions",recipient:{kind:"agent",name:"Another helper"}},deps));
    const concurrent=await Promise.allSettled([commit(another),commit(another)]);
    equal(concurrent.filter(item=>item.status==="fulfilled").length,1,"The real PostgreSQL preview lock prevents duplicate simultaneous grants");
    const winner=(concurrent.find(item=>item.status==="fulfilled")as PromiseFulfilledResult<Awaited<ReturnType<typeof commit>>>).value;
    await db`DELETE FROM org_members WHERE id = ${ownerMember}`;
    equal(await authenticateContextShareToken(winner.credential!.token,db),null,"Removing the exact source membership invalidates its outstanding context capabilities");
    return checks;
  } finally {
    await db`DELETE FROM sessions WHERE org_id IN (${sourceId},${targetId},${otherId})`;
    await db`DELETE FROM org_members WHERE org_id IN (${sourceId},${targetId},${otherId})`;
    await db`DELETE FROM orgs WHERE id IN (${sourceId},${targetId},${otherId})`;
    await closeOrgPool(sourceDb);
    await closeOrgPool(`brain_org_${targetId}`);
  }
}
