import type postgres from "postgres";
import { BILLING_SCHEMA_VERSION } from "./billing-schema";

export const GATEWAY_SCHEMA_VERSION = 2026102202;
export const ACTIVITY_SCHEMA_VERSION = 2026102301;
export async function ensureProvisioningSchema(db: postgres.Sql): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS engram_schema_state (id boolean PRIMARY KEY DEFAULT true CHECK (id), version integer NOT NULL)`;
  await db`ALTER TABLE engram_schema_state ADD COLUMN IF NOT EXISTS activity_version integer`;
  await db`ALTER TABLE engram_schema_state ADD COLUMN IF NOT EXISTS billing_version integer`;
  await db`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS provisioning_status text NOT NULL DEFAULT 'pending'`;
  await db`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS provisioned_at timestamptz`;
  await db`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS provisioning_attempts integer NOT NULL DEFAULT 0`;
  await db`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS provisioning_lease_until timestamptz`;
  await db`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS provisioning_lease_token uuid`;
  await db`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS provisioning_retry_at timestamptz`;
  await db`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS provisioning_error_code text`;
  await db`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_provisioning_status_valid') THEN
        ALTER TABLE orgs ADD CONSTRAINT orgs_provisioning_status_valid
          CHECK (provisioning_status IN ('pending', 'provisioning', 'ready', 'failed'));
      END IF;
    END $$`;
  await db`CREATE INDEX IF NOT EXISTS orgs_provisioning_idx ON orgs (provisioning_status, provisioning_retry_at)`;
}

export async function markSchemaReady(db: postgres.Sql): Promise<void> {
  await db`INSERT INTO engram_schema_state (id, version, activity_version, billing_version) VALUES (true, ${GATEWAY_SCHEMA_VERSION}, ${ACTIVITY_SCHEMA_VERSION}, ${BILLING_SCHEMA_VERSION}) ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, activity_version = EXCLUDED.activity_version, billing_version = EXCLUDED.billing_version`;
}

export async function assertRuntimeSchema(db: postgres.Sql): Promise<void> {
  try {
    const rows = await db`
      SELECT s.version, s.activity_version, s.billing_version, current_user AS role, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS inherits_roles
      FROM engram_schema_state s JOIN pg_roles r ON r.rolname = current_user WHERE s.id = true`;
    const row = rows[0];
    if (!row || row.version !== GATEWAY_SCHEMA_VERSION || row.activity_version !== ACTIVITY_SCHEMA_VERSION || row.billing_version !== BILLING_SCHEMA_VERSION) throw new Error("schema version mismatch");
    if ([row.rolsuper, row.rolcreatedb, row.rolcreaterole, row.rolbypassrls, row.rolreplication, row.inherits_roles].some(Boolean)) throw new Error("runtime role is privileged");
  } catch {
    throw new Error("Gateway database is not ready for restricted runtime; run the separate provisioner job first");
  }
}
