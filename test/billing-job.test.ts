import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..',import.meta.url));
async function run(options: {enabled?:boolean;authority?:string;mode?:string;dryRun?:boolean;pending?:number;review?:number;fail?:boolean}={}) {
  const directory=mkdtempSync(join(tmpdir(),'engram-billing-job-')),marker=join(directory,'closed'),calls=join(directory,'calls'),preload=join(directory,'preload.ts');
  writeFileSync(preload,`import{mock}from'bun:test';import{writeFileSync,appendFileSync}from'node:fs';
    const record=v=>appendFileSync(${JSON.stringify(calls)},v+'\\n');process.env.ENGRAM_JEV_BILLING_WORKER_ENABLED=${JSON.stringify(options.enabled===false?'0':'1')};
    mock.module(${JSON.stringify(join(repository,'gateway/src/config.ts'))},()=>({config:{deploymentMode:${JSON.stringify(options.mode??'hosted')},publicUrl:'https://billing.example',billing:{secretKey:'test-fixture-no-provider'}},databaseSecurity:{authority:${JSON.stringify(options.authority??'runtime')}}}));
    mock.module(${JSON.stringify(join(repository,'gateway/src/db.ts'))},()=>({migrate:async()=>record('schema'),closeDatabasePools:async()=>writeFileSync(${JSON.stringify(marker)},'closed')}));
    mock.module(${JSON.stringify(join(repository,'gateway/src/billing.ts'))},()=>({drainJevBilling:async(_deps,args)=>{record(JSON.stringify(args));${options.fail?"throw new Error('private-provider-key-and-recipient')":`return {enabled:true,pending:${options.pending??0},exported:1,review:${options.review??0},dryRun:${options.dryRun===true}}`}}}));`);
  try {
    const child=Bun.spawn([process.execPath,'--preload',preload,'gateway/src/jobs/billing.ts',...(options.dryRun?['--dry-run']:[])],{cwd:repository,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(readFileSync(marker,'utf8')).toBe('closed');
    let operations='';try{operations=readFileSync(calls,'utf8');}catch{}
    return {stdout,stderr,code,operations};
  } finally {rmSync(directory,{recursive:true,force:true});}
}
test('billing job restricts authority and stays inert until explicitly enabled',async()=>{
  const disabled=await run({enabled:false});expect(disabled.code).toBe(0);expect(disabled.operations).toBe('');
  for(const bad of [{authority:'provisioner'},{mode:'self-hosted'}]){const result=await run(bad);expect(result.code).toBe(1);expect(result.operations).toBe('');}
});
test('billing job verifies schema, bounds work and reports outstanding review',async()=>{
  const result=await run();expect(result.code).toBe(0);expect(result.operations).toBe('schema\n{"dryRun":false,"limit":25}\n');expect(JSON.parse(result.stdout).billing.exported).toBe(1);
  expect((await run({review:1})).code).toBe(1);expect((await run({pending:1})).code).toBe(1);
});
test('billing dry-run inspects safely before activation and errors never echo credentials',async()=>{
  const dry=await run({enabled:false,dryRun:true,pending:1});expect(dry.code).toBe(0);expect(dry.operations).toContain('"dryRun":true');
  const failed=await run({fail:true});expect(failed.code).toBe(1);expect(failed.stdout).toBe('');expect(failed.stderr).toBe('[billing] usage reconciliation failed; inspect aggregate billing state\n');
});

test('real disabled billing import graph needs no database, provider or worker isolation',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'engram-billing-real-disabled-')),marker=join(directory,'network'),guard=join(directory,'network-guard.ts');
  writeFileSync(guard,`import net from 'node:net';import{writeFileSync}from'node:fs';
    writeFileSync(${JSON.stringify(marker)},'0');
    const denied=()=>{writeFileSync(${JSON.stringify(marker)},'1');throw new Error('Unexpected network request in disabled job');};
    net.Socket.prototype.connect=denied;globalThis.fetch=async()=>denied();`);
  try {
    const child=Bun.spawn([process.execPath,'--no-env-file','--preload',guard,'gateway/src/jobs/billing.ts'],{cwd:repository,stdin:'ignore',stdout:'pipe',stderr:'pipe',env:{
      HOME:directory,ENGRAM_DEPLOYMENT_MODE:'hosted',ENGRAM_DATABASE_AUTHORITY:'runtime',ENGRAM_WORKER_ISOLATION:'process',
      ENGRAM_DB_URL_TEMPLATE:'postgresql://engram_disabled:dummy@127.0.0.1:1/__DB__',ENGRAM_TENANT_CREDENTIAL_KEY:'disabled-test-only-master-key-at-least-32-bytes',
      ENGRAM_JEV_BILLING_WORKER_ENABLED:'0',ENGRAM_JEV_BILLING_ENABLED:'0',ENGRAM_PUBLIC_URL:'https://disabled.example',
    }});
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    try {
      const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(code).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({billing:{enabled:false,pending:0,exported:0,review:0}});
      expect(readFileSync(marker,'utf8')).toBe('0');
    } finally {clearTimeout(timer);}
  } finally {rmSync(directory,{recursive:true,force:true});}
});
