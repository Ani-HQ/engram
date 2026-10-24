/** Opt-in, real Stripe anonymous-sandbox billing exercise. No production keys.
 * Uses the official Stripe CLI anonymous provisioning protocol directly to
 * avoid its automatic on-disk credential profile. All returned keys stay in
 * this process's memory. Run only with ENGRAM_RUN_STRIPE_SANDBOX=1.
 * Fresh native PostgreSQL lives under a private temporary directory on15434.
 * Hosted Checkout opens through127.0.0.1:15435/checkout in a separate test tab.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

if (process.env.ENGRAM_RUN_STRIPE_SANDBOX !== "1") throw new Error("Explicit anonymous sandbox opt-in required");
const pgBin = "/Applications/Postgres.app/Contents/Versions/18/bin";
const directory = await mkdtemp(join(tmpdir(), "engram-stripe-sandbox-"));
const dbTemplate = "postgresql://engram_stripe_test@127.0.0.1:15434/__DB__";
const firstOrgId = randomInt(1_000_000, 1_000_000_000), secondOrgId = firstOrgId + 1;
// Replace every provider/deployment value before any production module import.
Object.assign(process.env, { ENGRAM_DB_URL_TEMPLATE: dbTemplate, ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_DATABASE_AUTHORITY: "inline", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "1", ENGRAM_PROVISIONER_DB_URL_TEMPLATE: "", ENGRAM_TENANT_CREDENTIAL_KEY: "disposable-stripe-sandbox-only-master-key", ENGRAM_PUBLIC_URL: "https://engram-sandbox.example.com", GBRAIN_HOMES_DIR: join(directory, "homes"), RESEND_API_KEY: "", VOYAGE_API_KEY: "", REFLEX_API_KEY: "", TYPESAFE_API_KEY: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", STRIPE_CLOUD_MONTHLY_PRICE_ID: "", STRIPE_PORTAL_CONFIGURATION_ID: "", ENGRAM_WORKER_ISOLATION: "process", ENGRAM_GENERATIVE_API_KEY: "", ENGRAM_BRIEF_API_KEY: "", ENGRAM_DEV_LOGIN_LINKS: "0" });
const { handleBillingApi, handleBillingWebhook, getBillingSummary, requireHostedWriteAccess, verifyStripeSignature } = await import("../gateway/src/billing");
const { ensureComplimentaryAccessSchema } = await import("../gateway/src/billing-schema");
const { normalizeToken } = await import("../gateway/src/policies");
const { closeDatabasePools } = await import("../gateway/src/db");

let phase = "provisioning", checks = 0, key = "", webhookSecret = "", clockId = "", endpointId = "", clockNow = Math.floor(Date.now() / 1000);
let db: postgres.Sql | undefined, server: ReturnType<typeof Bun.serve> | undefined, tunnel: ReturnType<typeof Bun.spawn> | undefined;
let pgStarted = false, checkoutUrl = "", tunnelUrl = "", productId = "", priceId = "", portalId = "", clockCustomerId = "";
let completed = false, failureMessage = "", tunnelOutput: Promise<void> | undefined;
const customerIds = new Set<string>();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { interrupted = true; });
const report: Record<string, unknown> = {
  realStripeSandbox: false, productionTouched: false, realMoneyMoved: false,
  stripeDeliveryVerified: false, checkoutCompleted: false, renewalVerified: false,
  scheduledRenewalVerified: false, failedPaymentVerified: false, paymentRecoveryVerified: false,
  scheduledFailedRenewalVerified: false, cancellationVerified: false, endedPeriodVerified: false,
  duplicateReplayVerified: false, delayedEventReconciliationVerified: false,
  replaySource: "locally_signed_real_provider_events", providerRedeliveryVerified: false,
  workspaceIsolationVerified: false, asynchronousPaymentMethodVerified: false,
};
function check(value: unknown, message: string): asserts value { assert.ok(value, message); checks++; }
function progress(stage: string) { phase = stage; console.log(JSON.stringify({ stage, checks })); }
async function providedTestKey(): Promise<string> {
  const command = process.env.ENGRAM_STRIPE_SANDBOX_KEY_SOURCE;
  if (command !== "secret-manager") throw new Error("Unsupported test key source");
  const child = Bun.spawn(["gcloud", "secrets", "versions", "access", "latest", "--secret=engram-stripe-test-secret-key", "--project=ani-hq", "--quiet", "--verbosity=error", "--no-log-http"], {
    env: { ...process.env, CLOUDSDK_CORE_LOG_HTTP: "false", CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true" }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const [raw, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0 || raw.length > 1024) throw new Error("Dedicated sandbox test key unavailable");
    const value = raw.trim();
    if (!/^(?:sk|rk|rkcs)_test_[A-Za-z0-9_]+$/.test(value)) throw new Error("Dedicated sandbox secret must contain a TEST key");
    return value;
  } finally { clearTimeout(timer); }
}
async function child(command: string, args: string[]) {
  const process = Bun.spawn([command, ...args], { env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: directory, TMPDIR: directory }, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => process.kill("SIGKILL"), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code) throw new Error("Disposable PostgreSQL command failed");
    return stdout;
  } finally { clearTimeout(timeout); }
}
// Never include Stripe's message, request body, URL/query, account identifiers or
// returned object in diagnostics. These three structured fields are sufficient
// to locate a version/parameter failure without disclosing provider content.
function diagnosticToken(value: unknown, field: "type" | "code" | "param"): string | undefined {
  if (typeof value !== "string" || /(?:sk|rk|rkcs|whsec)_/i.test(value)) return;
  if (field === "type") return new Set(["api_error", "card_error", "idempotency_error", "invalid_request_error", "rate_limit_error", "authentication_error", "permission_error", "validation_error"]).has(value) ? value : undefined;
  return (field === "code" ? /^[a-z][a-z0-9_]{0,79}$/ : /^[a-z][a-z0-9_]*(?:\[(?:[a-z][a-z0-9_]*|[0-9]+)\]){0,8}$/).test(value) && value.length <= 120 ? value : undefined;
}
class SandboxProviderError extends Error {
  readonly diagnostic: { operation: string; status: number; type?: string; code?: string; param?: string };
  constructor(readonly status: number, operation: string, error: any) {
    const type = diagnosticToken(error?.type, "type"), code = diagnosticToken(error?.code, "code"), param = diagnosticToken(error?.param, "param");
    super(`Sandbox provider HTTP${status} during ${operation}`);
    this.diagnostic = { operation, status, ...(type ? { type } : {}), ...(code ? { code } : {}), ...(param ? { param } : {}) };
  }
}
function stripeOperation(path: string, method: string): string {
  const resources = new Set(["products", "prices", "customers", "subscriptions", "events", "invoices", "checkout", "sessions", "expire", "pay", "payment_methods", "attach", "billing_portal", "configurations", "webhook_endpoints", "test_helpers", "test_clocks", "advance"]);
  return `${method} /v1/` + path.split("?", 1)[0].split("/").map(part => resources.has(part) ? part : ":id").join("/");
}
async function json(url: string, init: RequestInit = {}, operation = "anonymous_sandbox_protocol") {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error(`Sandbox network request unavailable during ${operation}`); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SandboxProviderError(response.status, operation, body?.error);
  }
  return body;
}
async function stripe(path: string, params?: Record<string, string>, method?: string): Promise<any> {
  check(/^(?:sk|rk|rkcs)_test_[A-Za-z0-9_]+$/.test(key), "All provider operations require the newly provisioned TEST key");
  const verb = method ?? (params ? "POST" : "GET");
  const value = await json("https://api.stripe.com/v1/" + path, { method: verb, headers: { Authorization: "Bearer " + key, "Stripe-Version": "2026-09-30.endive", ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, ...(params ? { body: new URLSearchParams(params) } : {}) }, stripeOperation(path, verb));
  report.realStripeSandbox = true;
  if (typeof value?.livemode === "boolean") check(value.livemode === false, "Every Stripe object stays in test mode");
  return value;
}
async function wait<T>(load: () => Promise<T>, accept: (value: T) => boolean, label: string, attempts = 60, delay = 1000): Promise<T> {
  for (let i = 0; i < attempts; i++) { if (interrupted) throw new Error("Sandbox verification interrupted"); const value = await load(); if (accept(value)) return value; await Bun.sleep(delay); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const email = "engram-e2e@example.com";
  if (process.env.ENGRAM_STRIPE_SANDBOX_KEY_SOURCE) {
    key = await providedTestKey();
    check(true, "Dedicated user-provided test key captured only in memory");
    report.anonymousSandbox = false;
    progress("provided_test_key_memory_only");
  } else {
  const challenge = await json("https://ai.stripe.com/keys/challenge", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Engram anonymous sandbox verification" }, body: JSON.stringify({ email }) });
  check(String(challenge.algorithm).toLowerCase().replaceAll("-", "") === "sha256" && /^[a-f0-9]{64}$/i.test(challenge.challenge) && typeof challenge.salt === "string", "Official anonymous challenge has the supported bounded SHA256 form");
  let solution = -1;
  const proofDeadline = Date.now() + 60_000;
  for (let n = 0; n < 100_000_000; n++) {
    if (createHash("sha256").update(challenge.salt + String(n)).digest("hex") === challenge.challenge.toLowerCase()) { solution = n; break; }
    if (n % 4096 === 0 && Date.now() > proofDeadline) break;
  }
  check(solution >= 0, "Official anonymous proof-of-work solved within its budget");
  const sandbox = await json("https://ai.stripe.com/keys/provision", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Engram anonymous sandbox verification" }, body: JSON.stringify({ ...challenge, number: solution, email, name: "Engram disposable billing verification" }) });
  key = sandbox.restricted_key ?? sandbox.secret_key ?? "";
  check(/^(?:sk|rk|rkcs)_test_[A-Za-z0-9_]+$/.test(key), "Anonymous sandbox returned a test-only key without a CLI key file");
  report.realStripeSandbox = true;
  report.anonymousSandbox = true;
  progress("sandbox_provisioned_keys_memory_only");
  }

  await child(join(pgBin, "initdb"), ["-D", join(directory, "pg"), "-U", "engram_stripe_test", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
  await child(join(pgBin, "pg_ctl"), ["-D", join(directory, "pg"), "-l", join(directory, "postgres.log"), "-o", "-h127.0.0.1 -p15434", "start"]); pgStarted = true;
  await child(join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", "15434", "-U", "engram_stripe_test", "engram_gateway"]);
  db = postgres(dbTemplate.replace("__DB__", "engram_gateway"), { max: 4, onnotice() {} });
  const identity = await db`SELECT current_user AS role, current_database() AS name`;
  check(identity[0]?.role === "engram_stripe_test" && identity[0]?.name === "engram_gateway", "Only the fresh disposable PostgreSQL cluster is used");
  await db`CREATE TABLE orgs (id int PRIMARY KEY, created_at timestamptz NOT NULL)`;
  await db`INSERT INTO orgs VALUES (${firstOrgId}, now()-interval '30days'), (${secondOrgId}, now()-interval '30days')`;
  // Billing schema matches the migration; full migration/isolation integration
  // is a separate release gate. This exercises real handler SQL, no SQL mocks.
  await db`CREATE TABLE workspace_billing (org_id int PRIMARY KEY REFERENCES orgs(id), trial_ends_at timestamptz NOT NULL, stripe_customer_id text UNIQUE, stripe_subscription_id text UNIQUE, plan_id text, status text NOT NULL DEFAULT 'trial', current_period_ends_at timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false, checkout_session_id text, checkout_url text, checkout_expires_at timestamptz, checkout_generation int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`;
  await db`CREATE TABLE billing_webhook_events (id text PRIMARY KEY, event_type text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now())`;
  await ensureComplimentaryAccessSchema(db);
  const product = await stripe("products", { name: "Engram isolated Cloud test", "metadata[app]": "engram-e2e" });
  productId = product.id;
  const price = await stripe("prices", { product: product.id, currency: "usd", unit_amount: "1900", "recurring[interval]": "month" });
  priceId = price.id;
  const portal = await stripe("billing_portal/configurations", { "business_profile[headline]": "Engram disposable test", "features[subscription_cancel][enabled]": "true", "features[subscription_cancel][mode]": "at_period_end", "features[payment_method_update][enabled]": "true", "features[invoice_history][enabled]": "true" });
  portalId = portal.id;
  webhookSecret = "whsec_" + randomBytes(32).toString("hex");
  const settings = { mode: "hosted" as const, publicUrl: "https://engram-sandbox.example.com", secretKey: key, webhookSecret, cloudMonthlyPriceId: price.id, portalConfigurationId: portal.id };
  const deps = { db, settings, now: () => clockId ? new Date(clockNow * 1000) : new Date() };
  // Stripe signs deliveries with wall time even while its test clock advances.
  const webhookDeps = { db, settings, now: () => new Date() };
  const owner = normalizeToken({ name: email, email, orgId: firstOrgId, role: "owner", kind: "session" });
  const other = normalizeToken({ ...owner, orgId: secondOrgId });
  const bearer = randomBytes(32).toString("base64url");
  let deliveries = 0;
  let targetCustomer = "", deferPastDue = false, delayedEvent: any;
  // Only requests accepted through the public receiver populate these receipts.
  // Direct, locally signed replay tests must never count as Stripe delivery.
  const delivered = new Map<string, { type: string; objectId: string; cancelAtPeriodEnd: boolean }>();
  server = Bun.serve({ hostname: "127.0.0.1", port: 15435, maxRequestBodySize: 512_000, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/billing/webhook") {
      let raw: string, event: any;
      try { raw = await req.text(); event = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
      if (Buffer.byteLength(raw) > 512_000) return new Response(null, { status: 413 });
      const authenticated = verifyStripeSignature(Buffer.from(raw), req.headers.get("stripe-signature"), settings.webhookSecret);
      // Hold one genuine stale subscription event before storage. Other events
      // establish payment failure, then recovery. Releasing this original ID
      // afterward exercises reconciliation, rather than just deduplication.
      if (authenticated && event.livemode === false && deferPastDue && event.type === "customer.subscription.updated"
          && event.data?.object?.customer === targetCustomer && event.data?.object?.status === "past_due"
          && (!delayedEvent || delayedEvent.id === event.id)) {
        delayedEvent = event;
        return new Response(null, { status: 503 });
      }
      const response = await handleBillingWebhook(new Request(req.url, { method: req.method, headers: req.headers, body: raw }), webhookDeps);
      if (response.status === 200 && authenticated) {
        deliveries++;
        delivered.set(event.id, { type: event.type, objectId: event.data?.object?.id, cancelAtPeriodEnd: event.data?.object?.cancel_at_period_end === true });
      }
      return response;
    }
    const local = ["127.0.0.1", "localhost"].includes(new URL(req.url).hostname);
    if (!local) return new Response(null, { status: 404 });
    if (path === "/checkout") return checkoutUrl ? Response.redirect(checkoutUrl, 302) : new Response(null, { status: 503 });
    if (path === "/status") return Response.json({ phase, checks, deliveries, ...report });
    if (req.headers.get("authorization") !== "Bearer " + bearer) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleBillingApi(req, owner, deps);
  } });
  const received = async (type: string, objectId: string, label: string, accept: (value: { cancelAtPeriodEnd: boolean }) => boolean = () => true) => {
    const id = await wait(async () => [...delivered].find(([, value]) => value.type === type && value.objectId === objectId && accept(value))?.[0], Boolean, label, 90, 1000);
    check(!!(await db!`SELECT id FROM billing_webhook_events WHERE id=${id!} AND event_type=${type}`)[0], `${label} committed its exact provider event`);
    return id!;
  };
  const replay = async (event: any) => {
    const body = JSON.stringify(event), time = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret).update(`${time}.`).update(body).digest("hex");
    return handleBillingWebhook(new Request("http://127.0.0.1:15435/api/billing/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${time},v1=${signature}` }, body }), webhookDeps);
  };
  const api = async (path: string, body?: Record<string, unknown>, actor = owner) => handleBillingApi(new Request("http://127.0.0.1:15435/api/billing" + path, { method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) }), actor, deps);
  check((await getBillingSummary(owner, deps)).canWrite === false, "Expired workspace starts without paid entitlement");
  const otherCheckout = await api("/checkout", { plan: "cloud" }, other);
  check(otherCheckout.status === 200, "Actual Engram Checkout handler creates the other workspace's customer/session");
  const otherRow = (await db`SELECT * FROM workspace_billing WHERE org_id=${secondOrgId}`)[0];
  customerIds.add(otherRow.stripe_customer_id);
  await stripe("checkout/sessions/" + otherRow.checkout_session_id + "/expire", {});
  try {
    const clock = await stripe("test_helpers/test_clocks", { frozen_time: String(clockNow), name: "Engram isolated lifecycle" }); clockId = clock.id;
    report.testClockAvailable = true;
  } catch (error) {
    if (!(error instanceof SandboxProviderError) || error.status !== 403) throw error;
    report.testClockAvailable = false;
  }
  const customer = await stripe("customers", { email, ...(clockId ? { test_clock: clockId } : {}), "metadata[engram_org_id]": String(firstOrgId) });
  customerIds.add(customer.id); targetCustomer = customer.id;
  if (clockId) clockCustomerId = customer.id;
  await db`UPDATE workspace_billing SET stripe_customer_id=${customer.id} WHERE org_id=${firstOrgId}`;
  const checkout = await api("/checkout", { plan: "cloud" });
  check(checkout.status === 200, "Actual Engram handler creates the clock customer's real test Checkout");
  checkoutUrl = (await checkout.json()).url;
  check(new URL(checkoutUrl).hostname === "checkout.stripe.com", "Checkout URL is Stripe-hosted");
  const row = (await db`SELECT * FROM workspace_billing WHERE org_id=${firstOrgId}`)[0];
  const session = await stripe("checkout/sessions/" + row.checkout_session_id);
  check(session.livemode === false && session.mode === "subscription" && session.amount_total === 1900 && session.customer === customer.id, "Real Checkout uses the configured test price and authenticated workspace mapping");
  check((await api("/checkout", { plan: "cloud" })).status === 200, "Checkout retries reuse the existing session");

  // The public tunnel exposes only this disposable service. No production
  // credentials, database, application source or mail provider are present.
  tunnel = Bun.spawn(["/opt/homebrew/bin/cloudflared", "tunnel", "--config", "/dev/null", "--no-autoupdate", "--edge-ip-version", "4", "--protocol", "http2", "--url", "http://127.0.0.1:15435"], { env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: directory, TMPDIR: directory }, stdout: "pipe", stderr: "pipe" });
  void new Response(tunnel.stdout).text();
  tunnelOutput = (async () => { for await (const chunk of tunnel!.stderr as any) { const found = new TextDecoder().decode(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (found) tunnelUrl = found[0]; } })();
  await wait(async () => tunnelUrl, Boolean, "temporary isolated webhook tunnel", 45, 1000);
  const hook = await stripe("webhook_endpoints", { url: tunnelUrl + "/api/billing/webhook", api_version: "2026-09-30.endive", "enabled_events[0]": "checkout.session.completed", "enabled_events[1]": "customer.subscription.updated", "enabled_events[2]": "customer.subscription.deleted", "enabled_events[3]": "invoice.paid", "enabled_events[4]": "invoice.payment_failed", "enabled_events[5]": "customer.subscription.created", "enabled_events[6]": "checkout.session.async_payment_succeeded" });
  endpointId = hook.id; settings.webhookSecret = webhookSecret = hook.secret;
  check(typeof webhookSecret === "string" && webhookSecret.startsWith("whsec_"), "Real test webhook signing secret stays in memory");
  progress("checkout_ui_ready");
  console.log(JSON.stringify({ localCheckout: "http://127.0.0.1:15435/checkout", fakeEmail: email, testModeOnly: true }));
  const paidSession = await wait(() => stripe("checkout/sessions/" + row.checkout_session_id), value => value.status === "complete", "Stripe test Checkout completion", 180, 2000);
  check(paidSession.livemode === false && !!paidSession.subscription, "Test Checkout created a test subscription"); report.checkoutCompleted = true;
  const checkoutEventId = await received("checkout.session.completed", row.checkout_session_id, "real Checkout delivery");
  await wait(() => getBillingSummary(owner, deps), value => value.planId === "cloud" && value.canWrite, "Stripe-delivered webhook activates Engram", 90, 1000);
  report.stripeDeliveryVerified = true;
  const duplicate = await api("/checkout", { plan: "cloud" });
  check(duplicate.status === 409, "Actual Engram handler rejects a duplicate paid subscription");
  const portalSession = await api("/portal", {});
  check(portalSession.status === 200 && new URL((await portalSession.json()).url).hostname === "billing.stripe.com", "Actual Engram handler creates the dedicated test Portal session");
  check((await getBillingSummary(other, deps)).canWrite === false, "One workspace's subscription never pays for another workspace");
  check(otherRow.stripe_customer_id !== customer.id, "Workspace customers have distinct authoritative bindings");
  report.workspaceIsolationVerified = true;

  const event = await stripe("events/" + checkoutEventId);
  const before = (await db`SELECT processed_at FROM billing_webhook_events WHERE id=${event.id}`)[0];
  const duplicateResponse = await replay(event);
  const after = (await db`SELECT processed_at FROM billing_webhook_events WHERE id=${event.id}`)[0];
  check(duplicateResponse.status === 200 && new Date(after.processed_at).getTime() === new Date(before.processed_at).getTime(), "Actual webhook replay is transactionally idempotent");
  report.duplicateReplayVerified = true;

  progress("renewal");
  let subscription = await stripe("subscriptions/" + paidSession.subscription);
  const billingMode = typeof subscription.billing_mode === "string" ? subscription.billing_mode : subscription.billing_mode?.type;
  report.subscriptionBillingMode = ["classic", "flexible"].includes(billingMode) ? billingMode : "unknown";
  if (!clockId && billingMode !== "classic") {
    // Flexible mode is the default for this API version. A reset alone does
    // not invoice, while always_invoice can cancel already-paid prorations to
    // zero. Neither is evidence of a full renewal or a failed renewal charge.
    report.renewalMethod = "not_run_test_clock_required";
    report.missingVerification = ["scheduled_renewal", "failed_renewal", "payment_recovery", "delayed_event_reconciliation", "period_end_cancellation"];
    throw new Error("Full lifecycle requires a dedicated TEST key with Test Clock permissions for this subscription billing mode");
  }
  const firstEnd = subscription.items.data[0].current_period_end ?? subscription.current_period_end;
  if (clockId) {
    await stripe("test_helpers/test_clocks/" + clockId + "/advance", { frozen_time: String(firstEnd + 7200) });
    await wait(() => stripe("test_helpers/test_clocks/" + clockId), value => value.status === "ready", "test renewal clock"); clockNow = firstEnd + 7200;
    report.renewalMethod = "test_clock";
  } else {
    // Anonymous keys may omit TestClock permission. A real billing-cycle reset
    // still creates/pays a new test invoice; do not call it a timed renewal.
    await Bun.sleep(1100);
    // Endive changed this parameter from a scalar to {type: ...}; the form
    // encoding must match the pinned 2026-09-30.endive generated API schema.
    await stripe("subscriptions/" + paidSession.subscription, { "billing_cycle_anchor[type]": "now", proration_behavior: "none" });
    report.renewalMethod = "billing_cycle_restart";
    report.scheduledRenewalVerified = false;
  }
  subscription = await wait(() => stripe("subscriptions/" + paidSession.subscription), value => (value.items.data[0].current_period_end ?? value.current_period_end) > firstEnd, "test renewal period");
  check(subscription.status === "active", "Simulated renewal remains paid in Stripe test mode");
  const renewalInvoice = await wait(() => stripe("invoices/" + (typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice.id)), value => value.status === "paid", "renewal invoice payment");
  check(renewalInvoice.status === "paid" && renewalInvoice.amount_paid === 1900, "The real Stripe sandbox produced a paid1900cent renewal invoice");
  await received("invoice.paid", renewalInvoice.id, "real renewal invoice delivery");
  await wait(() => getBillingSummary(owner, deps), value => !!value.currentPeriodEndsAt && new Date(value.currentPeriodEndsAt).getTime() > firstEnd * 1000 && value.canWrite, "renewal entitlement refresh");
  report.renewalVerified = true;
  report.scheduledRenewalVerified = !!clockId;

  progress("failed_payment");
  // Stripe's documented attach-then-decline fixture creates a real failed test
  // invoice. No card numbers or real payment instruments enter the harness.
  // https://docs.stripe.com/testing?testing-method=payment-methods#declined-payments
  const decliningMethod = await stripe("payment_methods/pm_card_chargeCustomerFail/attach", { customer: customer.id });
  check(decliningMethod.customer === customer.id && /^pm_/.test(decliningMethod.id), "Declining test payment method belongs only to the disposable customer");
  await stripe("subscriptions/" + paidSession.subscription, { default_payment_method: decliningMethod.id });
  deferPastDue = true;
  const failurePeriodEnd = subscription.items.data[0].current_period_end ?? subscription.current_period_end;
  if (clockId) {
    await stripe("test_helpers/test_clocks/" + clockId + "/advance", { frozen_time: String(failurePeriodEnd + 7200) });
    await wait(() => stripe("test_helpers/test_clocks/" + clockId), value => value.status === "ready", "failed renewal clock"); clockNow = failurePeriodEnd + 7200;
  } else {
    await Bun.sleep(1100);
    await stripe("subscriptions/" + paidSession.subscription, { "billing_cycle_anchor[type]": "now", proration_behavior: "none", payment_behavior: "allow_incomplete" });
  }
  subscription = await wait(() => stripe("subscriptions/" + paidSession.subscription), value => ["past_due", "unpaid"].includes(value.status), "failed subscription payment");
  const failedInvoiceId = typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice.id;
  check(failedInvoiceId !== renewalInvoice.id, "Failure is a new subscription invoice");
  const failedInvoice = await wait(() => stripe("invoices/" + failedInvoiceId), value => value.status === "open" && value.attempt_count > 0, "real failed invoice attempt");
  check(failedInvoice.amount_remaining === 1900 && failedInvoice.amount_paid === 0, "Failed test invoice remains genuinely unpaid");
  await received("invoice.payment_failed", failedInvoiceId, "real failed invoice delivery");
  await wait(() => getBillingSummary(owner, deps), value => !value.canWrite && ["past_due", "unpaid"].includes(value.status), "payment failure blocks Engram writes");
  await assert.rejects(() => requireHostedWriteAccess(owner, deps), (error: any) => error.status === 402); checks++;
  await wait(async () => delayedEvent, Boolean, "genuine stale subscription event held before processing");
  report.failedPaymentVerified = true;
  report.failedPaymentMethod = clockId ? "test_clock" : "billing_cycle_restart";
  report.scheduledFailedRenewalVerified = !!clockId;

  progress("payment_recovery");
  const recoveryMethod = await stripe("payment_methods/pm_card_visa/attach", { customer: customer.id });
  check(recoveryMethod.customer === customer.id, "Recovery test payment method belongs to the same disposable customer");
  await stripe("subscriptions/" + paidSession.subscription, { default_payment_method: recoveryMethod.id });
  await stripe("invoices/" + failedInvoiceId + "/pay", { payment_method: recoveryMethod.id });
  const recoveredInvoice = await wait(() => stripe("invoices/" + failedInvoiceId), value => value.status === "paid", "failed invoice recovery payment");
  check(recoveredInvoice.amount_paid === 1900 && recoveredInvoice.amount_remaining === 0, "Recovery pays the original failed test invoice");
  await received("invoice.paid", failedInvoiceId, "real recovery invoice delivery");
  subscription = await wait(() => stripe("subscriptions/" + paidSession.subscription), value => value.status === "active", "recovered subscription");
  await wait(() => getBillingSummary(owner, deps), value => value.canWrite && value.status === "active", "recovery restores Engram writes");
  await requireHostedWriteAccess(owner, deps); checks++;
  report.paymentRecoveryVerified = true;

  progress("delayed_event_reconciliation");
  check(!(await db`SELECT id FROM billing_webhook_events WHERE id=${delayedEvent.id}`)[0], "Held provider event has never been processed");
  check((await replay(delayedEvent)).status === 200, "Locally signed replay processes the genuine stale past-due event");
  check(!!(await db`SELECT id FROM billing_webhook_events WHERE id=${delayedEvent.id}`)[0], "Stale event commits a new receipt instead of taking the duplicate path");
  const reconciled = await getBillingSummary(owner, deps);
  check(reconciled.status === "active" && reconciled.canWrite, "Authoritative current subscription wins over delayed past-due event data");
  deferPastDue = false;
  report.delayedEventReconciliationVerified = true;

  progress("cancellation");
  await stripe("subscriptions/" + paidSession.subscription, { cancel_at_period_end: "true" });
  await received("customer.subscription.updated", paidSession.subscription, "real scheduled cancellation delivery", value => value.cancelAtPeriodEnd);
  await wait(() => getBillingSummary(owner, deps), value => value.cancelAtPeriodEnd && value.canWrite, "cancel-at-period-end webhook");
  check((await getBillingSummary(owner, deps)).cancelAtPeriodEnd, "Cancellation preserves access through the paid period");
  const secondEnd = subscription.items.data[0].current_period_end ?? subscription.current_period_end;
  if (clockId) {
    await stripe("test_helpers/test_clocks/" + clockId + "/advance", { frozen_time: String(secondEnd + 120) });
    await wait(() => stripe("test_helpers/test_clocks/" + clockId), value => value.status === "ready", "cancellation clock"); clockNow = secondEnd + 120;
  } else {
    await stripe("subscriptions/" + paidSession.subscription, undefined, "DELETE");
  }
  await received("customer.subscription.deleted", paidSession.subscription, "real ended subscription delivery");
  await wait(() => getBillingSummary(owner, deps), value => !value.canWrite && value.status === "canceled", "ended subscription closes writes");
  await assert.rejects(() => requireHostedWriteAccess(owner, deps), (error: any) => error.status === 402); checks++;
  check((await api("/portal", {})).status === 200, "Billing recovery portal remains available after cancellation");
  check((await getBillingSummary(other, deps)).canWrite === false, "Lifecycle changes never grant the other workspace paid access");
  const otherFinal = (await db`SELECT * FROM workspace_billing WHERE org_id=${secondOrgId}`)[0];
  check(otherFinal.stripe_customer_id === otherRow.stripe_customer_id && otherFinal.stripe_subscription_id === null, "Other workspace customer binding and subscription remain unchanged");
  report.cancellationVerified = true;
  report.endedPeriodVerified = !!clockId;
  report.cancellationMethod = clockId ? "test_clock_period_end" : "scheduled_state_then_immediate_delete";
  report.providerDeliveredEventTypes = [...new Set([...delivered.values()].map(value => value.type))].sort();
  progress("complete");
  completed = true;
} catch (error) {
  if (error instanceof SandboxProviderError) report.providerFailure = error.diagnostic;
  failureMessage = error instanceof Error && !/(?:sk|rk|rkcs|whsec)_/.test(error.message) ? error.message.slice(0, 180) : "Sandbox test failed without exposing credentials";
} finally {
  const cleanupFailures: { resource: string; id?: string; diagnostic?: SandboxProviderError["diagnostic"] }[] = [];
  const retainedSandboxArtifacts: Record<string, unknown>[] = [];
  const cleanup = async (label: string, work: () => Promise<unknown>, id?: string) => {
    try { await work(); return true; } catch (error) { cleanupFailures.push({ resource: label, ...(id ? { id } : {}), ...(error instanceof SandboxProviderError ? { diagnostic: error.diagnostic } : {}) }); return false; }
  };
  if (endpointId) await cleanup("test_webhook_endpoint", () => stripe("webhook_endpoints/" + endpointId, undefined, "DELETE"), endpointId);
  if (clockId) {
    const deleted = await cleanup("test_clock_and_customer", () => stripe("test_helpers/test_clocks/" + clockId, undefined, "DELETE"), clockId);
    // Stripe deletes the clock's attached customer/subscriptions with the clock.
    if (deleted) customerIds.delete(clockCustomerId);
  }
  for (const customer of customerIds) await cleanup("test_customer", () => stripe("customers/" + customer, undefined, "DELETE"), customer);
  if (priceId) await cleanup("test_price_archival", () => stripe("prices/" + priceId, { active: "false" }), priceId);
  if (productId) await cleanup("test_product_archival", () => stripe("products/" + productId, { active: "false" }), productId);
  if (portalId) await cleanup("test_portal_deactivation", async () => {
    try { await stripe("billing_portal/configurations/" + portalId, { active: "false" }); }
    catch (error) {
      if (!(error instanceof SandboxProviderError) || error.status !== 400) throw error;
      const current = await stripe("billing_portal/configurations/" + portalId);
      if (current.id !== portalId || current.livemode !== false || current.is_default !== true || current.active !== true) throw error;
      // Preserve a verified default in the isolated TEST account when Stripe
      // rejects deactivation. Do not create/replace unrelated defaults, claim
      // later deletion, or hide the retained provider-managed configuration.
      retainedSandboxArtifacts.push({ resource: "default_test_portal_configuration", id: portalId, active: true, reason: "provider_rejected_deactivation_of_verified_test_default", diagnostic: error.diagnostic, expiryVerified: false, limitation: "No expiry or later deletion has been verified" });
    }
  }, portalId);
  if (tunnel) await cleanup("temporary_tunnel", async () => {
    tunnel!.kill("SIGTERM");
    const timer = setTimeout(() => tunnel!.kill("SIGKILL"), 3000);
    try { await tunnel!.exited; await tunnelOutput; } finally { clearTimeout(timer); }
  });
  if (server) await cleanup("local_http_server", async () => { await server!.stop(true); });
  await cleanup("database_pools", async () => { await db?.end({ timeout: 2 }); await closeDatabasePools(); });
  const pgStopped = !pgStarted || await cleanup("disposable_postgresql", () => child(join(pgBin, "pg_ctl"), ["-D", join(directory, "pg"), "-m", "immediate", "stop"]));
  if (pgStopped) await cleanup("temporary_directory", () => rm(directory, { recursive: true, force: true }));
  const ok = completed && cleanupFailures.length === 0;
  const result = { ok, phase, checks, ...(failureMessage ? { error: failureMessage } : {}), ...report, realDatabase: pgStarted, APIKeysPersisted: false, cleanupRequired: cleanupFailures.length > 0, cleanupFailures, retainedSandboxArtifacts, ...(pgStopped ? {} : { retainedPrivateDirectory: directory }) };
  (ok ? console.log : console.error)(JSON.stringify(result));
  process.exitCode = ok ? 0 : 1;
}
