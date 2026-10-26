/**
 * Real PostgreSQL integration, intentionally outside Bun's mock-module test run.
 * Start a disposable PostgreSQL cluster/container on 127.0.0.1:15432 with a
 * CREATEDB user named engram_test and an empty database named engram_gateway:
 *
 * ENGRAM_TEST_DB_URL_TEMPLATE='postgresql://engram_test@127.0.0.1:15432/__DB__' \
 *   bun test/integration-postgres.ts
 *
 * For CI use a postgres service with POSTGRES_USER=engram_test,
 * POSTGRES_DB=engram_gateway and map 15432:5432. Supply its test-only password
 * in ENGRAM_TEST_DB_URL_TEMPLATE. No production database variable is read.
 * The first run requires an empty database. Later runs reset only a database
 * bearing this script's sandbox marker. Never use a shared development cluster.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderAsync } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import { PROFILE_PHOTO_SCHEMA_VERSION, PROFILE_PRESENTATION_SCHEMA_VERSION } from "../gateway/src/showcase-schema";
import { MEMORY_USAGE_SCHEMA_VERSION } from "../gateway/src/memory-usage-schema";

const template = process.env.ENGRAM_TEST_DB_URL_TEMPLATE;
if (!template) throw new Error("Set ENGRAM_TEST_DB_URL_TEMPLATE to a disposable local PostgreSQL test cluster");
let target: URL;
try { target = new URL(template); } catch { throw new Error("The PostgreSQL integration test URL is invalid"); }
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost"].includes(target.hostname) ||
    target.port !== "15432" || decodeURIComponent(target.username) !== "engram_test" || target.pathname !== "/__DB__" || target.search || target.hash) {
  throw new Error("Integration tests require the engram_test user on a disposable loopback PostgreSQL cluster at port 15432 with the /__DB__ database placeholder");
}
// These assignments precede all application imports, so a local .env cannot
// silently redirect the integration script to the application's real database.
process.env.ENGRAM_DB_URL_TEMPLATE = template;
process.env.ENGRAM_DEPLOYMENT_MODE = "self-hosted";
process.env.ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS = "1";
process.env.ENGRAM_SIGNUP_MODE = "open";
process.env.ENGRAM_PROVISION_JOB = "";

const { sql, migrate, migrateOrgDataTables, ensureDatabase, poolFor, closeOrgPool, dataSql } = await import("../gateway/src/db");
const { recordAction, listActions } = await import("../gateway/src/actions");
const { getActivity, listActivities } = await import("../gateway/src/activities");
const { audit } = await import("../gateway/src/audit");
const { authenticateStoredSecret, issueToken, revokeToken, createSession } = await import("../gateway/src/auth");
const { getOrg, withOrg } = await import("../gateway/src/orgs");
const { currentContext } = await import("../gateway/src/context");
const { handleWeb } = await import("../gateway/src/web");
const { onboardingState } = await import("../gateway/src/org-api");
const { getBillingSummary, requireHostedWriteAccess, BillingError } = await import("../gateway/src/billing");
const { getShowcaseSettings, updateShowcaseSettings, getPublicActivity, handlePublicShowcase } = await import("../gateway/src/showcase");
const { upsertMemoryEntry, getMemoryEntry } = await import("../gateway/src/memory-entries");
const { normalizeToken, DEFAULT_POLICIES } = await import("../gateway/src/policies");
let checks = 0;
function check(value: unknown, message: string): asserts value { assert.ok(value, message); checks++; }
function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
async function rejects(callback: () => Promise<unknown>, predicate: (error: any) => boolean, message: string) {
  await assert.rejects(callback, predicate, message); checks++;
}

try {
  const identity = await sql`SELECT current_user AS username, current_database() AS database`;
  equal(identity[0], { username: "engram_test", database: "engram_gateway" }, "Only the named sandbox database may be modified");
  const existing = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const marked = existing.some(row => row.tablename === "_engram_integration_sandbox");
  if (existing.length && !marked) throw new Error("Refusing to run integration migrations against a non-empty, unmarked database");
  if (!marked) {
    await sql`CREATE TABLE _engram_integration_sandbox (id int PRIMARY KEY CHECK (id = 1), purpose text NOT NULL)`;
    await sql`INSERT INTO _engram_integration_sandbox VALUES (1, 'engram-disposable-integration-v1')`;
  }
  const marker = await sql`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`;
  equal(marker[0]?.purpose, "engram-disposable-integration-v1", "Sandbox marker must match this integration script");
  if (marked && existing.some(row => row.tablename === "orgs")) {
    // All tenant and identity tables in this dedicated sandbox reference orgs.
    // This statement is never reachable on an unmarked application database.
    await sql`TRUNCATE orgs RESTART IDENTITY CASCADE`;
    // The historical audit table intentionally has no org foreign key.
    await sql`TRUNCATE audit_log RESTART IDENTITY`;
    await sql`TRUNCATE billing_webhook_events`;
    // OAuth client registrations are not children of orgs. Fixed inventory
    // fixtures must be reset too when reusing this marked disposable database.
    await sql`TRUNCATE oauth_clients CASCADE`;
  }
  await migrate();
  // Simulate the immediately preceding profile schema only inside this guarded,
  // disposable cluster, then exercise the real additive upgrade on a saved row.
  await sql`ALTER TABLE action_profiles DROP COLUMN layout, DROP COLUMN highlights`;
  await sql`ALTER TABLE engram_schema_state DROP COLUMN profile_presentation_version`;
  const predecessorMarkers = (await sql`SELECT version, activity_version, billing_version, signup_version, signup_access_version, mail_series_version, jev_version, showcase_version, context_sharing_version FROM engram_schema_state WHERE id = true`)[0];
  equal(predecessorMarkers.showcase_version, 2026102501, "The predecessor runtime retains its exact showcase readiness marker");
  await sql`INSERT INTO action_profiles (org_id, slug, display_name, bio, published) VALUES (1, 'legacy-presentation-row', 'Legacy public name', 'Owner-written legacy bio', true)`;
  await migrate();
  equal((await sql`SELECT version, activity_version, billing_version, signup_version, signup_access_version, mail_series_version, jev_version, showcase_version, context_sharing_version FROM engram_schema_state WHERE id = true`)[0], predecessorMarkers, "The presentation upgrade leaves all predecessor readiness markers unchanged for cold starts and traffic rollback");
  equal((await sql`SELECT profile_presentation_version FROM engram_schema_state WHERE id = true`)[0].profile_presentation_version, PROFILE_PRESENTATION_SCHEMA_VERSION, "The additive presentation marker becomes ready separately from the predecessor contracts");
  const upgradedProfile = (await sql`SELECT slug, display_name, bio, published, layout, highlights FROM action_profiles WHERE org_id = 1`)[0];
  equal(upgradedProfile, { slug: "legacy-presentation-row", display_name: "Legacy public name", bio: "Owner-written legacy bio", published: true, layout: "studio", highlights: [] }, "Additive presentation migration preserves an existing published profile and defaults only its new fields");
  await migrate();
  equal((await sql`SELECT version, activity_version, billing_version, signup_version, signup_access_version, mail_series_version, jev_version, showcase_version, context_sharing_version FROM engram_schema_state WHERE id = true`)[0], predecessorMarkers, "Repeating the additive migration still preserves all predecessor readiness markers");
  equal((await sql`SELECT profile_presentation_version FROM engram_schema_state WHERE id = true`)[0].profile_presentation_version, PROFILE_PRESENTATION_SCHEMA_VERSION, "Repeating the additive migration retains exact presentation readiness");
  equal((await sql`SELECT slug, display_name, bio, published, layout, highlights FROM action_profiles WHERE org_id = 1`)[0], upgradedProfile, "Repeating the presentation migration leaves the original owner choices intact");
  // The photo upgrade is additive to every already deployed contract.
  await sql`ALTER TABLE action_profiles DROP COLUMN photo_png, DROP COLUMN photo_digest`;
  await sql`ALTER TABLE engram_schema_state DROP COLUMN profile_photo_version`;
  const beforePhotoMarkers = (await sql`SELECT version, activity_version, billing_version, signup_version, signup_access_version, mail_series_version, jev_version, showcase_version, profile_presentation_version, context_sharing_version, connections_version FROM engram_schema_state WHERE id = true`)[0];
  await migrate();
  equal((await sql`SELECT version, activity_version, billing_version, signup_version, signup_access_version, mail_series_version, jev_version, showcase_version, profile_presentation_version, context_sharing_version, connections_version FROM engram_schema_state WHERE id = true`)[0], beforePhotoMarkers, "Photo migration preserves all predecessor readiness contracts");
  equal((await sql`SELECT profile_photo_version FROM engram_schema_state WHERE id = true`)[0].profile_photo_version, PROFILE_PHOTO_SCHEMA_VERSION, "Photo readiness uses its exact additive marker");
  equal((await sql`SELECT photo_png, photo_digest FROM action_profiles WHERE org_id = 1`)[0], { photo_png: null, photo_digest: null }, "Existing profiles default to no uploaded image");
  equal((await sql`SELECT slug, display_name, bio, published, layout, highlights FROM action_profiles WHERE org_id = 1`)[0], upgradedProfile, "Photo migration preserves owner publication and presentation choices");
  await migrate();
  equal((await sql`SELECT profile_photo_version FROM engram_schema_state WHERE id = true`)[0].profile_photo_version, PROFILE_PHOTO_SCHEMA_VERSION, "Photo migration is repeatable");
  const beforeUsageMarkers = (await sql`SELECT version, activity_version, billing_version, signup_version, signup_access_version, mail_series_version, jev_version, showcase_version, profile_presentation_version, profile_photo_version, context_sharing_version, connections_version FROM engram_schema_state WHERE id = true`)[0];
  await sql`ALTER TABLE engram_schema_state DROP COLUMN memory_usage_version`;
  await migrate();
  equal((await sql`SELECT memory_usage_version FROM engram_schema_state WHERE id = true`)[0].memory_usage_version, MEMORY_USAGE_SCHEMA_VERSION, "Memory usage gets its own exact additive readiness marker");
  equal((await sql`SELECT version, activity_version, billing_version, signup_version, signup_access_version, mail_series_version, jev_version, showcase_version, profile_presentation_version, profile_photo_version, context_sharing_version, connections_version FROM engram_schema_state WHERE id = true`)[0], beforeUsageMarkers, "Memory usage migration preserves every prior feature and authority marker");
  await migrate();
  equal((await sql`SELECT memory_usage_version FROM engram_schema_state WHERE id = true`)[0].memory_usage_version, MEMORY_USAGE_SCHEMA_VERSION, "Memory usage migration is repeatable");
  await sql`DELETE FROM action_profiles WHERE org_id = 1 AND slug = 'legacy-presentation-row'`;
  equal(Number((await sql`SELECT count(*) AS n FROM orgs`)[0].n), 1, "Central migrations are repeatable without duplicating the legacy workspace");
  equal(Number((await sql`SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('tokens_org_name_idx', 'action_events_org_time_idx')`)[0].n), 2, "Tenant identity and action indexes exist on PostgreSQL");

  const now = new Date();
  const createdAt = new Date(now.getTime() - 2 * 86_400_000);
  await sql`
    INSERT INTO orgs (id, name, slug, kind, brain_db, home_dir, data_db, policies, created_at, provisioning_status)
    VALUES (2, 'Integration A', 'integration-a', 'team', 'brain_org_2', 'org-2', 'brain_org_2', ${sql.json(DEFAULT_POLICIES)}, ${createdAt}, 'ready'),
           (3, 'Integration B', 'integration-b', 'team', 'brain_org_3', 'org-3', 'brain_org_3', ${sql.json(DEFAULT_POLICIES)}, ${createdAt}, 'ready')`;
  const orgA = (await getOrg(2))!;
  const orgB = (await getOrg(3))!;
  check(orgA && orgB, "Both tenant storage mappings resolve");
  for (const org of [orgA, orgB]) {
    await ensureDatabase(org.dataDb);
    await migrateOrgDataTables(poolFor(org.dataDb));
    await migrateOrgDataTables(poolFor(org.dataDb));
    await poolFor(org.dataDb)`TRUNCATE memory_entries, trails, reflex_decisions, review_items, dream_runs RESTART IDENTITY CASCADE`;
  }
  assert.throws(() => dataSql(), /workspace context/); checks++;

  // Identical human/agent names are legitimate across workspaces. Their secret
  // credentials, permissions and current memberships must still resolve exactly.
  const rawA = await issueToken(2, "same-agent", true);
  const rawB = await issueToken(3, "same-agent", true);
  const rawReadOnly = await issueToken(2, "read-only-agent", false);
  const agentA = (await authenticateStoredSecret(rawA))!;
  const agentB = (await authenticateStoredSecret(rawB))!;
  equal([agentA.orgId, agentB.orgId, agentA.name, agentB.name], [2, 3, "same-agent", "same-agent"], "Opaque tokens bind identical names to separate tenants");
  equal((await authenticateStoredSecret(rawReadOnly))?.canWrite, false, "Read-only access survives storage and authentication");
  const ownerA = normalizeToken({ name: "owner-a", orgId: 2, role: "owner", kind: "session", email: "owner@example.test" });
  const ownerB = normalizeToken({ name: "owner-b", orgId: 3, role: "owner", kind: "session", email: "owner@example.test" });
  await sql`INSERT INTO org_members (org_id, email, role) VALUES (2, 'owner@example.test', 'owner'), (3, 'owner@example.test', 'owner')`;
  const sessionA = await createSession({ ...ownerA, email: ownerA.email });
  const sessionB = await createSession({ ...ownerB, email: ownerB.email });
  equal((await authenticateStoredSecret(sessionA))?.orgId, 2, "A session is bound to its exact tenant");
  // Exercise real cookie authentication and the HTTP switch route between two
  // ready stores. Metadata switching must not start an engine or carry the
  // source workspace context into the target's onboarding checks.
  const switchRequest = (raw: string, source: number, destination: number) => new Request("https://integration.example/api/session/switch", {
    method: "POST", headers: { Cookie: `engram_session=${raw}`, "X-Engram-Console": "1", "X-Engram-Workspace": String(source), "Content-Type": "application/json" },
    body: JSON.stringify({ orgId: destination }),
  });
  equal(currentContext(), undefined, "HTTP workspace switching starts outside a tenant context");
  const switched = await handleWeb(switchRequest(sessionA, 2, 3));
  equal(switched.status, 200, "A verified member can switch from one ready workspace to another");
  const switchedBody = await switched.json();
  equal([switchedBody.org.id, switchedBody.org.provisioningStatus], [3, "ready"], "The switch response describes the destination workspace");
  equal(switchedBody.onboarding.step, "connect", "Destination onboarding reads its own successful receipts");
  const switchedCookie = switched.headers.get("set-cookie")!;
  check(switchedCookie?.includes("HttpOnly") && switchedCookie.includes("SameSite=Strict"), "Workspace switching returns a protected session cookie");
  const switchedRaw = switchedCookie.split(";")[0].slice("engram_session=".length);
  equal((await authenticateStoredSecret(switchedRaw))?.orgId, 3, "The new session authenticates only as the destination tenant");
  equal((await authenticateStoredSecret(sessionA))?.orgId, 2, "The source credential keeps its original workspace binding");
  const afterSwitch = await handleWeb(new Request("https://integration.example/api/me", { headers: { Cookie: `engram_session=${switchedRaw}`, "X-Engram-Console": "1", "X-Engram-Workspace": "3" } }));
  equal((await afterSwitch.json()).org.id, 3, "The destination cookie selects that workspace on the next real HTTP read");
  const switchedBack = await handleWeb(switchRequest(switchedRaw, 3, 2));
  equal(switchedBack.status, 200, "A ready destination can switch back without leaking its context");
  equal((await switchedBack.json()).org.id, 2, "The return switch identifies the original workspace");
  const sessionsBeforeDeniedSwitch = Number((await sql`SELECT count(*) AS n FROM sessions`)[0].n);
  const deniedSwitch = await handleWeb(switchRequest(sessionA, 2, 1));
  equal(deniedSwitch.status, 404, "A person without destination membership cannot switch into that workspace");
  equal(deniedSwitch.headers.get("set-cookie"), null, "A denied switch cannot replace the browser session");
  equal(Number((await sql`SELECT count(*) AS n FROM sessions`)[0].n), sessionsBeforeDeniedSwitch, "A denied switch does not mint an orphan session");
  await withOrg(orgA, ownerA, async () => {
    await rejects(() => onboardingState(orgB), error => error.status === 403, "Onboarding still rejects a mismatched tenant context");
    equal(currentContext()?.org.id, 2, "A rejected nested onboarding call preserves its source context");
  });
  equal(currentContext(), undefined, "Tenant context is restored after switching and guarded onboarding failures");
  await sql`UPDATE org_members SET role = 'member' WHERE org_id = 2 AND email = 'owner@example.test'`;
  equal((await authenticateStoredSecret(sessionA))?.role, "member", "A demoted owner loses session billing privileges immediately");
  equal((await authenticateStoredSecret(sessionB))?.role, "owner", "Demotion in one tenant does not change another tenant's role");
  await sql`DELETE FROM org_members WHERE org_id = 2 AND email = 'owner@example.test'`;
  equal(await authenticateStoredSecret(sessionA), null, "A removed member cannot reuse an existing session");
  check(await authenticateStoredSecret(sessionB), "The other tenant's session remains valid");

  const utcDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const at = (minutes: number) => new Date(Math.max(utcDayStart, now.getTime() - minutes * 60_000)).toISOString();
  await withOrg(orgA, agentA, async () => {
    await recordAction(agentA, { tool: "github.create_pull_request", summary: "A-only release: 100% reviewed", resource: "https://private-a.example/pull/1", runId: "a-only-run", status: "completed", occurredAt: at(60) });
    await recordAction(agentA, { tool: "gmail.send", summary: "A-only email attempt", runId: "a-only-run", status: "failed", occurredAt: at(30) });
    await recordAction(agentA, { tool: "remember", summary: "A-only memory entry", status: "completed", occurredAt: at(20) });
    await audit("audit-a", "search", '{"q":"A-only private query"}', "ok", "private-a");
    await audit("audit-a", "list_actions", "{}", "ok");
    await rejects(() => recordAction(agentB, { tool: "code.build", summary: "Wrong tenant" }), error => error.status === 403, "A context cannot accept another tenant's actor");
    await rejects(() => listActions(agentB), error => error.status === 403, "A context cannot list another tenant's actions");
  });
  await withOrg(orgB, agentB, async () => {
    await recordAction(agentB, { tool: "calendar.create", summary: "B-only calendar event", status: "completed", occurredAt: at(40) });
    await recordAction(agentB, { tool: "github.create_pull_request", summary: "B-only release", status: "running", occurredAt: at(15) });
    await audit("audit-b", "remember", '{"text":"B-only private memory"}', "ok", "private-b");
  });
  const actionsA = await withOrg(orgA, agentA, () => listActions(agentA));
  const actionsB = await withOrg(orgB, agentB, () => listActions(agentB));
  equal(actionsA.actions.length, 4, "The action ledger unions A's reports and observed Engram audit calls");
  equal(actionsB.actions.length, 3, "Tenant B receives only its own actions and audit calls");
  check(!JSON.stringify(actionsA).includes("B-only") && !JSON.stringify(actionsB).includes("A-only"), "Private action bodies do not cross tenants");
  check(!actionsA.tools.includes("calendar.create") && actionsB.tools.includes("calendar.create"), "Action facets are tenant scoped");
  equal((await listActions(agentA, { q: "100%" })).actions.length, 1, "Search treats SQL wildcards as literal text");
  equal((await listActions(agentA, { resource: "PRIVATE-A.EXAMPLE" })).actions.length, 1, "Resource matching is literal and case insensitive");
  equal((await listActions(agentA, { status: "failed", tool: "gmail.send" })).actions.length, 1, "Combined status and tool filters execute against PostgreSQL");
  const first = await listActions(agentA, { runId: "a-only-run", limit: 1 });
  const second = await listActions(agentA, { runId: "a-only-run", limit: 1, offset: 1 });
  check(first.more && !second.more && first.actions[0].id !== second.actions[0].id, "Run filtering and pagination neither repeat nor skip actions");
  equal(actionsA.actions.filter(action => action.evidence === "observed").map(action => action.tool), ["search"], "Only actual Engram audit records carry observed evidence");

  const entryInput = { slug: "integration/shared-id", rawText: "The same entry body may exist in both tenants.", recordedAt: now.toISOString() };
  const entryA = await withOrg(orgA, agentA, () => upsertMemoryEntry({ ...entryInput, tokenName: "agent-a-only" }));
  const entryB = await withOrg(orgB, agentB, () => upsertMemoryEntry({ ...entryInput, tokenName: "agent-b-only" }));
  check(entryA && entryB, "Tenant data migrations accept real memory inserts");
  equal(entryA.id, entryB.id, "Identical memory content intentionally produces identical entry IDs");
  equal((await withOrg(orgA, agentA, () => getMemoryEntry(entryA.id)))?.tokenName, "agent-a-only", "A's physical tenant database retains its own copy");
  equal((await withOrg(orgB, agentB, () => getMemoryEntry(entryB.id)))?.tokenName, "agent-b-only", "B's physical tenant database retains its own copy");

  const hosted = { mode: "hosted" as const, publicUrl: "https://integration.example", secretKey: "", webhookSecret: "", cloudMonthlyPriceId: "" };
  const billingDeps = { db: sql, settings: hosted, now: () => now };
  const trialA = await withOrg(orgA, ownerA, () => getBillingSummary(ownerA, billingDeps));
  const trialB = await withOrg(orgB, ownerB, () => getBillingSummary(ownerB, billingDeps));
  equal(trialA.trialEndsAt, new Date(createdAt.getTime() + 14 * 86_400_000).toISOString(), "The trial ends 14 days after stored workspace creation");
  check(trialA.canWrite && trialB.canWrite, "New hosted tenants each receive trial entitlement");
  await sql`UPDATE orgs SET created_at = now() - interval '100 days' WHERE id = 2`;
  equal((await getBillingSummary(ownerA, billingDeps)).trialEndsAt, trialA.trialEndsAt, "Repeated billing access never restarts or recalculates an existing trial");
  await sql`UPDATE workspace_billing SET trial_ends_at = now() - interval '1 day' WHERE org_id = 2`;
  await rejects(() => withOrg(orgA, agentA, () => requireHostedWriteAccess(agentA, billingDeps)), error => error instanceof BillingError && error.status === 402, "An expired trial blocks the correct tenant's writes");
  await withOrg(orgB, agentB, () => requireHostedWriteAccess(agentB, billingDeps)); checks++;
  equal((await getBillingSummary(ownerB, billingDeps)).canWrite, true, "Expiring A does not change B's entitlement");

  equal((await getShowcaseSettings(ownerA, "https://integration.example")).profile.published, false, "A public profile starts unpublished without implied identity");
  await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "Only aggregates", published: true }, "https://integration.example");
  await updateShowcaseSettings(ownerB, { slug: "integration-b", displayName: "Public B", bio: "Only aggregates", published: true }, "https://integration.example");
  const publicA = (await getPublicActivity("integration-a"))!;
  const publicB = (await getPublicActivity("integration-b"))!;
  equal([publicA.profile.layout, publicA.profile.highlights], ["studio", []], "Legacy profile writes receive the new safe presentation defaults");
  const publicHighlights = [{ title: "A public release note", body: "This text was explicitly selected by the owner.", url: "https://example.com/releases" }];
  const presented = await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "Owner-written highlights", published: true, layout: "field-notes", highlights: publicHighlights }, "https://integration.example");
  equal([presented.profile.layout, presented.profile.highlights], ["field-notes", publicHighlights], "PostgreSQL returns the saved layout and bounded highlight records");
  const storedPresentation = (await sql`SELECT layout, highlights FROM action_profiles WHERE org_id = 2`)[0];
  equal([storedPresentation.layout, storedPresentation.highlights], ["field-notes", publicHighlights], "Owner-approved presentation persists in the current tenant's profile row");
  await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "Only aggregates", published: true }, "https://integration.example");
  equal([(await getPublicActivity("integration-a"))?.profile.layout, (await getPublicActivity("integration-a"))?.profile.highlights], ["field-notes", publicHighlights], "An old client's update atomically preserves saved layout and highlights");
  equal([publicB.profile.layout, publicB.profile.highlights], ["studio", []], "Another tenant receives none of the owner's chosen highlights");
  await rejects(() => sql`UPDATE action_profiles SET layout = 'unknown' WHERE org_id = 2`, error => error.code === "23514", "The database rejects an unsupported layout independently of request validation");
  await rejects(() => sql`UPDATE action_profiles SET highlights = ${sql.json(Array.from({ length: 4 }, () => ({ ...publicHighlights[0] })))} WHERE org_id = 2`, error => error.code === "23514", "The database bounds stored highlight arrays to three records");
  await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "Only aggregates", published: true, layout: "studio", highlights: [] }, "https://integration.example");
  equal((await getPublicActivity("integration-a"))?.profile.highlights, [], "An explicit empty highlight list clears previously approved public text");
  const selectedPhoto = "data:image/png;base64," + (await renderAsync('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#75d8b0"/></svg>', { font: { loadSystemFonts: false } })).asPng().toString("base64");
  const photographed = await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "Only aggregates", published: true, photo: selectedPhoto }, "https://integration.example");
  check(photographed.profile.photo?.startsWith("data:image/png;base64,"), "The authorized owner receives a normalized draft image");
  const storedPhoto = (await sql`SELECT photo_png, photo_digest FROM action_profiles WHERE org_id = 2`)[0];
  check(storedPhoto.photo_png instanceof Uint8Array && /^[a-f0-9]{64}$/.test(storedPhoto.photo_digest), "PostgreSQL stores a bounded bytea image and its digest");
  const photographedPublic = (await getPublicActivity("integration-a"))!;
  const photoPath = photographedPublic.profile.photoUrl!;
  check(photoPath.endsWith(`photo.png?v=${storedPhoto.photo_digest}`), "The public projection exposes only a versioned image URL");
  check(!JSON.stringify(photographedPublic).includes("base64"), "Photo bytes never enter public JSON/SSE projections");
  equal((await getPublicActivity("integration-b"))?.profile.photoUrl, null, "Another tenant receives no image by inheritance");
  const photoResponse = (await handlePublicShowcase(new Request("https://integration.example" + photoPath)))!;
  equal(photoResponse.status, 200, "The published image is available through its digest-bound route");
  equal(Buffer.from(await photoResponse.arrayBuffer()), Buffer.from(storedPhoto.photo_png), "The image response serves precisely the normalized saved bytes");
  await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "Legacy client", published: true }, "https://integration.example");
  equal((await getPublicActivity("integration-a"))?.profile.photoUrl, photoPath, "Legacy client writes atomically preserve uploaded images");
  await rejects(() => sql`UPDATE action_profiles SET photo_png = NULL WHERE org_id = 2`, error => error.code === "23514", "Database rejects incomplete photo digest/byte pairs");
  await rejects(() => sql`UPDATE action_profiles SET photo_digest = 'invalid' WHERE org_id = 2`, error => error.code === "23514", "Database rejects invalid photo digest shapes");
  await rejects(() => sql`UPDATE action_profiles SET photo_png = ${Buffer.alloc(524289)} WHERE org_id = 2`, error => error.code === "23514", "Database enforces the normalized image byte ceiling");
  await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "Only aggregates", published: true, photo: null }, "https://integration.example");
  equal((await getPublicActivity("integration-a"))?.profile.photoUrl, null, "Explicit image removal is immediately reflected in public projection");
  equal((await handlePublicShowcase(new Request("https://integration.example" + photoPath)))?.status, 404, "An old digest URL stops serving after removal");
  equal(publicA.stats, { totalActions: 4, completedActions: 3, failedActions: 1, runningActions: 0, activeAgents: 2, activeDays: 1 }, "Public totals aggregate only tenant A's actions");
  equal(publicB.stats.totalActions, 3, "Public tenant B totals stay separate");
  equal(publicA.tools, [{ category: "memory", count: 2 }, { category: "code", count: 1 }, { category: "email", count: 1 }], "Public categories execute in PostgreSQL and reveal generic tool groups only");
  equal(publicA.daily.length, 84, "Public activity projects exactly 12 weeks of daily totals");
  for (const sensitive of ["A-only", "B-only", "private-a", "private-b", "same-agent", "audit-a", "audit-b", "a-only-run"]) {
    check(!JSON.stringify(publicA).includes(sensitive) && !JSON.stringify(publicB).includes(sensitive), "Public aggregates exclude private content and agent identities");
  }
  await rejects(() => updateShowcaseSettings(ownerB, { slug: "integration-a", displayName: "Impersonation", bio: "", published: true }, "https://integration.example"), error => error.status === 409, "A tenant cannot claim another tenant's public profile slug");
  await updateShowcaseSettings(ownerA, { slug: "integration-a", displayName: "Public A", bio: "", published: false }, "https://integration.example");
  equal(await getPublicActivity("integration-a"), null, "Unpublishing immediately removes public database access");
  equal((await handlePublicShowcase(new Request("https://integration.example/api/public/activity/integration-a/card.svg")))?.status, 404, "Unpublished share cards are unavailable");
  check(await getPublicActivity("integration-b"), "Unpublishing A does not affect B's profile");
  await revokeToken(3, "same-agent");
  equal(await authenticateStoredSecret(rawB), null, "Token revocation applies to the specified tenant");
  equal((await authenticateStoredSecret(rawA))?.orgId, 2, "Revoking an identically named token in B leaves A's token valid");

  // Exercise the actual administrator executable. Its short-lived owner secrets
  // stay in memory: never include child stdout/stderr in assertion messages or
  // process output, even if a CLI regression causes a failure.
  function cli(args: string[]) {
    return spawnSync(process.execPath, [fileURLToPath(new URL("../cli/engram-admin.ts", import.meta.url)), ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, ENGRAM_DB_URL_TEMPLATE: template!, ENGRAM_DEPLOYMENT_MODE: "self-hosted" },
    });
  }
  const created = cli(["workspace", "create", "--name", "CLI sandbox", "--email", "cli@example.test"]);
  equal(created.status, 0, "Workspace creation CLI exits successfully and closes its pools");
  const ownerSecret = created.stdout.match(/^ens_[A-Za-z0-9_-]+$/m)?.[0];
  check(ownerSecret, "Workspace creation yields one expiring owner session");
  const cliOwner = await authenticateStoredSecret(ownerSecret);
  check(cliOwner, "The CLI owner session authenticates against the real database");
  equal([cliOwner.role, cliOwner.kind, cliOwner.email], ["owner", "session", "cli@example.test"], "The CLI provisions a human owner rather than a broad agent token");
  check(cliOwner.orgId !== 2 && cliOwner.orgId !== 3, "The CLI creates a new isolated workspace");
  const cliOrg = (await getOrg(cliOwner.orgId))!;
  equal(cliOrg.name, "CLI sandbox", "Workspace creation persists its supplied name");
  equal(cliOrg.dataDb, `brain_org_${cliOwner.orgId}`, "The CLI provisions a separate tenant database");
  equal((await sql`SELECT role FROM org_members WHERE org_id = ${cliOwner.orgId} AND email = 'cli@example.test'`)[0]?.role, "owner", "The CLI creates the exact owner membership");
  equal(Number((await sql`SELECT count(*) AS n FROM tokens WHERE org_id = ${cliOwner.orgId}`)[0].n), 0, "Owner bootstrap does not mint an agent API token");
  const duration = Number((await sql`SELECT extract(epoch FROM (expires_at - created_at)) AS seconds FROM sessions WHERE org_id = ${cliOwner.orgId} ORDER BY created_at DESC LIMIT 1`)[0].seconds);
  check(Math.abs(duration - 14 * 86_400) < 5, "The bootstrap owner session expires after 14 days");
  const renewed = cli(["workspace", "login", "--org", String(cliOwner.orgId), "--email", "cli@example.test"]);
  equal(renewed.status, 0, "An existing owner can renew access through the CLI");
  const renewedSecret = renewed.stdout.match(/^ens_[A-Za-z0-9_-]+$/m)?.[0];
  check(renewedSecret && renewedSecret !== ownerSecret, "Renewal issues a new opaque session");
  const renewedOwner = await authenticateStoredSecret(renewedSecret);
  equal([renewedOwner?.orgId, renewedOwner?.role], [cliOwner.orgId, "owner"], "Renewed access stays bound to the selected workspace owner");
  const countBeforeInvalid = Number((await sql`SELECT count(*) AS n FROM orgs`)[0].n);
  const invalidEmail = cli(["workspace", "create", "--name", "Rejected", "--email", "not-an-email"]);
  check(invalidEmail.status !== 0 && !/^ens_/m.test(invalidEmail.stdout), "Invalid email creation fails without returning a session");
  equal(Number((await sql`SELECT count(*) AS n FROM orgs`)[0].n), countBeforeInvalid, "Invalid CLI input does not provision an orphan workspace");
  await sql`INSERT INTO org_members (org_id, email, role) VALUES (${cliOwner.orgId}, 'member@example.test', 'member')`;
  for (const email of ["missing@example.test", "member@example.test", "not-an-email"]) {
    const denied = cli(["workspace", "login", "--org", String(cliOwner.orgId), "--email", email]);
    check(denied.status !== 0 && !/^ens_/m.test(denied.stdout), "Missing, non-owner and invalid email logins never receive owner access");
  }
  // Lifecycle updates use real transactions/advisory locks across connections.
  // Keep these after the original fixture totals so they also prove an existing
  // published profile updates without counting every heartbeat as another action.
  const lifecycleAgent = normalizeToken({ name: "lifecycle-agent", orgId: 3 });
  const lifecycleRun = "lifecycle-integration";
  const publicBeforeLifecycle = (await getPublicActivity("integration-b"))!;
  const lifecycleAt = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const started = { tool: "code.build", summary: "Building integration fixture", actionKey: "build:1", eventId: "build:1:start", status: "running", runId: lifecycleRun, occurredAt: lifecycleAt(5) };
  const deliveries = await Promise.all(Array.from({ length: 12 }, () => recordAction(lifecycleAgent, started)));
  equal(new Set(deliveries.map(result => result.action.id)).size, 1, "Concurrent delivery retries return one original event");
  equal(Number((await sql`SELECT count(*) AS n FROM action_events WHERE org_id = 3 AND agent = 'lifecycle-agent'`)[0].n), 1, "Concurrent retries insert one append-only row");
  const heartbeat = await recordAction(lifecycleAgent, { ...started, eventId: "build:1:heartbeat", occurredAt: lifecycleAt(4) });
  check(heartbeat.action.id !== deliveries[0].action.id, "A heartbeat is a new event of the same logical action");
  equal((await listActions(lifecycleAgent, { agent: lifecycleAgent.name })).actions.length, 1, "History projects one current logical action across heartbeats");
  const completed = await recordAction(lifecycleAgent, { ...started, eventId: "build:1:finish", status: "completed", summary: "Integration fixture built", occurredAt: lifecycleAt(3) });
  const projection = await listActions(lifecycleAgent, { agent: lifecycleAgent.name });
  equal([projection.actions.length, projection.actions[0].status, projection.actions[0].id], [1, "completed", completed.action.id], "A completion replaces the running projection without editing its history");
  equal(Number((await sql`SELECT count(*) AS n FROM action_events WHERE org_id = 3 AND agent = 'lifecycle-agent'`)[0].n), 3, "All three lifecycle events remain stored");
  for (const patch of [
    { eventId: "build:1:late-running", status: "running", occurredAt: lifecycleAt(6) },
    { eventId: "build:1:reopen", status: "running", occurredAt: lifecycleAt(1) },
    { eventId: "build:1:change-result", status: "failed", occurredAt: lifecycleAt(1) },
    { eventId: started.eventId, summary: "Conflicting retry payload" },
  ]) await rejects(() => recordAction(lifecycleAgent, { ...started, ...patch }), error => error.status === 409, "Stale updates, reopened terminal actions and conflicting event IDs fail closed");
  const afterCompletion = (await getPublicActivity("integration-b"))!;
  equal(afterCompletion.stats.totalActions, publicBeforeLifecycle.stats.totalActions + 1, "Public totals count a full running/heartbeat/completed lifecycle once");
  equal(afterCompletion.stats.runningActions, publicBeforeLifecycle.stats.runningActions, "Completed lifecycle rows do not leave historical running actions in public totals");

  const retryInput = { tool: "files.write", summary: "Retry without client timestamp", actionKey: "retry:1", eventId: "retry:1:finish", runId: lifecycleRun };
  const initialReceipt = await recordAction(lifecycleAgent, retryInput);
  const repeatedReceipt = await recordAction(lifecycleAgent, retryInput);
  equal(repeatedReceipt, initialReceipt, "Timestamp-free retries preserve original event ID and receipt time");
  await recordAction(normalizeToken({ name: "lifecycle-agent", orgId: 2 }), retryInput);
  await recordAction(normalizeToken({ name: "other-lifecycle-agent", orgId: 3 }), retryInput);
  equal(Number((await sql`SELECT count(*) AS n FROM action_events WHERE event_id = 'retry:1:finish'`)[0].n), 3, "The same event/key values are independent across tenants and authenticated agents");

  const changing = { tool: "files.write", summary: "Updating fixture", actionKey: "file:1", eventId: "file:1:start", status: "running", runId: lifecycleRun, occurredAt: lifecycleAt(2) };
  await recordAction(lifecycleAgent, changing);
  await rejects(() => recordAction(lifecycleAgent, { ...changing, tool: "mail.send", eventId: "file:1:wrong-tool" }), error => error.status === 409, "A logical action cannot switch tools");
  await rejects(() => recordAction(lifecycleAgent, { ...changing, eventId: "file:1:stale", occurredAt: lifecycleAt(3) }), error => error.status === 409, "An out-of-order running update cannot make an old action look current");
  const sameTime = lifecycleAt(1);
  await Promise.allSettled([
    recordAction(lifecycleAgent, { ...changing, eventId: "file:1:heartbeat", occurredAt: sameTime }),
    recordAction(lifecycleAgent, { ...changing, eventId: "file:1:finish", status: "completed", occurredAt: sameTime }),
  ]);
  equal((await listActions(lifecycleAgent, { agent: lifecycleAgent.name, q: "Updating fixture" })).actions[0].status, "completed", "Concurrent running and terminal updates finish terminal regardless of lock order");

  const working = await recordAction(lifecycleAgent, { tool: "code.test", summary: "Checking another fixture", actionKey: "test:working", eventId: "test:working:start", status: "running", runId: lifecycleRun });
  const stale = await recordAction(lifecycleAgent, { tool: "code.test", summary: "An old unconfirmed report", actionKey: "test:stale", eventId: "test:stale:start", status: "running", runId: lifecycleRun, occurredAt: lifecycleAt(17) });
  // Adjust only this test fixture to exercise receipt-age semantics. Production
  // reporting never mutates an existing event's receipt timestamp.
  await sql`UPDATE action_events SET recorded_at = clock_timestamp() - interval '16 minutes' WHERE id = ${stale.action.id}`;
  const live = (await getPublicActivity("integration-b"))!;
  check(live.live.workingAgents >= 1 && live.live.workingActions >= 1, "Fresh running reports appear as reported working activity");
  equal(live.live.staleActions, 1, "A stale running receipt is shown as unconfirmed instead of currently working");
  check(live.live.completedAgents >= 1 && live.live.recentlyActiveAgents >= 1, "Completed and recently active contributors coexist with current working reports");
  await recordAction(lifecycleAgent, { tool: working.action.tool, summary: "Checks completed", actionKey: working.action.actionKey!, eventId: "test:working:finish", status: "completed", runId: lifecycleRun });
  const finishedLive = (await getPublicActivity("integration-b"))!;
  equal(finishedLive.live.workingActions, live.live.workingActions - 1, "A terminal update removes its current working contribution");

  await sql`
    INSERT INTO action_events (id, org_id, agent, tool, summary, status, evidence, occurred_at)
    VALUES ('legacy-key-collision', 3, 'legacy-collision-agent', 'code.build', 'Legacy fixture', 'completed', 'reported', clock_timestamp())`;
  const collisionAgent = normalizeToken({ name: "legacy-collision-agent", orgId: 3 });
  await recordAction(collisionAgent, { tool: "code.build", summary: "Keyed fixture", actionKey: "legacy-key-collision", eventId: "legacy-key-collision:finish" });
  equal((await listActions(collisionAgent, { agent: collisionAgent.name })).actions.length, 2, "A legacy row ID cannot collide with another logical action's key");

  const beforeTie = (await getPublicActivity("integration-b"))!;
  // PostgreSQL receipts can share microsecond precision. Force the older running
  // event's random UUID to sort higher than the terminal event at an exact tie.
  await sql`
    WITH receipt AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO action_events (id, org_id, agent, tool, summary, status, evidence, occurred_at, recorded_at, action_key, event_id)
    SELECT events.id, 3, 'timestamp-tie-agent', 'code.build', 'Timestamp tie fixture', events.status, 'reported', receipt.at, receipt.at, 'tie:one', events.event_id
    FROM (VALUES
      ('ffffffff-ffff-4fff-bfff-ffffffffffff', 'running', 'tie:one:start'),
      ('00000000-0000-4000-8000-000000000000', 'completed', 'tie:one:finish')
    ) AS events(id, status, event_id) CROSS JOIN receipt`;
  const tieAgent = normalizeToken({ name: "timestamp-tie-agent", orgId: 3 });
  equal((await listActions(tieAgent, { agent: tieAgent.name })).actions.map(action => action.status), ["completed"], "Exact event/receipt timestamp ties prefer a terminal state over random UUID order");
  await rejects(() => recordAction(tieAgent, { tool: "code.build", summary: "Delayed heartbeat", actionKey: "tie:one", eventId: "tie:one:late", status: "running" }), error => error.status === 409, "A timestamp tie cannot reopen a terminal action through a later heartbeat");
  const afterTie = (await getPublicActivity("integration-b"))!;
  equal(afterTie.live.workingActions, beforeTie.live.workingActions, "Terminal tie priority also prevents false public working activity");
  equal(afterTie.stats.completedActions, beforeTie.stats.completedActions + 1, "A timestamp tie contributes one completed logical action");

  const planner = (await authenticateStoredSecret(await issueToken(2, "activity-planner")))!;
  const builder = (await authenticateStoredSecret(await issueToken(2, "activity-builder")))!;
  const foreign = (await authenticateStoredSecret(await issueToken(3, "activity-foreign")))!;
  const activityRun = "private-activity-integration";
  const planStartedAt = lifecycleAt(5);
  await recordAction(planner, { tool: "files.read", summary: "Prepare the release", actionKey: "plan:1", eventId: "plan:1:start", runId: activityRun, status: "running", occurredAt: planStartedAt, approach: "Compared local manifests and file hashes." });
  const planFinished = await recordAction(planner, { tool: "files.read", summary: "Release plan ready", actionKey: "plan:1", eventId: "plan:1:finish", runId: activityRun, status: "completed", occurredAt: lifecycleAt(4) });
  await recordAction(builder, { tool: "code.build", summary: "Compile the selected package", actionKey: "compile:1", eventId: "compile:1:start", runId: activityRun, status: "running", occurredAt: lifecycleAt(3), approach: "Built the selected package and inspected compiler output." });
  await recordAction(builder, { tool: "code.test", summary: "Smoke check failed", actionKey: "smoke:1", eventId: "smoke:1:finish", runId: activityRun, status: "failed", occurredAt: lifecycleAt(2), approach: "Ran smoke checks against the package." });
  await recordAction(foreign, { tool: "mail.send", summary: "Other tenant's unrelated task", runId: activityRun, approach: "Foreign private method." });
  const grouped = await listActivities(planner, { runId: activityRun, q: "manifests", agent: planner.name, tool: "code.build", status: "running" });
  equal(grouped.activities.length, 1, "Whole-activity search may match one contributor while a tool filter matches another");
  const item = grouped.activities[0];
  equal([item.id, item.summary, item.status, item.actionCount], [`run:${activityRun}`, "Prepare the release", "running", 3], "The run combines latest logical actions and retains its original reported title");
  equal(item.startedAt, planStartedAt, "Activity start time comes from the earliest lifecycle event rather than completion");
  equal(item.agents.map(agent => agent.name).sort(), [builder.name, planner.name].sort(), "Filtering one agent retains all authenticated collaborators");
  equal(item.tools, ["code.build", "code.test", "files.read"], "Activity tool logs retain all tools after filtering");
  equal(item.approaches.length, 3, "Activity approaches retain each contributing method summary");
  equal(item.agents.find(agent => agent.name === builder.name)?.actionCount, 2, "Contributor action counts reflect logical actions rather than event deliveries");
  equal([item.workingActions, item.staleActions], [1, 0], "Running activity freshness uses server receipts");
  const privateDetail = await getActivity(planner, item.id);
  equal(privateDetail.activity.actions.length, 3, "Detail returns all current actions without historical heartbeat duplicates");
  equal(privateDetail.activity.actions.find(action => action.agent === planner.name)?.approach, "Compared local manifests and file hashes.", "Omitting approach on completion preserves the last reported high-level method in private history");
  equal((await sql`SELECT approach FROM action_events WHERE id = ${planFinished.action.id}`)[0].approach, null, "Projection inheritance never rewrites the raw completion event");
  equal((await listActions(planner, { agent: planner.name })).actions[0].approach, "Compared local manifests and file hashes.", "The compatible action API exposes the preserved approach too");
  const excludedStatus = await listActivities(planner, { runId: activityRun, status: "completed" });
  equal(excludedStatus.activities.length, 0, "Status filters apply to the combined activity state");
  equal(excludedStatus.stats, { running: 1, completed: 0, failed: 0, total: 1 }, "Status button counts are computed before the selected status filter");
  await recordAction(builder, { tool: "code.build", summary: "Package compiled", actionKey: "compile:1", eventId: "compile:1:finish", runId: activityRun, status: "completed" });
  equal((await getActivity(planner, item.id)).activity.status, "failed", "When no actions are running a failed child determines the combined state");
  const foreignDetail = await getActivity(foreign, item.id);
  equal(foreignDetail.activity.actionCount, 1, "Identical run IDs in separate tenants never combine activity");
  check(!JSON.stringify(privateDetail).includes("Foreign private method"), "Private contributor and approach logs cannot cross tenants");
  const standalone = (await authenticateStoredSecret(await issueToken(2, "activity-standalone")))!;
  await recordAction(standalone, { tool: "files.read", summary: "Inspect a standalone package", actionKey: "standalone:1", eventId: "standalone:1:start", status: "running", approach: "Inspected package metadata." });
  const stableBefore = (await listActivities(standalone, { agent: standalone.name })).activities[0];
  await recordAction(standalone, { tool: "files.read", summary: "Standalone inspection complete", actionKey: "standalone:1", eventId: "standalone:1:finish", status: "completed" });
  const stableAfter = (await listActivities(standalone, { agent: standalone.name })).activities[0];
  check(/^action:[a-f0-9]{64}$/.test(stableBefore.id), "An uncorrelated logical action receives an opaque stable key-based activity ID");
  equal(stableAfter.id, stableBefore.id, "A no-run activity remains addressable across lifecycle event IDs");
  equal((await getActivity(standalone, stableBefore.id)).activity.status, "completed", "The original stable activity URL resolves the completed state");
  const firstActivityPage = await listActivities(planner, { limit: 1 });
  const nextActivityPage = await listActivities(planner, { limit: 1, offset: 1 });
  check(firstActivityPage.more && firstActivityPage.activities[0].id !== nextActivityPage.activities[0].id, "Grouped server pagination does not duplicate activities across pages");
  await rejects(() => getActivity(planner, "run:missing-activity"), error => error.status === 404, "Missing grouped detail uses the normal private 404 boundary");
  check(!JSON.stringify(await getPublicActivity("integration-b")).includes("Foreign private method"), "New private approach metadata never appears in public aggregates");

  const { checkTaskActivity } = await import("./integration-task-activity");
  checks += await checkTaskActivity(sql);
  const { checkInsights } = await import("./integration-insights");
  checks += await checkInsights({ db: sql, orgA, orgB, actorA: planner, actorB: foreign });

  const { checkConnections } = await import("./integration-connections");
  checks += await checkConnections(sql);
  const { checkMemoryUsage } = await import("./integration-memory-usage");
  checks += await checkMemoryUsage(sql);
  const { checkConnectionLifecycle } = await import("./integration-connection-lifecycle");
  checks += await checkConnectionLifecycle(sql);
  const { checkComplimentaryAccess } = await import("./integration-complimentary");
  checks += await checkComplimentaryAccess(sql);
  const { checkSignupInviteAccess } = await import("./integration-signup-access");
  checks += await checkSignupInviteAccess(sql);
  const { checkSignupInvites } = await import("./integration-signup-invites");
  checks += await checkSignupInvites(sql);
  const { checkWorkspaceName } = await import("./integration-workspace-name");
  checks += await checkWorkspaceName(sql);
  const { checkMailSeries } = await import("./integration-mail-series");
  checks += await checkMailSeries(sql);
  const { checkJev } = await import("./integration-jev");
  checks += await checkJev(sql);
  const { checkContextSharing } = await import("./integration-context-sharing");
  checks += await checkContextSharing(sql);

  process.stdout.write(JSON.stringify({ ok: true, checks, postgres: "real", coverage: ["repeatable migrations", "physical tenant databases", "token and live session isolation", "action union and filters", "trial persistence", "public aggregate privacy and unpublishing", "CLI workspace creation and owner login", "concurrent action lifecycle and delivery idempotency", "fresh and stale public activity", "private grouped activity and contributor methods", "durable insight queue and provider budget"] }) + "\n");
} finally {
  await Promise.all([closeOrgPool("brain_org_2"), closeOrgPool("brain_org_3")]);
  await sql.end({ timeout: 2 });
}
