// All deployment knobs in one place. ENGRAM_DB_URL_TEMPLATE is the runtime URL,
// a Postgres URL containing the literal __DB__ where the database name goes, e.g.
//   postgresql://postgres:pw@localhost:5544/__DB__
//   postgresql://engram:pw@/__DB__?host=/cloudsql/ani-hq:us-central1:engram-pg
const template = process.env.ENGRAM_DB_URL_TEMPLATE;
if (!template || !template.includes("__DB__")) {
  throw new Error("ENGRAM_DB_URL_TEMPLATE must be set and contain __DB__");
}

export function dbUrl(dbName: string): string {
  return template!.replace("__DB__", dbName);
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function secretValue(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return !value || value === "unset" ? "" : value;
}

const deploymentMode = process.env.ENGRAM_DEPLOYMENT_MODE ?? "self-hosted";
if (deploymentMode !== "hosted" && deploymentMode !== "self-hosted") {
  throw new Error("ENGRAM_DEPLOYMENT_MODE must be hosted or self-hosted");
}

// The compatibility path is an explicit operator decision, never the hosted
// default. Provisioning credentials are used only by the parent gateway.
const legacyDatabaseCredentials = deploymentMode === "self-hosted" && process.env.ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS === "1";
const databaseAuthority = process.env.ENGRAM_DATABASE_AUTHORITY ?? (deploymentMode === "hosted" ? "runtime" : "inline");
if (!["runtime", "provisioner", "inline"].includes(databaseAuthority) || (deploymentMode === "hosted" && databaseAuthority === "inline")) throw new Error("Invalid database authority for deployment mode");
if (legacyDatabaseCredentials && databaseAuthority !== "inline") throw new Error("Legacy database credentials require self-hosted inline authority");
const provisionerTemplate = process.env.ENGRAM_PROVISIONER_DB_URL_TEMPLATE;
const tenantCredentialKey = secretValue(process.env.ENGRAM_TENANT_CREDENTIAL_KEY);
function templateUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Invalid PostgreSQL URL template"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.pathname !== "/__DB__" || parsed.hash ||
      ["user", "username", "password", "database", "dbname"].some(key => parsed.searchParams.has(key))) {
    throw new Error("PostgreSQL templates require /__DB__ and credentials in URL userinfo");
  }
  return parsed;
}
const runtimeTemplateUrl = templateUrl(template!);
if (!legacyDatabaseCredentials) {
  if (Buffer.byteLength(tenantCredentialKey) < 32) throw new Error("ENGRAM_TENANT_CREDENTIAL_KEY must contain at least 32 bytes");
  const runtime = runtimeTemplateUrl;
  if (!runtime.username) throw new Error("Gateway runtime PostgreSQL role required");
  if (databaseAuthority === "runtime") {
    if (provisionerTemplate) throw new Error("Runtime database authority must not receive a provisioner credential");
  } else {
    if (!provisionerTemplate?.includes("__DB__")) throw new Error("ENGRAM_PROVISIONER_DB_URL_TEMPLATE must contain __DB__; legacy credentials require an explicit self-hosted compatibility option");
    const provisioner = templateUrl(provisionerTemplate);
    if (decodeURIComponent(runtime.username) === decodeURIComponent(provisioner.username)) throw new Error("Gateway runtime and provisioner must use different PostgreSQL roles");
    if (runtime.hostname !== provisioner.hostname || (runtime.port || "5432") !== (provisioner.port || "5432") || runtime.searchParams.get("host") !== provisioner.searchParams.get("host")) throw new Error("Runtime and provisioner must address the same PostgreSQL endpoint");
  }
  if (deploymentMode === "hosted" && !runtime.password) throw new Error("Hosted gateway runtime requires a PostgreSQL password");
}

export function provisionerDbUrl(dbName: string): string {
  if (databaseAuthority === "runtime") throw new Error("Provisioning is unavailable to the runtime identity");
  return (provisionerTemplate ?? template!).replace("__DB__", dbName);
}

export const databaseSecurity = {
  legacy: legacyDatabaseCredentials,
  authority: databaseAuthority as "runtime" | "provisioner" | "inline",
  runtimeRole: decodeURIComponent(runtimeTemplateUrl.username),
  tenantCredentialKey,
  workerUrlTemplate: process.env.ENGRAM_WORKER_DB_URL_TEMPLATE ?? "",
  maxTenantPools: Math.max(1, Math.min(128, Math.floor(envNumber("ENGRAM_MAX_TENANT_DB_POOLS", 32)))),
  tenantPoolIdleMs: envNumber("ENGRAM_TENANT_DB_POOL_IDLE_MS", 10 * 60_000),
  tenantConnectionLimit: Math.max(4, Math.min(64, Math.floor(envNumber("ENGRAM_TENANT_DB_CONNECTION_LIMIT", 12)))),
};
if (databaseSecurity.workerUrlTemplate && !databaseSecurity.workerUrlTemplate.includes("__DB__")) {
  throw new Error("ENGRAM_WORKER_DB_URL_TEMPLATE must contain __DB__");
}
if (databaseSecurity.workerUrlTemplate) templateUrl(databaseSecurity.workerUrlTemplate);

export const config = {
  // A self-hosted install never contacts a billing service or requires a licence.
  deploymentMode,
  port: Number(process.env.PORT ?? 8080),
  brainDb: process.env.ENGRAM_BRAIN_DB ?? "brain_shared",
  gbrainBin: process.env.GBRAIN_BIN ?? `${process.env.HOME}/.bun/bin/gbrain`,
  gbrainHomesDir: process.env.GBRAIN_HOMES_DIR ?? "/gbrain-homes",
  publicUrl: (process.env.ENGRAM_PUBLIC_URL ?? "").replace(/\/$/, ""),
  billing: {
    secretKey: secretValue(process.env.STRIPE_SECRET_KEY),
    webhookSecret: secretValue(process.env.STRIPE_WEBHOOK_SECRET),
    cloudMonthlyPriceId: secretValue(process.env.STRIPE_CLOUD_MONTHLY_PRICE_ID),
    portalConfigurationId: secretValue(process.env.STRIPE_PORTAL_CONFIGURATION_ID),
  },
  brainIdleMs: envNumber("ENGRAM_BRAIN_IDLE_MS", 10 * 60 * 1000),
  reflex: {
    apiKey: secretValue(process.env.REFLEX_API_KEY ?? process.env.TYPESAFE_API_KEY),
    model: (process.env.REFLEX_MODEL ?? process.env.TYPESAFE_MODEL ?? "jev-1.13.0").trim(),
    endpoint: (process.env.REFLEX_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone").trim(),
    timeoutMs: envNumber("REFLEX_TIMEOUT_MS", envNumber("JEV_TIMEOUT_MS", 15_000)),
    concurrency: envNumber("REFLEX_CONCURRENCY", envNumber("JEV_CONCURRENCY", 8)),
    minConfidence: Number(process.env.REFLEX_MIN_CONFIDENCE ?? process.env.JEV_MIN_CONFIDENCE ?? 0.55),
    writeStrict: process.env.REFLEX_WRITE_STRICT === "1",
  },
  voyage: {
    apiKey: secretValue(process.env.VOYAGE_API_KEY),
    model: (process.env.ENGRAM_EMBEDDING_MODEL ?? "voyage:voyage-4-large").trim(),
    dimensions: envNumber("ENGRAM_EMBEDDING_DIMENSIONS", 1024),
  },
  insights: {
    concurrency: Math.floor(Math.min(4, envNumber("ENGRAM_INSIGHT_CONCURRENCY", 2))),
    dailyProviderCalls: Math.floor(Math.min(1000, envNumber("ENGRAM_INSIGHT_DAILY_PROVIDER_CALLS", 24))),
    timeoutMs: Math.min(15_000, envNumber("ENGRAM_INSIGHT_TIMEOUT_MS", 6_000)),
    // Explicit provider configuration is required; an unrelated server key is
    // never automatically reused for tenant briefs.
    briefApiKey: secretValue(process.env.ENGRAM_BRIEF_API_KEY),
    briefModel: (process.env.ENGRAM_BRIEF_MODEL ?? "").trim(),
  },
  oauth: {
    issuer: (process.env.ENGRAM_OAUTH_ISSUER ?? "").trim(),
    audience: (process.env.ENGRAM_OAUTH_AUDIENCE ?? "").trim(),
    jwksUrl: (process.env.ENGRAM_OAUTH_JWKS_URL ?? "").trim(),
  },
  mail: {
    apiKey: secretValue(process.env.RESEND_API_KEY),
    from: (process.env.ENGRAM_MAIL_FROM ?? "engram@updates.ani.computer").trim(),
  },
};
