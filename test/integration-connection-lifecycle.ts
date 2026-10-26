import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { issueToken, authenticateStoredSecret } from "../gateway/src/auth";
import { recordAction } from "../gateway/src/actions";
import { lockConnection, oauthConnectionId } from "../gateway/src/connection-identity";
import { listConnections, updateConnection } from "../gateway/src/connections";
import { sha256 } from "../gateway/src/hash";
import { authenticateJwt, decodeJwt } from "../gateway/src/oauth";
import { handleOauth, pkceChallenge } from "../gateway/src/oauth-as";
import { signJwt } from "../gateway/src/oauth-keys";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";

// Only called by the guarded disposable-PostgreSQL integration runner.
export async function checkConnectionLifecycle(db: postgres.Sql): Promise<number> {
  let checks=0;
  const equal=(actual:unknown,expected:unknown,message:string)=>{assert.deepEqual(actual,expected,message);checks++;};
  for(const id of [43,44])await db`INSERT INTO orgs(id,name,slug,kind,brain_db,data_db,home_dir,policies,provisioning_status)
    VALUES(${id},'Connection lifecycle fixture',${`lifecycle-${id}`},'team',${`brain_org_${id}`},${`brain_org_${id}`},${`org-${id}`},${db.json(DEFAULT_POLICIES)},'ready')`;
  const ownerEmail='connection-owner@example.test',email='connection-member@example.test';
  const members=await db`INSERT INTO org_members(org_id,email,role) VALUES(43,${ownerEmail},'owner'),(43,${email},'member'),(44,${email},'member') RETURNING id,org_id,email`;
  const memberId=Number(members.find(row=>row.org_id===43&&row.email===email)!.id);
  const foreignMemberId=Number(members.find(row=>row.org_id===44)!.id);
  const owner=normalizeToken({name:ownerEmail,email:ownerEmail,orgId:43,kind:'session',role:'owner'});
  const raw=await issueToken(43,'lifecycle-key',true,null,db);
  const agent=(await authenticateStoredSecret(raw,db))!;
  const token=(await listConnections(owner,db)).connections.find(row=>row.name==='lifecycle-key')!;
  await db`INSERT INTO audit_log(org_id,token_name,tool,arg_summary,outcome) VALUES(43,'lifecycle-key','remember','preserved fixture','ok')`;
  await recordAction(agent,{tool:'code.test',summary:'Preserved connection task report',status:'completed'});
  await updateConnection(owner,{id:token.id,action:'archive'},db);
  equal(await authenticateStoredSecret(raw,db),null,'Archived access key stops authenticating');
  const archived=(await listConnections(owner,db)).connections.find(row=>row.id===token.id)!;
  equal([archived.archivedAt!==null,archived.status,archived.memoryCalls,archived.taskReports],[true,'revoked',1,1],'Archived inventory preserves successful work and revoked status');
  await updateConnection(owner,{id:token.id,action:'restore'},db);
  equal((await listConnections(owner,db)).connections.find(row=>row.id===token.id)?.archivedAt,null,'Restore returns the record to current inventory');
  equal(await authenticateStoredSecret(raw,db),null,'Restore never reactivates access-key authentication');
  await updateConnection(owner,{id:token.id,action:'delete'},db);
  equal((await listConnections(owner,db)).connections.some(row=>row.id===token.id),false,'Deleted access key is absent from inventory');
  equal(Number((await db`SELECT count(*) AS n FROM audit_log WHERE org_id=43 AND token_name='lifecycle-key'`)[0].n),1,'Delete preserves audit receipts');
  equal(Number((await db`SELECT count(*) AS n FROM action_events WHERE org_id=43 AND agent='lifecycle-key'`)[0].n),1,'Delete preserves task reports');
  await assert.rejects(()=>updateConnection(owner,{id:token.id,action:'restore'},db),error=>(error as any).status===404);checks++;
  const member=normalizeToken({...owner,email,role:'member'});
  await assert.rejects(()=>updateConnection(member,{id:token.id,action:'delete'},db),error=>(error as any).status===403);checks++;
  await db`UPDATE org_members SET role='member' WHERE org_id=43 AND email=${ownerEmail}`;
  await assert.rejects(()=>updateConnection(owner,{id:token.id,action:'delete'},db),error=>(error as any).status===403);checks++;
  await db`UPDATE org_members SET role='owner' WHERE org_id=43 AND email=${ownerEmail}`;

  const issuer='https://lifecycle.example',audience=`${issuer}/mcp`,client='connection-lifecycle-client',otherClient='connection-lifecycle-other-client';
  for(const id of [client,otherClient])await db`INSERT INTO oauth_clients(client_id,client_name,redirect_uris) VALUES(${id},'Codex',${db.json(['http://localhost:7777/cb'])})`;
  const grant=async(orgId:number,clientId:string,binding:number)=>{
    const raw=`orf_${randomBytes(24).toString('base64url')}`;
    await db`INSERT INTO oauth_refresh_tokens(sha256_hash,org_id,email,client_id,membership_id,resource,scope,expires_at)
      VALUES(${sha256(raw)},${orgId},${email},${clientId},${binding},${audience},'memory:read',now()+interval '1day')`;
    return raw;
  };
  const initial=await grant(43,client,memberId),duplicate=await grant(43,client,memberId);
  await grant(43,otherClient,memberId);await grant(44,client,foreignMemberId);
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const previousKey=process.env.ENGRAM_OAUTH_PRIVATE_KEY;
  process.env.ENGRAM_OAUTH_PRIVATE_KEY=privateKey.export({type:'pkcs8',format:'pem'}).toString();
  try {
    const claims={sub:email,email,org_id:43,membership_id:memberId,client_id:client,scope:'memory:read'};
    const legacy=signJwt(claims,{issuer,audience});
    equal((await authenticateJwt(legacy,audience))?.orgId,43,'Real legacy JWT authenticates before lifecycle revocation');
    const tokenRequest=async(body:Record<string,string>)=>{
      const url=new URL(`${issuer}/oauth/token`);
      const response=await handleOauth(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),url);
      assert.ok(response);return {status:response.status,body:await response.json() as any};
    };
    const refresh=(raw:string)=>tokenRequest({grant_type:'refresh_token',refresh_token:raw,client_id:client});
    const verifier='a'.repeat(43);
    const code=async()=>{
      const raw=`oac_${randomBytes(24).toString('base64url')}`,id=oauthConnectionId(43,email,client);
      await db.begin(async tx=>{
        await lockConnection(tx as unknown as postgres.Sql,43,id);
        const [state]=await tx`SELECT generation FROM connection_lifecycle WHERE org_id=43 AND connection_id=${id}`;
        await tx`INSERT INTO oauth_codes(sha256_hash,org_id,email,client_id,membership_id,redirect_uri,code_challenge,resource,scope,expires_at,connection_generation)
          VALUES(${sha256(raw)},43,${email},${client},${memberId},'http://localhost:7777/cb',${pkceChallenge(verifier)},${audience},'memory:read',now()+interval '5minutes',${Number(state?.generation??0)})`;
      });return raw;
    };
    const exchange=(raw:string)=>tokenRequest({grant_type:'authorization_code',code:raw,client_id:client,code_verifier:verifier,redirect_uri:'http://localhost:7777/cb'});
    const id=oauthConnectionId(43,email,client),beforeArchive=await code();
    const current=await refresh(initial);
    equal(current.status,200,'Real refresh endpoint mints a current access token');
    await updateConnection(owner,{id,action:'archive'},db);
    equal(await authenticateJwt(legacy,audience),null,'Archive rejects a previously signed legacy JWT using real stored generation');
    equal(await authenticateJwt(current.body.access_token,audience),null,'Archive rejects a newly signed access JWT immediately');
    equal((await refresh(initial)).status,400,'Archive revokes the initial OAuth refresh grant');
    equal((await refresh(duplicate)).status,400,'Archive revokes every duplicate grant for this connection');
    equal((await exchange(beforeArchive)).status,400,'Archive invalidates outstanding authorization codes');
    equal(Number((await db`SELECT count(*) AS n FROM oauth_refresh_tokens WHERE org_id=43 AND client_id=${otherClient} AND revoked_at IS NULL`)[0].n),1,'Archive leaves a different client untouched');
    equal(Number((await db`SELECT count(*) AS n FROM oauth_refresh_tokens WHERE org_id=44 AND client_id=${client} AND revoked_at IS NULL`)[0].n),1,'Archive leaves the same email/client in another workspace untouched');
    await assert.rejects(()=>updateConnection(owner,{id:oauthConnectionId(44,email,client),action:'delete'},db),error=>(error as any).status===404);checks++;
    await updateConnection(owner,{id,action:'restore'},db);
    equal(await authenticateJwt(legacy,audience),null,'Restore cannot resurrect legacy JWT access');
    const reconnected=await exchange(await code());
    equal(reconnected.status,200,'Real fresh authorization reconnects after archive');
    equal(decodeJwt(reconnected.body.access_token)?.payload.connection_generation,1,'Fresh access binds the advanced generation');
    equal((await authenticateJwt(reconnected.body.access_token,audience))?.orgId,43,'Fresh generation authenticates');
    equal(await authenticateJwt(legacy,audience),null,'Fresh authorization still leaves the legacy JWT revoked');
    const beforeDelete=await code();
    await updateConnection(owner,{id,action:'delete'},db);
    equal((await listConnections(owner,db)).connections.some(row=>row.id===id),false,'Deleted OAuth connection is absent from inventory');
    equal((await exchange(beforeDelete)).status,400,'A pre-delete code cannot restore a tombstoned connection');
    const afterDelete=await exchange(await code());
    equal(afterDelete.status,200,'Fresh OAuth authorization can recreate a deleted connection');
    equal((await listConnections(owner,db)).connections.find(row=>row.id===id)?.archivedAt,null,'Reconnected deleted identity is visible in current inventory');
    equal(await authenticateJwt(reconnected.body.access_token,audience),null,'A pre-delete JWT stays invalid after the identity reconnects');

    // Force both operations to wait on the same real Postgres advisory lock.
    // The refresh reads its credential before archive commits, then must
    // re-check validity after archive wins the queued mutation lock.
    let unlock!:()=>void,held!:()=>void;
    const released=new Promise<void>(resolve=>{unlock=resolve;}),ready=new Promise<void>(resolve=>{held=resolve;});
    const blocker=db.begin(async tx=>{await lockConnection(tx as unknown as postgres.Sql,43,id);held();await released;});
    const waitFor=async(n:number)=>{
      for(let attempt=0;attempt<100;attempt++){
        const [row]=await db`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%'`;
        if(Number(row.n)>=n)return;
        await Bun.sleep(10);
      }
      throw new Error('Expected queued connection lifecycle locks were not reached');
    };
    await ready;
    let archive:ReturnType<typeof updateConnection>|undefined,racing:ReturnType<typeof refresh>|undefined;
    try { archive=updateConnection(owner,{id,action:'archive'},db);await waitFor(1);racing=refresh(afterDelete.body.refresh_token);await waitFor(2); }
    finally { unlock();await blocker; }
    await archive;
    equal((await racing)!.status,400,'An in-flight refresh selected before archive cannot mint after archive commits');
    equal(await authenticateJwt(afterDelete.body.access_token,audience),null,'Queued refresh race cannot resurrect the pre-archive JWT');
  } finally { if(previousKey===undefined)delete process.env.ENGRAM_OAUTH_PRIVATE_KEY;else process.env.ENGRAM_OAUTH_PRIVATE_KEY=previousKey; }

  // A large set of hidden rows must not consume the public inventory window.
  await db`INSERT INTO tokens(org_id,name,sha256_hash,role,issuer_kind,created_at)
    SELECT 43,'lifecycle-hidden-'||n,'lifecycle-hidden-hash-'||n,'agent','operator',now()+interval '1hour' FROM generate_series(1,205) n`;
  await db`INSERT INTO connection_lifecycle(org_id,connection_id,kind,token_id,generation,deleted_at)
    SELECT org_id,'token:'||id,'token',id,1,now() FROM tokens WHERE org_id=43 AND name LIKE 'lifecycle-hidden-%'`;
  const visible=await issueToken(43,'lifecycle-visible-after-hidden',true,null,db);
  equal((await listConnections(owner,db)).connections.some(row=>row.name==='lifecycle-visible-after-hidden'),true,'Deleted rows are filtered before the200row inventory limit');
  equal((await authenticateStoredSecret(visible,db))?.orgId,43,'Independent new key remains usable');
  return checks;
}
