import type postgres from "postgres";

export const JEV_SCHEMA_VERSION = 2026102502;
export const JEV_OPERATOR_ONLY_TABLES = new Set(["jev_operator_access"]);

export async function ensureJevSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS workspace_jev_settings (
    org_id integer PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    monthly_budget_nanos bigint NOT NULL DEFAULT 0 CHECK (monthly_budget_nanos BETWEEN 0 AND 10000000000000),
    accepted_rate_version text,
    accepted_by_member_id integer,
    accepted_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  // Provisioner-owned approval and one-time bootstrap marker. Keep historical
  // member IDs so removal/recreation never silently reactivates this exemption.
  await db`CREATE TABLE IF NOT EXISTS jev_operator_access (
    org_id integer PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    owner_member_id integer NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    operator_role text NOT NULL,
    default_applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  // Older personal grants must not become team approvals after a kind change.
  await db`ALTER TABLE jev_operator_access ADD COLUMN IF NOT EXISTS explicit_workspace_approved boolean NOT NULL DEFAULT false`;
  await db`CREATE TABLE IF NOT EXISTS jev_invoice_batches (
    id uuid PRIMARY KEY,
    org_id integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    invoice_id text UNIQUE NOT NULL,
    customer_id text NOT NULL,
    subscription_id text NOT NULL,
    cutoff_at timestamptz NOT NULL,
    usage_nanos bigint NOT NULL CHECK (usage_nanos >= 0),
    carry_in_nanos bigint NOT NULL CHECK (carry_in_nanos BETWEEN 0 AND 9999999),
    carry_out_nanos bigint NOT NULL CHECK (carry_out_nanos BETWEEN 0 AND 9999999),
    amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
    status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','sending','exported','needs_reconciliation')),
    first_attempt_at timestamptz,
    lease_until timestamptz,
    stripe_invoice_item_id text,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await db`CREATE TABLE IF NOT EXISTS jev_billing_balances (
    org_id integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    subscription_id text NOT NULL,
    carry_nanos bigint NOT NULL DEFAULT 0 CHECK (carry_nanos BETWEEN 0 AND 9999999),
    PRIMARY KEY (org_id, subscription_id)
  )`;
  await db`CREATE TABLE IF NOT EXISTS jev_usage_calls (
    id uuid PRIMARY KEY,
    org_id integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    operation_id text,
    task text NOT NULL,
    requested_model text NOT NULL,
    reported_model text,
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','unknown','rejected')),
    funding text NOT NULL CHECK (funding IN ('subscription','operator-funded')),
    customer_id text,
    subscription_id text,
    rate_version text NOT NULL,
    input_nanos_per_token integer NOT NULL DEFAULT 42 CHECK (input_nanos_per_token = 42),
    markup_bps integer NOT NULL CHECK (markup_bps BETWEEN 0 AND 10000),
    input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 1000000),
    output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 1000000),
    provider_nanos bigint NOT NULL DEFAULT 0 CHECK (provider_nanos >= 0),
    customer_nanos bigint NOT NULL DEFAULT 0 CHECK (customer_nanos >= 0),
    requested_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    error_code text,
    invoice_batch_id uuid REFERENCES jev_invoice_batches(id)
  )`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS jev_usage_operation_idx ON jev_usage_calls (org_id,operation_id) WHERE operation_id IS NOT NULL`;
  await db`CREATE INDEX IF NOT EXISTS jev_usage_org_time_idx ON jev_usage_calls (org_id,requested_at)`;
  await db`CREATE INDEX IF NOT EXISTS jev_usage_unbilled_idx ON jev_usage_calls (org_id,subscription_id,requested_at) WHERE status = 'settled' AND funding = 'subscription' AND invoice_batch_id IS NULL`;
}
