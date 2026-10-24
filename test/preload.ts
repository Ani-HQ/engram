process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";
// Unit tests never provision a database. Explicit compatibility keeps their
// existing fake pools independent of deployment credentials. Hosted subprocess
// tests still receive a dummy derivation key, with no administrator credential.
process.env.ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS ??= "1";
process.env.ENGRAM_TENANT_CREDENTIAL_KEY ??= "engram-unit-only-credential-key-32bytes";
