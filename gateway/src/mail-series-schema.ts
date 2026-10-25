import type postgres from "postgres";

export const MAIL_SERIES_SCHEMA_VERSION = 2026102501;

export async function ensureMailSeriesSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS mail_series_enrollments (
    id uuid PRIMARY KEY,
    org_id integer UNIQUE NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    member_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    email text NOT NULL CHECK (email = lower(btrim(email))),
    signup_invite_id uuid NOT NULL REFERENCES hosted_signup_invites(id),
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'canceled', 'unsubscribed')),
    unsubscribe_hash text UNIQUE CHECK (unsubscribe_hash ~ '^[a-f0-9]{64}$'),
    last_step_at timestamptz,
    stopped_at timestamptz,
    stop_reason text CHECK (stop_reason IN ('access_revoked', 'membership_removed', 'unsubscribed', 'finished'))
  )`;
  await db`CREATE TABLE IF NOT EXISTS mail_series_jobs (
    id uuid PRIMARY KEY,
    enrollment_id uuid NOT NULL REFERENCES mail_series_enrollments(id) ON DELETE CASCADE,
    step text NOT NULL CHECK (step IN ('welcome', 'connect-agent', 'first-memory', 'second-agent')),
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
    due_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sent', 'skipped', 'canceled', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    lease_token uuid,
    lease_until timestamptz,
    first_attempt_at timestamptz,
    prepared_payload jsonb,
    completed_at timestamptz,
    error_code text CHECK (error_code IN ('delivery_failed', 'retry_exhausted', 'key_changed', 'invalid_payload')),
    UNIQUE (enrollment_id, step),
    UNIQUE (enrollment_id, ordinal)
  )`;
  await db`CREATE INDEX IF NOT EXISTS mail_series_jobs_due_idx ON mail_series_jobs (due_at, enrollment_id) WHERE status IN ('pending', 'leased')`;
}
