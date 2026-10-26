import type postgres from "postgres";

// Additive: existing authority and connection readiness contracts stay intact.
export const MEMORY_USAGE_SCHEMA_VERSION = 2026102604;
export async function ensureMemoryUsageSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS memory_context_runs (
    org_id integer NOT NULL REFERENCES orgs(id),
    actor_key text NOT NULL CHECK (actor_key ~ '^[a-f0-9]{64}$'),
    run_hash text NOT NULL CHECK (run_hash ~ '^[a-f0-9]{64}$'),
    max_bytes integer NOT NULL CHECK (max_bytes BETWEEN 1024 AND 16384),
    delivered_bytes integer NOT NULL DEFAULT 0 CHECK (delivered_bytes >= 0 AND delivered_bytes <= max_bytes),
    fingerprints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fingerprints) = 'array' AND jsonb_array_length(fingerprints) <= 128),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, actor_key, run_hash)
  )`;
  await db`CREATE INDEX IF NOT EXISTS memory_context_runs_retention_idx ON memory_context_runs(org_id, updated_at)`;
  await db`CREATE TABLE IF NOT EXISTS memory_connection_usage (
    org_id integer NOT NULL REFERENCES orgs(id),
    actor_key text NOT NULL CHECK (actor_key ~ '^[a-f0-9]{64}$'),
    actor_name text NOT NULL CHECK (octet_length(actor_name) <= 1024),
    actor_kind text NOT NULL CHECK (actor_kind IN ('token', 'oauth', 'session')),
    tracking_since timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_recall_at timestamptz,
    last_remember_at timestamptz,
    recalls bigint NOT NULL DEFAULT 0 CHECK (recalls >= 0),
    remembers bigint NOT NULL DEFAULT 0 CHECK (remembers >= 0),
    response_bytes bigint NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
    estimated_tokens bigint NOT NULL DEFAULT 0 CHECK (estimated_tokens >= 0),
    duplicate_recalls bigint NOT NULL DEFAULT 0 CHECK (duplicate_recalls >= 0),
    budget_stops bigint NOT NULL DEFAULT 0 CHECK (budget_stops >= 0),
    truncated_responses bigint NOT NULL DEFAULT 0 CHECK (truncated_responses >= 0),
    run_scoped_responses bigint NOT NULL DEFAULT 0 CHECK (run_scoped_responses >= 0),
    response_scoped_responses bigint NOT NULL DEFAULT 0 CHECK (response_scoped_responses >= 0),
    PRIMARY KEY (org_id, actor_key)
  )`;
  await db`CREATE INDEX IF NOT EXISTS memory_connection_usage_actor_idx ON memory_connection_usage(org_id, actor_kind, actor_name)`;
  await db`CREATE INDEX IF NOT EXISTS memory_connection_usage_retention_idx ON memory_connection_usage(org_id, updated_at)`;
  await db`ALTER TABLE memory_connection_usage ADD COLUMN IF NOT EXISTS integration_declaration jsonb`;
  await db`ALTER TABLE memory_connection_usage ADD COLUMN IF NOT EXISTS integration_declared_at timestamptz`;
  await db`ALTER TABLE memory_connection_usage ADD COLUMN IF NOT EXISTS integration_credential_key text`;
  await db`ALTER TABLE memory_connection_usage ADD COLUMN IF NOT EXISTS integration_check jsonb`;
  await db`ALTER TABLE memory_connection_usage ADD COLUMN IF NOT EXISTS integration_check_probe_hash text`;
  await db`CREATE TABLE IF NOT EXISTS memory_integration_checks (
    org_id integer NOT NULL REFERENCES orgs(id),
    actor_key text NOT NULL CHECK (actor_key ~ '^[a-f0-9]{64}$'),
    probe_hash text NOT NULL CHECK (probe_hash ~ '^[a-f0-9]{64}$'),
    run_hash text NOT NULL CHECK (run_hash ~ '^[a-f0-9]{64}$'),
    credential_key text NOT NULL CHECK (credential_key ~ '^[a-f0-9]{64}$'),
    declaration_hash text NOT NULL CHECK (declaration_hash ~ '^[a-f0-9]{64}$'),
    started_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
    recall_at timestamptz, save_at timestamptz,
    PRIMARY KEY(org_id, actor_key, probe_hash),
    CHECK (expires_at > started_at AND expires_at <= started_at + interval '15 minutes')
  )`;
  await db`CREATE INDEX IF NOT EXISTS memory_integration_checks_retention_idx ON memory_integration_checks(org_id, expires_at)`;
}
