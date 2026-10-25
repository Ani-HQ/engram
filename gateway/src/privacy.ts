import { config, databaseSecurity } from "./config";
import { tenantDbUrl } from "./tenant-db";
import { currentOrg, type ContextOrg } from "./context";
import { requireHostedWriteAccess } from "./billing";
import type { TokenRecord } from "./policies";

type BrainWorkspace = Pick<ContextOrg, "brainDb" | "homeDir"> & Partial<Pick<ContextOrg, "policies">>;

// A provider key on the server is not consent to process every tenant's data.
export function externalAiAllowed(org = currentOrg()): boolean {
  return org?.policies.externalAiProcessing === true;
}

// Jev consent never enables embeddings or generated briefs, and the legacy
// external-AI preference never grants permission to send content to Jev.
export function jevAllowed(org = currentOrg()): boolean {
  return org?.policies.jevProcessing === true;
}

// Reading an expired workspace must not trigger paid external model processing.
// Preserve the saved preference; this copy is effective only for this request.
export async function processingOrg<T extends ContextOrg>(org: T, actor: TokenRecord): Promise<T> {
  if (config.deploymentMode !== "hosted" || (!externalAiAllowed(org) && !jevAllowed(org))) return org;
  try { await requireHostedWriteAccess(actor); return org; }
  catch { return { ...org, policies: { ...org.policies, externalAiProcessing: false, jevProcessing: false } }; }
}

export function brainEnvironment(org: BrainWorkspace, source = process.env): Record<string, string> {
  const home = `${config.gbrainHomesDir}/${org.homeDir}`;
  const env: Record<string, string> = {
    HOME: home,
    GBRAIN_HOME: home,
    GBRAIN_DATABASE_URL: tenantDbUrl(org.brainDb, databaseSecurity.workerUrlTemplate || undefined),
    DO_NOT_TRACK: "1",
  };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "NODE_ENV"]) {
    if (source[key]) env[key] = source[key]!;
  }
  if (org.policies?.externalAiProcessing === true && config.voyage.apiKey) {
    env.VOYAGE_API_KEY = config.voyage.apiKey;
  }
  return env;
}
