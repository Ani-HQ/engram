import type postgres from "postgres";

// Gateway metadata: counts only, no IP address, email or account identity.
export async function ensureSiteAnalyticsSchema(db: postgres.Sql): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS site_events (
      id             bigserial PRIMARY KEY,
      at             timestamptz NOT NULL DEFAULT now(),
      name           text NOT NULL CHECK (name IN ('pageview', 'cta', 'signup_submitted')),
      path           text NOT NULL,
      cta            text,
      referrer_host  text,
      utm_source     text,
      utm_medium     text,
      utm_campaign   text,
      landing_path   text,
      visitor        text NOT NULL
    )`;
  await db`CREATE INDEX IF NOT EXISTS site_events_at_idx ON site_events (at DESC)`;
}
