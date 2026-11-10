import type postgres from "postgres";

// Additive readiness marker: older revisions can still start after migration.
// Standing share rules expire after 90 days unless the owner renews them.
// Existing rules get 90 days from the migration, not from when they were made,
// so nobody's sharing stops without a reminder first.
export const SHARE_RULE_EXPIRY_SCHEMA_VERSION = 2026111001;
export async function ensureShareRuleExpirySchema(db: postgres.Sql): Promise<void> {
  await db`ALTER TABLE share_rules ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days')`;
  await db`ALTER TABLE share_rules ADD COLUMN IF NOT EXISTS renewal_notified_at timestamptz`;
  await db`CREATE INDEX IF NOT EXISTS share_rules_expiry_idx ON share_rules (expires_at) WHERE revoked_at IS NULL`;
}
