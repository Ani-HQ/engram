import type postgres from "postgres";

// Additive readiness marker: older revisions can still start after migration.
// One row per authenticated agent credential (token or OAuth actor name). The
// agent may report a name and logo; a workspace owner may override or lock them.
export const AGENT_IDENTITY_SCHEMA_VERSION = 2026103001;
export async function ensureAgentIdentitySchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS agent_identities (
    org_id integer NOT NULL REFERENCES orgs(id),
    actor_kind text NOT NULL CHECK (actor_kind IN ('token', 'oauth')),
    actor_name text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 600),
    reported_name text CHECK (reported_name IS NULL OR length(reported_name) BETWEEN 1 AND 60),
    reported_logo_png bytea CHECK (reported_logo_png IS NULL OR octet_length(reported_logo_png) <= 65536),
    reported_at timestamptz,
    owner_name text CHECK (owner_name IS NULL OR length(owner_name) BETWEEN 1 AND 60),
    owner_logo_png bytea CHECK (owner_logo_png IS NULL OR octet_length(owner_logo_png) <= 65536),
    locked boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, actor_kind, actor_name)
  )`;
}
