import type postgres from "postgres";

// Additive readiness marker: older revisions can still start after migration.
// Agents' connectors report cumulative token counts read from their local
// session logs. Only counts are stored: no prompts, outputs or file content.
export const TOKEN_USAGE_SCHEMA_VERSION = 2026111601;
export async function ensureTokenUsageSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS token_usage_sessions (
    org_id integer NOT NULL REFERENCES orgs(id),
    agent text NOT NULL CHECK (octet_length(agent) BETWEEN 1 AND 1024),
    session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
    harness text NOT NULL CHECK (harness ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
    model text CHECK (model IS NULL OR model ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
    input bigint NOT NULL DEFAULT 0 CHECK (input BETWEEN 0 AND 1000000000000),
    output bigint NOT NULL DEFAULT 0 CHECK (output BETWEEN 0 AND 1000000000000),
    cache_read bigint NOT NULL DEFAULT 0 CHECK (cache_read BETWEEN 0 AND 1000000000000),
    cache_write bigint NOT NULL DEFAULT 0 CHECK (cache_write BETWEEN 0 AND 1000000000000),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, agent, session_hash)
  )`;
  await db`CREATE INDEX IF NOT EXISTS token_usage_sessions_recent_idx ON token_usage_sessions(org_id, agent, first_seen_at)`;
  await db`CREATE TABLE IF NOT EXISTS token_usage_hourly (
    org_id integer NOT NULL REFERENCES orgs(id),
    hour timestamptz NOT NULL CHECK (date_trunc('hour', hour, 'UTC') = hour),
    harness text NOT NULL CHECK (harness ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
    input bigint NOT NULL DEFAULT 0 CHECK (input >= 0),
    output bigint NOT NULL DEFAULT 0 CHECK (output >= 0),
    cache_read bigint NOT NULL DEFAULT 0 CHECK (cache_read >= 0),
    cache_write bigint NOT NULL DEFAULT 0 CHECK (cache_write >= 0),
    PRIMARY KEY (org_id, hour, harness)
  )`;
  // Owners can hide token counters without unpublishing. Existing profiles
  // show them by default, matching the editor's "Show token usage" switch.
  await db`ALTER TABLE action_profiles ADD COLUMN IF NOT EXISTS show_tokens boolean NOT NULL DEFAULT true`;
}
