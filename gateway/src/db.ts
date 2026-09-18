import postgres from "postgres";
import { dbUrl } from "./config";

export const sql = postgres(dbUrl("engram_gateway"), {
  max: 5,
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
}
