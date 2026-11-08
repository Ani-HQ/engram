import type postgres from "postgres";

// Additive readiness marker: older revisions can still start after migration.
// Linked workspaces: a person lets one of their personal agent connections read
// a team they belong to. Share requests: a teammate asks for something from a
// person's personal memory; the owner reviews excerpts and decides.
export const WORKSPACE_ACCESS_SCHEMA_VERSION = 2026110801;
export async function ensureWorkspaceAccessSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS connection_workspace_links (
    id bigserial PRIMARY KEY,
    home_org_id integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    actor_kind text NOT NULL CHECK (actor_kind IN ('token', 'oauth')),
    actor_name text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 600),
    target_org_id integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    target_membership_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    granted_by_email text NOT NULL CHECK (length(granted_by_email) BETWEEN 3 AND 254),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_by_email text,
    CHECK (home_org_id <> target_org_id)
  )`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS connection_workspace_links_active
    ON connection_workspace_links (home_org_id, actor_kind, actor_name, target_org_id) WHERE revoked_at IS NULL`;
  await db`CREATE INDEX IF NOT EXISTS connection_workspace_links_target
    ON connection_workspace_links (target_org_id, created_at DESC) WHERE revoked_at IS NULL`;

  await db`CREATE TABLE IF NOT EXISTS context_share_grants (
    id uuid PRIMARY KEY,
    source_org integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    owner_member_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    team_org integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    requester_member_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    topic text NOT NULL CHECK (length(topic) BETWEEN 3 AND 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  )`;
  await db`CREATE INDEX IF NOT EXISTS context_share_grants_lookup
    ON context_share_grants (team_org, requester_member_id, owner_member_id) WHERE revoked_at IS NULL`;

  await db`CREATE TABLE IF NOT EXISTS context_share_requests (
    id uuid PRIMARY KEY,
    team_org integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    requester_member_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    requester_actor text NOT NULL CHECK (length(requester_actor) BETWEEN 1 AND 600),
    owner_org integer NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    owner_member_id integer NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
    question text NOT NULL CHECK (length(question) BETWEEN 5 AND 500),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'declined', 'expired')),
    share_id uuid REFERENCES context_shares(id) ON DELETE SET NULL,
    grant_id uuid REFERENCES context_share_grants(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    notified_at timestamptz
  )`;
  await db`CREATE INDEX IF NOT EXISTS context_share_requests_owner
    ON context_share_requests (owner_org, owner_member_id, created_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS context_share_requests_requester
    ON context_share_requests (team_org, requester_member_id, created_at DESC)`;
  await db`ALTER TABLE context_shares ADD COLUMN IF NOT EXISTS grant_id uuid REFERENCES context_share_grants(id) ON DELETE SET NULL`;
}
