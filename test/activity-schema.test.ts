import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { ACTIVITY_SCHEMA_VERSION, GATEWAY_SCHEMA_VERSION, assertRuntimeSchema, ensureProvisioningSchema, markSchemaReady } from "../gateway/src/provisioning-schema";
import { BILLING_SCHEMA_VERSION } from "../gateway/src/billing-schema";
import { HOSTED_SIGNUP_SCHEMA_VERSION, SIGNUP_ACCESS_SCHEMA_VERSION } from "../gateway/src/signup-invites-schema";
import { MAIL_SERIES_SCHEMA_VERSION } from "../gateway/src/mail-series-schema";
import { JEV_SCHEMA_VERSION } from "../gateway/src/jev-schema";
import { PROFILE_PHOTO_SCHEMA_VERSION, PROFILE_PRESENTATION_SCHEMA_VERSION, SHOWCASE_SCHEMA_VERSION } from "../gateway/src/showcase-schema";
import { CONTEXT_SHARING_SCHEMA_VERSION } from "../gateway/src/context-sharing-schema";
import { CONNECTIONS_SCHEMA_VERSION } from "../gateway/src/connections-schema";
import { MEMORY_USAGE_SCHEMA_VERSION } from "../gateway/src/memory-usage-schema";

const ready = { version: GATEWAY_SCHEMA_VERSION, activity_version: ACTIVITY_SCHEMA_VERSION, billing_version: BILLING_SCHEMA_VERSION, signup_version: HOSTED_SIGNUP_SCHEMA_VERSION, signup_access_version: SIGNUP_ACCESS_SCHEMA_VERSION, mail_series_version: MAIL_SERIES_SCHEMA_VERSION, jev_version: JEV_SCHEMA_VERSION, showcase_version: SHOWCASE_SCHEMA_VERSION, profile_presentation_version: PROFILE_PRESENTATION_SCHEMA_VERSION, profile_photo_version: PROFILE_PHOTO_SCHEMA_VERSION, context_sharing_version: CONTEXT_SHARING_SCHEMA_VERSION, connections_version: CONNECTIONS_SCHEMA_VERSION, memory_usage_version: MEMORY_USAGE_SCHEMA_VERSION as number | null | undefined, role:"engram_gateway_runtime", rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,rolreplication:false,inherits_roles:false };
function database(row:Record<string,unknown>|null=ready){
  const calls:{query:string;values:unknown[]}[]=[];
  const db=((parts:TemplateStringsArray,...values:unknown[])=>{const query=parts.join("?");calls.push({query,values});return Promise.resolve(query.includes("SELECT s.version")?(row?[row]:[]):[]);}) as unknown as postgres.Sql;
  return {db,calls};
}

describe("additive activity schema readiness",()=>{
  test("keeps the old authority marker while recording feature readiness separately",async()=>{
    const {db,calls}=database();
    expect(GATEWAY_SCHEMA_VERSION).toBe(2026102202);
    expect(ACTIVITY_SCHEMA_VERSION).toBe(2026102301);
    expect(HOSTED_SIGNUP_SCHEMA_VERSION).toBe(2026102401);
    expect(SHOWCASE_SCHEMA_VERSION).toBe(2026102501);
    expect(PROFILE_PRESENTATION_SCHEMA_VERSION).toBe(2026102502);
    await ensureProvisioningSchema(db);
    expect(calls.some(call=>call.query.includes("ADD COLUMN IF NOT EXISTS activity_version integer"))).toBe(true);
    expect(calls.some(call=>call.query.includes("ADD COLUMN IF NOT EXISTS signup_version integer"))).toBe(true);
    expect(calls.some(call=>call.query.includes("ADD COLUMN IF NOT EXISTS signup_access_version integer"))).toBe(true);
    expect(calls.some(call=>call.query.includes("ADD COLUMN IF NOT EXISTS profile_presentation_version integer"))).toBe(true);
    expect(calls.some(call=>call.query.includes("ADD COLUMN IF NOT EXISTS profile_photo_version integer"))).toBe(true);
    expect(calls.some(call=>call.query.includes("ADD COLUMN IF NOT EXISTS memory_usage_version integer"))).toBe(true);
    await markSchemaReady(db);
    expect(calls.at(-1)?.values).toEqual([2026102202,2026102301,BILLING_SCHEMA_VERSION,HOSTED_SIGNUP_SCHEMA_VERSION,SIGNUP_ACCESS_SCHEMA_VERSION,MAIL_SERIES_SCHEMA_VERSION,JEV_SCHEMA_VERSION,2026102501,2026102502,PROFILE_PHOTO_SCHEMA_VERSION,CONTEXT_SHARING_SCHEMA_VERSION,CONNECTIONS_SCHEMA_VERSION,MEMORY_USAGE_SCHEMA_VERSION]);
    expect(calls.at(-1)?.query).toContain("activity_version = EXCLUDED.activity_version");
    expect(calls.at(-1)?.query).toContain("profile_presentation_version = EXCLUDED.profile_presentation_version");
    await expect(assertRuntimeSchema(db)).resolves.toBeUndefined();
  });
  test("new runtime rejects absent or wrong feature readiness without weakening role constraints",async()=>{
    for (const profile_photo_version of [undefined, null, PROFILE_PHOTO_SCHEMA_VERSION-1, PROFILE_PHOTO_SCHEMA_VERSION+1]) await expect(assertRuntimeSchema(database({ ...ready, profile_photo_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const memory_usage_version of [undefined, null, MEMORY_USAGE_SCHEMA_VERSION-1, MEMORY_USAGE_SCHEMA_VERSION+1]) await expect(assertRuntimeSchema(database({ ...ready, memory_usage_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const connections_version of [undefined, null, CONNECTIONS_SCHEMA_VERSION-1]) await expect(assertRuntimeSchema(database({ ...ready, connections_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const context_sharing_version of [undefined, null, CONTEXT_SHARING_SCHEMA_VERSION-1]) await expect(assertRuntimeSchema(database({ ...ready, context_sharing_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const signup_access_version of [undefined, null, SIGNUP_ACCESS_SCHEMA_VERSION-1]) await expect(assertRuntimeSchema(database({ ...ready, signup_access_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const showcase_version of [undefined, null, SHOWCASE_SCHEMA_VERSION-1, SHOWCASE_SCHEMA_VERSION+1]) await expect(assertRuntimeSchema(database({ ...ready, showcase_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const profile_presentation_version of [undefined, null, PROFILE_PRESENTATION_SCHEMA_VERSION-1, PROFILE_PRESENTATION_SCHEMA_VERSION+1]) await expect(assertRuntimeSchema(database({ ...ready, profile_presentation_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const jev_version of [undefined, null, JEV_SCHEMA_VERSION-1]) await expect(assertRuntimeSchema(database({ ...ready, jev_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for (const mail_series_version of [undefined, null, MAIL_SERIES_SCHEMA_VERSION - 1]) await expect(assertRuntimeSchema(database({ ...ready, mail_series_version }).db)).rejects.toThrow("run the separate provisioner job first");
    for(const row of [null,{...ready,activity_version:undefined},{...ready,activity_version:null},{...ready,activity_version:2026102202},{...ready,activity_version:2026102302},{...ready,billing_version:undefined},{...ready,billing_version:BILLING_SCHEMA_VERSION-1},{...ready,signup_version:undefined},{...ready,signup_version:null},{...ready,signup_version:HOSTED_SIGNUP_SCHEMA_VERSION-1},{...ready,version:2026102301},{...ready,rolsuper:true},{...ready,inherits_roles:true}]){
      await expect(assertRuntimeSchema(database(row).db)).rejects.toThrow("run the separate provisioner job first");
    }
    const missingColumn=((...args:any[])=>Promise.reject(Object.assign(new Error("private SQL details"),{code:"42703"}))) as unknown as postgres.Sql;
    await expect(assertRuntimeSchema(missingColumn)).rejects.toThrow("run the separate provisioner job first");
  });
});
