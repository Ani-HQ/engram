import postgres from "postgres";
import { currentContext } from "./context";
import { config, databaseSecurity, dbUrl, provisionerDbUrl } from "./config";
import { assertTenantDatabaseReady, prepareGatewayDatabase, protectGatewayMetadata, provisionerPool, provisionTenantDatabase, tenantDbUrl } from "./tenant-db";
import { ensureInsightSchema } from "./insights-schema";
import { ensureComplimentaryAccessSchema } from "./billing-schema";
import { ensureHostedSignupInvitesSchema } from "./signup-invites-schema";
import { ensureMailSeriesSchema } from "./mail-series-schema";
import { ensureJevSchema } from "./jev-schema";
import { ensureContextSharingSchema } from "./context-sharing-schema";
import { ensureConnectionsSchema } from "./connections-schema";
import { ensureMemoryUsageSchema } from "./memory-usage-schema";
import { ensureConnectionClientSchema } from "./connection-client-schema";
import { ensureSiteAnalyticsSchema } from "./site-analytics-schema";
import { assertRuntimeSchema, ensureProvisioningSchema, markSchemaReady } from "./provisioning-schema";

export const sql = postgres(dbUrl("engram_gateway"), {
  max: 5,
  connect_timeout: 2,
  onnotice: () => {},
});
const requestSql = sql;

type TenantPool = { client: postgres.Sql; lastUsed: number; leases: number };
const orgPools = new Map<string, TenantPool>();

export async function closeDatabasePools(): Promise<void> {
  const pools = [...orgPools.values()].map(entry => entry.client);
  orgPools.clear();
  await Promise.all(pools.map(pool => pool.end({ timeout: 2 })));
  await sql.end({ timeout: 2 });
}

export function dataSql(): postgres.Sql {
  const context = currentContext();
  if (!context) throw new Error("A workspace context is required to access tenant data");
  if (context.org.id !== context.token.orgId) throw new Error("Actor and workspace context must match");
  return context.dataSql;
}

export function poolFor(dbName: string): postgres.Sql {
  if (dbName === "engram_gateway") return sql;
  assertBrainDbName(dbName);
  const existing = orgPools.get(dbName);
  if (existing) { existing.lastUsed = Date.now(); return existing.client; }
  // Never evict a pool leased by a request or job. Bound the process-wide
  // connection budget; callers can retry when idle tenant pools expire.
  const now = Date.now();
  for (const [name, entry] of orgPools) {
    if (!entry.leases && now - entry.lastUsed >= databaseSecurity.tenantPoolIdleMs) {
      orgPools.delete(name);
      void entry.client.end({ timeout: 2 }).catch(() => {});
    }
  }
  if (orgPools.size >= databaseSecurity.maxTenantPools) throw new Error("Tenant database capacity reached; retry shortly");
  const pool = postgres(tenantDbUrl(dbName), {
    max: 3,
    idle_timeout: 60,
    connect_timeout: 2,
    onnotice: () => {},
    connection: { statement_timeout: 30_000, idle_in_transaction_session_timeout: 30_000 },
  });
  orgPools.set(dbName, { client: pool, lastUsed: now, leases: 0 });
  return pool;
}

export async function usingOrgPool<T>(dbName: string, fn: (client: postgres.Sql) => Promise<T>): Promise<T> {
  const client = poolFor(dbName);
  const entry = orgPools.get(dbName);
  if (entry) entry.leases++;
  try { return await fn(client); }
  finally { if (entry) { entry.leases--; entry.lastUsed = Date.now(); } }
}

export async function closeOrgPool(dbName: string): Promise<void> {
  if (dbName === "engram_gateway") return;
  const pool = orgPools.get(dbName);
  if (!pool) return;
  orgPools.delete(dbName);
  await pool.client.end({ timeout: 1 }).catch(() => {});
}

export function adminSql(): postgres.Sql {
  return postgres(provisionerDbUrl("postgres"), { max: 1, onnotice: () => {} });
}

export function assertBrainDbName(name: string): string {
  if (name !== "brain_shared" && !/^brain_org_\d+$/.test(name)) {
    throw new Error(`invalid brain database name: ${name}`);
  }
  return name;
}

export async function ensureDatabase(dbName: string): Promise<void> {
  const safe = assertBrainDbName(dbName);
  if (databaseSecurity.authority === "runtime") return assertTenantDatabaseReady(safe);
  if (!databaseSecurity.legacy) return provisionTenantDatabase(safe);
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

export async function migrateTenantDataTables(dbName: string): Promise<void> {
  assertBrainDbName(dbName);
  const tenant = postgres(tenantDbUrl(dbName), { max: 1, onnotice: () => {} });
  try { await migrateOrgDataTables(tenant); } finally { await tenant.end({ timeout: 2 }); }
}

export async function migrate() {
  if (databaseSecurity.authority === "runtime") return assertRuntimeSchema(requestSql);
  await prepareGatewayDatabase();
  // Never give DDL/admin authority to the request pool or a memory subprocess.
  const sql = databaseSecurity.legacy ? postgres(dbUrl("engram_gateway"), { max: 1, onnotice: () => {} }) : provisionerPool("engram_gateway");
  try {
  await sql`SELECT pg_advisory_lock(hashtextextended('engram/gateway-schema/v1', 0))`;
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
  await ensureProvisioningSchema(sql);

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

  // An append-only ledger for actions reported by connected agents. Server audit
  // records remain in audit_log and are read alongside these with their own evidence.
  await sql`
    CREATE TABLE IF NOT EXISTS action_events (
      id          text PRIMARY KEY,
      org_id      int NOT NULL REFERENCES orgs(id),
      agent       text NOT NULL,
      tool        text NOT NULL,
      summary     text NOT NULL,
      resource    text,
      status      text NOT NULL CHECK (status IN ('completed', 'failed', 'running')),
      evidence    text NOT NULL CHECK (evidence = 'reported'),
      run_id      text,
      occurred_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      detail      text
    )`;
  await sql`CREATE INDEX IF NOT EXISTS action_events_org_time_idx ON action_events (org_id, occurred_at DESC, recorded_at DESC, id DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS action_events_org_agent_idx ON action_events (org_id, agent)`;
  await sql`CREATE INDEX IF NOT EXISTS action_events_org_run_idx ON action_events (org_id, run_id) WHERE run_id IS NOT NULL`;
  // Lifecycle reports remain immutable events. Optional client keys project one
  // logical action and deduplicate delivery retries within an authenticated agent.
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS action_key text`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS event_id text`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS payload_fingerprint text`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS approach text CHECK (approach IS NULL OR char_length(approach) <= 1000)`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS task_title text CHECK (task_title IS NULL OR char_length(task_title) <= 300)`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS outcome text CHECK (outcome IS NULL OR char_length(outcome) <= 2000)`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS current_step text CHECK (current_step IS NULL OR char_length(current_step) <= 500)`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS harness text CHECK (harness IS NULL OR harness ~ '^[a-z0-9][a-z0-9._-]{0,79}$')`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS source_label text CHECK (source_label IS NULL OR char_length(source_label) <= 100)`;
  await sql`ALTER TABLE action_events ADD COLUMN IF NOT EXISTS source_kind text CHECK (source_kind IS NULL OR source_kind IN ('registered', 'reported'))`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS action_events_org_agent_event_idx ON action_events (org_id, agent, event_id) WHERE event_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS action_events_lifecycle_idx ON action_events (org_id, agent, action_key, occurred_at DESC, recorded_at DESC, id DESC) WHERE action_key IS NOT NULL`;

  // Billing identity is bound to an authenticated workspace on the server. No
  // activity, memory, token, or transcript content is sent to the payment service.
  await sql`
    CREATE TABLE IF NOT EXISTS workspace_billing (
      org_id                  int PRIMARY KEY REFERENCES orgs(id),
      trial_ends_at           timestamptz NOT NULL,
      stripe_customer_id      text UNIQUE,
      stripe_subscription_id  text UNIQUE,
      plan_id                 text,
      status                  text NOT NULL DEFAULT 'trial',
      current_period_ends_at  timestamptz,
      cancel_at_period_end    boolean NOT NULL DEFAULT false,
      checkout_session_id     text,
      checkout_url            text,
      checkout_expires_at     timestamptz,
      checkout_generation     integer NOT NULL DEFAULT 0,
      updated_at              timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      id           text PRIMARY KEY,
      event_type   text NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now()
    )`;

  // A workspace is private until its owner explicitly publishes an aggregate
  // activity profile. Slug uniqueness also prevents one workspace impersonating another.
  await sql`
    CREATE TABLE IF NOT EXISTS action_profiles (
      org_id       int PRIMARY KEY REFERENCES orgs(id),
      slug         text UNIQUE NOT NULL CHECK (length(slug) BETWEEN 3 AND 48 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 80),
      bio          text NOT NULL DEFAULT '' CHECK (length(bio) <= 160),
      published    boolean NOT NULL DEFAULT false,
      show_activity boolean NOT NULL DEFAULT false,
      layout       text NOT NULL DEFAULT 'studio',
      highlights   jsonb NOT NULL DEFAULT '[]'::jsonb,
      photo_png    bytea,
      photo_digest text,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`ALTER TABLE action_profiles ADD COLUMN IF NOT EXISTS show_activity boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE action_profiles ADD COLUMN IF NOT EXISTS layout text NOT NULL DEFAULT 'studio'`;
  await sql`ALTER TABLE action_profiles ADD COLUMN IF NOT EXISTS highlights jsonb NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE action_profiles ADD COLUMN IF NOT EXISTS photo_png bytea`;
  await sql`ALTER TABLE action_profiles ADD COLUMN IF NOT EXISTS photo_digest text`;
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_profiles_photo_valid' AND conrelid = 'action_profiles'::regclass) THEN
        ALTER TABLE action_profiles ADD CONSTRAINT action_profiles_photo_valid CHECK (
          (photo_png IS NULL AND photo_digest IS NULL) OR
          (photo_png IS NOT NULL AND octet_length(photo_png) BETWEEN 57 AND 524288 AND photo_digest IS NOT NULL AND photo_digest ~ '^[a-f0-9]{64}$')
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_profiles_layout_valid' AND conrelid = 'action_profiles'::regclass) THEN
        ALTER TABLE action_profiles ADD CONSTRAINT action_profiles_layout_valid CHECK (layout IN ('studio', 'field-notes'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_profiles_highlights_valid' AND conrelid = 'action_profiles'::regclass) THEN
        ALTER TABLE action_profiles ADD CONSTRAINT action_profiles_highlights_valid
          CHECK (jsonb_typeof(highlights) = 'array' AND jsonb_array_length(highlights) <= 3);
      END IF;
    END $$`;

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

  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS harness text CHECK (harness IS NULL OR harness ~ '^[a-z0-9][a-z0-9._-]{0,79}$')`;
  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS source_label text CHECK (source_label IS NULL OR char_length(source_label) <= 100)`;
  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS issuer_kind text NOT NULL DEFAULT 'legacy'`;
  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS issued_by_email text`;
  await sql`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS issued_by_member_id int`;
  await sql`CREATE INDEX IF NOT EXISTS tokens_issuer_idx ON tokens (org_id, issued_by_email) WHERE revoked_at IS NULL`;
  // Historical credentials cannot be attributed safely. Explicit legacy mode
  // preserves them; strict upgrades require reissuing and linking credentials.
  if (!databaseSecurity.legacy) await sql`UPDATE tokens SET revoked_at = now() WHERE issuer_kind = 'legacy' AND revoked_at IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS tokens_active_secret_idx ON tokens (sha256_hash) WHERE revoked_at IS NULL`;
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tokens_issuer_valid') THEN
        ALTER TABLE tokens ADD CONSTRAINT tokens_issuer_valid CHECK (
          issuer_kind IN ('legacy', 'operator', 'member') AND
          (issuer_kind <> 'member' OR (issued_by_email IS NOT NULL AND issued_by_member_id IS NOT NULL)));
      END IF;
    END $$`;

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
  await sql`ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS membership_id bigint`;
  await sql`ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS membership_id bigint`;
  await ensureConnectionsSchema(sql);
  await ensureConnectionClientSchema(sql);
  await ensureMemoryUsageSchema(sql);
  await ensureInsightSchema(sql);
  await ensureComplimentaryAccessSchema(sql);
  await ensureHostedSignupInvitesSchema(sql);
  await ensureMailSeriesSchema(sql);
  await ensureJevSchema(sql);
  await ensureContextSharingSchema(sql);
  await ensureSiteAnalyticsSchema(sql);
  await protectGatewayMetadata(sql);
  await markSchemaReady(sql);
  if (databaseSecurity.authority === "inline") {
    const workspaces = await sql`SELECT id, brain_db, data_db, home_dir FROM orgs WHERE brain_db != 'pending' AND data_db != 'pending'`;
    for (const workspace of workspaces) {
      const id = Number(workspace.id);
      const expectedBrain = id === 1 ? config.brainDb : `brain_org_${id}`;
      const expectedData = id === 1 ? "engram_gateway" : expectedBrain;
      const expectedHome = id === 1 ? "brain" : `org-${id}`;
      if (!Number.isSafeInteger(id) || id < 1 || workspace.brain_db !== expectedBrain || workspace.data_db !== expectedData || workspace.home_dir !== expectedHome) throw new Error("Invalid workspace storage binding during migration");
      await ensureDatabase(String(workspace.brain_db));
      if (workspace.data_db !== "engram_gateway") {
        // Provisioning many tenants must not pin all of them in request pools.
        await migrateTenantDataTables(String(workspace.data_db));
      }
      await sql`UPDATE orgs SET provisioning_status = 'ready', provisioned_at = now(), provisioning_error_code = NULL WHERE id = ${id}`;
    }
  }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtextextended('engram/gateway-schema/v1', 0))`.catch(() => {});
    await sql.end({ timeout: 2 });
  }
}
