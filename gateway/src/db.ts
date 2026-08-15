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
      scope       text,
      arg_summary text,
      outcome     text NOT NULL
    )`;
  await sql`CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC)`;
}
