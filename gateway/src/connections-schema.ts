import type postgres from "postgres";

// Additive readiness marker: older revisions can still start after migration.
export const CONNECTIONS_SCHEMA_VERSION = 2026102601;
export async function ensureConnectionsSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS connection_lifecycle (
    org_id integer NOT NULL REFERENCES orgs(id),
    connection_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('token', 'oauth')),
    token_id integer,
    email text,
    client_id text,
    generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
    archived_at timestamptz,
    deleted_at timestamptz,
    PRIMARY KEY (org_id, connection_id),
    CHECK ((kind = 'token' AND token_id IS NOT NULL AND email IS NULL AND client_id IS NULL)
      OR (kind = 'oauth' AND token_id IS NULL AND email IS NOT NULL AND client_id IS NOT NULL))
  )`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS connection_lifecycle_oauth_idx ON connection_lifecycle(org_id, email, client_id) WHERE kind = 'oauth'`;
  await db`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS connection_generation integer NOT NULL DEFAULT 0`;
}
