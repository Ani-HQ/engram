// Separate public-runtime identity fixture. It never receives an admin URL.
import assert from "node:assert/strict";
import { databaseSecurity } from "../gateway/src/config";
import { closeDatabasePools, ensureDatabase, migrate, sql } from "../gateway/src/db";
import { createOrg, getOrg, withOrg } from "../gateway/src/orgs";
import { normalizeToken } from "../gateway/src/policies";
import { main as provisionerMain } from "../gateway/src/jobs/provision";
assert.equal(databaseSecurity.authority, "runtime");
assert.ok(!process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE);
try {
  const identity = (await sql`SELECT current_database() AS db, current_user AS role`)[0];
  assert.deepEqual(identity, { db: "engram_gateway", role: "engram_gateway_security_test" });
  await migrate(); // readiness SELECT only; runtime has no DDL privileges
  if (process.argv[2] === "queue") {
    const org = await createOrg(`Pending external ${Date.now()}`, "pending@example.test", "personal");
    assert.equal(org.provisioningStatus, "pending");
    await assert.rejects(() => withOrg(org, normalizeToken({ name: "pending", orgId: org.id }), async () => "forbidden"), /being prepared/);
    await assert.rejects(() => ensureDatabase(org.brainDb));
    await assert.rejects(() => provisionerMain(), /Separate provisioner authority/);
    console.log(JSON.stringify({ id: org.id, brainDb: org.brainDb }));
  } else {
    const org = await getOrg(Number(process.argv[2]));
    assert.equal(org?.provisioningStatus, "ready");
    await ensureDatabase(org!.brainDb); // protected read-only readiness marker
    const role = await withOrg(org!, normalizeToken({ name: "ready", orgId: org!.id }), async () => (await (await import("../gateway/src/db")).dataSql()`SELECT current_user AS role`)[0].role);
    assert.equal(role, `engram_tenant_${org!.id}`);
    console.log("ready");
  }
} finally { await closeDatabasePools(); }
