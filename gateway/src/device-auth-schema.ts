import type postgres from "postgres";

// Central metadata for browser-approved installer sign-in. Only a hash of the
// secret device code is stored; the short user code is shown in the terminal
// and the browser. The client address is a keyed hash used for rate limiting.
export async function ensureDeviceAuthSchema(db: postgres.Sql): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS device_authorizations (
      id               bigserial PRIMARY KEY,
      device_code_hash text NOT NULL UNIQUE,
      user_code        text NOT NULL UNIQUE CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
      device           text NOT NULL CHECK (char_length(device) BETWEEN 1 AND 80),
      agents           jsonb NOT NULL,
      client_hash      text NOT NULL,
      status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
      org_id           int REFERENCES orgs(id) ON DELETE CASCADE,
      decided_by_email text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      expires_at       timestamptz NOT NULL,
      decided_at       timestamptz,
      consumed_at      timestamptz,
      last_polled_at   timestamptz
    )`;
  await db`CREATE INDEX IF NOT EXISTS device_authorizations_created_idx ON device_authorizations (created_at)`;
  await db`CREATE INDEX IF NOT EXISTS device_authorizations_client_idx ON device_authorizations (client_hash, created_at)`;
}
