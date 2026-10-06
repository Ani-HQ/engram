import postgres from "postgres";
import { currentContext } from "./context";
import { dbUrl } from "./config";

export const sql = postgres(dbUrl("engram_gateway"), {
  max: 5,
  connect_timeout: 2,
  onnotice: () => {},
});

const orgPools = new Map<string, postgres.Sql>();

export function dataSql(): postgres.Sql {
  return currentContext()?.dataSql ?? sql;
}

export function poolFor(dbName: string): postgres.Sql {
  if (dbName === "engram_gateway") return sql;
  const existing = orgPools.get(dbName);
  if (existing) return existing;
  const pool = postgres(dbUrl(dbName), {
    max: 3,
    connect_timeout: 2,
    onnotice: () => {},
  });
  orgPools.set(dbName, pool);
  return pool;
}

export async function closeOrgPool(dbName: string): Promise<void> {
  if (dbName === "engram_gateway") return;
  const pool = orgPools.get(dbName);
  if (!pool) return;
  orgPools.delete(dbName);
  await pool.end({ timeout: 1 }).catch(() => {});
}

export function adminSql(): postgres.Sql {
  return postgres(dbUrl("postgres"), { max: 1, onnotice: () => {} });
}

export function assertBrainDbName(name: string): string {
  if (name !== "brain_shared" && !/^brain_org_\d+$/.test(name)) {
    throw new Error(`invalid brain database name: ${name}`);
  }
  return name;
}

export async function ensureDatabase(dbName: string): Promise<void> {
  const safe = assertBrainDbName(dbName);
  const admin = adminSql();
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${safe}`;
    if (rows.length) return;
    await admin.unsafe(`CREATE DATABASE ${safe}`);
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

export async function migrateOrgDataTables(client: postgres.Sql) {
  await client`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id            text PRIMARY KEY,
      fingerprint   text UNIQUE NOT NULL,
      slug          text NOT NULL,
      archive_slug  text,
      recorded_at   timestamptz,
      token_name    text,
      raw_text      text NOT NULL,
      topic_hint    text,
      status        text NOT NULL DEFAULT 'active',
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`;
  await client`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS repo text`;
  await client`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS harness text`;
  await client`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS session_id text`;
  await client`CREATE INDEX IF NOT EXISTS memory_entries_slug_idx ON memory_entries (slug)`;
  await client`CREATE INDEX IF NOT EXISTS memory_entries_status_idx ON memory_entries (status, recorded_at DESC)`;
  await client`CREATE INDEX IF NOT EXISTS memory_entries_repo_idx ON memory_entries (repo)`;

  await client`
    CREATE TABLE IF NOT EXISTS trails (
      id            text PRIMARY KEY,
      harness       text NOT NULL,
      session_id    text NOT NULL,
      repo          text,
      cwd           text,
      branch        text,
      author_email  text,
      started_at    timestamptz,
      ended_at      timestamptz,
      transcript    text,
      digest        text,
      digest_slug   text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (harness, session_id)
    )`;
  await client`CREATE INDEX IF NOT EXISTS trails_repo_idx ON trails (repo, ended_at DESC)`;
  await client`CREATE INDEX IF NOT EXISTS trails_author_idx ON trails (author_email, ended_at DESC)`;

  await client`
    CREATE TABLE IF NOT EXISTS reflex_decisions (
      id          bigserial PRIMARY KEY,
      entry_id    text REFERENCES memory_entries(id),
      sheet       text NOT NULL,
      payload     jsonb NOT NULL,
      model_ref   text,
      confidence  double precision,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await client`CREATE INDEX IF NOT EXISTS reflex_decisions_entry_idx ON reflex_decisions (entry_id, sheet, created_at DESC)`;

  await client`
    CREATE TABLE IF NOT EXISTS dream_runs (
      id          bigserial PRIMARY KEY,
      night_key   text UNIQUE NOT NULL,
      status      text NOT NULL DEFAULT 'running',
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      cursor      jsonb,
      stats       jsonb,
      error       text
    )`;

  await client`
    CREATE TABLE IF NOT EXISTS review_items (
      id           bigserial PRIMARY KEY,
      fingerprint  text UNIQUE NOT NULL,
      entry_id     text REFERENCES memory_entries(id),
      kind         text NOT NULL,
      state        text NOT NULL DEFAULT 'pending',
      confidence   double precision,
      payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
      run_id       bigint REFERENCES dream_runs(id),
      resolved_at  timestamptz,
      resolved_by  text,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`;
  await client`CREATE INDEX IF NOT EXISTS review_items_state_idx ON review_items (state, created_at DESC)`;
}

export async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS tokens (
      id          serial PRIMARY KEY,
      name        text UNIQUE NOT NULL,
      sha256_hash text NOT NULL,
      scopes      jsonb NOT NULL DEFAULT '{}'::jsonb,
      secrets_acl jsonb NOT NULL DEFAULT 'false'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      revoked_at  timestamptz,
      last_used_at timestamptz
    )`;
	  await sql`
	    CREATE TABLE IF NOT EXISTS audit_log (
	      id          bigserial PRIMARY KEY,
	      ts          timestamptz NOT NULL DEFAULT now(),
	      token_name  text NOT NULL,
	      tool        text NOT NULL,
	      arg_summary text,
	      outcome     text NOT NULL
	    )`;
  await sql`CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC)`;

  // Which page a call touched was only ever recoverable by string-scraping
  // arg_summary, and `remember` never put a slug in there at all: it takes a topic
  // and derives the slug itself. Recording it properly is what makes "who contributed
  // to this page" answerable.
  await sql`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS slug text`;
  await sql`
    CREATE INDEX IF NOT EXISTS audit_log_slug_idx
    ON audit_log (slug, ts) WHERE slug IS NOT NULL`;
  // Recover what the old rows can still tell us. put_page and the add_* tools put the
  // slug first in their arguments, so it survives the 200-character summary. Rows from
  // `remember` cannot be recovered and stay null, which is honest rather than guessed.
  await sql`
    UPDATE audit_log
    SET slug = substring(arg_summary from '"slug":"([^"]+)"')
    WHERE slug IS NULL AND arg_summary LIKE '%"slug":"%'`;

  await migrateOrgDataTables(sql);

  await sql`
    CREATE TABLE IF NOT EXISTS orgs (
      id          serial PRIMARY KEY,
      name        text NOT NULL,
      slug        text UNIQUE NOT NULL,
      brain_db    text NOT NULL,
      home_dir    text NOT NULL,
      data_db     text NOT NULL,
      policies    jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'team'`;
  await sql`UPDATE orgs SET kind = 'team' WHERE kind IS NULL OR kind NOT IN ('team', 'personal')`;

  await sql`
    INSERT INTO orgs (id, name, slug, kind, brain_db, home_dir, data_db, policies)
    VALUES (
      1,
      'Ani HQ',
      'ani-hq',
      'team',
      'brain_shared',
      'brain',
      'engram_gateway',
      '{}'::jsonb
    )
    ON CONFLICT (id) DO NOTHING`;
  await sql`SELECT setval('orgs_id_seq', GREATEST((SELECT MAX(id) FROM orgs), 1))`;

  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS org_id int REFERENCES orgs(id)`;
  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'agent'`;
  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS can_write boolean NOT NULL DEFAULT true`;
  await sql`UPDATE tokens SET org_id = 1 WHERE org_id IS NULL`;
  // Tokens that existed before orgs were identity for one trusted team. Promote
  // those, and only those: a token minted after Ani HQ's row stays an agent.
  await sql`
    UPDATE tokens
    SET role = 'owner'
    WHERE org_id = 1
      AND role = 'agent'
      AND created_at <= (SELECT created_at FROM orgs WHERE id = 1)`;
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tokens_name_key'
      ) THEN
        ALTER TABLE tokens DROP CONSTRAINT tokens_name_key;
      END IF;
    END $$`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS tokens_org_name_idx ON tokens (org_id, name)`;

  await sql`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS org_id int`;
  await sql`UPDATE audit_log SET org_id = 1 WHERE org_id IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id, ts DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS org_members (
      id          serial PRIMARY KEY,
      org_id      int NOT NULL REFERENCES orgs(id),
      email       text NOT NULL,
      role        text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, email)
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id          serial PRIMARY KEY,
      org_id      int NOT NULL REFERENCES orgs(id),
      name        text NOT NULL,
      role        text NOT NULL,
      email       text,
      sha256_hash text UNIQUE NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      revoked_at  timestamptz
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS invites (
      id           serial PRIMARY KEY,
      org_id       int REFERENCES orgs(id),
      email        text NOT NULL,
      role         text NOT NULL DEFAULT 'member',
      sha256_hash  text UNIQUE NOT NULL,
      created_by   text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      accepted_at  timestamptz,
      pending_name text
    )`;
  await sql`ALTER TABLE invites ALTER COLUMN org_id DROP NOT NULL`;
  await sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS pending_name text`;

  await sql`
    CREATE TABLE IF NOT EXISTS share_rules (
      id           serial PRIMARY KEY,
      owner_email  text NOT NULL,
      source_org   int NOT NULL REFERENCES orgs(id),
      target_org   int NOT NULL REFERENCES orgs(id),
      match        jsonb NOT NULL DEFAULT '{}'::jsonb,
      level        text NOT NULL DEFAULT 'digest',
      created_at   timestamptz NOT NULL DEFAULT now(),
      paused_at    timestamptz,
      revoked_at   timestamptz
    )`;
  await sql`CREATE INDEX IF NOT EXISTS share_rules_source_idx ON share_rules (source_org, revoked_at)`;
  await sql`CREATE INDEX IF NOT EXISTS share_rules_owner_idx ON share_rules (owner_email, revoked_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS shared_copies (
      id              serial PRIMARY KEY,
      rule_id         int REFERENCES share_rules(id),
      source_kind     text NOT NULL,
      source_id       text NOT NULL,
      target_org      int NOT NULL REFERENCES orgs(id),
      target_slug     text,
      target_trail_id text,
      synced_at       timestamptz NOT NULL DEFAULT now(),
      revoked_at      timestamptz,
      UNIQUE (rule_id, source_kind, source_id)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS shared_copies_target_idx ON shared_copies (target_org, revoked_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id    text PRIMARY KEY,
      redirect_uris jsonb NOT NULL,
      client_name  text,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS oauth_requests (
      id             text PRIMARY KEY,
      client_id      text NOT NULL,
      redirect_uri   text NOT NULL,
      state          text,
      code_challenge text NOT NULL,
      resource       text,
      scope          text,
      email          text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL,
      used_at        timestamptz
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      id             serial PRIMARY KEY,
      sha256_hash    text UNIQUE NOT NULL,
      client_id      text NOT NULL,
      email          text NOT NULL,
      org_id         int NOT NULL REFERENCES orgs(id),
      redirect_uri   text NOT NULL,
      code_challenge text NOT NULL,
      resource       text,
      scope          text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL,
      used_at        timestamptz
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id          serial PRIMARY KEY,
      sha256_hash text UNIQUE NOT NULL,
      client_id   text NOT NULL,
      email       text NOT NULL,
      org_id      int NOT NULL REFERENCES orgs(id),
      resource    text,
      scope       text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      revoked_at  timestamptz
    )`;
}
