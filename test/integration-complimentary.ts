// Called only by the guarded, marked disposable PostgreSQL integration runner.
import assert from "node:assert/strict";
import type postgres from "postgres";
import { complimentarySettings, manageComplimentaryAccess } from "../deploy/complimentary-access";
import { getBillingSummary, requireHostedWriteAccess, type BillingSettings } from "../gateway/src/billing";
import { normalizeToken } from "../gateway/src/policies";

export async function checkComplimentaryAccess(db: postgres.Sql): Promise<number> {
  let checks = 0;
  const equal = (a: unknown, b: unknown, message: string) => { assert.deepEqual(a, b, message); checks++; };
  const reject = async (work: () => Promise<unknown>, code: string) => { await assert.rejects(work, (error: any) => error.code === code); checks++; };
  const now = new Date(), ownerEmail = "complimentary-owner@example.test";
  await db`INSERT INTO org_members (org_id, email, role) VALUES (1, ${ownerEmail}, 'owner') ON CONFLICT (org_id, email) DO UPDATE SET role='owner'`;
  await db`INSERT INTO workspace_billing (org_id, trial_ends_at) VALUES (1, now()-interval '1 day') ON CONFLICT (org_id) DO UPDATE SET trial_ends_at=EXCLUDED.trial_ends_at`;
  const before = (await db`SELECT trial_ends_at, status, stripe_customer_id, stripe_subscription_id FROM workspace_billing WHERE org_id=1`)[0];
  const otherBefore = (await db`SELECT row_to_json(b) AS value FROM workspace_billing b WHERE org_id=2`)[0]?.value;
  const owner = normalizeToken({ name: ownerEmail, email: ownerEmail, role: "owner", kind: "session", orgId: 1 });
  const settings: BillingSettings = { mode: "hosted", publicUrl: "https://engram.example.test", secretKey: "sk_test_disposable", webhookSecret: "whsec_disposable", cloudMonthlyPriceId: "price_disposable" };
  let providerCalls = 0;
  const deps = { db, settings, now: () => new Date(), fetch: (async () => { providerCalls++; throw new Error("No provider is allowed in this test"); }) as typeof fetch };
  const options = complimentarySettings(["grant", "--project", "ani-hq", "--org", "1", "--workspace-name", "Ani HQ", "--owner-email", ownerEmail, "--request-id", "integration-comp-grant-1", "--reason", "Disposable integration only", "--run"], now);
  await reject(() => requireHostedWriteAccess(owner, deps), "subscription_required");
  await reject(() => manageComplimentaryAccess(db, { ...options, ownerEmail: "absent-owner@example.test" }, now), "complimentary_owner_workspace_mismatch");
  equal(Number((await db`SELECT count(*) AS n FROM workspace_complimentary_access`)[0].n), 0, "Mismatched owner creates no entitlement");
  const [first, retry] = await Promise.all([manageComplimentaryAccess(db, options, now), manageComplimentaryAccess(db, options, now)]);
  equal(first.grantId, retry.grantId, "Concurrent exact retries commit one grant identity");
  equal(Number((await db`SELECT count(*) AS n FROM complimentary_access_events WHERE org_id=1`)[0].n), 1, "A repeated grant commits one audit event");
  equal((await getBillingSummary(owner, deps)).entitlementSource, "complimentary", "Runtime reads separate complimentary entitlement");
  equal((await getBillingSummary(owner, deps)).complimentary?.expiresAt, null, "No expiry is a real NULL timestamp");
  await requireHostedWriteAccess(normalizeToken({ ...owner, role: "agent", kind: "token" }), deps); checks++;
  equal((await getBillingSummary(owner, { ...deps, now: () => new Date("2126-01-01T00:00:00Z") })).canWrite, true, "Non-expiring access remains valid without a fabricated future trial");
  const summary = JSON.stringify(await getBillingSummary(owner, deps));
  equal(summary.includes(first.grantId!), false, "Browser billing summary omits operator grant identity");
  equal((await db`SELECT trial_ends_at, status, stripe_customer_id, stripe_subscription_id FROM workspace_billing WHERE org_id=1`)[0], before, "Grant leaves trial and Stripe billing unchanged");
  equal((await db`SELECT row_to_json(b) AS value FROM workspace_billing b WHERE org_id=2`)[0]?.value, otherBefore, "Another workspace's complete billing row is unchanged");
  const other = normalizeToken({ ...owner, orgId: 2 });
  equal((await getBillingSummary(other, deps)).complimentary, null, "Another workspace never inherits the grant");
  const revoke = { ...options, operation: "revoke" as const, requestId: "integration-comp-revoke-1", grantId: first.grantId! };
  await manageComplimentaryAccess(db, revoke, now);
  await reject(() => requireHostedWriteAccess(owner, deps), "subscription_required");
  equal(Number((await db`SELECT count(*) AS n FROM complimentary_access_events WHERE org_id=1`)[0].n), 2, "Revocation preserves grant and revoke audit history");
  equal(providerCalls, 0, "Complimentary grants, access checks and revocation never contact Stripe");
  return checks;
}
