import type postgres from "postgres";

export const CONTEXT_SHARING_SCHEMA_VERSION = 2026102502;

export async function ensureContextSharingSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS context_share_previews (
    id uuid PRIMARY KEY, source_org integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    owner_member_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    recipient_kind text NOT NULL CHECK (recipient_kind IN ('team','agent')),
    target_org integer REFERENCES orgs(id) ON DELETE CASCADE,
    target_member_id integer REFERENCES org_members(id) ON DELETE CASCADE,
    agent_name text, instruction text NOT NULL CHECK (length(instruction) BETWEEN 5 AND 1000),
    candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 12),
    source_hash text NOT NULL, method text NOT NULL CHECK (method IN ('model','text')),
    expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((recipient_kind = 'team' AND target_org IS NOT NULL AND target_member_id IS NOT NULL AND agent_name IS NULL)
      OR (recipient_kind = 'agent' AND target_org IS NULL AND target_member_id IS NULL AND agent_name IS NOT NULL AND length(agent_name) BETWEEN 1 AND 80))
  )`;
  await db`CREATE INDEX IF NOT EXISTS context_share_previews_owner ON context_share_previews(source_org, owner_member_id, created_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS context_share_previews_expiry ON context_share_previews(expires_at)`;
  await db`CREATE TABLE IF NOT EXISTS context_shares (
    id uuid PRIMARY KEY, source_org integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    owner_member_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    recipient_kind text NOT NULL CHECK (recipient_kind IN ('team','agent')),
    target_org integer REFERENCES orgs(id) ON DELETE CASCADE,
    target_member_id integer REFERENCES org_members(id) ON DELETE CASCADE,
    agent_name text, instruction text NOT NULL CHECK (length(instruction) BETWEEN 5 AND 1000),
    token_hash text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
    CHECK ((recipient_kind = 'team' AND target_org IS NOT NULL AND target_member_id IS NOT NULL AND agent_name IS NULL AND token_hash IS NULL)
      OR (recipient_kind = 'agent' AND target_org IS NULL AND target_member_id IS NULL AND agent_name IS NOT NULL AND length(agent_name) BETWEEN 1 AND 80 AND token_hash IS NOT NULL))
  )`;
  await db`CREATE INDEX IF NOT EXISTS context_shares_owner ON context_shares(source_org, owner_member_id, created_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS context_shares_target ON context_shares(target_org, created_at DESC) WHERE revoked_at IS NULL`;
  await db`CREATE TABLE IF NOT EXISTS context_share_items (
    id uuid PRIMARY KEY, share_id uuid NOT NULL REFERENCES context_shares(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1200),
    source_kind text NOT NULL CHECK (source_kind IN ('entry','trail')), source_id text NOT NULL,
    source_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(share_id, ordinal)
  )`;
}
