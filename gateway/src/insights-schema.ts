import type postgres from "postgres";

export async function ensureInsightSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS insight_jobs (
    id uuid PRIMARY KEY, org_id integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    actor_name text NOT NULL, kind text NOT NULL DEFAULT 'activity' CHECK (kind IN ('activity','memory')), dedup_key text, request jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
    attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
    result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`;
  await db`ALTER TABLE insight_jobs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'activity'`;
  await db`ALTER TABLE insight_jobs ADD COLUMN IF NOT EXISTS dedup_key text`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS insight_jobs_dedup ON insight_jobs(org_id,kind,dedup_key) WHERE dedup_key IS NOT NULL`;
  await db`CREATE INDEX IF NOT EXISTS insight_jobs_org_recent ON insight_jobs(org_id, created_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS insight_jobs_pending ON insight_jobs(status, created_at) WHERE status IN ('queued','running')`;
  await db`CREATE TABLE IF NOT EXISTS insight_provider_budgets (
    org_id integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, day date NOT NULL,
    calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0), PRIMARY KEY(org_id, day)
  )`;
  await db`CREATE TABLE IF NOT EXISTS insight_memory_cursors (
    org_id integer PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    scanned_at timestamptz NOT NULL, scanned_id text NOT NULL DEFAULT ''
  )`;
}
