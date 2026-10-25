# Hosted plans and billing

Self-hosted Engram is MIT licensed and has no Engram subscription. The initial hosted plan is Cloud at **$19 USD per workspace per month**, with a 14-day cardless trial anchored to workspace creation. This is launch pricing, not willingness-to-pay validation. Hosting costs, support needs, and real workloads should inform later changes.

The public catalog lives in `gateway/src/plans.ts`. Prices and Stripe Price IDs are selected by the server. Checkout verifies the configured Stripe Price is active, $19 USD, and monthly before creating a payment session. A client cannot choose an arbitrary amount, Stripe customer, or workspace. Each workspace is billed independently, including personal workspaces when used on the hosted service.

Hosted Engram is operated by **Outcome Driven Holdings LLC**. Billing/account
support and privacy requests go to [ani@odstdio.com](mailto:ani@odstdio.com), with
an acknowledgement target of two business days. Subscription cancellation is
separate from data erasure: it does not delete memory, activity, account records,
or backups. Owners retain read/export access after hosted writes end. Account or
workspace erasure is a verified manual operator request, described in
[Privacy](PRIVACY.md) and the [retention procedure](DATA_RETENTION.md).

## Configure a hosted service

Set these secrets and environment values through the deployment's secret manager. Do not commit them:

```text
ENGRAM_DEPLOYMENT_MODE=hosted
ENGRAM_PUBLIC_URL=https://your-canonical-host
STRIPE_SECRET_KEY=<Stripe test or live key>
STRIPE_WEBHOOK_SECRET=<matching webhook signing secret>
STRIPE_CLOUD_MONTHLY_PRICE_ID=<19 USD monthly recurring price>
STRIPE_PORTAL_CONFIGURATION_ID=<Engram-specific billing portal configuration>
RESEND_API_KEY=<configured mail key for verified sign-in>
ENGRAM_DEV_LOGIN_LINKS=0
ENGRAM_INSECURE_COOKIE=0
```

Create a Stripe recurring product/price for Cloud. Enable Customer Portal payment-method management, invoices, and cancellation in Stripe. Register **POST `/api/billing/webhook`** using snapshot events and the pinned API version `2026-09-30.endive`, with:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- `invoice.created`, `invoice.paid`, `invoice.payment_failed`

Payment is confirmed through the verified webhook or authoritative subscription refresh, never through the checkout return URL. Hosted mode fails closed when Checkout is unconfigured. The default deployment mode remains self-hosted, so enabling a paid service is an explicit operator action; existing production is not silently switched into billing by this change.

`deploy/configure-stripe.py` inspects the explicitly selected Secret Manager key's account and test/live mode without printing its value. `--apply` provisions/reuses the Engram product, $19 recurring price, dedicated Customer Portal configuration, and canonical webhook, then stores four Engram-specific secrets and grants the runtime identity access. It never creates a charge. Live setup additionally requires `--allow-live`; use that only with explicit merchant authorization. Stripe API idempotency keys and a price lookup key make retries safe. An unavailable one-time webhook signing secret requires an explicit safe rotation rather than adopting another application's secret.

For new Cloud Run installations and releases, follow [the staged release procedure](RELEASE.md). After explicit operator approval, `deploy/configure-database.py` prepares the three dedicated database secrets and scoped secret-access grants. The separately approved IAM setup must provide distinct runtime, provisioner and SQL connector identities. The web runtime never receives the administrative database URL. Stripe provisioning is a separate approved setup step; reuse and verify existing Engram resources when they are already configured.

Use `deploy/release.py plan`, then `stage` with a fresh verified backup. Staging runs the separate provisioner job and creates a tagged candidate with zero production traffic. Run its public and authenticated private `smoke`, then `activate`. The release binds all four dedicated Stripe secrets, the canonical origin, runtime isolation and the restricted database identity together. Cloud Build defaults to producing a plan; it does not automatically activate traffic. Hosted activation can stop writes for existing workspaces whose original 14-day trial has expired.

`deploy/configure-hosted.sh` is a legacy billing-only helper. It does not establish the required split database authority, provisioning job, scoped IAM, sandbox launcher, backup or candidate verification. Do not use it to bootstrap the current hosted architecture or replace the staged release procedure.

On22October2026 the operator authorized and provisioned Engram-only **live-mode** product, price, portal and webhook configuration for `https://engram.ani.computer/api/billing/webhook`, using the four `engram-stripe-*` Secret Manager resources. No charges were created. This setup is not a test-mode payment roundtrip or proof of a completed customer subscription; runtime activation and payment verification are separate release checks.

References: [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create), [webhook signatures and delivery](https://docs.stripe.com/webhooks), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), and [API versioning](https://docs.stripe.com/api/versioning).

## API and boundaries

- `GET /api/plans`: public catalog and deployment mode; no secrets or customer IDs.
- `GET /api/billing`: current authenticated owner's workspace plan and access dates.
- `POST /api/billing/checkout {"plan":"cloud"}`: a Stripe-hosted Checkout URL.
- `POST /api/billing/portal {}`: a Customer Portal URL for that owner's workspace.
- `POST /api/billing/webhook`: signed Stripe events; the sole public billing mutation.

The browser uses its HttpOnly session and console CSRF header. Owner API credentials may use bearer authentication. Delegated OAuth clients cannot manage billing. Each payment customer is bound to an authenticated workspace in the server database; webhook metadata cannot invent or change that binding. Duplicate events commit idempotently, and out-of-order events refresh current Stripe subscription state instead of rolling back a newer subscription.

After a trial or paid access period ends, content writes stop through HTTP, MCP, sharing, and the background cycle. Reads, memory/activity exports, privacy settings, deletion, credential revocation, and unpublishing stay available. Cancellation does not delete workspace data or backups. A missed webhook cannot grant indefinite access past a paid period; the server rechecks Stripe before extending it.

Billing sends an opaque workspace reference to Stripe, not agent identities, memory, action content, or transcripts. Stripe collects payment and billing information on its hosted page. Keep the operator's retention and privacy disclosures aligned with the actual deployment.

## Optional Jev usage

Jev is a separate opt-in add-on to the Cloud workspace subscription. It is not
enabled by the older embeddings/briefs consent, and a server key alone grants no
permission. `GET /api/jev` exposes the selected workspace's eligibility, saved
budget, accepted pricing and aggregate usage; `PUT /api/jev` requires a current
owner's human email session, the console CSRF header and an exact workspace pin.
The request supplies `enabled`, `monthlyBudgetUsd` as a decimal string and, for
paid Cloud use, `acceptedRateVersion`. It never accepts a provider API key.

Self-hosters use their own `JEV_API_KEY`; blank/`unset` values fall back to
`REFLEX_API_KEY`, then `TYPESAFE_API_KEY`. They explicitly enable Jev for the
workspace and pay their provider directly. Engram does not export self-hosted
Jev usage to Stripe. [Reflex](REFLEX.md) describes model/transport configuration
and the separate Voyage/OpenAI controls.

Hosted customer use requires all of the following: a configured key and reviewed
model selection, a ready workspace with Jev enabled, an active paid Cloud
subscription, a positive monthly soft budget and acceptance of the current
approved rate. A trial or ordinary complimentary workspace does not authorize
customer-billed Jev. New paid usage remains disabled unless the operator
explicitly sets `ENGRAM_JEV_BILLING_ENABLED=1` and an approved
`ENGRAM_JEV_MARKUP_BPS`; `0` basis points means provider price. No markup is
implicitly selected. The default model is TypeSafe’s stable `jev-latest` alias, which can change
underlying versions; it does not lock model weights. Exact selectable versions
remain supported when the provider exposes them. Requested and reported model
names are recorded truthfully alongside usage. The immutable rate version and
markup are captured with
each admitted call; a rate change requires renewed workspace acceptance before
new paid calls can proceed.

The implemented provider rate is $0.042 USD per million input tokens and zero
for output tokens, consistent with [TypeSafe's published pricing](https://typesafe.ai/).
Rates can change; verify the provider contract and deliberately update the
versioned rate before changing this snapshot. The workspace sees the approved
customer rate including markup before enabling it. This code/configuration is
not evidence that a live Jev charge has occurred.

**Selected beta pricing — 25 October 2026:** pass provider cost through at
$0.042 USD per million input tokens, with output tokens free and no markup
(`ENGRAM_JEV_MARKUP_BPS=0`). The operator delegated this pricing decision; the
rate was checked against TypeSafe's public pricing and
[API usage documentation](https://docs.typesafe.ai/api/system-one).
The existing Cloud workspace subscription covers the product and hosting;
the optional Jev line passes through its measured provider usage during beta.
This is a launch choice, not a finding from willingness-to-pay research.
Cloud Build records zero markup while retaining billing disabled by default.
Release review, explicit activation and each paid workspace's rate acceptance
remain required. Operator-funded and self-hosted behavior stays as described
below.

### Prepare and review the Jev release

Store the key using `bash deploy/set-jev-key.sh`; its hidden terminal prompt
writes only `engram-jev-api-key` through stdin. Do not paste a key into chat,
source, command arguments or a browser setting. `deploy/configure-jev.py plan
--project YOUR_PROJECT` is offline; `check` reads the stored key and the official
model list without inference, while `prepare` also grants the existing runtime
identity access to that one secret. These commands do not enable a workspace.

If hidden terminal paste is unavailable on macOS, run
`bash deploy/set-jev-key.sh --clipboard`. After it starts, copy only the Jev key
from the provider console and press Return in Terminal without pasting. The
helper reads the clipboard locally and sends the value through stdin to the
same secret; it never prints the value or puts it in command arguments.

An approved release may pass `--jev-owner-email owner@example.test` to select
one existing personal workspace's sole owner. The provisioner applies the
one-time default with `--jev-operator-budget-usd 1`; no private owner address is
committed. The request runtime and tenant engines never receive this selector.

Prepare the private exporter with `python3 deploy/jev-billing.py prepare
--project YOUR_PROJECT --image gcr.io/YOUR_PROJECT/engram:REVIEWED_BUILD`.
It creates a disabled `engram-billing` job and a paused quarter-hour schedule;
preparation performs no exports. Its only secret bindings are the restricted
runtime database template, tenant credential key and dedicated Stripe key.
It receives no Jev key, webhook signing key or administrator database URL.

After a customer rate is approved, stage with
`--jev-enable-customer-billing --jev-markup-bps 0` and use
the same values for smoke and activation. Activation verifies the prepared
exporter and enables it only after traffic changes. Without that flag, the
exporter remains paused. Rollback pauses it; frozen pending batches remain
available for operator reconciliation. The standalone exporter `enable`
command additionally requires `--allow-customer-billing`.

The existing dedicated Stripe endpoint needs `invoice.created` added before
customer billing activation. The explicitly approved `configure-stripe.py
--apply` path upgrades only the known previous event list on that same endpoint,
preserving its ID and signing secret; live configuration also requires
`--allow-live`. Unknown endpoint settings fail for manual review. Verify the
result using `verify-billing.py`; no live Jev invoice roundtrip is established
by the offline or PostgreSQL tests.

An expressly authorized personal operator workspace has a separate,
provisioner-owned funding record. Its one-time default is Jev enabled with a
$1 USD monthly soft budget, measured against known provider cost; its customer
charge is zero. The helper requires one exact existing personal owner selected
by the operator, does not create/promote an owner, and does not embed a personal
email in source. Repeating provisioning does not reactivate a later opt-out or
revoked funding record. This exception does not enable other accounts or AI
providers. The runtime can read, but cannot grant or rewrite, operator funding.

Soft budgets reset on UTC calendar-month boundaries, independently of the
subscription's billing cycle. Admission checks settled known spending before
new calls. Already admitted/in-flight calls can exceed the threshold, so this
is not a hard spending guarantee. The durable daily attempt allowance still
applies. Missing consent, funding, approved price or available budget leaves the
local memory/search path available.

### Usage receipts and invoice export

Every hosted Jev attempt reserves a durable receipt before transmission. The
provider's actual input/output token counts and returned model are validated and
settled before interpreting its answers. A valid call can therefore be billable
even when its answers are unusable. The ledger uses integer nano-USD amounts,
stores the accepted rate/model/funding identity, and contains no prompts or
memory/action text. Hosted calls have one transmission attempt. Stable background
operation IDs deny retransmission after a crash; reading a cached result does
not create another provider call or usage charge.

Timed-out, aborted, failed or malformed responses remain unresolved/unbilled;
a model mismatch is recorded as rejected with no customer charge. Unknown and
pending receipts need operator review, not a blind replay. Operator-funded usage
is accounted separately and never added to a customer invoice.

A signed `invoice.created` event prepares a batch only for an exact stored
workspace/customer/subscription binding and a USD draft subscription invoice.
It takes settled, previously unbatched customer usage requested before that
invoice's creation time. The total plus the same workspace/subscription's
existing sub-cent remainder is floored to whole cents; the remaining fraction
carries forward for that subscription. Calls are not rounded up to a cent each.
The batch freezes the selected usage, invoice identity and amount before export.

Only an aggregate `Jev usage` invoice item, amount and opaque batch/workspace
references go to Stripe. Export reconciles matching invoice items before every
possible POST and uses a stable Stripe idempotency key. It writes only to the
original draft invoice. A response lost after provider acceptance can be recovered
from the exact item; duplicate/mismatched items, an already-finalized invoice
without the item or an unresolved attempt beyond the 23-hour local retry horizon
require manual reconciliation. The exporter does not silently move the charge to
another invoice, finalize an invoice, or initiate a separate off-session payment.

The webhook acknowledges after durable batch preparation even when export needs
reconciliation, so an add-on export retry does not deliberately hold up the base
invoice's automatic finalization. The dedicated billing worker drains up to 25
eligible durable batches, reports aggregate outcomes and supports read-only
`--dry-run` inspection. Its separate `ENGRAM_JEV_BILLING_WORKER_ENABLED=1`
approval permits existing accepted usage to export even after new-call billing
is turned off. Preparation keeps that worker disabled and its private schedule
paused until the approved release step. A finalized or ambiguous invoice remains
an operator review item; never delete its batch or recreate it under a new key
to force collection.

The additive `jev_version` readiness marker requires provisioner migration before
the restricted runtime starts. Usage, accepted rates, carry balances and invoice
receipts must survive traffic rollback for reconciliation. Keep the current
provisioner/ACL protections; do not downgrade them with an older image. Neither
local tests nor this documentation establish live invoice collection; verify the
approved deployment, webhook delivery and aggregate worker state separately.

## Operator-managed complimentary access

New signup invitations carry 60 days of unlimited core knowledge transfers from
verified redemption. The original timestamps are preserved through delayed
provisioning and retries. Workspace access summaries expose the exact expiry,
server time and invitation provenance for the countdown and X extension link.
They expose no raw invite credential. Expired invitation access does not reset
trials or keep blocking an otherwise valid subscription checkout. See
[beta invitations](BETA_INVITES.md) for single-use link and optional mailbox
binding behavior. Earlier grants retain their original terms.

A hosted workspace can have a separate complimentary entitlement. Its nullable
`expires_at` is genuinely non-expiring when null; it does not extend, reset or
falsify the original 14-day trial, create a Stripe customer, or represent a paid
subscription. Revocation or finite expiry removes that entitlement immediately
on the next access check. A still-valid independent trial or paid subscription
continues to grant its own access. Workspace permissions, membership, OAuth
scopes and provider consent still apply.

`GET /api/billing` adds `entitlementSource` (`complimentary`, `subscription`,
`trial`, `none`, or `self-hosted`) and `complimentary`, which is null or contains
`active`, `grantedAt`, nullable `expiresAt` and nullable `revokedAt`. Active
complimentary access is labeled `planId/status: complimentary`, with
`checkoutAvailable: false`; Checkout also rejects it before contacting Stripe.
Original trial/paid-period dates and `subscriptionStatus` remain truthful. An
existing billing portal stays available so a complimentary grant cannot hide or
silently cancel an existing chargeable subscription. Browser summaries never
expose the operator grant UUID, audit reason or owner identity.

The schema stores entitlement state in `workspace_complimentary_access` and
append-only operator receipts in `complimentary_access_events`. Grant/revoke and
its receipt commit in one transaction, with a database-role attribution and
reason. The request runtime has **SELECT only** on both tables; it cannot grant,
revoke, erase or forge receipts. There is no public/admin HTTP grant endpoint.
The additive `billing_version` readiness marker requires the separate provisioner
to migrate before the new runtime starts, while preserving the previous base
and activity schema markers.

The launch operator helper is deliberately pinned to project `ani-hq`, workspace
1 named `Ani HQ` and its deterministic storage bindings. It requires the exact
normalized current owner's email as an explicit argument; no personal email is
embedded in source. It never creates/promotes an owner or defaults a target.
By default it prints an offline plan with no credential lookup. The operator
adds `--run` only for the intended operation:

```sh
bun deploy/complimentary-access.ts grant --project ani-hq --org 1 \
  --workspace-name 'Ani HQ' --owner-email owner@example.test \
  --request-id owner-authorized-launch-access-v1 \
  --reason 'Owner-authorized non-expiring launch access'
```

Replace the example identity with the authorized existing owner at execution.
Omitting `--expires-at` means no expiry; a finite grant requires an explicit
future canonical ISO timestamp. Exact retries use the same request ID and
payload and return the original receipt; changing a reused request fails. An
already active grant cannot be silently replaced or extended. Grant verification,
exact owner/workspace locking and the audit write share the transaction.

Use `inspect` with the same project/org/workspace/owner arguments and `--run` for
a read-only status check. To revoke, use `revoke` with those same binding
arguments, a new `--request-id`, a reason and `--grant-id` from the operator
result. Revocation matches both workspace and exact grant UUID, so an old revoke
cannot remove a newer grant. No provider/payment request is part of any helper
operation. The feature's presence does not mean a production grant has been
applied; verify the operator result and authenticated billing summary separately.

**Rollback:** `deploy/release.py rollback` restores service traffic only. It
leaves the current dream/provisioner jobs and database ACLs intact and performs
no database restore. An older request runtime ignores the additive marker and
retains its existing behavior; it does not recognize complimentary access.
Do not downgrade or manually rerun the older provisioner after this migration:
its blanket runtime DML grants predate these operator-only tables and would
weaken their SELECT-only protection. Keep the updated provisioner/ACLs even
when rolling service traffic back.

## Before accepting live payments

`deploy/verify-billing.py` performs read-only checks using the four dedicated Engram Secret Manager resources. It requires an explicit merchant account and test/live mode; it checks the active $19 monthly price, Engram product, Portal recovery/cancellation features, canonical return URL, and exactly one matching enabled webhook with the pinned API version and event list. Secret values remain in memory. Output contains only check outcomes, mode and API version; it never prints credential values or provider response bodies.

```sh
python3 deploy/verify-billing.py --project YOUR_PROJECT \
  --public-url https://your-canonical-host \
  --expected-account acct_YOUR_MERCHANT --expected-mode live
```

After the canonical URL serves the reviewed hosted revision, add `--probe-webhook` to test its loaded signing secret and raw-body validation. The helper sends one valid, intentionally unsupported synthetic event, then requests with a missing signature and changed signed bytes. The valid event returns before billing storage access; the other requests must be rejected. This creates no customer, Checkout/Portal session, subscription or payment. Requests use normal TLS verification, refuse redirects and have bounded timeouts. The helper does not change IAM or create secrets.

This probe establishes application signature handling, not delivery from Stripe or payment completion. The default command sends only Stripe GET requests; the optional probe sends POST requests only to the already configured canonical webhook. It does not verify which secret versions a Cloud Run revision has loaded; verify its secret bindings and complete the candidate smoke as part of the release. Offline helper tests run with `python3 test/billing-verification.py`.

Run the suite and the real PostgreSQL integration script, then exercise Stripe **test mode** end to end: new subscription, duplicate and delayed webhooks, failed renewal, cancellation at period end, ended subscription, recovery, and a second workspace. Verify the configured price, currency, taxation, invoice details, portal configuration, and the matching live webhook secret before switching to live keys. This repository implementation does not establish tax registrations or legal terms on behalf of the operator.

The default automated suite performs no provider mutations. An explicitly opted-in manual harness, `ENGRAM_RUN_STRIPE_SANDBOX=1 bun test/integration-stripe-sandbox.ts`, exercises the real billing handlers against a fresh disposable PostgreSQL cluster and a new anonymous Stripe test sandbox. It uses the [official anonymous sandbox protocol](https://docs.stripe.com/cli/sandbox) directly because the CLI saves returned credentials to its profile; the harness keeps keys only in memory. It requires native PostgreSQL 18 and `cloudflared`, exposes only a disposable webhook receiver, uses a fake `example.com` identity, and never reads the operator's Stripe CLI profile or sends email. Follow its local Checkout link in a separate browser tab and use only Stripe test payment details. No production database or live merchant configuration is used.

For this deployment's operator-provided sandbox key, additionally set `ENGRAM_STRIPE_SANDBOX_KEY_SOURCE=secret-manager`. The harness reads only `engram-stripe-test-secret-key` from project `ani-hq`, captures its value in memory with cloud CLI file logging disabled, and refuses live keys before making any Stripe request. This path does not provision an anonymous sandbox. Each run uses fresh disposable workspace IDs so its idempotency keys cannot collide with another test run. It never changes the four live billing secrets or deployment bindings.

```sh
ENGRAM_RUN_STRIPE_SANDBOX=1 \
ENGRAM_STRIPE_SANDBOX_KEY_SOURCE=secret-manager \
bun test/integration-stripe-sandbox.ts
```

On 24 October 2026, this dedicated-key invocation **passed 332 checks** against a fresh disposable PostgreSQL database and a real Stripe test-mode subscription with flexible billing and a Test Clock. Stripe delivered signed events through the public test receiver for all six exercised event types: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. The run verified Checkout activation, a scheduled paid renewal, a failed scheduled renewal that blocked writes, recovery by paying the original failed invoice, cancellation with access through the paid period, ended-period write denial, and isolation of the second workspace.

Duplicate and delayed-event reconciliation also passed using **locally signed replays of real provider events**. These checks do not establish Stripe-initiated redelivery (`providerRedeliveryVerified: false`). Asynchronous payment methods were not exercised (`asynchronousPaymentMethodVerified: false`); the completed lifecycle covers card payments.

The final result reported `APIKeysPersisted: false`, `productionTouched: false`, and `realMoneyMoved: false`. Cleanup completed with `cleanupRequired: false`, `cleanupFailures: []`, and `retainedSandboxArtifacts: []`. No sandbox artifacts were reported as retained, including a default Portal configuration.

The harness reports which lifecycle stages actually passed. Anonymous sandbox permissions can omit Test Clocks: flexible billing then stops after the verified Checkout stages and reports the missing lifecycle coverage. The classic-billing fallback restarts a test billing cycle and separately tests scheduled-cancellation state and immediate cancellation; it does not claim a naturally timed renewal or paid-period expiry. Provider rate limits stop the run; do not evade them by rotating identities or networks. Live merchant configuration, staging verification, and this completed test-mode payment roundtrip remain distinct release evidence.

## Pricing context

The single workspace plan keeps the first purchase understandable and avoids charging per agent before actual usage is known. Self-hosting keeps the same core features. For context, [Mem0's published plans](https://mem0.ai/pricing) separate open-source use from managed request-based plans, while [Zep](https://www.getzep.com/pricing/) uses managed credits and larger enterprise plans. Engram's launch price is a product assumption and should be tested with customers; these products are not feature-equivalent.
