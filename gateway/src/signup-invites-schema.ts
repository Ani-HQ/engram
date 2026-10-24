import type postgres from "postgres";

export const HOSTED_SIGNUP_SCHEMA_VERSION = 2026102401;
export const SIGNUP_OPERATOR_ONLY_TABLES = new Set(["hosted_signup_operators"]);

export async function ensureHostedSignupInvitesSchema(db: postgres.Sql): Promise<void> {
  await db`ALTER TABLE engram_schema_state ADD COLUMN IF NOT EXISTS signup_operator_bootstrapped boolean NOT NULL DEFAULT false`;
  await db`
    CREATE TABLE IF NOT EXISTS hosted_signup_operators (
      member_id integer PRIMARY KEY REFERENCES org_members(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS hosted_signup_invites (
      id uuid PRIMARY KEY,
      code_hash text UNIQUE NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
      email text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
      created_by_member_id integer NOT NULL REFERENCES org_members(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      redeemed_at timestamptz,
      redeemed_org_id integer REFERENCES orgs(id),
      redeemed_owner_member_id integer REFERENCES org_members(id),
      complimentary_applied_at timestamptz,
      complimentary_revoked_at timestamptz,
      complimentary_grant_id uuid,
      complimentary_error_code text,
      complimentary_retry_at timestamptz,
      CHECK (expires_at > created_at)
    )`;
  await db`ALTER TABLE hosted_signup_invites ADD COLUMN IF NOT EXISTS complimentary_error_code text`;
  await db`ALTER TABLE hosted_signup_invites ADD COLUMN IF NOT EXISTS complimentary_retry_at timestamptz`;
  await db`
    CREATE TABLE IF NOT EXISTS hosted_signup_verifications (
      id uuid PRIMARY KEY,
      signup_invite_id uuid NOT NULL REFERENCES hosted_signup_invites(id),
      email text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
      pending_name text NOT NULL,
      token_hash text UNIQUE NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz
    )`;
  await db`CREATE INDEX IF NOT EXISTS hosted_signup_verifications_invite_time_idx ON hosted_signup_verifications (signup_invite_id, created_at DESC)`;
  await db`ALTER TABLE invites ADD COLUMN IF NOT EXISTS signup_invite_id uuid REFERENCES hosted_signup_invites(id)`;
  await db`ALTER TABLE invites ADD COLUMN IF NOT EXISTS oauth_request_id text`;
  await db`CREATE INDEX IF NOT EXISTS hosted_signup_invites_redemption_idx ON hosted_signup_invites (redeemed_org_id) WHERE redeemed_at IS NOT NULL`;
  // Bootstrap admission authority once. An ambiguous or absent org-1 owner
  // leaves an empty allowlist permanently; later migrations never promote a new
  // owner or reactivate an operator whose authority was explicitly revoked.
  await db.begin(async tx => {
    await tx`INSERT INTO engram_schema_state (id, version) VALUES (true, 0) ON CONFLICT (id) DO NOTHING`;
    const state = (await tx`SELECT signup_operator_bootstrapped FROM engram_schema_state WHERE id = true FOR UPDATE`)[0];
    if (state?.signup_operator_bootstrapped) return;
    const owners = await tx`SELECT id FROM org_members WHERE org_id = 1 AND role = 'owner' ORDER BY id FOR UPDATE`;
    if (owners.length === 1) {
      await tx`INSERT INTO hosted_signup_operators (member_id) VALUES (${owners[0].id}) ON CONFLICT (member_id) DO NOTHING`;
    }
    await tx`UPDATE engram_schema_state SET signup_operator_bootstrapped = true WHERE id = true`;
  });
}
