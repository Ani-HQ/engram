import { createHmac, createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { failureCode } from "./diagnostics";
import { sql } from "./db";
import { sha256 } from "./hash";
import { issueToken, type TokenRecord } from "./auth";
import { normalizeEmail, publicUrlFrom, type Org } from "./orgs";
import { isHuman } from "./policies";
import { clientAddress } from "./site-analytics";

// Browser-approved installer sign-in, in the spirit of RFC 8628. The terminal
// starts a request and polls with a secret device code. A signed-in person
// checks the short user code and approves it for their selected workspace.
// Access keys are issued only once, when the approved request is collected.

export const DEVICE_AGENT_LABELS = Object.freeze({ "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const);
export type DeviceHarness = keyof typeof DEVICE_AGENT_LABELS;
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 3;
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_START_LIMIT = 10;
export const DEVICE_START_WINDOW_MINUTES = 10;
// A ceiling across all clients bounds the table even if addresses are spoofed.
export const DEVICE_START_GLOBAL_LIMIT = 1000;
const TOKEN_NAME_LIMIT = 100;
const MAX_BODY = 4096;
// Allow a little network jitter before asking a client to slow down.
const POLL_TOLERANCE_MS = 500;

export type DeviceAgent = { harness: DeviceHarness; label: string | null };
export type DeviceStart = { device: string; agents: DeviceAgent[] };
export type DeviceStatus = "pending" | "approved" | "denied" | "consumed" | "expired";
export type DeviceRow = {
  id: number; status: "pending" | "approved" | "denied" | "consumed"; device: string; agents: DeviceAgent[];
  userCode: string; orgId: number | null; decidedByEmail: string | null; createdAt: Date; expiresAt: Date; lastPolledAt: Date | null;
};

export class DeviceAuthError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/;

function printable(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !PRINTABLE.test(value)) return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed && trimmed.length <= max ? trimmed : null;
}

export function parseDeviceStart(body: unknown): DeviceStart | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const device = printable(input.device, 80);
  if (!device || !Array.isArray(input.agents) || input.agents.length < 1 || input.agents.length > 6) return null;
  const agents: DeviceAgent[] = [];
  for (const raw of input.agents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { harness, label } = raw as Record<string, unknown>;
    if (typeof harness !== "string" || !Object.hasOwn(DEVICE_AGENT_LABELS, harness)) return null;
    if (agents.some(agent => agent.harness === harness)) return null;
    let parsedLabel: string | null = null;
    if (label !== undefined && label !== null && !(typeof label === "string" && !label.trim())) {
      parsedLabel = printable(label, 80);
      if (!parsedLabel) return null;
    }
    agents.push({ harness: harness as DeviceHarness, label: parsedLabel });
  }
  return { device, agents };
}

export function parseDeviceCode(body: unknown): string | null {
  const value = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).deviceCode : null;
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** Uniform 8-character code from an alphabet without vowels or look-alikes. */
export function generateUserCode(random: (size: number) => Uint8Array = randomBytes): string {
  let code = "";
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  while (code.length < 8) {
    for (const byte of random(16)) {
      if (byte >= limit) continue;
      code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (code.length === 8) break;
    }
  }
  return code;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Case-insensitive and hyphen/space-optional. Returns the stored 8-character form. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every(char => USER_CODE_ALPHABET.includes(char)) ? code : null;
}

export function deviceTokenName(harness: DeviceHarness, device: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = `${DEVICE_AGENT_LABELS[harness]} on ${device}`;
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const name = `${base.slice(0, TOKEN_NAME_LIMIT - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(name)) return name;
  }
  throw new Error("no available connection name");
}

/** The state a client should see, without side effects. */
export function deviceStatus(row: Pick<DeviceRow, "status" | "expiresAt">, now: Date): DeviceStatus {
  if (row.status === "denied" || row.status === "consumed") return row.status;
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : row.status;
}

export function pollTooFast(lastPolledAt: Date | null, now: Date, interval = DEVICE_POLL_INTERVAL_SECONDS): boolean {
  return Boolean(lastPolledAt) && now.getTime() - lastPolledAt!.getTime() < interval * 1000 - POLL_TOLERANCE_MS;
}

export function clientHash(req: Request, secret = process.env.ENGRAM_TENANT_CREDENTIAL_KEY ?? "engram"): string {
  return createHmac("sha256", createHash("sha256").update(`engram-device-auth\n${secret}`).digest()).update(clientAddress(req)).digest("hex").slice(0, 32);
}

function parseAgents(value: unknown): DeviceAgent[] {
  const list = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(list) ? list.filter(agent => agent && Object.hasOwn(DEVICE_AGENT_LABELS, agent.harness)).map(agent => ({ harness: agent.harness, label: typeof agent.label === "string" ? agent.label : null })) : [];
}

function toRow(row: any): DeviceRow {
  return {
    id: Number(row.id), status: row.status, device: String(row.device), agents: parseAgents(row.agents), userCode: String(row.user_code),
    orgId: row.org_id === null || row.org_id === undefined ? null : Number(row.org_id), decidedByEmail: row.decided_by_email ? String(row.decided_by_email) : null,
    createdAt: new Date(row.created_at), expiresAt: new Date(row.expires_at), lastPolledAt: row.last_polled_at ? new Date(row.last_polled_at) : null,
  };
}

export interface DeviceDeps { db?: postgres.Sql; now?: () => Date; secret?: string }

export async function startDeviceAuthorization(input: DeviceStart, client: string, publicUrl: string, deps: DeviceDeps = {}) {
  const db = deps.db ?? sql, now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - DEVICE_START_WINDOW_MINUTES * 60_000);
  // Opportunistic pruning keeps the table small; rows are useless after expiry.
  await db`DELETE FROM device_authorizations WHERE created_at < ${new Date(now.getTime() - 86_400_000)}`;
  const [counts] = await db`
    SELECT count(*) FILTER (WHERE client_hash = ${client})::int AS client, count(*)::int AS total
    FROM device_authorizations WHERE created_at > ${since}`;
  if (Number(counts?.client) >= DEVICE_START_LIMIT || Number(counts?.total) >= DEVICE_START_GLOBAL_LIMIT) {
    throw new DeviceAuthError("Too many sign-in requests. Please wait a few minutes and try again.", 429, "rate_limited");
  }
  const deviceCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    const rows = await db`
      INSERT INTO device_authorizations (device_code_hash, user_code, device, agents, client_hash, created_at, expires_at)
      VALUES (${sha256(deviceCode)}, ${userCode}, ${input.device}, ${db.json(input.agents)}, ${client}, ${now}, ${expiresAt})
      ON CONFLICT (user_code) DO NOTHING RETURNING id`;
    if (!rows.length) continue;
    const base = publicUrl.replace(/\/$/, ""), shown = formatUserCode(userCode);
    return {
      deviceCode, userCode: shown,
      verificationUri: `${base}/app#device`, verificationUriComplete: `${base}/app#device=${shown}`,
      expiresIn: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS,
    };
  }
  throw new Error("could not allocate a user code");
}

export type PollResult =
  | { status: "pending" | "slow_down" | "denied" | "expired" | "consumed" }
  | { status: "approved"; host: string; mcp: string; workspace: { id: number; name: string }; tokens: { harness: DeviceHarness; name: string; token: string }[] };

export async function pollDeviceAuthorization(deviceCode: string, publicUrl: string, deps: DeviceDeps = {}): Promise<PollResult> {
  const db = deps.db ?? sql, now = deps.now?.() ?? new Date();
  return db.begin(async tx => {
    const rows = await tx`SELECT * FROM device_authorizations WHERE device_code_hash = ${sha256(deviceCode)} FOR UPDATE`;
    // An unknown code looks expired, so polling never reveals which codes exist.
    if (!rows.length) return { status: "expired" as const };
    const row = toRow(rows[0]);
    const status = deviceStatus(row, now);
    if (status === "pending") {
      const tooFast = pollTooFast(row.lastPolledAt, now);
      await tx`UPDATE device_authorizations SET last_polled_at = ${now} WHERE id = ${row.id}`;
      return { status: tooFast ? "slow_down" as const : "pending" as const };
    }
    if (status !== "approved") return { status };
    const org = row.orgId ? (await tx`SELECT id, name FROM orgs WHERE id = ${row.orgId}`)[0] : null;
    const email = row.decidedByEmail ? normalizeEmail(row.decidedByEmail) : null;
    let tokens: { harness: DeviceHarness; name: string; token: string }[] = [];
    try {
      if (!org || !email) throw new Error("approval is incomplete");
      tokens = await tx.savepoint(async sp => {
        const taken = new Set((await sp`SELECT name FROM tokens WHERE org_id = ${row.orgId}`).map(item => String(item.name)));
        const issued = [];
        for (const agent of row.agents) {
          const name = deviceTokenName(agent.harness, row.device, taken);
          taken.add(name);
          // issueToken re-checks, under a row lock, that the approver is still a member.
          const token = await issueToken(row.orgId!, name, true, email, sp as unknown as postgres.Sql, { harness: agent.harness, label: agent.label });
          issued.push({ harness: agent.harness, name, token });
        }
        return issued;
      });
    } catch (error) {
      // Approval no longer holds (for example, the approver left the workspace).
      console.error("[device] key issue failed:", failureCode(error));
      await tx`UPDATE device_authorizations SET status = 'denied', decided_at = ${now} WHERE id = ${row.id}`;
      return { status: "denied" as const };
    }
    await tx`UPDATE device_authorizations SET status = 'consumed', consumed_at = ${now}, last_polled_at = ${now} WHERE id = ${row.id}`;
    const host = publicUrl.replace(/\/$/, "");
    return { status: "approved" as const, host, mcp: `${host}/mcp`, workspace: { id: Number(org.id), name: String(org.name) }, tokens };
  }) as Promise<PollResult>;
}

export function publicDeviceRequest(row: DeviceRow, now: Date) {
  return {
    userCode: formatUserCode(row.userCode), device: row.device,
    agents: row.agents.map(agent => ({ harness: agent.harness, label: agent.label ?? DEVICE_AGENT_LABELS[agent.harness] })),
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), status: deviceStatus(row, now),
  };
}

export async function getDeviceRequest(userCode: string, deps: DeviceDeps = {}) {
  const db = deps.db ?? sql, now = deps.now?.() ?? new Date();
  const rows = await db`SELECT * FROM device_authorizations WHERE user_code = ${userCode}`;
  return rows.length ? publicDeviceRequest(toRow(rows[0]), now) : null;
}

async function decide(userCode: string, decision: "approved" | "denied", email: string, orgId: number | null, deps: DeviceDeps) {
  const db = deps.db ?? sql, now = deps.now?.() ?? new Date();
  const updated = await db`
    UPDATE device_authorizations SET status = ${decision}, org_id = ${orgId}, decided_by_email = ${email}, decided_at = ${now}
    WHERE user_code = ${userCode} AND status = 'pending' AND expires_at > ${now} RETURNING id`;
  if (updated.length) return;
  const rows = await db`SELECT status, expires_at FROM device_authorizations WHERE user_code = ${userCode}`;
  if (!rows.length) throw new DeviceAuthError("This code was not found. Check the code in your terminal and try again.", 404, "not_found");
  const status = deviceStatus({ status: rows[0].status, expiresAt: new Date(rows[0].expires_at) }, now);
  const messages: Record<string, string> = {
    expired: "This code has expired. Run the command again in your terminal for a new code.",
    denied: "This request was denied. Run the command again in your terminal to start over.",
    approved: "This request is already approved. Return to your terminal.",
    consumed: "This computer is already connected. Return to your terminal.",
  };
  throw new DeviceAuthError(messages[status] ?? "This request can no longer be changed.", 409, status);
}

export function isConsolePerson(token: TokenRecord): boolean {
  return isHuman(token) && token.kind !== "oauth";
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  try { const text = await req.text(); return text.length > MAX_BODY ? null : JSON.parse(text); } catch { return null; }
}

/** POST /api/device/start and /api/device/poll. Unauthenticated; no cookies are read. */
export async function handlePublicDeviceApi(req: Request, url: URL, deps: DeviceDeps = {}): Promise<Response | null> {
  if (url.pathname !== "/api/device/start" && url.pathname !== "/api/device/poll") return null;
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { Allow: "POST", "Content-Type": "application/json", "Cache-Control": "no-store" } });
  try {
    if (url.pathname === "/api/device/start") {
      const input = parseDeviceStart(await readJson(req));
      if (!input) return json({ error: "bad_request", message: "Provide a computer name and one to six supported agents." }, 400);
      return json(await startDeviceAuthorization(input, clientHash(req, deps.secret), publicUrlFrom(req), deps));
    }
    const deviceCode = parseDeviceCode(await readJson(req));
    if (!deviceCode) return json({ error: "bad_request" }, 400);
    return json(await pollDeviceAuthorization(deviceCode, publicUrlFrom(req), deps));
  } catch (error) {
    if (error instanceof DeviceAuthError) return json({ error: error.code, message: error.message }, error.status);
    console.error("[device] request failed:", failureCode(error));
    return json({ error: "unavailable", message: "Sign-in is temporarily unavailable. Please try again." }, 503);
  }
}

export function isDeviceConsolePath(pathname: string): boolean {
  return pathname === "/api/device" || pathname === "/api/device/approve" || pathname === "/api/device/deny";
}

/** Console routes. The caller has authenticated the session cookie, checked the
 * console CSRF header and the workspace pin, and applied hosted write gating. */
export async function handleDeviceConsoleApi(req: Request, url: URL, token: TokenRecord, org: Org, deps: DeviceDeps = {}): Promise<Response | null> {
  if (!isDeviceConsolePath(url.pathname)) return null;
  if (!isConsolePerson(token) || !token.email) return json({ error: "Sign in with your own account to approve a computer.", code: "forbidden" }, 403);
  try {
    if (url.pathname === "/api/device") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      const code = normalizeUserCode(url.searchParams.get("code"));
      if (!code) return json({ error: "Enter the 8-letter code shown in your terminal.", code: "invalid_code" }, 400);
      const request = await getDeviceRequest(code, deps);
      return request ? json(request) : json({ error: "This code was not found. Check the code in your terminal and try again.", code: "not_found" }, 404);
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await readJson(req);
    const code = normalizeUserCode(body && typeof body === "object" ? (body as Record<string, unknown>).userCode : null);
    if (!code) return json({ error: "Enter the 8-letter code shown in your terminal.", code: "invalid_code" }, 400);
    if (url.pathname === "/api/device/deny") {
      await decide(code, "denied", token.email, null, deps);
      return json({ ok: true });
    }
    // Approval is bound to the workspace the person is looking at.
    if (req.headers.get("x-engram-workspace") !== String(org.id)) return json({ error: "Select a workspace and try again.", code: "workspace_required" }, 400);
    await decide(code, "approved", token.email, org.id, deps);
    return json({ ok: true, workspace: { id: org.id, name: org.name } });
  } catch (error) {
    if (error instanceof DeviceAuthError) return json({ error: error.message, code: error.code }, error.status);
    console.error("[device] console request failed:", failureCode(error));
    return json({ error: "Approval is temporarily unavailable. Please try again." }, 503);
  }
}
