#!/usr/bin/env bun
// Operator-only, one-use read credential. No gateway imports or migrations.
// Raw bearer values travel only through release.py stdin, never argv/files/logs.
import type postgres from "postgres";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnerCheckError, settings as databaseSettings, withOperatorDatabase, type OwnerCheckSettings } from "./check-owners";

export interface CandidateSettings extends OwnerCheckSettings { image: string; stateFile: string; tag: string; python: string }
export function settings(args: string[]): CandidateSettings {
  const values: Record<string,string> = {}, base: string[] = [];
  for (let i=0;i<args.length;i++) {
    const key=args[i];
    if (key === "--run") { base.push(key); continue; }
    if (!["--project","--region","--instance","--image","--state-file","--tag","--python"].includes(key) || values[key] !== undefined || !args[i+1] || args[i+1].startsWith("--")) throw new OwnerCheckError("invalid_arguments");
    values[key]=args[++i];
    if (["--project","--region","--instance"].includes(key)) base.push(key,values[key]);
  }
  const selected=databaseSettings(base), image=values["--image"] ?? "", tag=values["--tag"] ?? "candidate";
  if (!new RegExp(`^gcr\\.io/${selected.project}/engram(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$`).test(image) || image.endsWith(":latest") || !/^[a-z][a-z0-9-]{0,30}$/.test(tag) || !values["--state-file"]) throw new OwnerCheckError("invalid_arguments");
  const python=values["--python"] ?? "python3";
  if (python.includes("\0") || python.startsWith("-")) throw new OwnerCheckError("invalid_arguments");
  return {...selected,image,tag,python,stateFile:resolve(values["--state-file"])};
}

type Credential = { name: string; raw: string; hash: string };
export type SmokeOutcome = { ok: boolean; reason: string; tokenRevoked: boolean; cleanupRequired: boolean; credential?: {orgId:1;name:string} };
const release = fileURLToPath(new URL("./release.py",import.meta.url));
function stopped(signal: AbortSignal) { if (signal.aborted) throw new OwnerCheckError("interrupted"); }

async function lockOwner(tx: postgres.Sql) {
  // NO KEY UPDATE blocks consent/policy changes but permits FK KEY SHARE from
  // lazy billing/audit rows used by ordinary candidate read requests.
  const orgs=await tx`SELECT id, policies FROM orgs WHERE id=1 FOR NO KEY UPDATE`;
  if (orgs.length !== 1) throw new OwnerCheckError("org1_missing");
  if (orgs[0].policies?.externalAiProcessing === true) throw new OwnerCheckError("provider_processing_enabled");
  const owners=await tx`SELECT id FROM org_members WHERE org_id=1 AND role='owner'
    AND email=lower(email) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' FOR NO KEY UPDATE`;
  if (!owners.length) throw new OwnerCheckError("owner_required");
}

export async function revokeCredential(db: postgres.Sql, credential: Credential): Promise<boolean> {
  try {
    return await db.begin(async tx=>{
      // Fence an unknown issuance commit before accepting absence as cleanup.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${credential.name},0))`;
      await tx`UPDATE tokens SET revoked_at=coalesce(revoked_at,now())
        WHERE org_id=1 AND name=${credential.name} AND sha256_hash=${credential.hash}`;
      const rows=await tx`SELECT NOT EXISTS(SELECT 1 FROM tokens WHERE org_id=1 AND name=${credential.name}
        AND sha256_hash=${credential.hash} AND revoked_at IS NULL) AS confirmed`;
      return rows[0]?.confirmed === true;
    });
  } catch { return false; }
}

export async function withSmokeCredential(db: postgres.Sql, smoke: (raw:string)=>Promise<void>, signal=new AbortController().signal): Promise<SmokeOutcome> {
  const raw=`eng_${randomBytes(32).toString("base64url")}`;
  const credential={name:`operator-candidate-smoke-${randomUUID()}`,raw,hash:createHash("sha256").update(raw).digest("hex")};
  let attempted=false, revoked=false, reason="smoke_unavailable", passed=false;
  try {
    stopped(signal);
    await db.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${credential.name},0))`;
      await lockOwner(tx);
      stopped(signal);
      // Set before SQL execution: an unknown commit outcome still needs cleanup.
      attempted=true;
      await tx`INSERT INTO tokens(name,sha256_hash,scopes,secrets_acl,org_id,role,can_write,issuer_kind,issued_by_email,issued_by_member_id)
        VALUES(${credential.name},${credential.hash},'{}'::jsonb,'false'::jsonb,1,'agent',false,'operator',NULL,NULL)`;
    });
    // The credential is committed and visible before running remote reads. Keep
    // its owner/consent prerequisite stable without blocking FK references.
    await db.begin(async tx=>{
      await tx`SET LOCAL idle_in_transaction_session_timeout='300s'`;
      await lockOwner(tx);
      stopped(signal);
      await smoke(raw);
      stopped(signal);
    });
    passed=true;
    reason="smoke_passed";
  } catch(error) {
    reason=error instanceof OwnerCheckError ? error.code : "smoke_unavailable";
  } finally {
    // Deliberately independent of the smoke's abort signal. Keep the SQL proxy
    // alive until revocation is confirmed, including failed/unknown issuance.
    if (attempted) revoked=await revokeCredential(db,credential);
  }
  if (attempted && !revoked) return {ok:false,reason:"credential_cleanup_unconfirmed",tokenRevoked:false,cleanupRequired:true,credential:{orgId:1,name:credential.name}};
  return {ok:passed,reason,tokenRevoked:attempted && revoked,cleanupRequired:false};
}

function readState(path:string): {text:string;state:any} {
  let descriptor: number|undefined;
  try {
    descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink!==1 || stat.size>65536 || (stat.mode&0o022)!==0 || stat.uid!==process.getuid?.()) throw new Error();
    const text=readFileSync(descriptor,"utf8"), state=JSON.parse(text);
    if (!state || typeof state!=="object" || Array.isArray(state)) throw new Error();
    return {text,state};
  } catch { throw new OwnerCheckError("invalid_release_state"); }
  finally { if(descriptor!==undefined) closeSync(descriptor); }
}
function writeState(path:string,state:unknown) {
  const temporary=join(dirname(path),`.engram-smoke-state-${randomUUID()}`);
  try { writeFileSync(temporary,JSON.stringify(state,null,2)+"\n",{flag:"wx",mode:0o600}); renameSync(temporary,path); }
  finally { rmSync(temporary,{force:true}); }
}
function validateState(options:CandidateSettings,state:any) {
  if (state.project!==options.project || state.region!==options.region || state.service!=="engram" || state.image!==options.image || state.tag!==options.tag ||
      typeof state.candidateRevision!=="string" || !/^engram-[a-z0-9-]+$/.test(state.candidateRevision) || !/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(state.candidateURL ?? "")) throw new OwnerCheckError("release_state_mismatch");
}
export async function releaseSmoke(options:CandidateSettings,stateFile:string,raw:string,signal:AbortSignal):Promise<void> {
  stopped(signal);
  const child=Bun.spawn([options.python,release,"smoke","--project",options.project,"--region",options.region,"--service","engram","--image",options.image,"--tag",options.tag,"--state-file",stateFile,"--smoke-token-stdin"],{
    env:{...process.env,CLOUDSDK_CORE_LOG_HTTP:"false",CLOUDSDK_CORE_VERBOSITY:"error",CLOUDSDK_CORE_DISABLE_FILE_LOGGING:"true"},
    stdin:new Blob([raw+"\n"]),stdout:"ignore",stderr:"ignore",
  });
  let timedOut=false;
  const stop=()=>child.kill("SIGKILL");
  signal.addEventListener("abort",stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;stop();},240_000);
  try {
    const code=await child.exited;
    if(signal.aborted) throw new OwnerCheckError("interrupted");
    if(timedOut || code!==0) throw new OwnerCheckError(timedOut ? "smoke_timeout" : "smoke_failed");
  } finally { clearTimeout(timer);signal.removeEventListener("abort",stop); }
}

export async function run(options:CandidateSettings, signal=new AbortController().signal, dependencies:{connect?:typeof withOperatorDatabase;smoke?:typeof releaseSmoke}={}):Promise<SmokeOutcome> {
  if (!options.run) throw new OwnerCheckError("explicit_execution_required");
  const initial=readState(options.stateFile);validateState(options,initial.state);
  // Do not publish an activation proof until the temporary credential is gone.
  const pending={...initial.state,publicSmoke:false,privateSmoke:false};delete pending.smokeAt;
  writeState(options.stateFile,pending);
  const baseline=readState(options.stateFile).text;
  const directory=mkdtempSync("/tmp/engram-candidate-smoke-");chmodSync(directory,0o700);
  const scratch=join(directory,"release-state.json");writeState(scratch,pending);
  try {
    // Do not pass the abort signal to the proxy: cancellation must not remove
    // the revocation path while a temporary credential may still exist.
    let lastOutcome:SmokeOutcome|undefined, result:SmokeOutcome;
    try {
      result=await (dependencies.connect ?? withOperatorDatabase)(options,"write",async db=>{
        lastOutcome=await withSmokeCredential(db,raw=>(dependencies.smoke ?? releaseSmoke)(options,scratch,raw,signal),signal);
        return lastOutcome;
      });
    } catch(error) {
      // A proxy teardown failure must not hide an already-unconfirmed revoke.
      if(lastOutcome?.cleanupRequired) return lastOutcome;
      throw error;
    }
    if (result.ok) {
      const proof=readState(scratch).state;validateState(options,proof);
      if(proof.publicSmoke!==true || proof.privateSmoke!==true || typeof proof.smokeAt!=="string" || !Number.isFinite(Date.parse(proof.smokeAt))) throw new OwnerCheckError("smoke_proof_missing");
      if(readState(options.stateFile).text!==baseline) throw new OwnerCheckError("release_state_changed");
      writeState(options.stateFile,{...pending,publicSmoke:true,privateSmoke:true,smokeAt:proof.smokeAt});
    }
    return result;
  } finally { rmSync(directory,{recursive:true,force:true}); }
}

if(import.meta.main) {
  const controller=new AbortController();
  process.once("SIGINT",()=>controller.abort());process.once("SIGTERM",()=>controller.abort());
  try {
    const options=settings(process.argv.slice(2));
    if(!options.run) console.log(JSON.stringify({mode:"plan",project:options.project,instance:`${options.project}:${options.region}:${options.instance}`,database:"engram_gateway",orgId:1,image:options.image,stateFile:options.stateFile,credential:{role:"agent",canWrite:false,issuerKind:"operator",lifetime:"revoke in finally"},ownerRequired:true,providerProcessingRequired:false,tokenOutput:false,mutations:["one temporary read-only operator credential, then revocation","local smoke proof only after revocation"]}));
    else { const result=await run(options,controller.signal);console.log(JSON.stringify(result));process.exitCode=result.ok ? 0 : 2; }
  } catch(error) {
    console.log(JSON.stringify({ok:false,reason:error instanceof OwnerCheckError ? error.code : "smoke_unavailable",cleanupRequired:false}));process.exitCode=1;
  }
}
