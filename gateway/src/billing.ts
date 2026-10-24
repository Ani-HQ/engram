import { createHmac, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { config } from "./config";
import { currentOrg } from "./context";
import { sql } from "./db";
import { hasOauthScope, normalizeToken, type TokenRecord } from "./policies";
import { paidPlan, PLANS, TRIAL_DAYS } from "./plans";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const STRIPE_VERSION = "2026-09-30.endive";
const WEBHOOK_LIMIT = 512_000;
const LIVE_STATUSES = new Set(["active", "trialing"]);
const KNOWN_STATUSES = new Set(["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]);
const WEBHOOK_TYPES = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]);

export class BillingError extends Error {
  constructor(message: string, public status = 400, public code = "billing_error") { super(message); }
}

export interface BillingSettings {
  mode: "hosted" | "self-hosted";
  publicUrl: string;
  secretKey: string;
  webhookSecret: string;
  cloudMonthlyPriceId: string;
  portalConfigurationId?: string;
}
export interface BillingDependencies {
  db?: postgres.Sql;
  fetch?: typeof fetch;
  now?: () => Date;
  settings?: BillingSettings;
}
function dependencies(input: BillingDependencies) {
  return { db: input.db ?? sql, fetch: input.fetch ?? fetch, now: input.now ?? (() => new Date()), settings: input.settings ?? {
    mode: config.deploymentMode, publicUrl: config.publicUrl, ...config.billing,
  } };
}

function trustedOrigin(settings: BillingSettings): string | null {
  try {
    const url = new URL(settings.publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch { return null; }
}
function ready(settings: BillingSettings): boolean {
  return settings.mode === "hosted" && !!settings.secretKey && !!settings.webhookSecret && /^price_[A-Za-z0-9]+$/.test(settings.cloudMonthlyPriceId) && !!trustedOrigin(settings);
}
export function publicPlans(input: BillingDependencies = {}) {
  const { settings } = dependencies(input);
  return { mode: settings.mode, trialDays: TRIAL_DAYS, currency: "usd", checkoutAvailable: ready(settings), plans: PLANS };
}

// Keep payment recovery, privacy controls, exports, revocation and deletion free
// to use. Share creation/resumption can backfill an entire workspace, so those
// routes have the same entitlement requirement as direct content writes.
export function requiresHostedEntitlement(method: string, pathname: string): boolean {
  if (method === "PATCH") return /^\/api\/share\/rules\/\d+$/.test(pathname);
  if (method !== "POST") return false;
  if (["/api/capture", "/api/page/restore", "/api/tokens", "/api/invites", "/api/trails", "/api/share", "/api/share/rules", "/api/review/approve"].includes(pathname)) return true;
  return /^\/api\/trails\/[^/]+\/share$/.test(pathname) || /^\/api\/share\/rules\/\d+\/resume$/.test(pathname);
}

function actorFor(token: TokenRecord, owner = false, write = false) {
  const actor = normalizeToken(token);
  if (!Number.isSafeInteger(actor.orgId) || actor.orgId < 1 || (currentOrg() && currentOrg()!.id !== actor.orgId) ||
      (owner && (actor.role !== "owner" || actor.kind === "oauth")) || (owner && !hasOauthScope(actor, write ? "memory:write" : "memory:read")) || (write && !actor.canWrite)) {
    throw new BillingError("Only a workspace owner can manage billing", 403, "forbidden");
  }
  return actor;
}
async function ensureRow(orgId: number, db: postgres.Sql) {
  // Anchoring to workspace creation prevents read requests or retries resetting a trial.
  await db`
    INSERT INTO workspace_billing (org_id, trial_ends_at)
    SELECT id, created_at + interval '14 days' FROM orgs WHERE id = ${orgId}
    ON CONFLICT (org_id) DO NOTHING`;
}
async function getRow(orgId: number, db: postgres.Sql, lock = false): Promise<any> {
  const rows = lock
    ? await db`SELECT b.*, c.id AS complimentary_id, c.granted_at AS complimentary_granted_at,
        c.expires_at AS complimentary_expires_at, c.revoked_at AS complimentary_revoked_at
        FROM workspace_billing b LEFT JOIN workspace_complimentary_access c ON c.org_id = b.org_id
        WHERE b.org_id = ${orgId} FOR UPDATE OF b`
    : await db`SELECT b.*, c.id AS complimentary_id, c.granted_at AS complimentary_granted_at,
        c.expires_at AS complimentary_expires_at, c.revoked_at AS complimentary_revoked_at
        FROM workspace_billing b LEFT JOIN workspace_complimentary_access c ON c.org_id = b.org_id
        WHERE b.org_id = ${orgId}`;
  if (!rows[0]) throw new BillingError("Workspace billing is unavailable", 503, "billing_unavailable");
  return rows[0];
}
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value as string);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function complimentaryAccess(row: any, now: Date) {
  if (!row?.complimentary_id) return null;
  const grantedAt = iso(row.complimentary_granted_at);
  const expiresAt = iso(row.complimentary_expires_at);
  const revokedAt = iso(row.complimentary_revoked_at);
  const active = !!grantedAt && new Date(grantedAt).getTime() <= now.getTime()
    && row.complimentary_revoked_at === null
    && (row.complimentary_expires_at === null || (!!expiresAt && new Date(expiresAt).getTime() > now.getTime()));
  return { active, grantedAt, expiresAt, revokedAt };
}
function snapshot(row: any, settings: BillingSettings, now: Date) {
  const trialEndsAt = iso(row?.trial_ends_at);
  // A missed webhook cannot leave a canceled subscription entitled forever.
  const periodEndsAt = iso(row?.current_period_ends_at);
  const subscribed = row?.plan_id === "cloud" && LIVE_STATUSES.has(row?.status) && !!periodEndsAt && new Date(periodEndsAt).getTime() > now.getTime();
  const trial = row?.status === "trial" && !!trialEndsAt && new Date(trialEndsAt).getTime() > now.getTime();
  const complimentary = complimentaryAccess(row, now);
  const comp = complimentary?.active === true;
  return {
    mode: settings.mode, planId: comp ? "complimentary" : row?.plan_id === "cloud" ? "cloud" : "trial", status: comp ? "complimentary" : trial ? "trial" : row?.status === "trial" ? "trial_expired" : LIVE_STATUSES.has(row?.status) && !subscribed ? "payment_pending" : String(row?.status ?? "trial_expired"),
    canWrite: comp || subscribed || trial, trialEndsAt, currentPeriodEndsAt: periodEndsAt,
    entitlementSource: comp ? "complimentary" : subscribed ? "subscription" : trial ? "trial" : "none",
    complimentary, subscriptionStatus: row?.stripe_subscription_id ? String(row.status) : null,
    cancelAtPeriodEnd: row?.cancel_at_period_end === true, checkoutAvailable: !comp && ready(settings), portalAvailable: ready(settings) && !!row?.stripe_customer_id,
  };
}
const SELF_HOSTED = { mode: "self-hosted", planId: "self-hosted", status: "self-hosted", canWrite: true, entitlementSource: "self-hosted", complimentary: null, subscriptionStatus: null, trialEndsAt: null, currentPeriodEndsAt: null, cancelAtPeriodEnd: false, checkoutAvailable: false, portalAvailable: false };

async function entitlementRow(orgId: number, deps: Dependencies) {
  const row = await getRow(orgId, deps.db);
  // Operator-funded access does not depend on a payment-provider roundtrip. An
  // existing subscription stays intact and its portal remains available.
  if (complimentaryAccess(row, deps.now())?.active) return row;
  if (row.stripe_customer_id && row.plan_id === "cloud" && LIVE_STATUSES.has(row.status) &&
      (!row.current_period_ends_at || new Date(row.current_period_ends_at).getTime() <= deps.now().getTime()) && ready(deps.settings)) {
    return deps.db.begin(async tx => {
      const db = tx as unknown as postgres.Sql;
      return syncSubscription(deps, db, await getRow(orgId, db, true));
    });
  }
  return row;
}

export async function getBillingSummary(token: TokenRecord, input: BillingDependencies = {}) {
  const actor = actorFor(token, true);
  const deps = dependencies(input);
  if (deps.settings.mode === "self-hosted") return { ...SELF_HOSTED };
  await ensureRow(actor.orgId, deps.db);
  return snapshot(await entitlementRow(actor.orgId, deps), deps.settings, deps.now());
}
// Reads, exports, deleting data, and payment management remain available after an
// expired trial. Call this only before adding/changing billable workspace content.
export async function requireHostedWriteAccess(token: TokenRecord, input: BillingDependencies = {}): Promise<void> {
  const actor = actorFor(token);
  const deps = dependencies(input);
  if (deps.settings.mode === "self-hosted") return;
  await ensureRow(actor.orgId, deps.db);
  const state = snapshot(await entitlementRow(actor.orgId, deps), deps.settings, deps.now());
  if (!state.canWrite) throw new BillingError("This workspace needs an active Cloud subscription to add or change content. Existing data remains readable and exportable.", 402, "subscription_required");
}

type Dependencies = ReturnType<typeof dependencies>;
async function stripe(deps: Dependencies, path: string, params?: Record<string, string>, key?: string): Promise<any> {
  let response: Response;
  try {
    response = await deps.fetch(`https://api.stripe.com/v1/${path}`, {
      method: params ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${deps.settings.secretKey}`, "Stripe-Version": STRIPE_VERSION,
        ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(params ? { body: new URLSearchParams(params) } : {}),
    });
  } catch { throw new BillingError("The payment service is temporarily unavailable. Please retry.", 503, "billing_unavailable"); }
  if (!response.ok) throw new BillingError("The payment service could not complete this request. Please retry.", 503, "billing_unavailable");
  try { return await response.json(); } catch { throw new BillingError("The payment service returned an invalid response", 503, "billing_unavailable"); }
}
function stripeId(value: unknown, prefix: string): string | null {
  const id = typeof value === "object" && value !== null ? (value as any).id : value;
  return typeof id === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(id) ? id : null;
}
function redirectUrl(value: unknown, host: string): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && url.hostname === host && !url.username && !url.password) return url.href;
  } catch {}
  throw new BillingError("The payment service returned an invalid redirect", 503, "billing_unavailable");
}
function timestamp(seconds: unknown): string | null {
  const value = Number(seconds);
  return value > 0 && Number.isFinite(value) ? iso(value * 1000) : null;
}

async function currentSubscription(deps: Dependencies, customer: string, orgId: number) {
  const subscriptions: any[] = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ customer, status: "all", limit: "100", ...(after ? { starting_after: after } : {}) });
    const result = await stripe(deps, `subscriptions?${query}`);
    if (!Array.isArray(result.data)) throw new BillingError("The payment service returned an invalid subscription list", 503);
    subscriptions.push(...result.data);
    if (!result.has_more) {
      return subscriptions.filter(sub => stripeId(sub.id, "sub") && stripeId(sub.customer, "cus") === customer && sub.metadata?.engram_org_id === String(orgId) && KNOWN_STATUSES.has(sub.status) &&
          Array.isArray(sub.items?.data) && sub.items.data.length === 1 && sub.items.data[0]?.price?.id === deps.settings.cloudMonthlyPriceId && sub.items.data[0]?.quantity === 1)
        .sort((a, b) => Number(LIVE_STATUSES.has(b.status)) - Number(LIVE_STATUSES.has(a.status)) || Number(b.created ?? 0) - Number(a.created ?? 0))[0] ?? null;
    }
    after = stripeId(result.data.at(-1), "sub") ?? "";
    if (!after) break;
  }
  throw new BillingError("The payment service returned too many subscription records", 503);
}
async function syncSubscription(deps: Dependencies, db: postgres.Sql, row: any) {
  const sub = await currentSubscription(deps, String(row.stripe_customer_id), Number(row.org_id));
  const period = sub ? timestamp(sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? sub.trial_end) : null;
  const status = sub?.status ?? (row.status === "trial" ? "trial" : "canceled");
  await db`
    UPDATE workspace_billing SET stripe_subscription_id = ${sub?.id ?? null}, plan_id = ${sub ? "cloud" : null},
      status = ${status}, current_period_ends_at = ${period}, cancel_at_period_end = ${sub?.cancel_at_period_end === true}, updated_at = now()
    WHERE org_id = ${Number(row.org_id)}`;
  return { ...row, stripe_subscription_id: sub?.id ?? null, plan_id: sub ? "cloud" : null, status, current_period_ends_at: period, cancel_at_period_end: sub?.cancel_at_period_end === true };
}

async function checkout(token: TokenRecord, plan: unknown, input: BillingDependencies) {
  const actor = actorFor(token, true, true);
  if (!paidPlan(plan)) throw new BillingError("Choose an available plan");
  const deps = dependencies(input);
  if (!ready(deps.settings)) throw new BillingError("Hosted checkout has not been configured", 503, "billing_unavailable");
  const origin = trustedOrigin(deps.settings)!;
  await ensureRow(actor.orgId, deps.db);
  return deps.db.begin(async tx => {
    const db = tx as unknown as postgres.Sql;
    await getRow(actor.orgId, db, true);
    // A complimentary grant may commit while this request waits for the row
    // lock. A separate read observes that grant before any provider operation.
    let row = await getRow(actor.orgId, db);
    if (complimentaryAccess(row, deps.now())?.active) throw new BillingError("This workspace already has complimentary access. No subscription is required.", 409, "complimentary_access");
    if (config.signupMode === "invite-only") {
      const admission = await db`SELECT id FROM hosted_signup_invites
        WHERE redeemed_org_id = ${actor.orgId} AND redeemed_at IS NOT NULL AND revoked_at IS NULL AND complimentary_revoked_at IS NULL LIMIT 1`;
      if (admission.length) throw new BillingError("Your invitation includes complimentary access. Setup is still being completed.", 409, "complimentary_pending");
    }
    const price = await stripe(deps, `prices/${encodeURIComponent(deps.settings.cloudMonthlyPriceId)}`);
    const catalog = PLANS.find(item => item.id === "cloud")!;
    if (price.id !== deps.settings.cloudMonthlyPriceId || price.active !== true || price.currency !== catalog.currency || price.unit_amount !== catalog.monthlyPrice * 100 ||
        price.type !== "recurring" || price.recurring?.interval !== "month" || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== "licensed") {
      throw new BillingError("The configured payment price does not match the published plan", 503, "billing_unavailable");
    }
    if (row.stripe_customer_id) row = await syncSubscription(deps, db, row);
    if (row.stripe_subscription_id && !["canceled", "incomplete_expired"].includes(row.status)) {
      throw new BillingError("This workspace already has a subscription. Manage it in the billing portal.", 409, "subscription_exists");
    }
    if (row.checkout_url && row.checkout_expires_at && new Date(row.checkout_expires_at).getTime() > deps.now().getTime() + 30_000) {
      return { url: redirectUrl(row.checkout_url, "checkout.stripe.com") };
    }
    let customer = stripeId(row.stripe_customer_id, "cus");
    if (!customer) {
      // No memory, workspace title, token identity, or agent information leaves Engram.
      const result = await stripe(deps, "customers", { "metadata[engram_org_id]": String(actor.orgId) }, `engram-customer-${actor.orgId}`);
      customer = stripeId(result.id, "cus");
      if (!customer) throw new BillingError("The payment service returned an invalid customer", 503);
      await db`UPDATE workspace_billing SET stripe_customer_id = ${customer}, updated_at = now() WHERE org_id = ${actor.orgId}`;
    }
    const generation = Number(row.checkout_generation ?? 0) + 1;
    const result = await stripe(deps, "checkout/sessions", {
      mode: "subscription", customer, "line_items[0][price]": deps.settings.cloudMonthlyPriceId, "line_items[0][quantity]": "1",
      client_reference_id: String(actor.orgId), "metadata[engram_org_id]": String(actor.orgId), "subscription_data[metadata][engram_org_id]": String(actor.orgId),
      success_url: `${origin}/app?billing=success#billing`, cancel_url: `${origin}/app?billing=canceled#billing`,
    }, `engram-checkout-${actor.orgId}-${generation}`);
    const id = stripeId(result.id, "cs");
    const url = redirectUrl(result.url, "checkout.stripe.com");
    const expires = timestamp(result.expires_at);
    if (!id || !expires) throw new BillingError("The payment service returned an invalid checkout session", 503);
    await db`
      UPDATE workspace_billing SET checkout_session_id = ${id}, checkout_url = ${url}, checkout_expires_at = ${expires},
        checkout_generation = ${generation}, updated_at = now() WHERE org_id = ${actor.orgId}`;
    return { url };
  });
}
async function portal(token: TokenRecord, input: BillingDependencies) {
  const actor = actorFor(token, true, true);
  const deps = dependencies(input);
  if (!ready(deps.settings)) throw new BillingError("Hosted billing has not been configured", 503, "billing_unavailable");
  await ensureRow(actor.orgId, deps.db);
  const row = await getRow(actor.orgId, deps.db);
  const customer = stripeId(row.stripe_customer_id, "cus");
  if (!customer) throw new BillingError("This workspace has no billing account yet", 409);
  const configuration = deps.settings.portalConfigurationId;
  if (configuration && !/^bpc_[A-Za-z0-9]+$/.test(configuration)) throw new BillingError("Hosted billing portal has not been configured", 503);
  const result = await stripe(deps, "billing_portal/sessions", { customer, return_url: `${trustedOrigin(deps.settings)}/app#billing`, ...(configuration ? { configuration } : {}) });
  return { url: redirectUrl(result.url, "billing.stripe.com") };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(await readBody(req, 2048)); }
  catch (error) { if (error instanceof BillingError) throw error; throw new BillingError("Provide a valid JSON object"); }
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new BillingError("Provide a valid JSON object");
}
function failure(error: unknown): Response {
  return error instanceof BillingError
    ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: HEADERS })
    : Response.json({ error: "Billing is temporarily unavailable", code: "billing_unavailable" }, { status: 503, headers: HEADERS });
}
export async function handleBillingApi(req: Request, token: TokenRecord, input: BillingDependencies = {}): Promise<Response> {
  try {
    const path = new URL(req.url).pathname;
    if (path === "/api/billing" && req.method === "GET") return Response.json(await getBillingSummary(token, input), { headers: HEADERS });
    actorFor(token, true, true);
    if (req.method !== "POST" || !["/api/billing/checkout", "/api/billing/portal"].includes(path)) return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...HEADERS, Allow: path === "/api/billing" ? "GET" : "POST" } });
    const body = await readJson(req);
    if (path.endsWith("/checkout")) {
      if (Object.keys(body).some(key => key !== "plan")) throw new BillingError("Only a plan may be supplied");
      return Response.json(await checkout(token, body.plan, input), { headers: HEADERS });
    }
    if (Object.keys(body).length) throw new BillingError("The billing portal does not accept account identifiers");
    return Response.json(await portal(token, input), { headers: HEADERS });
  } catch (error) { return failure(error); }
}

export function verifyStripeSignature(payload: Uint8Array, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !header || header.length > 8192) return false;
  const fields = header.split(",").map(part => part.trim().split("="));
  const timestamps = fields.filter(([key]) => key === "t").map(([, value]) => value);
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0] ?? "")) return false;
  const time = Number(timestamps[0]);
  if (!Number.isSafeInteger(time) || Math.abs(nowSeconds - time) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamps[0]}.`).update(payload).digest();
  return fields.some(([key, value]) => key === "v1" && /^[a-fA-F0-9]{64}$/.test(value ?? "") && timingSafeEqual(expected, Buffer.from(value, "hex")));
}
async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  const length = Number(req.headers.get("content-length"));
  if (length > limit) throw new BillingError("Request is too large", 413);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new BillingError("Request is too large", 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
export async function handleBillingWebhook(req: Request, input: BillingDependencies = {}): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...HEADERS, Allow: "POST" } });
  try {
    const deps = dependencies(input);
    if (!ready(deps.settings)) throw new BillingError("Hosted billing has not been configured", 503, "billing_unavailable");
    const payload = await readBody(req, WEBHOOK_LIMIT);
    if (!verifyStripeSignature(payload, req.headers.get("stripe-signature"), deps.settings.webhookSecret, Math.floor(deps.now().getTime() / 1000))) throw new BillingError("Invalid webhook signature");
    let event: any;
    try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); } catch { throw new BillingError("Invalid webhook event"); }
    if (!stripeId(event?.id, "evt") || typeof event?.type !== "string" || !event?.data?.object) throw new BillingError("Invalid webhook event");
    const keyMode = deps.settings.secretKey.match(/^(?:sk|rk)_(test|live)_/)?.[1];
    if (keyMode && event.livemode !== (keyMode === "live")) throw new BillingError("Webhook environment does not match");
    if (!WEBHOOK_TYPES.has(event.type)) return Response.json({ received: true }, { headers: HEADERS });
    await deps.db.begin(async tx => {
      const db = tx as unknown as postgres.Sql;
      // The deduplication record and subscription state commit together. A failed
      // refresh rolls both back so Stripe can retry instead of losing the event.
      const inserted = await db`
        INSERT INTO billing_webhook_events (id, event_type) VALUES (${event.id}, ${event.type})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (!inserted.length) return;
      const customer = stripeId(event.data.object.customer, "cus");
      if (!customer) return;
      // Never create a tenant/customer binding from webhook metadata. Only a
      // customer created by an authenticated owner can affect an existing tenant.
      const rows = await db`SELECT * FROM workspace_billing WHERE stripe_customer_id = ${customer} FOR UPDATE`;
      if (!rows[0]) return;
      // Fetch current subscriptions even for old/deleted events. This prevents a
      // delayed event for a prior subscription undoing a newer paid subscription.
      await syncSubscription(deps, db, rows[0]);
    });
    return Response.json({ received: true }, { headers: HEADERS });
  } catch (error) { return failure(error); }
}
