import type postgres from "postgres";

export const BILLING_SCHEMA_VERSION = 2026102401;
export const OPERATOR_ONLY_BILLING_TABLES = new Set(["workspace_complimentary_access", "complimentary_access_events"]);

export async function ensureComplimentaryAccessSchema(db: postgres.Sql): Promise<void> {
  // Separate from Stripe and the original trial. NULL means no expiry, not an
  // invented future trial date. Only the provisioner/operator may mutate these.
  await db`
    CREATE TABLE IF NOT EXISTS workspace_complimentary_access (
      id uuid PRIMARY KEY,
      org_id integer UNIQUE NOT NULL REFERENCES orgs(id),
      owner_member_id integer NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      revoked_at timestamptz,
      CHECK (expires_at IS NULL OR expires_at > granted_at),
      CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS complimentary_access_events (
      id uuid PRIMARY KEY,
      org_id integer NOT NULL REFERENCES orgs(id),
      grant_id uuid NOT NULL,
      owner_member_id integer NOT NULL,
      operation text NOT NULL CHECK (operation IN ('grant', 'revoke')),
      request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 8 AND 120),
      payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      operator_role text NOT NULL,
      reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, request_id)
    )`;
  await db`CREATE INDEX IF NOT EXISTS complimentary_access_events_org_time_idx ON complimentary_access_events (org_id, created_at DESC)`;
}
