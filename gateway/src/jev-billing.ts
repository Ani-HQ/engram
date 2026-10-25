import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type StripeRequest = (path: string, params?: Record<string,string>, key?: string) => Promise<any>;
export type JevInvoiceDependencies = { db: postgres.Sql; request: StripeRequest; now: Date; env?: NodeJS.ProcessEnv };
const CENT = 10_000_000n;
const HORIZON = 23 * 60 * 60_000;
const TERMINAL = ['invoice_unavailable','ambiguous_expired','item_mismatch','duplicate_items','too_many_items'];
const id = (value: any, prefix: string): string | null => typeof (value?.id ?? value) === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value?.id ?? value) ? value?.id ?? value : null;
function subscription(invoice: any) { return id(invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription, 'sub'); }

export async function prepareJevInvoiceBatch(invoice: any, deps: JevInvoiceDependencies): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (env.ENGRAM_JEV_BILLING_ENABLED !== '1' && env.ENGRAM_JEV_BILLING_WORKER_ENABLED !== '1') return null;
  const invoiceId = id(invoice,'in'), customer = id(invoice?.customer,'cus'), sub = subscription(invoice);
  if (!invoiceId || !customer || !sub || invoice.status !== 'draft' || invoice.currency !== 'usd' || !Number.isSafeInteger(invoice.created) || invoice.created <= 0) return null;
  const cutoff = new Date(invoice.created * 1000);
  if (cutoff.getTime() > deps.now.getTime() + 5 * 60_000) return null;
  return deps.db.begin(async tx => {
    const [billing] = await tx`SELECT b.org_id FROM workspace_billing b WHERE b.stripe_customer_id = ${customer}
      AND (b.stripe_subscription_id = ${sub} OR EXISTS (SELECT 1 FROM jev_usage_calls u WHERE u.org_id = b.org_id
        AND u.customer_id = ${customer} AND u.subscription_id = ${sub} AND u.status = 'settled' AND u.funding = 'subscription')) FOR UPDATE OF b`;
    if (!billing) return null; // Webhook metadata never creates a binding.
    const [existing] = await tx`SELECT id,org_id,customer_id,subscription_id FROM jev_invoice_batches WHERE invoice_id = ${invoiceId}`;
    if (existing) return existing.org_id === billing.org_id && existing.customer_id === customer && existing.subscription_id === sub ? String(existing.id) : null;
    await tx`INSERT INTO jev_billing_balances (org_id,subscription_id) VALUES (${billing.org_id},${sub}) ON CONFLICT DO NOTHING`;
    const [balance] = await tx`SELECT carry_nanos FROM jev_billing_balances WHERE org_id = ${billing.org_id} AND subscription_id = ${sub} FOR UPDATE`;
    const calls = await tx`SELECT id,customer_nanos FROM jev_usage_calls WHERE org_id = ${billing.org_id} AND customer_id = ${customer} AND subscription_id = ${sub}
      AND funding = 'subscription' AND status = 'settled' AND invoice_batch_id IS NULL AND requested_at < ${cutoff} FOR UPDATE`;
    const usage = calls.reduce((sum,row) => sum + BigInt(row.customer_nanos),0n), carry = BigInt(balance.carry_nanos), amount = (usage+carry)/CENT, remainder = (usage+carry)%CENT;
    const batchId = randomUUID();
    await tx`INSERT INTO jev_invoice_batches (id,org_id,invoice_id,customer_id,subscription_id,cutoff_at,usage_nanos,carry_in_nanos,carry_out_nanos,amount_cents,status)
      VALUES (${batchId},${billing.org_id},${invoiceId},${customer},${sub},${cutoff},${usage.toString()},${carry.toString()},${remainder.toString()},${amount.toString()},${amount === 0n ? 'exported' : 'prepared'})`;
    if (calls.length) await tx`UPDATE jev_usage_calls SET invoice_batch_id = ${batchId} WHERE id = ANY(${calls.map(row => String(row.id))}::uuid[])`;
    await tx`UPDATE jev_billing_balances SET carry_nanos = ${remainder.toString()} WHERE org_id = ${billing.org_id} AND subscription_id = ${sub}`;
    return batchId;
  });
}

export async function exportJevInvoiceBatch(batchId: string, deps: JevInvoiceDependencies): Promise<'exported'|'pending'|'review'> {
  if ((deps.env ?? process.env).ENGRAM_JEV_BILLING_WORKER_ENABLED !== '1') return 'pending';
  const batch = await deps.db.begin(async tx => {
    const [row] = await tx`SELECT * FROM jev_invoice_batches WHERE id = ${batchId} FOR UPDATE`;
    if (!row || row.status === 'exported') return null;
    if (TERMINAL.includes(row.error_code) || (row.status === 'sending' && row.lease_until && new Date(row.lease_until) > deps.now)) return null;
    await tx`UPDATE jev_invoice_batches SET status = 'sending', lease_until = ${new Date(deps.now.getTime()+60_000)} WHERE id = ${batchId}`;
    return row;
  });
  if (!batch) return 'pending';
  const review = async (reason: string) => {
    await deps.db`UPDATE jev_invoice_batches SET status = 'needs_reconciliation', error_code = ${reason}, lease_until = NULL WHERE id = ${batchId}`;
    return 'review' as const;
  };
  const exported = async (itemId: string) => {
    await deps.db`UPDATE jev_invoice_batches SET status = 'exported', stripe_invoice_item_id = ${itemId}, error_code = NULL, lease_until = NULL WHERE id = ${batchId}`;
    return 'exported' as const;
  };
  try {
    // Reconcile before every possible write, including a provider-accepted POST
    // whose HTTP response or local commit was lost. Only opaque IDs go to Stripe.
    const invoice = await deps.request(`invoices/${batch.invoice_id}`);
    if (id(invoice,'in') !== batch.invoice_id || id(invoice.customer,'cus') !== batch.customer_id || subscription(invoice) !== batch.subscription_id || invoice.currency !== 'usd') return review('invoice_unavailable');
    const matches: any[] = [];
    let after = '';
    for (let page = 0; page < 3; page++) {
      const query = new URLSearchParams({ invoice: batch.invoice_id, customer: batch.customer_id, limit: '100', ...(after ? { starting_after: after } : {}) });
      const result = await deps.request(`invoiceitems?${query}`);
      if (!Array.isArray(result.data)) throw new Error('invalid_stripe_list');
      matches.push(...result.data.filter((item: any) => item?.metadata?.engram_jev_batch_id === batchId));
      if (!result.has_more) { after = ''; break; }
      after = id(result.data.at(-1),'ii') ?? '';
      if (!after) return review('too_many_items');
    }
    if (after) return review('too_many_items');
    if (matches.length > 1) return review('duplicate_items');
    if (matches.length === 1) {
      const item = matches[0], itemId = id(item,'ii');
      if (!itemId || id(item.invoice,'in') !== batch.invoice_id || id(item.customer,'cus') !== batch.customer_id || String(item.amount) !== String(batch.amount_cents) || item.currency !== 'usd' || item.metadata?.engram_org_id !== String(batch.org_id)) return review('item_mismatch');
      return exported(itemId);
    }
    if (invoice.status !== 'draft') return review('invoice_unavailable');
    if (batch.first_attempt_at && deps.now.getTime()-new Date(batch.first_attempt_at).getTime() >= HORIZON) return review('ambiguous_expired');
    await deps.db`UPDATE jev_invoice_batches SET first_attempt_at = coalesce(first_attempt_at,${deps.now}) WHERE id = ${batchId}`;
    const item = await deps.request('invoiceitems', { customer: batch.customer_id, invoice: batch.invoice_id, subscription: batch.subscription_id,
      amount: String(batch.amount_cents), currency: 'usd', discountable: 'false', description: 'Jev usage',
      'metadata[engram_jev_batch_id]': batchId, 'metadata[engram_org_id]': String(batch.org_id) }, `engram-jev-invoice-${batchId}`);
    const itemId = id(item,'ii');
    if (!itemId || id(item.invoice,'in') !== batch.invoice_id || id(item.customer,'cus') !== batch.customer_id || String(item.amount) !== String(batch.amount_cents) || item.currency !== 'usd') return review('item_mismatch');
    return exported(itemId);
  } catch {
    await deps.db`UPDATE jev_invoice_batches SET status = 'needs_reconciliation', error_code = 'provider_unavailable', lease_until = ${new Date(deps.now.getTime()+60_000)} WHERE id = ${batchId}`;
    return 'pending';
  }
}

export async function drainJevInvoiceBatches(deps: JevInvoiceDependencies, options: { limit?: number; dryRun?: boolean } = {}) {
  const counts = { enabled: (deps.env ?? process.env).ENGRAM_JEV_BILLING_WORKER_ENABLED === '1', pending: 0, exported: 0, review: 0, dryRun: options.dryRun === true };
  if (!counts.enabled && !options.dryRun) return counts;
  const rows = await deps.db`SELECT id FROM jev_invoice_batches WHERE status IN ('prepared','sending','needs_reconciliation')
    AND (lease_until IS NULL OR lease_until <= ${deps.now}) AND (error_code IS NULL OR NOT (error_code = ANY(${TERMINAL}))) ORDER BY created_at LIMIT ${Math.max(1,Math.min(25,options.limit ?? 25))}`;
  counts.pending = rows.length;
  const started = Date.now();
  if (!options.dryRun) for (const row of rows) {
    if (Date.now() - started >= 240_000) break;
    const result = await exportJevInvoiceBatch(String(row.id),deps);
    if (result === 'exported') counts.exported++; else if (result === 'review') counts.review++;
  }
  const [remaining] = await deps.db`SELECT count(*) FILTER (WHERE error_code = ANY(${TERMINAL}))::int AS review,
    count(*) FILTER (WHERE error_code IS NULL OR NOT (error_code = ANY(${TERMINAL})))::int AS pending FROM jev_invoice_batches WHERE status <> 'exported'`;
  counts.pending = Number(remaining.pending); counts.review = Number(remaining.review);
  return counts;
}
