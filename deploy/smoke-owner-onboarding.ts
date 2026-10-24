#!/usr/bin/env bun
// Operator-only, no-email smoke. No gateway startup/migration imports.
import type postgres from "postgres";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { OwnerCheckError, withOperatorDatabase } from "./check-owners";
import { settings as candidateSettings, type CandidateSettings } from "./smoke-candidate";

const ORIGIN = "https://candidate---engram-l4ewh6u7va-uc.a.run.app";
type Checks = Record<string, boolean>;
function requireCheck(value: unknown, code: string): asserts value { if (!value) throw new OwnerCheckError(code); }
function normalizedOwnerEmail(email: string): boolean { return email.length <= 254 && email === email.trim().toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
export interface OwnerOnboardingSettings extends CandidateSettings { ownerEmail: string }
export function ownerOnboardingSettings(args: string[]): OwnerOnboardingSettings {
  const base: string[] = [];
  let ownerEmail = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--owner-email") {
      requireCheck(!ownerEmail && !!args[i + 1] && !args[i + 1].startsWith("--"), "owner_email_required");
      ownerEmail = args[++i];
    } else base.push(args[i]);
  }
  requireCheck(normalizedOwnerEmail(ownerEmail), "normalized_owner_email_required");
  return { ...candidateSettings(base), ownerEmail };
}

export function ownerSmokeState(options: CandidateSettings, now = Date.now()): any {
  let fd: number | undefined;
  try {
    fd = openSync(options.stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    requireCheck(stat.isFile() && stat.nlink === 1 && stat.size <= 65536 && !(stat.mode & 0o022) && stat.uid === process.getuid?.(), "invalid_release_state");
    requireCheck(now - stat.mtimeMs >= -1000 && now - stat.mtimeMs <= 3_600_000, "stale_release_state");
    const state = JSON.parse(readFileSync(fd, "utf8"));
    requireCheck(options.project === "ani-hq" && options.region === "us-central1" && options.instance === "engram-pg" && options.tag === "candidate", "unauthorized_target");
    requireCheck(state.project === options.project && state.region === options.region && state.service === "engram" && state.image === options.image && state.tag === options.tag && state.candidateURL === ORIGIN && /^engram-[a-z0-9-]+$/.test(state.candidateRevision), "release_state_mismatch");
    return state;
  } finally { if (fd !== undefined) closeSync(fd); }
}

async function cloudJson(args: string[], signal: AbortSignal): Promise<any> {
  const child = Bun.spawn(["gcloud", ...args, "--project=ani-hq", "--region=us-central1", "--format=json", "--quiet", "--verbosity=error", "--no-log-http"], {
    env: { ...process.env, CLOUDSDK_CORE_LOG_HTTP: "false", CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true" }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const stop = () => child.kill("SIGKILL"), timer = setTimeout(stop, 45_000);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const [raw, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    requireCheck(!signal.aborted && code === 0 && raw.length <= 1_000_000, "candidate_verification_unavailable");
    return JSON.parse(raw);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}

export async function verifyOwnerCandidate(options: CandidateSettings, signal: AbortSignal): Promise<void> {
  const state = ownerSmokeState(options);
  const service = await cloudJson(["run", "services", "describe", "engram"], signal);
  const tagged = service.status?.traffic?.filter((row: any) => row.tag === "candidate");
  requireCheck(tagged?.length === 1 && tagged[0].revisionName === state.candidateRevision && tagged[0].url === ORIGIN, "candidate_identity_changed");
  const revision = await cloudJson(["run", "revisions", "describe", state.candidateRevision], signal);
  requireCheck(revision.metadata?.name === state.candidateRevision && revision.spec?.containers?.length === 1 && revision.spec.containers[0].image === options.image && revision.status?.conditions?.some((row: any) => row.type === "Ready" && row.status === "True"), "candidate_not_ready");
  requireCheck(ownerSmokeState(options).candidateRevision === state.candidateRevision, "release_state_changed");
}

export function ownerSmokeRequest(path: string, method: string, body: unknown, cookie: string, workspace: string, signal: AbortSignal, transport: typeof httpsRequest = httpsRequest): Promise<{ status: number; setCookie: string | null; data: any }> {
  requireCheck(!signal.aborted, "interrupted");
  requireCheck(method === "GET" && body === undefined && ["/api/me", "/api/billing", "/api/policies", "/api/showcase", "/api/connections"].includes(path), "unauthorized_smoke_route");
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    const finish = (error?: Error, value?: { status: number; setCookie: string | null; data: any }) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", stop);
      error ? reject(error) : resolve(value!);
    };
    const stop = () => { request?.destroy(); finish(new OwnerCheckError("interrupted")); };
    const timer = setTimeout(() => { request?.destroy(); finish(new OwnerCheckError("http_timeout")); }, 25_000);
    try { request = transport({ protocol: "https:", hostname: new URL(ORIGIN).hostname, port: 443, path, method, family: 4, rejectUnauthorized: true, headers: {
      "Accept": "application/json", "Content-Type": "application/json", "X-Engram-Console": "1", "X-Engram-Workspace": workspace, ...(cookie ? { Cookie: cookie } : {}),
    } }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { response.resume(); finish(new OwnerCheckError("http_redirect_refused")); return; }
      let length = 0;
      const chunks: Buffer[] = [];
      response.on("error", () => finish(new OwnerCheckError("http_unavailable")));
      response.on("data", chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 1_000_000) { response.destroy(); request?.destroy(); finish(new OwnerCheckError("response_limit")); return; }
        chunks.push(bytes);
      });
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8"), cookies = response.headers["set-cookie"];
          const setCookie = Array.isArray(cookies) && cookies.length === 1 ? cookies[0] : typeof cookies === "string" ? cookies : null;
          finish(undefined, { status, setCookie, data: text ? JSON.parse(text) : null });
        } catch { finish(new OwnerCheckError("invalid_http_response")); }
      });
    }); } catch { finish(new OwnerCheckError("http_unavailable")); return; }
    request.on("error", () => finish(new OwnerCheckError("http_unavailable")));
    signal.addEventListener("abort", stop, { once: true });
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function ownerReads(raw: string, allowBilling: boolean, signal: AbortSignal, ownerEmail: string, request = ownerSmokeRequest): Promise<Checks> {
  requireCheck(/^ens_[A-Za-z0-9_-]{32}$/.test(raw), "invalid_owner_session");
  // The operator already committed this genuine, email-bound session. Hosted
  // sign-in no longer exchanges arbitrary bearer credentials for browser cookies.
  let cookie = `engram_session=${raw}`;
  const call = (path: string, method = "GET", body?: unknown, workspace = "1") => request(path, method, body, cookie, workspace, signal);
  const checks: Checks = {};
  try {
    const me = await call("/api/me");
    requireCheck(me.status === 200 && me.data.email === ownerEmail && me.data.role === "owner" && me.data.org?.id === 1 && me.data.org.provisioningStatus === "ready", "owner_identity_mismatch");
    requireCheck(typeof me.data.onboarding?.step === "string" && typeof me.data.onboarding.hasToken === "boolean" && typeof me.data.onboarding.hasPage === "boolean", "onboarding_unavailable");
    checks.emailSessionAuthenticated = checks.ownerMatches = checks.workspaceReady = checks.onboardingReadable = true;
    if (allowBilling) {
      const billing = await call("/api/billing");
      requireCheck(billing.status === 200 && billing.data.mode === "hosted" && typeof billing.data.canWrite === "boolean", "billing_unavailable");
      checks.billingReadable = true;
    } else checks.billingSkippedToAvoidProviderRefresh = true;
    const policies = await call("/api/policies");
    requireCheck(policies.status === 200 && policies.data && typeof policies.data === "object", "policies_unavailable");
    checks.policiesReadable = true;
    const showcase = await call("/api/showcase");
    requireCheck(showcase.status === 200 && showcase.data && typeof showcase.data === "object", "showcase_unavailable");
    checks.showcaseReadable = true;
    const inventory = await call("/api/connections");
    requireCheck(inventory.status === 200 && Array.isArray(inventory.data?.connections) && inventory.data.connections.length <= 200 && typeof inventory.data.checkedAt === "string", "connections_unavailable");
    const secretFields = /(?:token|secret|hash|authorization|refresh_token|redirect_uri|code)/i;
    requireCheck(inventory.data.connections.every((row: any) => row && typeof row.agent === "string" && ["token", "oauth"].includes(row.kind) && ["authorized", "expired", "revoked", "membership_removed"].includes(row.status) && Object.keys(row).every(key => !secretFields.test(key))), "unsafe_connections_payload");
    checks.connectionsReadable = checks.connectionsMetadataOnly = true;
    checks.connectionsWorkspacePinned = (await call("/api/connections", "GET", undefined, "invalid-workspace")).status === 409;
    requireCheck(checks.connectionsWorkspacePinned, "connections_workspace_pin_missing");
    checks.staleWorkspaceRejected = (await call("/api/me", "GET", undefined, "invalid-workspace")).status === 409;
    requireCheck(checks.staleWorkspaceRejected, "workspace_pin_missing");
    return checks;
  } finally { cookie = ""; }
}

export async function withOwnerSmokeSession(db: postgres.Sql, ownerEmail: string, read: typeof ownerReads, signal: AbortSignal): Promise<{ ok: boolean; checks: Checks; sessionRevoked: boolean; cleanupRequired: boolean }> {
  requireCheck(normalizedOwnerEmail(ownerEmail), "normalized_owner_email_required");
  const raw = `ens_${randomBytes(24).toString("base64url")}`, hash = createHash("sha256").update(raw).digest("hex"), name = `operator-owner-smoke-${randomUUID()}`;
  let id = 0, attempted = false, revoked = false, checks: Checks = {}, passed = false;
  const lockOwner = async (tx: postgres.Sql) => {
    await tx`SET LOCAL lock_timeout='3s'`;
    const org = (await tx`SELECT id, brain_db, data_db, home_dir, policies, provisioning_status FROM public.orgs WHERE id=1 FOR NO KEY UPDATE`)[0];
    requireCheck(org?.brain_db === "brain_shared" && org.data_db === "engram_gateway" && org.home_dir === "brain" && org.provisioning_status === "ready" && org.policies?.externalAiProcessing !== true, "owner_workspace_unavailable");
    const owner = await tx`SELECT id FROM public.org_members WHERE org_id=1 AND email=${ownerEmail} AND role='owner' FOR NO KEY UPDATE`;
    requireCheck(owner.length === 1 && !signal.aborted, "selected_owner_required");
  };
  try {
    await db.begin(async tx => {
      await lockOwner(tx as unknown as postgres.Sql);
      id = Number((await tx`SELECT nextval(pg_get_serial_sequence('public.sessions','id')) AS id`)[0].id);
      requireCheck(Number.isSafeInteger(id) && id > 0, "session_id_unavailable");
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${name},0))`;
      attempted = true;
      await tx`INSERT INTO public.sessions(id,org_id,name,role,email,sha256_hash,expires_at) VALUES(${id},1,${name},'owner',${ownerEmail},${hash},now()+interval '8 minutes')`;
    });
    await db.begin(async tx => {
      await tx`SET LOCAL idle_in_transaction_session_timeout='180s'`;
      await lockOwner(tx as unknown as postgres.Sql);
      // Billing refresh can call Stripe for existing subscriptions; skip those.
      const binding = await tx`SELECT stripe_customer_id FROM public.workspace_billing WHERE org_id=1`;
      checks = await read(raw, !binding[0]?.stripe_customer_id, signal, ownerEmail);
      requireCheck(!signal.aborted, "interrupted");
    });
    passed = true;
  } catch { passed = false; }
  finally {
    if (attempted) {
      try {
        revoked = await db.begin(async tx => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${name},0))`;
          await tx`UPDATE public.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=${id} AND org_id=1 AND sha256_hash=${hash} AND name=${name}`;
          const result = await tx`SELECT NOT EXISTS(SELECT 1 FROM public.sessions WHERE id=${id} AND org_id=1 AND sha256_hash=${hash} AND name=${name} AND revoked_at IS NULL) AS confirmed`;
          return result[0]?.confirmed === true;
        });
      } catch { revoked = false; }
    }
  }
  return { ok: passed && revoked, checks, sessionRevoked: revoked, cleanupRequired: attempted && !revoked };
}

export async function runOwnerSmoke(options: OwnerOnboardingSettings, signal = new AbortController().signal) {
  requireCheck(options.run, "explicit_execution_required");
  await verifyOwnerCandidate(options, signal);
  // Keep the operator proxy alive through cleanup even if the HTTP run aborts.
  return withOperatorDatabase(options, "write", async db => {
    await verifyOwnerCandidate(options, signal);
    const result = await withOwnerSmokeSession(db, options.ownerEmail, ownerReads, signal);
    result.checks.candidateIdentityVerified = true;
    return result;
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  try {
    const options = ownerOnboardingSettings(process.argv.slice(2));
    ownerSmokeState(options);
    if (!options.run) console.log(JSON.stringify({ plan: true, existingSelectedOwnerOnly: true, candidateVerifiedBeforeTransmission: true, temporarySessionAtMostTenMinutes: true, exactSessionRevocationRequired: true, emailSent: false, providerCalls: false, rawCredentialOutput: false, execution: false }));
    else { const result = await runOwnerSmoke(options, controller.signal); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 2; }
  } catch { console.log(JSON.stringify({ ok: false, checks: {}, sessionRevoked: false, cleanupRequired: false })); process.exitCode = 1; }
}
