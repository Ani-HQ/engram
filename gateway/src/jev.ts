import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { config } from "./config";
import { currentOrg } from "./context";
import { sql } from "./db";
import type { TokenRecord } from "./policies";
import { configuredJevModel, isJevModel, jevModelMatches } from "./jev-model";

const NANOS = 1_000_000_000n;
const INPUT_NANOS = 42n;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
type Deps = { db?: postgres.Sql; env?: NodeJS.ProcessEnv; now?: Date };
const dependencies = (deps: Deps) => ({ db: deps.db ?? sql, env: deps.env ?? process.env, now: deps.now ?? new Date() });

export class JevError extends Error {
  constructor(message: string, public status = 400, public code = "jev_error") { super(message); }
}
export function usd(nanos: bigint): string {
  const negative = nanos < 0n; if (negative) nanos = -nanos;
  return `${negative ? '-' : ''}${nanos / NANOS}.${String(nanos % NANOS).padStart(9, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}
export function parseJevBudget(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(value)) throw new JevError("Enter a USD budget with at most two decimal places.");
  const [whole, fraction = ''] = value.split('.');
  const result = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * 10_000_000n;
  if (result > 10_000n * NANOS) throw new JevError("The monthly budget must not exceed $10,000.");
  return result;
}
function month(now: Date) {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}
export function jevPricing(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.ENGRAM_JEV_MARKUP_BPS ?? '';
  const markup = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  const approved = env.ENGRAM_JEV_BILLING_ENABLED === '1' && Number.isInteger(markup) && markup >= 0 && markup <= 10000;
  return { currency: 'usd' as const, providerInputPerMillionUsd: '0.042', inputPerMillionUsd: approved ? usd(INPUT_NANOS * 1_000_000n * BigInt(10000 + markup) / 10000n) : null,
    outputPerMillionUsd: approved ? '0.00' : null, markupBps: approved ? markup : null, rateVersion: approved ? `jev-input42-output0-markup${markup}-v1` : null };
}
function providerConfigured(env: NodeJS.ProcessEnv) {
  const key = [env.JEV_API_KEY,env.REFLEX_API_KEY,env.TYPESAFE_API_KEY].map(value => (value ?? '').trim()).find(value => value && value !== 'unset') ?? '';
  return !!key && key !== 'unset' && isJevModel(configuredJevModel(env));
}
async function funding(db: postgres.Sql, orgId: number, now: Date) {
  const [operator] = await db`SELECT a.org_id FROM jev_operator_access a JOIN org_members m ON m.id = a.owner_member_id AND m.org_id = a.org_id AND m.role = 'owner'
    JOIN orgs o ON o.id = a.org_id WHERE a.org_id = ${orgId} AND a.revoked_at IS NULL
      AND (o.kind = 'personal' OR a.explicit_workspace_approved)
      AND (SELECT count(*) FROM org_members owners WHERE owners.org_id = o.id AND owners.role = 'owner') = 1`;
  if (operator) return { kind: 'operator-funded' as const, customer: null, subscription: null };
  const [row] = await db`SELECT b.stripe_customer_id,b.stripe_subscription_id FROM workspace_billing b
    WHERE b.org_id = ${orgId} AND b.plan_id = 'cloud' AND b.status = 'active' AND b.current_period_ends_at > ${now}
      AND b.stripe_customer_id IS NOT NULL AND b.stripe_subscription_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_complimentary_access c WHERE c.org_id = b.org_id AND c.revoked_at IS NULL AND c.granted_at <= ${now} AND (c.expires_at IS NULL OR c.expires_at > ${now}))`;
  return row ? { kind: 'subscription' as const, customer: String(row.stripe_customer_id), subscription: String(row.stripe_subscription_id) } : null;
}
async function totals(db: postgres.Sql, orgId: number, now: Date) {
  const period = month(now);
  const [row] = await db`SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'reserved')::int AS pending,
      count(*) FILTER (WHERE status IN ('unknown','rejected'))::int AS unknown,
      coalesce(sum(input_tokens),0)::text AS input, coalesce(sum(output_tokens),0)::text AS output,
      coalesce(sum(CASE WHEN status = 'settled' THEN CASE WHEN funding = 'operator-funded' THEN provider_nanos ELSE customer_nanos END ELSE 0 END),0)::text AS spent
    FROM jev_usage_calls WHERE org_id = ${orgId} AND requested_at >= ${period.start} AND requested_at < ${period.end}`;
  return { period, row, spent: BigInt(row.spent) };
}
export async function getJevSummary(actor: TokenRecord, input: Deps = {}) {
  const { db, env, now } = dependencies(input);
  const [org] = await db`SELECT policies FROM orgs WHERE id = ${actor.orgId}`;
  const [settings] = await db`SELECT * FROM workspace_jev_settings WHERE org_id = ${actor.orgId}`;
  const [member] = await db`SELECT id,role FROM org_members WHERE org_id = ${actor.orgId} AND email = ${actor.email ?? ''}`;
  if (!org || !member || actor.kind !== 'session' || !actor.email || !['owner','member'].includes(actor.role) || (currentOrg() && currentOrg()!.id !== actor.orgId)) throw new JevError("Sign in with your workspace email to view Jev settings.", 403, 'forbidden');
  const selfHosted = config.deploymentMode === 'self-hosted', source = await funding(db, actor.orgId, now), pricing = jevPricing(env);
  const eligibility = selfHosted ? 'self-hosted' : source?.kind ?? 'subscription-required';
  const configured = providerConfigured(env) && (selfHosted || source?.kind === 'operator-funded' || pricing.rateVersion !== null);
  const enabled = settings?.enabled === true && org.policies?.jevProcessing === true;
  const total = await totals(db, actor.orgId, now), budget = BigInt(settings?.monthly_budget_nanos ?? 0), remaining = budget > total.spent ? budget - total.spent : 0n;
  const consented = selfHosted || source?.kind === 'operator-funded' || settings?.accepted_rate_version === pricing.rateVersion;
  const unavailableReason = !enabled ? 'disabled' : !configured ? 'not-configured' : eligibility === 'subscription-required' ? 'subscription-required' : !consented ? 'consent-required' : !selfHosted && (budget === 0n || total.spent >= budget) ? 'budget-reached' : null;
  return { enabled, available: unavailableReason === null, canManage: member.role === 'owner' && actor.role === 'owner', configured, eligibility, unavailableReason,
    pricing: { ...pricing, ...(selfHosted || source?.kind === 'operator-funded' ? { inputPerMillionUsd: null, outputPerMillionUsd: null, markupBps: null, rateVersion: null } : {}) },
    budget: { monthlyUsd: usd(budget), spentUsd: usd(total.spent), remainingUsd: usd(remaining), periodStartsAt: total.period.start.toISOString(), periodEndsAt: total.period.end.toISOString(), softLimit: true },
    usage: { calls: Number(total.row.calls), inputTokens: String(total.row.input), outputTokens: String(total.row.output), pendingCalls: Number(total.row.pending), unknownCalls: Number(total.row.unknown) } };
}

export async function handleJevApi(req: Request, actor: TokenRecord, input: Deps = {}): Promise<Response> {
  const { db, env, now } = dependencies(input);
  try {
    if (actor.kind !== 'session' || !actor.email || !['owner','member'].includes(actor.role) || (currentOrg() && currentOrg()!.id !== actor.orgId)) throw new JevError('Sign in with your workspace email to manage Jev.',403,'forbidden');
    const pin = req.headers.get('x-engram-workspace');
    if (!pin) throw new JevError('Select a workspace and try again.',400,'workspace_required');
    if (pin !== String(actor.orgId)) throw new JevError('The selected workspace changed. Try again.',409,'workspace_changed');
    if (req.method === 'GET') return Response.json(await getJevSummary(actor, input), { headers: HEADERS });
    if (req.method !== 'PUT') return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...HEADERS, Allow: 'GET, PUT' } });
    if (actor.role !== 'owner' || !actor.canWrite || req.headers.get('x-engram-console') !== '1') throw new JevError('Only a signed-in workspace owner can change Jev settings.',403,'forbidden');
    const raw = await req.text(); if (raw.length > 2048) throw new JevError('Settings request too large.',413);
    let body: any; try { body = JSON.parse(raw); } catch { throw new JevError('Expected JSON settings.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['enabled','monthlyBudgetUsd','acceptedRateVersion'].includes(key)) || typeof body.enabled !== 'boolean') throw new JevError('Invalid Jev settings.');
    const budget = parseJevBudget(body.monthlyBudgetUsd);
    await db.begin(async tx => {
      const [org] = await tx`SELECT id FROM orgs WHERE id = ${actor.orgId} FOR UPDATE`;
      const [member] = await tx`SELECT id FROM org_members WHERE org_id = ${actor.orgId} AND email = ${actor.email!} AND role = 'owner' FOR SHARE`;
      if (!org || !member) throw new JevError('Only a current workspace owner can change Jev settings.',403,'forbidden');
      const selfHosted = config.deploymentMode === 'self-hosted', source = await funding(tx as unknown as postgres.Sql, actor.orgId, now), price = jevPricing(env);
      if (body.enabled && !selfHosted) {
        if (!source) throw new JevError('An active Cloud subscription is required for billed Jev usage.',409,'subscription_required');
        if (budget === 0n) throw new JevError('Choose a positive monthly soft budget.');
        if (source.kind === 'subscription' && (!price.rateVersion || body.acceptedRateVersion !== price.rateVersion)) throw new JevError('Review and accept the current Jev rate before enabling it.',409,'rate_acceptance_required');
      }
      await tx`INSERT INTO workspace_jev_settings (org_id,enabled,monthly_budget_nanos,accepted_rate_version,accepted_by_member_id,accepted_at)
        VALUES (${actor.orgId},${body.enabled},${budget.toString()},${price.rateVersion},${member.id},${now})
        ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, monthly_budget_nanos = EXCLUDED.monthly_budget_nanos,
          accepted_rate_version = EXCLUDED.accepted_rate_version, accepted_by_member_id = EXCLUDED.accepted_by_member_id, accepted_at = EXCLUDED.accepted_at, updated_at = ${now}`;
      await tx`UPDATE orgs SET policies = jsonb_set(policies,'{jevProcessing}',${tx.json(body.enabled)}::jsonb) WHERE id = ${actor.orgId}`;
    });
    return Response.json(await getJevSummary(actor, input), { headers: HEADERS });
  } catch (error) {
    return error instanceof JevError ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: HEADERS }) : Response.json({ error: 'Jev settings are temporarily unavailable.' }, { status: 503, headers: HEADERS });
  }
}

export async function reserveJevCall(input: { orgId: number; model: string; task: string; operationId?: string }, options: Deps = {}): Promise<{ id: string } | null> {
  const { db, env, now } = dependencies(options);
  const configuredModel = configuredJevModel(env);
  if (config.deploymentMode !== 'hosted' || !providerConfigured(env) || !Number.isSafeInteger(input.orgId) || input.orgId < 1 || (currentOrg() && currentOrg()!.id !== input.orgId) || input.model !== configuredModel || !isJevModel(input.model) || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.task) || (input.operationId !== undefined && (!/^[a-zA-Z0-9:_-]{1,240}$/.test(input.operationId)))) return null;
  return db.begin(async tx => {
    const [org] = await tx`SELECT policies,provisioning_status FROM orgs WHERE id = ${input.orgId} FOR SHARE`;
    if (!org || org.provisioning_status !== 'ready' || org.policies?.jevProcessing !== true) return null;
    const [settings] = await tx`SELECT * FROM workspace_jev_settings WHERE org_id = ${input.orgId} FOR UPDATE`;
    if (!settings?.enabled || BigInt(settings.monthly_budget_nanos) === 0n) return null;
    if (input.operationId && (await tx`SELECT id FROM jev_usage_calls WHERE org_id = ${input.orgId} AND operation_id = ${input.operationId}`).length) return null;
    const source = await funding(tx as unknown as postgres.Sql, input.orgId, now), price = jevPricing(env);
    if (!source || (source.kind === 'subscription' && (!price.rateVersion || settings.accepted_rate_version !== price.rateVersion))) return null;
    if ((await totals(tx as unknown as postgres.Sql, input.orgId, now)).spent >= BigInt(settings.monthly_budget_nanos)) return null;
    const reserved = await tx`INSERT INTO insight_provider_budgets(org_id,day,calls) VALUES (${input.orgId},${now.toISOString().slice(0,10)}::date,1)
      ON CONFLICT(org_id,day) DO UPDATE SET calls = insight_provider_budgets.calls+1 WHERE insight_provider_budgets.calls < ${config.insights.dailyProviderCalls} RETURNING calls`;
    if (!reserved.length) return null;
    const id = randomUUID();
    await tx`INSERT INTO jev_usage_calls (id,org_id,operation_id,task,requested_model,funding,customer_id,subscription_id,rate_version,markup_bps,requested_at)
      VALUES (${id},${input.orgId},${input.operationId ?? null},${input.task},${input.model},${source.kind},${source.customer},${source.subscription},${source.kind === 'operator-funded' ? 'jev-operator-input42-output0-v1' : price.rateVersion!},${source.kind === 'operator-funded' ? 0 : price.markupBps!},${now})`;
    return { id };
  });
}
export async function settleJevCall(id: string, usage: { model: string; inputTokens: number; outputTokens: number }, input: Deps = {}): Promise<boolean> {
  const { db, now } = dependencies(input);
  if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens < 0 || usage.outputTokens < 0 || usage.inputTokens > 1_000_000 || usage.outputTokens > 1_000_000 || !isJevModel(usage.model)) { await failJevCall(id,'invalid_usage',input); return false; }
  return db.begin(async tx => {
    const [identity] = await tx`SELECT org_id FROM jev_usage_calls WHERE id = ${id}`;
    if (!identity || (currentOrg() && currentOrg()!.id !== identity.org_id)) return false;
    await tx`SELECT org_id FROM workspace_jev_settings WHERE org_id = ${identity.org_id} FOR UPDATE`;
    const [row] = await tx`SELECT * FROM jev_usage_calls WHERE id = ${id} FOR UPDATE`;
    if (row.status !== 'reserved') return row.status === 'settled' && row.reported_model === usage.model && Number(row.input_tokens) === usage.inputTokens && Number(row.output_tokens) === usage.outputTokens;
    const matched = jevModelMatches(row.requested_model, usage.model);
    const provider = matched ? BigInt(usage.inputTokens) * BigInt(row.input_nanos_per_token) : 0n;
    const customer = matched && row.funding === 'subscription' ? (provider * BigInt(10000 + row.markup_bps) + 5000n) / 10000n : 0n;
    await tx`UPDATE jev_usage_calls SET status = ${matched ? 'settled' : 'rejected'}, reported_model = ${usage.model}, input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens},
      provider_nanos = ${provider.toString()}, customer_nanos = ${customer.toString()}, settled_at = ${now}, error_code = ${matched ? null : 'model_mismatch'} WHERE id = ${id}`;
    return matched;
  });
}
export async function failJevCall(id: string, reason: 'timeout'|'network'|'http_error'|'invalid_usage'|'aborted', input: Deps = {}): Promise<void> {
  const { db, now } = dependencies(input);
  const orgId = currentOrg()?.id;
  await db`UPDATE jev_usage_calls SET status = 'unknown', error_code = ${reason}, settled_at = ${now} WHERE id = ${id} AND status = 'reserved' AND (${orgId ?? null}::integer IS NULL OR org_id = ${orgId ?? null})`;
}

export async function configureJevOperatorDefault(db: postgres.Sql, input: { email: string; workspaceId?: number }): Promise<{ applied: boolean; reason: 'applied'|'already-configured'|'owner-not-found'|'ambiguous-owner'|'configuration-conflict' }> {
  const email = input.email.trim().toLowerCase();
  if (input.workspaceId !== undefined && (!Number.isInteger(input.workspaceId) || input.workspaceId < 1 || input.workspaceId > 2147483647)) throw new JevError('Operator workspace must be a positive PostgreSQL integer.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { applied: false, reason: 'owner-not-found' };
  const budget = parseJevBudget(process.env.ENGRAM_JEV_OPERATOR_MONTHLY_BUDGET_USD ?? '1');
  if (budget === 0n) throw new JevError('Operator Jev budget must be positive.');
  return db.begin(async tx => {
    const rows = await tx`SELECT o.id FROM orgs o
      WHERE (${input.workspaceId ?? null}::integer IS NULL AND o.kind = 'personal' OR o.id = ${input.workspaceId ?? null})
        AND o.provisioning_status = 'ready'
        AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.email = ${email} AND m.role = 'owner')
      ORDER BY o.id FOR UPDATE OF o`;
    if (!rows.length) return { applied: false, reason: 'owner-not-found' };
    if (rows.length !== 1) return { applied: false, reason: 'ambiguous-owner' };
    const row = rows[0];
    // Lock every existing membership before checking roles. The org lock also
    // fences a concurrent new membership's foreign-key check.
    const members = await tx`SELECT id,email,role FROM org_members WHERE org_id = ${row.id} ORDER BY id FOR SHARE`;
    const owner = members.find(member => member.email === email && member.role === 'owner');
    if (!owner) return { applied: false, reason: 'owner-not-found' };
    if (members.filter(member => member.role === 'owner').length !== 1) return { applied: false, reason: 'ambiguous-owner' };
    const [prior] = await tx`SELECT owner_member_id,explicit_workspace_approved FROM jev_operator_access WHERE org_id = ${row.id}`;
    if (prior) return { applied: false, reason: prior.owner_member_id !== owner.id || (input.workspaceId !== undefined && !prior.explicit_workspace_approved) ? 'configuration-conflict' : 'already-configured' };
    const inserted = await tx`INSERT INTO jev_operator_access (org_id,owner_member_id,operator_role,explicit_workspace_approved) VALUES (${row.id},${owner.id},current_user,${input.workspaceId !== undefined})
      ON CONFLICT (org_id) DO NOTHING RETURNING org_id`;
    if (!inserted.length) return { applied: false, reason: 'already-configured' };
    await tx`INSERT INTO workspace_jev_settings (org_id,enabled,monthly_budget_nanos,accepted_by_member_id,accepted_at)
      VALUES (${row.id},true,${budget.toString()},${owner.id},now())
      ON CONFLICT (org_id) DO UPDATE SET enabled = true, monthly_budget_nanos = EXCLUDED.monthly_budget_nanos, accepted_by_member_id = EXCLUDED.accepted_by_member_id, accepted_at = EXCLUDED.accepted_at`;
    await tx`UPDATE orgs SET policies = jsonb_set(policies,'{jevProcessing}','true'::jsonb) WHERE id = ${row.id}`;
    return { applied: true, reason: 'applied' };
  });
}
