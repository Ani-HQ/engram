import type postgres from "postgres";

// Separate additive readiness leaves older deployed feature contracts intact.
export const CONNECTION_CLIENT_SCHEMA_VERSION = 2026102701;
export async function ensureConnectionClientSchema(db: postgres.Sql): Promise<void> {
  await db`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS client_names jsonb NOT NULL DEFAULT '[]'::jsonb`;
  await db`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tokens_client_names_valid' AND conrelid = 'tokens'::regclass) THEN
      ALTER TABLE tokens ADD CONSTRAINT tokens_client_names_valid CHECK (
        jsonb_typeof(client_names) = 'array' AND jsonb_array_length(client_names) <= 4
        AND octet_length(client_names::text) <= 2048
        AND NOT jsonb_path_exists(client_names, '$[*] ? (@.type() != "string")'));
    END IF;
  END $$`;
}
