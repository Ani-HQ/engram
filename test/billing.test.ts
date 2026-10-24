import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type postgres from "postgres";
import { getBillingSummary, handleBillingApi, handleBillingWebhook, publicPlans, requireHostedWriteAccess, verifyStripeSignature, type BillingSettings } from "../gateway/src/billing";
import { runWithContext } from "../gateway/src/context";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";

const now = new Date("2026-10-22T12:00:00Z");
const owner = normalizeToken({ name: "private-owner@example.com", orgId: 7, role: "owner", kind: "session" });
const hosted: BillingSettings = { mode: "hosted", publicUrl: "https://engram.example", secretKey: "sk_test_unit_only", webhookSecret: "whsec_unit_only", cloudMonthlyPriceId: "price_cloud" };
const trial = { org_id: 7, trial_ends_at: "2026-11-01T00:00:00Z", stripe_customer_id: null, stripe_subscription_id: null, plan_id: null, status: "trial", current_period_ends_at: null, cancel_at_period_end: false, checkout_generation: 0 };

function database(initial: Record<string, any> = trial) {
  const rows = new Map<number, any>([[7, { ...initial }]]);
  const events = new Set<string>();
  const calls: { query: string; values: any[] }[] = [];
  const db = (async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    if (query.includes("INSERT INTO workspace_billing")) {
      if (!rows.has(values[0])) rows.set(values[0], { ...trial, org_id: values[0] });
      return [];
    }
    if (query.includes("INSERT INTO billing_webhook_events")) {
      if (events.has(values[0])) return [];
      events.add(values[0]); return [{ id: values[0] }];
    }
    if (query.includes("SELECT") && query.includes("FROM workspace_billing")) {
      const row = query.includes("stripe_customer_id") ? [...rows.values()].find(row => row.stripe_customer_id === values[0]) : rows.get(values[0]);
      return row ? [{ ...row }] : [];
    }
    if (query.includes("UPDATE workspace_billing")) {
      const orgId = values.at(-1);
      const row = rows.get(orgId);
      if (query.includes("SET stripe_customer_id")) row.stripe_customer_id = values[0];
      else if (query.includes("SET checkout_session_id")) Object.assign(row, { checkout_session_id: values[0], checkout_url: values[1], checkout_expires_at: values[2], checkout_generation: values[3] });
      else if (query.includes("SET stripe_subscription_id")) Object.assign(row, { stripe_subscription_id: values[0], plan_id: values[1], status: values[2], current_period_ends_at: values[3], cancel_at_period_end: values[4] });
      else throw new Error("Unexpected update");
      return [];
    }
    throw new Error(`Unexpected query: ${query}`);
  }) as unknown as postgres.Sql;
  db.begin = (async (callback: any) => {
    const before = new Map([...rows].map(([id, row]) => [id, { ...row }]));
    const beforeEvents = new Set(events);
    try { return await callback(db); }
    catch (error) { rows.clear(); before.forEach((row, id) => rows.set(id, row)); events.clear(); beforeEvents.forEach(id => events.add(id)); throw error; }
  }) as any;
  return { db, rows, events, calls };
}
function transport(subscriptions: any[] = []) {
  const calls: { url: URL; init?: RequestInit; body: URLSearchParams }[] = [];
  let fail = false;
  let redirect = "https://checkout.stripe.com/c/pay/cs_test_123";
  let price = { id: "price_cloud", active: true, currency: "usd", unit_amount: 1900, type: "recurring", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init, body: new URLSearchParams(String(init?.body ?? "")) });
    if (fail) return Response.json({ error: { message: "secret-provider-information" } }, { status: 500 });
    if (parsed.pathname.endsWith("/prices/price_cloud")) return Response.json(price);
    if (parsed.pathname.endsWith("/customers")) return Response.json({ id: "cus_123" });
    if (parsed.pathname.endsWith("/checkout/sessions")) return Response.json({ id: "cs_test_123", url: redirect, expires_at: now.getTime() / 1000 + 3600 });
    if (parsed.pathname.endsWith("/billing_portal/sessions")) return Response.json({ url: "https://billing.stripe.com/p/session/test" });
    if (parsed.pathname.endsWith("/subscriptions")) return Response.json({ data: subscriptions, has_more: false });
    throw new Error("Unexpected Stripe path");
  }) as typeof fetch;
  return { fetcher, calls, fail: () => { fail = true; }, redirect: (url: string) => { redirect = url; }, price: (value: any) => { price = { ...price, ...value }; } };
}
const subscription = (changes: any = {}) => ({ id: "sub_123", customer: "cus_123", metadata: { engram_org_id: "7" }, created: 100, status: "active", cancel_at_period_end: false, items: { data: [{ price: { id: "price_cloud" }, quantity: 1, current_period_end: now.getTime() / 1000 + 86400 }] }, ...changes });
const request = (path: string, body: any = {}) => new Request(`https://untrusted-host.example/api/billing${path}`, { method: "POST", body: JSON.stringify(body) });
function signedEvent(type = "customer.subscription.updated", changes: any = {}, raw?: string) {
  const payload = raw ?? JSON.stringify({ id: "evt_123", type, livemode: false, data: { object: { customer: "cus_123", status: "past_due", metadata: { engram_org_id: "999" } } }, ...changes });
  const time = Math.floor(now.getTime() / 1000);
  const signature = createHmac("sha256", hosted.webhookSecret).update(`${time}.${payload}`).digest("hex");
  return new Request("https://engram.example/api/billing/webhook", { method: "POST", body: payload, headers: { "Stripe-Signature": `t=${time},v1=${signature}` } });
}

describe("workspace plans and entitlements", () => {
  const complimentary = { complimentary_id: "8ccf05c8-362a-4c26-8f16-0cb1cb99c7f5", complimentary_granted_at: "2026-10-01T00:00:00Z", complimentary_expires_at: null, complimentary_revoked_at: null };

  test("non-expiring complimentary access is distinct from trial and subscription without provider requests", async () => {
    const store = database({ ...trial, trial_ends_at: "2026-10-10T00:00:00Z", ...complimentary });
    const remote = transport(); remote.fail();
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    const result = await getBillingSummary(owner, deps);
    expect(result).toMatchObject({ planId: "complimentary", status: "complimentary", entitlementSource: "complimentary", canWrite: true, trialEndsAt: "2026-10-10T00:00:00.000Z", currentPeriodEndsAt: null, checkoutAvailable: false, complimentary: { active: true, grantedAt: "2026-10-01T00:00:00.000Z", expiresAt: null, revokedAt: null } });
    await requireHostedWriteAccess(normalizeToken({ ...owner, role: "agent" }), deps);
    expect(remote.calls).toHaveLength(0);
    expect(store.rows.get(7).status).toBe("trial");
    expect(JSON.stringify(result)).not.toContain("complimentary_id");
    const checkout = await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, deps);
    expect(checkout.status).toBe(409);
    expect((await checkout.json()).code).toBe("complimentary_access");
    expect(remote.calls).toHaveLength(0);
  });

  test("expiry and revocation fail closed while a separate paid entitlement still survives", async () => {
    for (const changes of [{ complimentary_expires_at: now.toISOString() }, { complimentary_revoked_at: "2026-10-21T00:00:00Z" }, { complimentary_granted_at: "invalid" }, { complimentary_expires_at: "invalid" }]) {
      const store = database({ ...trial, trial_ends_at: "2026-10-10T00:00:00Z", ...complimentary, ...changes });
      const deps = { db: store.db, settings: hosted, now: () => now };
      expect((await getBillingSummary(owner, deps))).toMatchObject({ canWrite: false, entitlementSource: "none", complimentary: { active: false } });
      await expect(requireHostedWriteAccess(owner, deps)).rejects.toMatchObject({ code: "subscription_required" });
    }
    const store = database({ ...trial, ...complimentary, complimentary_revoked_at: "2026-10-21T00:00:00Z", status: "active", plan_id: "cloud", stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", current_period_ends_at: "2026-11-01T00:00:00Z" });
    expect(await getBillingSummary(owner, { db: store.db, settings: hosted, now: () => now })).toMatchObject({ canWrite: true, entitlementSource: "subscription", status: "active", complimentary: { active: false } });
  });

  test("complimentary overlays preserve paid billing visibility and tenant boundaries", async () => {
    const store = database({ ...trial, ...complimentary, status: "active", plan_id: "cloud", stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", current_period_ends_at: "2026-10-21T00:00:00Z" });
    const remote = transport();
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    expect(await getBillingSummary(owner, deps)).toMatchObject({ entitlementSource: "complimentary", portalAvailable: true, subscriptionStatus: "active", currentPeriodEndsAt: "2026-10-21T00:00:00.000Z" });
    expect(remote.calls).toHaveLength(0);
    expect((await handleBillingApi(request("/portal"), owner, deps)).status).toBe(200);
    expect(remote.calls[0].body.get("customer")).toBe("cus_123");
    const other = normalizeToken({ ...owner, orgId: 8 });
    store.rows.set(8, { ...trial, org_id: 8, trial_ends_at: "2026-10-10T00:00:00Z" });
    await expect(requireHostedWriteAccess(other, deps)).rejects.toMatchObject({ code: "subscription_required" });
    expect((await getBillingSummary(other, deps)).complimentary).toBeNull();
  });

  test("self hosting has all features without database or payment requests", async () => {
    const store = database();
    const remote = transport();
    const deps = { db: store.db, fetch: remote.fetcher, settings: { ...hosted, mode: "self-hosted" as const } };
    expect((await getBillingSummary(owner, deps)).canWrite).toBe(true);
    await requireHostedWriteAccess(normalizeToken({ ...owner, role: "agent" }), deps);
    expect(store.calls).toHaveLength(0);
    expect(remote.calls).toHaveLength(0);
    expect(publicPlans(deps)).toMatchObject({ checkoutAvailable: false, trialDays: 14, plans: [{ id: "self-hosted", monthlyPrice: 0 }, { id: "cloud", monthlyPrice: 19 }] });
    expect(JSON.stringify(publicPlans(deps))).not.toContain("whsec");
    expect(JSON.stringify(publicPlans(deps))).not.toContain("price_cloud");
  });

  test("trial is anchored to workspace creation, never first billing access", async () => {
    const store = database();
    const deps = { db: store.db, settings: hosted, now: () => now };
    expect((await getBillingSummary(owner, deps)).status).toBe("trial");
    await requireHostedWriteAccess(owner, deps);
    expect(store.calls[0].query).toContain("created_at + interval '14 days'");
    expect(store.calls[0].values).toEqual([7]);
    store.rows.get(7).trial_ends_at = "2026-10-22T11:59:59Z";
    expect((await getBillingSummary(owner, deps))).toMatchObject({ status: "trial_expired", canWrite: false });
    await expect(requireHostedWriteAccess(owner, deps)).rejects.toMatchObject({ status: 402, code: "subscription_required" });
  });

  test("owners alone manage billing; OAuth agents and tenant context mismatches are denied", async () => {
    const store = database();
    const deps = { db: store.db, settings: hosted };
    for (const token of [normalizeToken({ ...owner, role: "member" }), normalizeToken({ ...owner, role: "agent" }), normalizeToken({ ...owner, kind: "oauth" }), normalizeToken({ ...owner, canWrite: false })]) {
      expect((await handleBillingApi(request("/checkout", { plan: "cloud" }), token, deps)).status).toBe(403);
    }
    await runWithContext({ org: { id: 99, name: "Other", slug: "other", kind: "team", brainDb: "brain_org_99", dataDb: "brain_org_99", homeDir: "other", policies: DEFAULT_POLICIES }, token: normalizeToken({ ...owner, orgId: 99 }), dataSql: store.db }, async () => {
      await expect(requireHostedWriteAccess(owner, deps)).rejects.toMatchObject({ status: 403 });
    });
    expect(store.calls).toHaveLength(0);
  });

  test("paid access ends at cached period boundary, refreshes current state and fails closed", async () => {
    const store = database({ ...trial, status: "active", plan_id: "cloud", stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", current_period_ends_at: "2026-10-22T11:00:00Z" });
    const remote = transport([subscription()]);
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    await requireHostedWriteAccess(owner, deps);
    expect(remote.calls).toHaveLength(1);
    expect(store.rows.get(7).current_period_ends_at).toBe("2026-10-23T12:00:00.000Z");
    remote.calls.length = 0;
    await requireHostedWriteAccess(owner, deps);
    expect(remote.calls).toHaveLength(0);
    store.rows.get(7).current_period_ends_at = "2026-10-22T11:00:00Z";
    remote.fail();
    await expect(requireHostedWriteAccess(owner, deps)).rejects.toMatchObject({ status: 503 });
  });
});

describe("hosted payment sessions", () => {
  test("creates only the authenticated tenant's configured plan with stable retries and canonical redirects", async () => {
    const store = database();
    const remote = transport();
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    const response = await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_123" });
    expect(remote.calls).toHaveLength(3);
    const [, customer, checkout] = remote.calls;
    expect([...customer.body]).toEqual([["metadata[engram_org_id]", "7"]]);
    expect(customer.init?.headers).toMatchObject({ "Idempotency-Key": "engram-customer-7", "Stripe-Version": "2026-09-30.endive" });
    expect(checkout.body.get("line_items[0][price]")).toBe("price_cloud");
    expect(checkout.body.get("customer")).toBe("cus_123");
    expect(checkout.body.get("subscription_data[metadata][engram_org_id]")).toBe("7");
    expect(checkout.body.get("success_url")).toBe("https://engram.example/app?billing=success#billing");
    expect(checkout.init?.headers).toMatchObject({ "Idempotency-Key": "engram-checkout-7-1" });
    expect(JSON.stringify(remote.calls)).not.toContain(owner.name);
    expect((await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, deps)).status).toBe(200);
    expect(remote.calls).toHaveLength(5); // Price validation and fresh subscription check, same open Checkout.
    expect(store.calls.some(call => call.query.includes("FOR UPDATE"))).toBe(true);
  });

  test("rejects caller supplied price, customer, tenant and arbitrary return URLs", async () => {
    const store = database(); const remote = transport();
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted };
    for (const body of [{ plan: "cloud", orgId: 8 }, { plan: "cloud", price: "price_cheap" }, { plan: "cloud", customer: "cus_other" }, { plan: "cloud", returnUrl: "https://attacker.example" }, { plan: "unlisted" }]) {
      expect((await handleBillingApi(request("/checkout", body), owner, deps)).status).toBe(400);
    }
    expect((await handleBillingApi(request("/portal", { customer: "cus_other" }), owner, deps)).status).toBe(400);
    expect(remote.calls).toHaveLength(0); expect(store.calls).toHaveLength(0);
  });

  test("won't sell duplicate active subscriptions and portal is bound to stored customer", async () => {
    const store = database({ ...trial, stripe_customer_id: "cus_123" });
    const remote = transport([subscription()]);
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    expect((await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, deps)).status).toBe(409);
    expect(remote.calls).toHaveLength(2);
    const response = await handleBillingApi(request("/portal"), owner, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://billing.stripe.com/p/session/test" });
    expect(remote.calls[2].body.get("customer")).toBe("cus_123");
    expect(remote.calls[2].body.get("return_url")).toBe("https://engram.example/app#billing");
  });

  test("checkout fails closed on missing configuration, invalid origins and provider failures", async () => {
    for (const settings of [{ ...hosted, secretKey: "" }, { ...hosted, webhookSecret: "" }, { ...hosted, cloudMonthlyPriceId: "" }, { ...hosted, publicUrl: "http://engram.example" }, { ...hosted, publicUrl: "https://engram.example/attacker" }]) {
      expect(publicPlans({ settings }).checkoutAvailable).toBe(false);
      expect((await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, { settings })).status).toBe(503);
    }
    const store = database(); const remote = transport(); remote.fail();
    const response = await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, { db: store.db, fetch: remote.fetcher, settings: hosted });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret-provider");
    expect(store.rows.get(7).stripe_customer_id).toBeNull();
    const unsafe = transport(); unsafe.redirect("https://attacker.example/checkout");
    expect((await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, { db: store.db, fetch: unsafe.fetcher, settings: hosted })).status).toBe(503);
    expect(store.rows.get(7).stripe_customer_id).toBeNull();
  });

  test("uses the server's dedicated Engram portal configuration", async () => {
    const store = database({ ...trial, stripe_customer_id: "cus_123" });
    const remote = transport();
    const deps = { db: store.db, fetch: remote.fetcher, settings: { ...hosted, portalConfigurationId: "bpc_engram" } };
    expect((await handleBillingApi(request("/portal"), owner, deps)).status).toBe(200);
    expect(remote.calls[0].body.get("configuration")).toBe("bpc_engram");
    expect((await handleBillingApi(request("/portal", { configuration: "bpc_foreign" }), owner, deps)).status).toBe(400);
    expect((await handleBillingApi(request("/portal"), owner, { ...deps, settings: { ...hosted, portalConfigurationId: "invalid" } })).status).toBe(503);
    expect(remote.calls).toHaveLength(1);
  });

  test("never charges a configured Stripe price that differs from the public catalog", async () => {
    for (const mismatch of [{ unit_amount: 19900 }, { currency: "eur" }, { active: false }, { recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } }]) {
      const store = database(); const remote = transport(); remote.price(mismatch);
      const response = await handleBillingApi(request("/checkout", { plan: "cloud" }), owner, { db: store.db, fetch: remote.fetcher, settings: hosted });
      expect(response.status).toBe(503);
      expect(remote.calls).toHaveLength(1);
      expect(store.rows.get(7).stripe_customer_id).toBeNull();
      expect(store.calls.some(call => call.query.includes("UPDATE workspace_billing"))).toBe(false);
    }
  });
});

describe("signed billing webhook lifecycle", () => {
  test("requires exact payload signature, a bounded timestamp and supports secret rotation signatures", async () => {
    const payload = new TextEncoder().encode('{"a":"é"}');
    const time = Math.floor(now.getTime() / 1000);
    const signature = createHmac("sha256", hosted.webhookSecret).update(`${time}.`).update(payload).digest("hex");
    expect(verifyStripeSignature(payload, `t=${time},v1=${"a".repeat(64)},v1=${signature}`, hosted.webhookSecret, time)).toBe(true);
    for (const header of [null, `t=${time},v1=bad`, `t=${time},v1=${"a".repeat(64)}`, `t=${time - 301},v1=${signature}`, `t=${time + 301},v1=${signature}`, `t=${time},t=${time},v1=${signature}`]) {
      expect(verifyStripeSignature(payload, header, hosted.webhookSecret, time)).toBe(false);
    }
    expect(verifyStripeSignature(new TextEncoder().encode('{ "a":"é"}'), `t=${time},v1=${signature}`, hosted.webhookSecret, time)).toBe(false);
  });

  test("refreshes authoritative subscriptions, ignores stale event fields and deduplicates transactionally", async () => {
    const store = database({ ...trial, stripe_customer_id: "cus_123" });
    const remote = transport([subscription({ id: "sub_old", status: "canceled", created: 1 }), subscription({ id: "sub_new", created: 200 })]);
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    expect((await handleBillingWebhook(signedEvent("customer.subscription.deleted"), deps)).status).toBe(200);
    expect(store.rows.get(7)).toMatchObject({ status: "active", stripe_subscription_id: "sub_new", plan_id: "cloud" });
    expect(remote.calls[0].url.searchParams.get("customer")).toBe("cus_123");
    expect(remote.calls[0].url.searchParams.get("status")).toBe("all");
    expect((await handleBillingWebhook(signedEvent("customer.subscription.deleted"), deps)).status).toBe(200);
    expect(remote.calls).toHaveLength(1);
    expect(store.events.size).toBe(1);
    expect(store.calls.find(call => call.query.includes("stripe_customer_id") && call.query.includes("SELECT"))?.values).toEqual(["cus_123"]);
  });

  test("doesn't infer tenant ownership from event metadata or accept other tenant subscriptions", async () => {
    const store = database({ ...trial, stripe_customer_id: "cus_123" });
    const remote = transport([subscription({ metadata: { engram_org_id: "999" } }), subscription({ customer: "cus_other" }), subscription({ items: { data: [{ price: { id: "price_other" }, quantity: 1 }] } })]);
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    expect((await handleBillingWebhook(signedEvent(), deps)).status).toBe(200);
    expect(store.rows.get(7).plan_id).toBeNull();
    expect(store.rows.get(7).status).toBe("trial");
    expect((await handleBillingWebhook(signedEvent("customer.subscription.updated", { id: "evt_unknown", data: { object: { customer: "cus_unknown", metadata: { engram_org_id: "7" } } } }), deps)).status).toBe(200);
    expect(remote.calls).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });

  test("failed processing rolls back deduplication so a delivery can retry", async () => {
    const store = database({ ...trial, stripe_customer_id: "cus_123" });
    const failed = transport(); failed.fail();
    const deps = { db: store.db, fetch: failed.fetcher, settings: hosted, now: () => now };
    expect((await handleBillingWebhook(signedEvent(), deps)).status).toBe(503);
    expect(store.events.size).toBe(0);
    expect((await handleBillingWebhook(signedEvent(), { ...deps, fetch: transport([subscription()]).fetcher })).status).toBe(200);
    expect(store.events.size).toBe(1); expect(store.rows.get(7).status).toBe("active");
  });

  test("rejects invalid and cross-environment events before database access and bounds body size", async () => {
    const store = database(); const remote = transport();
    const deps = { db: store.db, fetch: remote.fetcher, settings: hosted, now: () => now };
    expect((await handleBillingWebhook(new Request("https://engram.example/api/billing/webhook", { method: "POST", body: "{}" }), deps)).status).toBe(400);
    expect((await handleBillingWebhook(signedEvent("customer.subscription.updated", { livemode: true }), deps)).status).toBe(400);
    expect((await handleBillingWebhook(signedEvent("customer.subscription.updated", {}, "not json"), deps)).status).toBe(400);
    expect((await handleBillingWebhook(new Request("https://engram.example/api/billing/webhook", { method: "POST", body: "x".repeat(512_001) }), deps)).status).toBe(413);
    expect(store.calls).toHaveLength(0); expect(remote.calls).toHaveLength(0);
  });
});
