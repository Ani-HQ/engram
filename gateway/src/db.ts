import postgres from "postgres";
import { dbUrl } from "./config";

export const sql = postgres(dbUrl("engram_gateway"), {
  max: 5,
  connect_timeout: 2,
  onnotice: () => {},
});

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

  await sql`
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
  await sql`CREATE INDEX IF NOT EXISTS memory_entries_slug_idx ON memory_entries (slug)`;
  await sql`CREATE INDEX IF NOT EXISTS memory_entries_status_idx ON memory_entries (status, recorded_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS reflex_decisions (
      id          bigserial PRIMARY KEY,
      entry_id    text REFERENCES memory_entries(id),
      sheet       text NOT NULL,
      payload     jsonb NOT NULL,
      model_ref   text,
      confidence  double precision,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS reflex_decisions_entry_idx ON reflex_decisions (entry_id, sheet, created_at DESC)`;

  await sql`
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

  await sql`
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
  await sql`CREATE INDEX IF NOT EXISTS review_items_state_idx ON review_items (state, created_at DESC)`;
}
