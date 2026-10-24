import { config } from "./config";

// Only this identity's short-lived, SQL-scoped token reaches a sandbox. It has
// roles/cloudsql.client and no Secret Manager, Run, IAM, or gateway privileges.
// The runtime's metadata token stays in the parent process.
export async function workerConnectorEnvironment(): Promise<Record<string, string>> {
  const instance = process.env.ENGRAM_CLOUDSQL_INSTANCE;
  if (!instance) return {};
  const identity = process.env.ENGRAM_WORKER_CONNECTOR_SERVICE_ACCOUNT;
  if (!identity || !/^[a-z][a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(identity)) throw new Error("A dedicated worker SQL connector identity is required");
  const metadata = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  if (!metadata.ok) throw new Error("Worker connector identity is unavailable");
  const parent = await metadata.json() as { access_token?: string };
  if (!parent.access_token) throw new Error("Worker connector identity is unavailable");
  const response = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(identity)}:generateAccessToken`, {
    method: "POST", headers: { Authorization: `Bearer ${parent.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: ["https://www.googleapis.com/auth/sqlservice.admin"], lifetime: "3600s" }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Worker SQL connector authorization is unavailable");
  const token = await response.json() as { accessToken?: string };
  if (!token.accessToken) throw new Error("Worker SQL connector authorization is unavailable");
  return { ENGRAM_WORKER_CLOUDSQL_INSTANCE: instance, ENGRAM_WORKER_CLOUDSQL_TOKEN: token.accessToken };
}
