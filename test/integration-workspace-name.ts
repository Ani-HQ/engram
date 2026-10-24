// Real metadata/authorization checks, called only by the marked disposable PG runner.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createSession, issueToken } from "../gateway/src/auth";
import { config } from "../gateway/src/config";
import { handleOrgApi } from "../gateway/src/org-api";
import { getOrg, renameWorkspace } from "../gateway/src/orgs";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { handleWeb } from "../gateway/src/web";

export async function checkWorkspaceName(db: postgres.Sql): Promise<number> {
  assert.equal((await db`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose, "engram-disposable-integration-v1");
  let checks = 1;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  const orgIds = [840001, 840002];
  equal(Number((await db`SELECT count(*) AS n FROM orgs WHERE id IN ${db(orgIds)}`)[0].n), 0, "Workspace-name fixtures cannot replace existing workspaces");
  const prefix = `rename-${randomUUID()}`, ownerEmail = `${prefix}-owner@example.test`, memberEmail = `${prefix}-member@example.test`;
  const priorMode = config.deploymentMode;
  const snapshot = async (id: number) => (await db`SELECT to_jsonb(o) - 'name' AS value FROM orgs o WHERE id = ${id}`)[0]?.value;
  const request = (raw: string, body: unknown, options: { pin?: string | null; method?: string; consoleHeader?: boolean } = {}) => new Request("https://workspace-name.example/api/workspace", {
    method: options.method ?? "PUT",
    headers: {
      Cookie: `engram_session=${raw}`, "Content-Type": "application/json",
      ...(options.consoleHeader === false ? {} : { "X-Engram-Console": "1" }),
      ...(options.pin === null ? {} : { "X-Engram-Workspace": options.pin ?? String(orgIds[0]) }),
    },
    ...((options.method ?? "PUT") === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  let ownerSession = "", memberSession = "", otherSession = "", token = "";
  let renameConnection: postgres.Sql | undefined;
  let competingRename: Promise<unknown> | undefined;
  try {
    for (const [index, id] of orgIds.entries()) {
      await db`INSERT INTO orgs (id, name, slug, kind, brain_db, data_db, home_dir, policies, provisioning_status)
        VALUES (${id}, ${`Original workspace ${index}`}, ${`${prefix}-${index}`}, ${index === 0 ? "personal" : "team"},
          ${`brain_org_${id}`}, ${`brain_org_${id}`}, ${`org-${id}`}, ${db.json({ ...DEFAULT_POLICIES, agentsMayWrite: false, acceptShares: false })}, 'ready')`;
      await db`INSERT INTO org_members (org_id, email, role) VALUES (${id}, ${ownerEmail}, 'owner')`;
      // Expired hosted access must not block a harmless account-metadata change.
      await db`INSERT INTO workspace_billing (org_id, trial_ends_at) VALUES (${id}, now() - interval '1 day')`;
    }
    await db`INSERT INTO org_members (org_id, email, role) VALUES (${orgIds[0]}, ${memberEmail}, 'member')`;
    ownerSession = await createSession({ orgId: orgIds[0], name: ownerEmail, email: ownerEmail, role: "owner" });
    // Stored role claims cannot promote a live member to workspace owner.
    memberSession = await createSession({ orgId: orgIds[0], name: memberEmail, email: memberEmail, role: "owner" });
    otherSession = await createSession({ orgId: orgIds[1], name: ownerEmail, email: ownerEmail, role: "owner" });
    token = await issueToken(orgIds[0], `${prefix}-agent`, false);
    config.deploymentMode = "hosted";
    const originalTarget = await snapshot(orgIds[0]);
    const originalOther = (await db`SELECT to_jsonb(o) AS value FROM orgs o WHERE id = ${orgIds[1]}`)[0].value;
    const originalBilling = await db`SELECT to_jsonb(b) AS value FROM workspace_billing b WHERE org_id IN ${db(orgIds)} ORDER BY org_id`;
    const databasesBefore = Number((await db`SELECT count(*) AS n FROM pg_database WHERE datname IN (${`brain_org_${orgIds[0]}`}, ${`brain_org_${orgIds[1]}`})`)[0].n);
    equal(databasesBefore, 0, "Ready metadata fixtures have no tenant databases or engines");

    const renamed = await renameWorkspace(orgIds[0], ownerEmail, "  Trimmed personal name  ", db);
    equal([renamed?.id, renamed?.name], [orgIds[0], "Trimmed personal name"], "Live owner can rename and surrounding spaces are trimmed");
    equal(await snapshot(orgIds[0]), originalTarget, "Helper changes only the workspace name");
    equal((await renameWorkspace(orgIds[0], ownerEmail, "x", db))?.name, "x", "A one-character name is valid");
    equal((await renameWorkspace(orgIds[0], ownerEmail, "🧠".repeat(50), db))?.name, "🧠".repeat(50), "The 100 UTF-16-unit boundary accepts valid Unicode names");
    equal(await renameWorkspace(orgIds[0], memberEmail, "Forbidden member name", db), null, "A current member cannot rename the workspace");
    equal(await renameWorkspace(orgIds[0], "absent-owner@example.test", "Forbidden absent name", db), null, "A removed or absent owner cannot rename the workspace");
    equal(await renameWorkspace(0, ownerEmail, "Invalid target", db), null, "Invalid workspace IDs fail closed");
    for (const name of ["", "   ", "a".repeat(101), "name\n", "\u0085name"]) {
      equal(await renameWorkspace(orgIds[0], ownerEmail, name, db), null, "Helper rejects invalid names without writing");
    }

    const response = await handleWeb(request(ownerSession, { name: "  My renamed workspace  " }));
    equal(response.status, 200, "A genuine owner session can rename expired hosted workspace metadata");
    const payload = await response.json();
    equal([payload.org?.id, payload.org?.name, payload.org?.kind], [orgIds[0], "My renamed workspace", "personal"], "The response identifies the renamed current workspace");
    equal(response.headers.get("set-cookie"), null, "Renaming does not mint or exchange credentials");
    equal(response.headers.get("cache-control"), "no-store", "Workspace metadata changes cannot be cached");
    equal(await snapshot(orgIds[0]), originalTarget, "HTTP rename preserves every other target field including slug, storage, policies and provisioning");
    equal((await db`SELECT to_jsonb(o) AS value FROM orgs o WHERE id = ${orgIds[1]}`)[0].value, originalOther, "Another workspace remains completely unchanged");
    equal(await db`SELECT to_jsonb(b) AS value FROM workspace_billing b WHERE org_id IN ${db(orgIds)} ORDER BY org_id`, originalBilling, "Neither workspace's trial or Stripe state changes");
    equal(Number((await db`SELECT count(*) AS n FROM pg_database WHERE datname IN (${`brain_org_${orgIds[0]}`}, ${`brain_org_${orgIds[1]}`})`)[0].n), 0, "Successful renames never provision or start tenant storage");
    const otherFields = await snapshot(orgIds[1]);
    const teamResponse = await handleWeb(request(otherSession, { name: "Renamed team workspace" }, { pin: String(orgIds[1]) }));
    equal(teamResponse.status, 200, "A team owner can rename their selected workspace too");
    equal([(await teamResponse.json()).org?.name, await snapshot(orgIds[1])], ["Renamed team workspace", otherFields], "Team rename also changes only its display name");

    for (const name of [null, 7, {}, [], "", "   ", "a".repeat(101), "\nname", "name\u0000", "name\u007f", "\u0085name", "🧠".repeat(51)]) {
      equal((await handleWeb(request(ownerSession, { name }))).status, 400, "Malformed, oversized and raw-control names return a controlled 400");
    }
    for (const body of [{}, { name: "Allowed", orgId: orgIds[1] }, { name: "Allowed", slug: "forged" }, { name: "Allowed", policies: {} }, []]) {
      equal((await handleWeb(request(ownerSession, body))).status, 400, "Only the name field may be supplied");
    }
    equal((await handleWeb(request(ownerSession, { name: "Missing pin" }, { pin: null }))).status, 400, "A mutation must explicitly pin its selected workspace");
    equal((await handleWeb(request(ownerSession, { name: "Stale pin" }, { pin: String(orgIds[1]) }))).status, 409, "A stale workspace pin cannot rename a different workspace");
    equal((await handleWeb(request(otherSession, { name: "Foreign session" }))).status, 409, "A session belonging to another workspace cannot use the source pin");
    equal((await handleWeb(request(ownerSession, { name: "Missing CSRF" }, { consoleHeader: false }))).status, 403, "The custom-header CSRF boundary still guards renaming");
    equal((await handleWeb(request(memberSession, { name: "Promoted claim" }))).status, 403, "A session's stale owner claim cannot override live member role");
    equal((await handleWeb(request(token, { name: "Agent cookie" }))).status, 401, "An agent token cannot become a hosted owner through a cookie");
    equal((await handleWeb(request(ownerSession, { name: "Wrong method" }, { method: "POST" }))).status, 405, "The workspace mutation accepts only PUT");
    const org = (await getOrg(orgIds[0], db))!;
    for (const kind of ["token", "oauth"] as const) {
      const actor = normalizeToken({ name: ownerEmail, email: ownerEmail, orgId: orgIds[0], role: "owner", kind });
      const denied = await handleOrgApi(request(ownerSession, { name: "Delegated owner" }), new URL("https://workspace-name.example/api/workspace"), actor, org);
      equal(denied?.status, 403, "Delegated or opaque credentials cannot invoke the owner-only rename handler");
    }
    equal((await db`SELECT name FROM orgs WHERE id = ${orgIds[0]}`)[0].name, "My renamed workspace", "All rejected attempts preserve the last authorized name");

    await db`UPDATE orgs SET provisioning_status = 'pending' WHERE id = ${orgIds[0]}`;
    equal(await renameWorkspace(orgIds[0], ownerEmail, "Premature helper rename", db), null, "Helper cannot rename a workspace before storage is ready");
    equal((await handleWeb(request(ownerSession, { name: "Premature HTTP rename" }))).status, 202, "HTTP rename retains the existing provisioning response");
    equal((await db`SELECT name FROM orgs WHERE id = ${orgIds[0]}`)[0].name, "My renamed workspace", "Pending storage never allows a metadata rename");
    await db`UPDATE orgs SET provisioning_status = 'ready' WHERE id = ${orgIds[0]}`;

    // Use a dedicated second connection so the observer proves the rename is
    // actually waiting on demotion, rather than relying on scheduler timing.
    // A reserved Sql handle cannot begin transactions; a separate one-connection
    // pool retains the production helper's real transaction boundary.
    const template = process.env.ENGRAM_TEST_DB_URL_TEMPLATE!;
    renameConnection = postgres(template.replace("__DB__", "engram_gateway"), { max: 1, onnotice() {} });
    const pid = Number((await renameConnection`SELECT pg_backend_pid() AS pid`)[0].pid);
    await renameConnection`SET lock_timeout = '3s'`;
    await db.begin(async blocker => {
      await blocker`UPDATE org_members SET role = 'member' WHERE org_id = ${orgIds[0]} AND email = ${ownerEmail}`;
      competingRename = renameWorkspace(orgIds[0], ownerEmail, "Raced demoted owner", renameConnection!);
      // Observe a rejection immediately too, avoiding an unhandled rejection
      // while the lock-wait observer is still polling.
      void competingRename.catch(() => {});
      let waited = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await db`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
        if (activity[0]?.wait_event_type === "Lock") { waited = true; break; }
        await Bun.sleep(5);
      }
      equal(waited, true, "Concurrent rename waits for the real owner's membership transaction");
    });
    equal(await competingRename, null, "After demotion commits, the waiting rename rechecks membership and fails closed");
    equal((await db`SELECT name FROM orgs WHERE id = ${orgIds[0]}`)[0].name, "My renamed workspace", "A competing demotion prevents the stale owner's write");
    equal((await handleWeb(request(ownerSession, { name: "Old owner session" }))).status, 403, "The existing session loses rename authority immediately on demotion");
    await db`DELETE FROM org_members WHERE org_id = ${orgIds[0]} AND email = ${ownerEmail}`;
    equal(await renameWorkspace(orgIds[0], ownerEmail, "Removed owner", db), null, "A removed membership cannot authorize the helper");
    equal((await handleWeb(request(ownerSession, { name: "Removed owner session" }))).status, 401, "The removed owner's old cookie cannot rename a workspace");
    return checks;
  } finally {
    config.deploymentMode = priorMode;
    if (competingRename) await competingRename.catch(() => {});
    if (renameConnection) {
      await renameConnection.end({ timeout: 1 });
    }
    await db`DELETE FROM tokens WHERE org_id IN ${db(orgIds)}`;
    await db`DELETE FROM sessions WHERE org_id IN ${db(orgIds)}`;
    await db`DELETE FROM workspace_billing WHERE org_id IN ${db(orgIds)}`;
    await db`DELETE FROM org_members WHERE org_id IN ${db(orgIds)}`;
    await db`DELETE FROM orgs WHERE id IN ${db(orgIds)}`;
  }
}
