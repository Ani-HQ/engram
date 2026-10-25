/** A Cloud SQL-like CREATEROLE/CREATEDB provisioner, never a superuser.
 * Only the marked disposable loopback PostgreSQL cluster is permitted. */
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

async function checkProvisionerJobBootstrap(template: string, admin: postgres.Sql, provisioner: string, runtime: string, password: string, runtimePassword: string): Promise<number> {
  // The real job intentionally fixes the metadata database name. Preserve the
  // marked parent fixture while exercising its full entrypoint in a fresh DB
  // owned by the managed, non-superuser provisioner. This suite runs alone on
  // its guarded disposable cluster; restore the original name even on failure.
  const saved = "engram_job_parent_fixture";
  assert.equal(Number((await admin`SELECT count(*) AS n FROM pg_database WHERE datname = ${saved}`)[0].n), 0, "Never replace an existing saved fixture");
  const ownerEmail = "managed-job-owner@example.test";
  const runtimeUrl = new URL(template), provisionerUrl = new URL(template);
  runtimeUrl.username = runtime; runtimeUrl.password = runtimePassword;
  provisionerUrl.username = provisioner; provisionerUrl.password = password;
  const env = { ...process.env, ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_DATABASE_AUTHORITY: "provisioner", ENGRAM_DB_URL_TEMPLATE: runtimeUrl.toString(), ENGRAM_PROVISIONER_DB_URL_TEMPLATE: provisionerUrl.toString(), ENGRAM_TENANT_CREDENTIAL_KEY: "engram-managed-disposable-key-32-characters", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "", ENGRAM_PROVISION_JOB: "", ENGRAM_ONBOARDING_EMAILS: "0", ENGRAM_JEV_BILLING_ENABLED: "0", ENGRAM_JEV_OPERATOR_EMAIL: ownerEmail, ENGRAM_JEV_OPERATOR_WORKSPACE_ID: "1", ENGRAM_JEV_OPERATOR_MONTHLY_BUDGET_USD: "1" };
  const child = async (code: string) => {
    const process = Bun.spawn([globalThis.process.execPath, "--eval", `globalThis.fetch=async()=>{throw new Error('External requests forbidden in managed job regression')};try{${code}}catch(error){console.log(JSON.stringify({ok:false,sqlState:/^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:'test_failure'}));process.exitCode=1;}`], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => process.kill("SIGKILL"), 30_000);
    try {
      const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited, process.stderr.pipeTo(new WritableStream({ write() {} }))]);
      assert.equal(code, 0, output);
      return JSON.parse(output);
    } finally { clearTimeout(timer); if (process.exitCode === null) { process.kill("SIGKILL"); await process.exited; } }
  };
  let isolated = false, db: postgres.Sql | undefined, reader: postgres.Sql | undefined;
  let checks = 0;
  try {
    // Parent suites have closed their clients; fence any remaining test-only
    // sessions before a rename rather than copying or altering their data.
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'engram_gateway' AND pid <> pg_backend_pid()`;
    await admin.unsafe(`ALTER DATABASE engram_gateway RENAME TO ${saved}`); isolated = true;
    await admin.unsafe(`CREATE DATABASE engram_gateway OWNER ${provisioner}`);
    db = postgres(template.replace("__DB__", "engram_gateway"), { max: 1, onnotice() {} });
    for (const extension of ["vector", "pg_trgm", "pgcrypto"]) await db.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    // The managed role needs ADMIN on the separately created runtime role to
    // rotate its password; the runtime receives no role memberships itself.
    const version = Number((await admin`SHOW server_version_num`)[0].server_version_num);
    await admin.unsafe(`GRANT ${runtime} TO ${provisioner} WITH ADMIN OPTION${version >= 160000 ? ", INHERIT FALSE, SET TRUE" : ""}`);
    const migrated = await child(`const {migrate,closeDatabasePools}=await import('./gateway/src/db');try{await migrate();console.log(JSON.stringify({ok:true}));}finally{await closeDatabasePools();}`);
    assert.equal(migrated.ok, true); checks++;
    await db`UPDATE orgs SET provisioning_status='ready', provisioned_at=now() WHERE id=1`;
    const owner = Number((await db`INSERT INTO org_members(org_id,email,role) VALUES(1,${ownerEmail},'owner') RETURNING id`)[0].id);
    const rejected = await child(`const assert=(await import('node:assert/strict')).default;const {sql,closeDatabasePools}=await import('./gateway/src/db');const {configureJevOperatorDefault}=await import('./gateway/src/jev');try{assert.equal((await sql\`SELECT current_user AS role\`)[0].role,'${runtime}');await assert.rejects(()=>configureJevOperatorDefault(sql,{email:'${ownerEmail}',workspaceId:1}),error=>error.code==='42501');console.log(JSON.stringify({ok:true,wrongPoolRejected:true}));}finally{await closeDatabasePools();}`);
    assert.equal(rejected.wrongPoolRejected, true); checks++;
    assert.equal(Number((await db`SELECT count(*) AS n FROM jev_operator_access`)[0].n), 0); checks++;
    const job = await child(`const {main}=await import('./gateway/src/jobs/provision');await main();`);
    assert.deepEqual(job.provisioning, { ready: 0, failed: 0, pending: 0 }); checks++;
    const [grant] = await db`SELECT a.owner_member_id,a.operator_role,a.explicit_workspace_approved,s.enabled,s.monthly_budget_nanos,
      s.accepted_by_member_id,o.policies->'jevProcessing' AS consent
      FROM jev_operator_access a JOIN workspace_jev_settings s USING(org_id) JOIN orgs o ON o.id=a.org_id WHERE a.org_id=1`;
    assert.deepEqual(grant, { owner_member_id: owner, operator_role: provisioner, explicit_workspace_approved: true, enabled: true, monthly_budget_nanos: "1000000000", accepted_by_member_id: owner, consent: true }); checks++;
    reader = postgres(runtimeUrl.toString().replace("__DB__", "engram_gateway"), { max: 1, onnotice() {} });
    assert.equal((await reader`SELECT current_user AS role`)[0].role, runtime); checks++;
    const [flags] = await reader`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    assert.equal(Object.values(flags).some(Boolean), false); checks++;
    await assert.rejects(async () => { await reader!`UPDATE jev_operator_access SET revoked_at=now() WHERE org_id=1`; }, (error: any) => error.code === "42501"); checks++;
    await db`UPDATE workspace_jev_settings SET enabled=false WHERE org_id=1`;
    await db`UPDATE orgs SET policies=jsonb_set(policies,'{jevProcessing}','false'::jsonb) WHERE id=1`;
    const retry = await child(`const {main}=await import('./gateway/src/jobs/provision');await main();`);
    assert.deepEqual(retry.provisioning, { ready: 0, failed: 0, pending: 0 }); checks++;
    assert.equal(Number((await db`SELECT count(*) AS n FROM jev_operator_access`)[0].n), 1); checks++;
    assert.deepEqual((await db`SELECT s.enabled,o.policies->'jevProcessing' AS consent FROM workspace_jev_settings s JOIN orgs o ON o.id=s.org_id WHERE s.org_id=1`)[0], { enabled: false, consent: false }); checks++;
    return checks;
  } finally {
    await Promise.all([db?.end({ timeout: 1 }), reader?.end({ timeout: 1 })]);
    if (isolated) {
      await admin.unsafe("DROP DATABASE IF EXISTS engram_gateway WITH (FORCE)");
      await admin.unsafe(`ALTER DATABASE ${saved} RENAME TO engram_gateway`);
    }
  }
}

export async function checkManagedProvisioner(template: string): Promise<number> {
  const target = new URL(template);
  if (target.hostname !== "127.0.0.1" || target.port !== "15432" || target.username !== "engram_test" || target.pathname !== "/__DB__" || target.search || target.hash) throw new Error("Managed provisioner regression requires the disposable15432 cluster");
  const admin = postgres(template.replace("__DB__", "postgres"), { max: 1, onnotice() {} });
  const marker = postgres(template.replace("__DB__", "engram_gateway"), { max: 1, onnotice() {} });
  const database = "brain_org_710001", gatewayDatabase = "engram_acl_refresh_test", provisioner = "engram_managed_provisioner_test", runtime = "engram_managed_runtime_test", engine = "engram_tenant_710001";
  const password = `managed-test-${randomUUID()}`;
  const runtimePassword = `managed-runtime-test-${randomUUID()}`;
  let fixture: postgres.Sql | undefined;
  try {
    assert.equal((await marker`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose, "engram-disposable-integration-v1");
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${gatewayDatabase} WITH (FORCE)`);
    for (const role of [engine, provisioner, runtime]) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    const literal = String((await admin`SELECT quote_literal(${password}::text) AS value`)[0].value);
    const runtimeLiteral = String((await admin`SELECT quote_literal(${runtimePassword}::text) AS value`)[0].value);
    await admin.unsafe(`CREATE ROLE ${provisioner} LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION CREATEDB CREATEROLE NOINHERIT PASSWORD ${literal}`);
    await admin.unsafe(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${runtimeLiteral}`);
    await admin.unsafe(`CREATE DATABASE ${database} OWNER ${provisioner}`);
    await admin.unsafe(`CREATE DATABASE ${gatewayDatabase} OWNER ${provisioner}`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${gatewayDatabase} TO ${runtime}`);
    fixture = postgres(template.replace("__DB__", database), { max: 1, onnotice() {} });
    // Managed providers install privileged extensions separately. Their objects
    // deliberately retain the administrator's distinct ownership.
    for (const extension of ["vector", "pg_trgm", "pgcrypto"]) await fixture.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    await fixture.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE ${provisioner}`);
      await tx`CREATE TABLE public.managed_legacy (id integer PRIMARY KEY, value text)`;
      await tx`CREATE TYPE public.managed_kind AS ENUM ('old', 'new')`;
      await tx`CREATE FUNCTION public.managed_legacy_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'`;
      await tx`CREATE PROCEDURE public.managed_legacy_proc() LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END'`;
    });
    await fixture.end(); fixture = undefined;
    fixture = postgres(template.replace("__DB__", gatewayDatabase), { max: 1, onnotice() {} });
    await fixture.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE ${provisioner}`);
      await tx`CREATE TABLE public.acl_probe (id integer PRIMARY KEY)`;
      await tx`INSERT INTO public.acl_probe VALUES (1)`;
      await tx`CREATE TABLE public.workspace_complimentary_access (id integer PRIMARY KEY)`;
      await tx`INSERT INTO public.workspace_complimentary_access VALUES (1)`;
      await tx`CREATE TABLE public.jev_operator_access (id integer PRIMARY KEY)`;
      await tx`INSERT INTO public.jev_operator_access VALUES (1)`;
    });
    await fixture.end(); fixture = undefined;
    const runtimeUrl = new URL(template), provisionerUrl = new URL(template);
    runtimeUrl.username = runtime; runtimeUrl.password = runtimePassword;
    provisionerUrl.username = provisioner; provisionerUrl.password = password;
    const code = `
      import assert from 'node:assert/strict'; import postgres from 'postgres';
      const {provisionTenantDatabase,tenantDbUrl,protectGatewayMetadata}=await import('./gateway/src/tenant-db');
      const phase=query=>typeof query!=='string'?'unknown':/^ALTER SCHEMA/i.test(query)?'schema_owner':/^ALTER (TABLE|SEQUENCE|VIEW)/i.test(query)?'relation_owner':/^ALTER FUNCTION/i.test(query)?'function_owner':/^ALTER (TYPE|DOMAIN)/i.test(query)?'type_owner':/^CREATE EXTENSION/i.test(query)?'extension':/^ALTER DEFAULT/i.test(query)?'default_acl': /^(GRANT|REVOKE).*DATABASE/i.test(query)?'database_acl':/^(GRANT|REVOKE).*SCHEMA/i.test(query)?(/FUNCTIONS/i.test(query)?'function_acl':/TABLES/i.test(query)?'table_acl':/SEQUENCES/i.test(query)?'sequence_acl':'schema_acl'):/^GRANT/i.test(query)?'membership_acl':/^REVOKE/i.test(query)?'other_acl':/^CREATE (SCHEMA|TABLE)/i.test(query)?'control_schema':'other';
      let engineClient, provisionerClient, gatewayClient, observer;
      const readers=[];
      try {
        await provisionTenantDatabase('${database}');
        provisionerClient=postgres(process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE.replace('__DB__','${database}'),{max:1,onnotice(){}});
        const authority=(await provisionerClient\`SELECT pg_has_role(current_user,'${engine}','SET') AS can_set,pg_has_role(current_user,'${engine}','USAGE') AS inherits,(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public') AS schema_owner\`)[0];
        assert.equal(authority.can_set,true); assert.equal(authority.inherits,false); assert.equal(authority.schema_owner,'${provisioner}');
        engineClient=postgres(tenantDbUrl('${database}'),{max:1,onnotice(){}});
        const db=engineClient;
        assert.equal((await db\`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='managed_legacy_proc()'::regprocedure AND prosecdef\`)[0].owner,'${engine}');
        assert.equal((await db\`SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed\`)[0].allowed,false);
        assert.equal((await db\`SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed\`)[0].allowed,true);
        const flags=(await db\`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user\`)[0]; assert(Object.values(flags).every(value=>value===false));
        assert.equal((await db\`SELECT count(*)::integer AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)\`)[0].n,0);
        await db\`ALTER TABLE managed_legacy ADD COLUMN migrated boolean DEFAULT true\`;
        await db\`CREATE TABLE managed_new (id integer)\`;
        await db\`CREATE FUNCTION managed_new_fn() RETURNS integer LANGUAGE sql AS 'SELECT 2'\`;
        assert.equal((await db\`SELECT count(*)::integer AS n FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE p.oid='managed_new_fn()'::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE'\`)[0].n,0);
        await assert.rejects(()=>db\`UPDATE engram_control.workspace SET version=9\`,error=>error.code==='42501');
        await provisionTenantDatabase('${database}');
        assert.equal((await db\`SELECT current_user AS role\`)[0].role,'${engine}');
        assert.equal((await db\`SELECT version FROM engram_control.workspace WHERE id=true\`)[0].version,1);
        assert.equal((await db\`SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('managed_legacy','managed_new') AND pg_get_userbyid(c.relowner)=current_user\`)[0].n,2);
        let checks=13;
        gatewayClient=postgres(process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE.replace('__DB__','${gatewayDatabase}'),{max:1,onnotice(){}});
        observer=postgres(process.env.ENGRAM_MANAGED_TEST_OBSERVER_TEMPLATE.replace('__DB__','${gatewayDatabase}'),{max:1,onnotice(){}});
        assert.equal((await gatewayClient\`SELECT rolsuper FROM pg_roles WHERE rolname=current_user\`)[0].rolsuper,false); checks++;
        await protectGatewayMetadata(gatewayClient);
        for(let i=0;i<2;i++)readers.push(postgres(process.env.ENGRAM_DB_URL_TEMPLATE.replace('__DB__','${gatewayDatabase}'),{max:1,onnotice(){},connection:{statement_timeout:5000}}));
        const pids=await Promise.all(readers.map(async reader=>Number((await reader\`SELECT pg_backend_pid() AS pid\`)[0].pid)));
        assert.equal((await readers[0]\`SELECT count(*)::integer AS n FROM public.acl_probe\`)[0].n,1); checks++;
        const outcomes=[], pauses=[];
        function instrument(client,after){
          const wrapped=(...args)=>client(...args);
          wrapped.unsafe=async(...args)=>{const result=await client.unsafe(...args);await after(args[0]);return result;};
          wrapped.begin=async(work)=>client.begin(tx=>work(instrument(tx,after)));
          return wrapped;
        }
        const match=query=>query==='REVOKE ALL ON TABLE public."acl_probe" FROM "${runtime}"'?0:query==='DROP POLICY IF EXISTS engram_gateway_runtime ON public."acl_probe"'?1:-1;
        const refreshing=instrument(gatewayClient,async query=>{
          const index=match(query); if(index<0)return;
          const tag='engram_acl_overlap_'+index;
          outcomes[index]=readers[index].unsafe('SELECT count(*)::integer AS n FROM public.acl_probe /* '+tag+' */').then(rows=>({ok:true,n:rows[0].n})).catch(error=>({ok:false,code:error.code}));
          let witnessed=false;
          // The writer is paused after the actual REVOKE or policy DROP. Wait
          // until PostgreSQL confirms that the independent runtime read arrived
          // before letting the writer restore access and commit. Reads may
          // block on DDL or observe the old committed permissions; neither may
          // fail or see an empty FORCE-RLS projection.
          for(let attempt=0;attempt<100;attempt++){
            const active=(await observer\`SELECT query FROM pg_stat_activity WHERE pid=\${pids[index]}\`)[0];
            if(active?.query?.includes(tag)){witnessed=true;break;}
            await Bun.sleep(5);
          }
          assert.equal(witnessed,true,'Concurrent runtime read must overlap the exact authority gap'); pauses.push(index);
        });
        await protectGatewayMetadata(refreshing);
        assert.deepEqual(pauses,[0,1]); checks++;
        assert.deepEqual(await Promise.all(outcomes),[{ok:true,n:1},{ok:true,n:1}]); checks++;
        assert.equal((await readers[0]\`SELECT count(*)::integer AS n FROM public.acl_probe\`)[0].n,1); checks++;
        await assert.rejects(()=>readers[0]\`UPDATE public.workspace_complimentary_access SET id=2\`,error=>error.code==='42501'); checks++;
        assert.equal((await readers[0]\`SELECT count(*)::integer AS n FROM public.jev_operator_access\`)[0].n,1); checks++;
        await assert.rejects(()=>readers[0]\`INSERT INTO public.jev_operator_access VALUES (2)\`,error=>error.code==='42501'); checks++;
        await assert.rejects(()=>readers[0]\`UPDATE public.jev_operator_access SET id=2\`,error=>error.code==='42501'); checks++;
        const aborted=instrument(gatewayClient,async query=>{if(match(query)===1)throw Object.assign(new Error('intentional_acl_refresh_abort'),{code:'TEST_ABORT'});});
        await assert.rejects(()=>protectGatewayMetadata(aborted),error=>error.code==='TEST_ABORT'); checks++;
        assert.equal((await readers[1]\`SELECT count(*)::integer AS n FROM public.acl_probe\`)[0].n,1,'Failed refresh must preserve the prior grant and policy'); checks++;
        await assert.rejects(()=>readers[1]\`UPDATE public.workspace_complimentary_access SET id=2\`,error=>error.code==='42501'); checks++;
        console.log(JSON.stringify({ok:true,checks,concurrentAuthorityReads:2,refreshRollbackVerified:true}));
      } catch(error) { console.log(JSON.stringify({ok:false,sqlState:/^[A-Z0-9]{5}$/.test(error.code??'')?error.code:'test_failure',phase:phase(error.query)})); process.exitCode=1; }
      finally { await Promise.all([engineClient?.end({timeout:1}),provisionerClient?.end({timeout:1}),gatewayClient?.end({timeout:1}),observer?.end({timeout:1}),...readers.map(reader=>reader.end({timeout:1}))]); }
    `;
    const child = Bun.spawn([process.execPath, "--eval", code], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_DATABASE_AUTHORITY: "provisioner", ENGRAM_DB_URL_TEMPLATE: runtimeUrl.toString(), ENGRAM_PROVISIONER_DB_URL_TEMPLATE: provisionerUrl.toString(), ENGRAM_MANAGED_TEST_OBSERVER_TEMPLATE: template, ENGRAM_TENANT_CREDENTIAL_KEY: "engram-managed-disposable-key-32-characters", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "" }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited, child.stderr.pipeTo(new WritableStream({ write() {} }))]);
      assert.equal(status, 0, output);
      assert.equal(JSON.parse(output).ok, true);
      // Close the marker client before temporarily preserving its database.
      await marker.end({ timeout: 1 });
      return Number(JSON.parse(output).checks) + await checkProvisionerJobBootstrap(template, admin, provisioner, runtime, password, runtimePassword);
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  } finally {
    await fixture?.end({ timeout: 1 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${gatewayDatabase} WITH (FORCE)`);
    for (const role of [engine, provisioner, runtime]) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await Promise.all([admin.end({ timeout: 1 }), marker.end({ timeout: 1 })]);
  }
}

if (import.meta.main) console.log(`Managed provisioner checks: ${await checkManagedProvisioner(process.env.ENGRAM_TEST_DB_URL_TEMPLATE ?? "")}`);
