import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnerCheckError } from "../deploy/check-owners";
import { run, settings, validateCandidateSmokeEnvironment, withSmokeCredential } from "../deploy/smoke-candidate";

function database(input:{owner?:boolean;provider?:boolean;jev?:boolean;ownerIds?:number[][];revokeFails?:boolean;unknownIssue?:boolean}={}) {
  const calls:{query:string;values:unknown[]}[]=[];
  let row:{name:string;hash:string;revoked:boolean}|undefined;
  let ownerReads=0;
  const db:any=async(parts:TemplateStringsArray,...values:unknown[])=>{
    const query=parts.join("?");calls.push({query,values});
    if(query.includes("FROM orgs"))return [{id:1,policies:{externalAiProcessing:input.provider===true,jevProcessing:input.jev===true}}];
    if(query.includes("FROM org_members"))return input.owner===false?[]:(input.ownerIds?.[ownerReads++]??[41]).map(id=>({id}));
    if(query.includes("INSERT INTO tokens")) {
      row={name:String(values[0]),hash:String(values[1]),revoked:false};
      if(input.unknownIssue)throw new Error("PRIVATE_DATABASE_CREDENTIAL_DO_NOT_LOG");
      return [];
    }
    if(query.includes("UPDATE tokens")) {
      if(input.revokeFails)throw new Error("PRIVATE_DATABASE_CREDENTIAL_DO_NOT_LOG");
      if(row && row.name===values[0] && row.hash===values[1])row.revoked=true;
      return [];
    }
    if(query.includes("SELECT NOT EXISTS"))return [{confirmed:!row || row.revoked}];
    return [];
  };
  db.begin=async(work:(tx:any)=>unknown)=>work(db);
  return {db,calls,row:()=>row};
}
const repository=fileURLToPath(new URL("..",import.meta.url));
const digest="sha256:"+"a".repeat(64);
function cloudFixture(state:any){
  const service={metadata:{name:"engram"},status:{traffic:[{tag:state.tag,revisionName:state.candidateRevision,url:state.candidateURL}]}};
  const revision={kind:"Revision",metadata:{name:state.candidateRevision,labels:{"serving.knative.dev/service":"engram","serving.knative.dev/route":"engram","serving.knative.dev/configuration":"engram","cloud.googleapis.com/location":"us-central1"}},
    spec:{containers:[{image:`gcr.io/ani-hq/engram@${digest}`,env:[{name:"JEV_API_KEY",valueFrom:{secretKeyRef:{name:"engram-jev-api-key",key:"latest"}}},{name:"ENGRAM_WORKER_ISOLATION",value:"cloudrun"}]}]},status:{imageDigest:`gcr.io/ani-hq/engram@${digest}`,conditions:[{type:"Ready",status:"True"}]}};
  const image={image_summary:{digest}};
  const read:any=async(_project:string,args:string[])=>JSON.stringify(args[1]==="services"?service:args[1]==="revisions"?revision:image);
  return{service,revision,image,read};
}

describe("operator candidate smoke credential",()=>{
  test("defaults to an offline plan with a fixed workspace and no credential process",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"engram-smoke-plan-")),marker=join(directory,"called");
    try {
      writeFileSync(join(directory,"gcloud"),`#!/bin/sh\ntouch '${marker}'\nexit 99\n`,{mode:0o700});
      const child=Bun.spawn([process.execPath,"deploy/smoke-candidate.ts","--project","ani-hq","--image","gcr.io/ani-hq/engram:reviewed-build","--state-file",join(directory,"not-yet-created.json")],{cwd:repository,env:{PATH:directory},stdout:"pipe",stderr:"pipe"});
      const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(code,error).toBe(0);
      expect(JSON.parse(out)).toMatchObject({mode:"plan",orgId:1,credential:{role:"agent",canWrite:false,issuerKind:"operator"},ownerRequired:true,tokenOutput:false});
      expect(existsSync(marker)).toBe(false);
      for(const args of [["--project","ani-hq","--org","7"],["--project","ani-hq","--image","gcr.io/other/engram:build","--state-file","x"]])expect(()=>settings(args)).toThrow();
    } finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("checks and locks owner plus disabled provider consent before issuing only a read-only agent token",async()=>{
    const fixture=database();let bearer="";
    const result=await withSmokeCredential(fixture.db,async raw=>{bearer=raw;expect(fixture.row()?.revoked).toBe(false);});
    expect(result).toEqual({ok:true,reason:"smoke_passed",tokenRevoked:true,cleanupRequired:false});
    expect(bearer).toMatch(/^eng_[A-Za-z0-9_-]{43}$/);
    const insert=fixture.calls.find(call=>call.query.includes("INSERT INTO tokens"))!;
    expect(insert.query).toContain("1,'agent',false,'operator',NULL,NULL");
    expect(insert.values[1]).toBe(createHash("sha256").update(bearer).digest("hex"));
    expect(JSON.stringify(fixture.calls)).not.toContain(bearer);
    expect(JSON.stringify(result)).not.toContain(bearer);
    expect(fixture.calls.filter(call=>call.query.includes("FOR NO KEY UPDATE"))).toHaveLength(4);
    expect(fixture.calls.filter(call=>call.query.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(fixture.row()?.revoked).toBe(true);
  });

  test("missing owner, enabled provider processing or prior cancellation never issues a credential",async()=>{
    for(const [input,reason] of [[{owner:false},"owner_required"],[{provider:true},"provider_processing_enabled"],[{jev:true},"provider_processing_enabled"]] as const){
      const fixture=database(input),result=await withSmokeCredential(fixture.db,async()=>{throw new Error("Must not call candidate");});
      expect(result).toMatchObject({ok:false,reason,cleanupRequired:false});
      expect(fixture.calls.some(call=>call.query.includes("INSERT INTO tokens"))).toBe(false);
    }
    const controller=new AbortController();controller.abort();const fixture=database();
    expect(await withSmokeCredential(fixture.db,async()=>{},controller.signal)).toMatchObject({ok:false,reason:"interrupted"});
    expect(fixture.calls).toHaveLength(0);
  });
  test("an owner replacement between issuance and reads revokes the credential instead of transmitting it",async()=>{
    const fixture=database({ownerIds:[[41],[42]]});let called=false;
    const result=await withSmokeCredential(fixture.db,async()=>{called=true;});
    expect(result).toMatchObject({ok:false,reason:"owner_changed",tokenRevoked:true,cleanupRequired:false});expect(called).toBe(false);expect(fixture.row()?.revoked).toBe(true);
  });

  test("immutable candidate proof binds tag URL, revision, image digest and a single provider-free worker environment",()=>{
    const options=settings(["--project","ani-hq","--image","gcr.io/ani-hq/engram:reviewed-build","--state-file","/tmp/engram-proof-fixture.json"]);
    const state={project:options.project,region:options.region,service:"engram",image:options.image,tag:options.tag,candidateRevision:"engram-r-fixture",candidateURL:"https://candidate-fixture.a.run.app"};
    const safe=cloudFixture(state);expect(validateCandidateSmokeEnvironment(options,state,safe.service,safe.revision,safe.image)).toEqual({revision:state.candidateRevision,imageDigest:`gcr.io/ani-hq/engram@${digest}`});
    const reject=(mutate:(fixture:any)=>void)=>{const value:any=cloudFixture(state);mutate(value);expect(()=>validateCandidateSmokeEnvironment(options,state,value.service,value.revision,value.image)).toThrow();};
    reject(value=>value.service.status.traffic[0].revisionName="engram-other");reject(value=>value.service.status.traffic[0].url="https://other.a.run.app");reject(value=>value.service.status.traffic.push(value.service.status.traffic[0]));
    reject(value=>value.revision.metadata.name="engram-other");reject(value=>value.revision.metadata.labels["serving.knative.dev/service"]="another-service");reject(value=>value.revision.metadata.labels["cloud.googleapis.com/location"]="us-east1");
    reject(value=>value.image.image_summary.digest="sha256:"+"b".repeat(64));reject(value=>value.revision.status.imageDigest="gcr.io/ani-hq/engram@sha256:"+"b".repeat(64));reject(value=>value.revision.spec.containers.push(value.revision.spec.containers[0]));
    for(const entry of [{name:"VOYAGE_API_KEY",value:""},{name:"VOYAGE_API_KEY",valueFrom:{secretKeyRef:{name:"private-secret",key:"latest"}}},{name:"NODE_OPTIONS",value:"--require private"},{name:"BUN_OPTIONS",value:"--preload private"},{name:"LD_PRELOAD",value:"private"},{name:"GBRAIN_BIN",value:"/tmp/other-worker"},{name:"ENGRAM_WORKER_ISOLATION",value:"process"}])reject(value=>value.revision.spec.containers[0].env.push(entry));
    for(const field of ["command","args","volumeMounts","envFrom"])reject(value=>value.revision.spec.containers[0][field]=[{name:"override"}]);
    reject(value=>value.revision.spec.volumes=[{name:"private",secret:{secretName:"private"}}]);reject(value=>value.revision.spec.containers[0].workingDir="/tmp/unreviewed");reject(value=>delete value.revision.spec.containers[0].env);reject(value=>value.revision.status.conditions=[]);
    reject(value=>value.revision.spec.containers[0].env=value.revision.spec.containers[0].env.filter((entry:any)=>entry.name!=="ENGRAM_WORKER_ISOLATION"));
  });

  test("smoke failure and unknown issuance commit still revoke exactly the generated credential",async()=>{
    for(const input of [{},{unknownIssue:true}]){
      const fixture=database(input);
      const result=await withSmokeCredential(fixture.db,async()=>{throw new Error("PRIVATE_CANDIDATE_RESPONSE_DO_NOT_LOG");});
      expect(result).toMatchObject({ok:false,tokenRevoked:true,cleanupRequired:false});
      expect(fixture.row()?.revoked).toBe(true);
      const revoke=fixture.calls.find(call=>call.query.includes("UPDATE tokens"))!;
      expect(revoke.query).toContain("org_id=1 AND name=? AND sha256_hash=?");
      expect(revoke.values).toEqual([fixture.row()!.name,fixture.row()!.hash]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
  });

  test("unconfirmed revocation fails closed with a nonsecret cleanup identity",async()=>{
    const fixture=database({revokeFails:true});let bearer="";
    const result=await withSmokeCredential(fixture.db,async raw=>{bearer=raw;});
    expect(result).toMatchObject({ok:false,reason:"credential_cleanup_unconfirmed",tokenRevoked:false,cleanupRequired:true,credential:{orgId:1,name:fixture.row()!.name}});
    expect(JSON.stringify(result)).not.toContain(bearer);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  test("activation proof is published only after successful smoke and confirmed revocation",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"engram-smoke-proof-")),stateFile=join(directory,"state.json");
    const options=settings(["--project","ani-hq","--image","gcr.io/ani-hq/engram:reviewed-build","--state-file",stateFile,"--run"]);
    const state={project:"ani-hq",region:"us-central1",service:"engram",image:options.image,tag:"candidate",candidateRevision:"engram-r-fixture",candidateURL:"https://candidate-fixture.a.run.app",publicSmoke:true,privateSmoke:true};
    try {
      for(const revokeFails of [false,true]){
        writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});const fixture=database({revokeFails});
        const result=await run(options,undefined,{read:cloudFixture(state).read,connect:(async(_options:any,mode:any,work:any)=>{expect(mode).toBe("write");return work(fixture.db);}) as any,
          smoke:async(_options,scratch,raw)=>{
            expect(raw).toMatch(/^eng_/);
            expect(JSON.parse(readFileSync(stateFile,"utf8")).privateSmoke).toBe(false);
            const proof=JSON.parse(readFileSync(scratch,"utf8"));writeFileSync(scratch,JSON.stringify({...proof,publicSmoke:true,privateSmoke:true,smokeAt:new Date().toISOString()}),{mode:0o600});
          }});
        expect(result.ok).toBe(!revokeFails);
        expect(JSON.parse(readFileSync(stateFile,"utf8")).privateSmoke).toBe(!revokeFails);
      }
    } finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("only verified cloud metadata plus the fixed release subprocess permits saved consent without changing it",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"engram-smoke-safe-provider-")),stateFile=join(directory,"state.json"),priorPath=process.env.PATH;
    const options=settings(["--project","ani-hq","--image","gcr.io/ani-hq/engram:reviewed-build","--state-file",stateFile,"--run"]);
    const state={project:options.project,region:options.region,service:"engram",image:options.image,tag:options.tag,candidateRevision:"engram-r-fixture",candidateURL:"https://candidate-fixture.a.run.app"};
    try {
      writeFileSync(join(directory,"python3"),`#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';await Bun.stdin.text();const args=process.argv.slice(2),path=args[args.indexOf('--state-file')+1],state=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...state,publicSmoke:true,privateSmoke:true,smokeAt:new Date().toISOString()}));`,{mode:0o700});
      const cloud=cloudFixture(state);
      writeFileSync(join(directory,"gcloud"),`#!${process.execPath}\nconst args=process.argv.slice(2),value=args[1]==='services'?${JSON.stringify(cloud.service)}:args[1]==='revisions'?${JSON.stringify(cloud.revision)}:${JSON.stringify(cloud.image)};process.stdout.write(JSON.stringify(value));`,{mode:0o700});
      process.env.PATH=directory+(priorPath?":"+priorPath:"");
      const fixture=database({provider:true,jev:true});writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});
      const result=await run(options,undefined,{connect:(async(_o:any,_mode:any,work:any)=>work(fixture.db))as any});
      expect(result).toEqual({ok:true,reason:"smoke_passed",tokenRevoked:true,cleanupRequired:false});expect(fixture.row()?.revoked).toBe(true);
      expect(fixture.calls.some(call=>/UPDATE\s+orgs|policies\s*=/.test(call.query))).toBe(false);expect(JSON.parse(readFileSync(stateFile,"utf8")).smokeEnvironment).toEqual({revision:state.candidateRevision,imageDigest:`gcr.io/ani-hq/engram@${digest}`});
      for(const kind of ["callback","interpreter","metadata-reader"]){
        writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});const denied=database({provider:true});
        const blocked=await run({...options,...(kind==="interpreter"?{python:join(directory,"python3")}:{})},undefined,{...(kind==="metadata-reader"?{read:cloudFixture(state).read}:{}),connect:(async(_o:any,_mode:any,work:any)=>work(denied.db))as any,...(kind==="callback"?{smoke:async()=>{throw new Error("must not run");}}:{})});
        expect(blocked).toMatchObject({ok:false,reason:"provider_processing_enabled"});expect(denied.row()).toBeUndefined();
      }
      writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});let connected=false;const unsafe=cloudFixture(state);unsafe.revision.spec.containers[0].env.push({name:"VOYAGE_API_KEY",value:"private"} as any);
      await expect(run(options,undefined,{read:unsafe.read,connect:(async()=>{connected=true;})as any})).rejects.toMatchObject({code:"candidate_environment_unverified"});expect(connected).toBe(false);expect(JSON.parse(readFileSync(stateFile,"utf8")).privateSmoke).toBe(false);
    } finally {if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;rmSync(directory,{recursive:true,force:true});}
  });

  test("release subprocess receives its bearer only on stdin and cannot echo it through helper logs",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"engram-smoke-stdin-")),python=join(directory,"python-fixture"),marker=join(directory,"safe-result.json");
    const raw="eng_"+"x".repeat(43);
    try {
      writeFileSync(join(directory,"metadata-only.json"),JSON.stringify({project:"ani-hq",region:"us-central1",service:"engram",image:"gcr.io/ani-hq/engram:reviewed-build",tag:"candidate",candidateRevision:"engram-r-fixture",candidateURL:"https://candidate-fixture.a.run.app"}),{mode:0o600});
      writeFileSync(python,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';const token=(await Bun.stdin.text()).trim();writeFileSync(${JSON.stringify(marker)},JSON.stringify({stdinCorrect:token===${JSON.stringify(raw)},inArguments:process.argv.some(arg=>arg.includes(token)),stdinFlag:process.argv.includes('--smoke-token-stdin')}));console.log(token);console.error(token);`,{mode:0o700});
      const script=`const {releaseSmoke,settings}=await import('./deploy/smoke-candidate');const options=settings(${JSON.stringify(["--project","ani-hq","--image","gcr.io/ani-hq/engram:reviewed-build","--state-file",join(directory,"metadata-only.json"),"--python",python,"--run"])});await releaseSmoke(options,options.stateFile,${JSON.stringify(raw)},new AbortController().signal);`;
      const child=Bun.spawn([process.execPath,"--eval",script],{cwd:repository,stdout:"pipe",stderr:"pipe"});
      const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(code,error).toBe(0);expect(out).toBe("");expect(error).toBe("");
      expect(JSON.parse(readFileSync(marker,"utf8"))).toEqual({stdinCorrect:true,inArguments:false,stdinFlag:true});
    } finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("smoke subprocess uses the exact reviewed Jev billing and zero-markup settings",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"engram-smoke-jev-")),stateFile=join(directory,"state.json"),python=join(directory,"python-fixture"),marker=join(directory,"flags.json");
    const state={project:"ani-hq",region:"us-central1",service:"engram",image:"gcr.io/ani-hq/engram:reviewed-build",tag:"candidate",candidateRevision:"engram-r-fixture",candidateURL:"https://candidate-fixture.a.run.app"};
    try {
      writeFileSync(python,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';await Bun.stdin.text();const args=process.argv.slice(2);const i=args.indexOf('--jev-markup-bps');writeFileSync(${JSON.stringify(marker)},JSON.stringify({customerBillingEnabled:args.includes('--jev-enable-customer-billing'),markupBps:i<0?null:Number(args[i+1])}));`,{mode:0o700});
      const options=settings(["--project","ani-hq","--image",state.image,"--state-file",stateFile,"--python",python,"--run"]);
      const {releaseSmoke}=await import("../deploy/smoke-candidate");
      for(const jev of [undefined,{customerBillingEnabled:false,markupBps:null},{customerBillingEnabled:false,markupBps:0},{customerBillingEnabled:true,markupBps:0},{customerBillingEnabled:true,markupBps:1000}]){
        writeFileSync(stateFile,JSON.stringify({...state,...(jev===undefined?{}:{jev})}),{mode:0o600});
        await releaseSmoke(options,stateFile,"eng_"+"x".repeat(43),new AbortController().signal);
        expect(JSON.parse(readFileSync(marker,"utf8"))).toEqual(jev??{customerBillingEnabled:false,markupBps:null});
      }
    } finally{rmSync(directory,{recursive:true,force:true});}
  });

  test("invalid reviewed Jev settings fail before an operator credential can be issued",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"engram-smoke-jev-invalid-")),stateFile=join(directory,"state.json");
    const options=settings(["--project","ani-hq","--image","gcr.io/ani-hq/engram:reviewed-build","--state-file",stateFile,"--run"]);
    const state={project:"ani-hq",region:"us-central1",service:"engram",image:options.image,tag:"candidate",candidateRevision:"engram-r-fixture",candidateURL:"https://candidate-fixture.a.run.app"};
    let connected=false;
    try {
      for(const jev of [null,[],{customerBillingEnabled:"true",markupBps:0},{customerBillingEnabled:true,markupBps:null},{customerBillingEnabled:true,markupBps:-1},{customerBillingEnabled:true,markupBps:10001},{customerBillingEnabled:true,markupBps:0.1},{customerBillingEnabled:false},{customerBillingEnabled:false,markupBps:0,unexpected:"override"}]){
        writeFileSync(stateFile,JSON.stringify({...state,jev}),{mode:0o600});
        await expect(run(options,undefined,{connect:(async()=>{connected=true;throw new Error("Must not connect");}) as any})).rejects.toMatchObject({code:"invalid_jev_release_settings"});
      }
      expect(connected).toBe(false);
    } finally{rmSync(directory,{recursive:true,force:true});}
  });
});
