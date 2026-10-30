import type postgres from "postgres";
import { lockConnection, oauthConnectionId } from "./connection-identity";
import { currentOrg } from "./context";
import { config } from "./config";
import { sql } from "./db";
import { oauthActorName } from "./oauth";
import { isHuman, normalizeToken, type TokenRecord } from "./policies";
import { redactSecrets } from "./redact";
import { normalizeSquarePng, PROFILE_PHOTO_DATA_PREFIX } from "./showcase-photo";

// A connected agent may describe itself with a display name and a logo. These
// are display hints the agent reported, never proof of the product, model or
// person behind a credential. A workspace owner can override, reset or lock them.

export const AGENT_LOGO_SIZES = [64, 128, 256, 512];
export const AGENT_LOGO_STORED = 64;
export const AGENT_NAME_MAX = 60;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const LOGO_HINT = `Logos must be a square PNG data URL (${AGENT_LOGO_SIZES.join(", ")} px, 8-bit RGB or RGBA, up to 512 KB).`;

export class AgentIdentityError extends Error { constructor(message: string, public status = 400) { super(message); } }

export interface AgentIdentity {
  agent: string;
  kind: "token" | "oauth";
  name: string | null;
  logo: string | null;
  source: "agent" | "owner" | null;
  locked: boolean;
  reportedName: string | null;
  reportedLogo: boolean;
  reportedAt: string | null;
  ownerName: string | null;
  ownerLogo: boolean;
}

/** Collapse whitespace, strip controls and secrets, and bound the length. Empty means clear. */
export function cleanAgentName(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new AgentIdentityError("Name must be text");
  const cleaned = redactSecrets(value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim());
  if (!cleaned) return null;
  if ([...cleaned].length > AGENT_NAME_MAX) throw new AgentIdentityError(`Name must be at most ${AGENT_NAME_MAX} characters`);
  return cleaned;
}

/** Re-encode an untrusted PNG data URL into a small canonical PNG. Empty means clear. */
export async function cleanAgentLogo(value: unknown): Promise<Buffer | null> {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new AgentIdentityError(LOGO_HINT);
  try { return (await normalizeSquarePng(value, AGENT_LOGO_SIZES, AGENT_LOGO_STORED)).bytes; }
  catch { throw new AgentIdentityError(LOGO_HINT); }
}

function logoUrl(bytes: unknown): string | null {
  return bytes ? PROFILE_PHOTO_DATA_PREFIX + Buffer.from(bytes as Uint8Array).toString("base64") : null;
}
function date(value: unknown): string | null { if (!value) return null; const parsed = new Date(value as string); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null; }

export function mapAgentIdentity(row: any): AgentIdentity {
  const ownerName = row.owner_name ? String(row.owner_name) : null, reportedName = row.reported_name ? String(row.reported_name) : null;
  const name = ownerName ?? reportedName;
  const logo = logoUrl(row.owner_logo_png) ?? logoUrl(row.reported_logo_png);
  const ownerSet = Boolean(ownerName || row.owner_logo_png);
  return {
    agent: String(row.actor_name), kind: row.actor_kind === "oauth" ? "oauth" : "token",
    name, logo, source: ownerSet ? "owner" : name || logo ? "agent" : null, locked: row.locked === true,
    reportedName, reportedLogo: Boolean(row.reported_logo_png), reportedAt: date(row.reported_at),
    ownerName, ownerLogo: Boolean(row.owner_logo_png),
  };
}

/** MCP set_identity: the calling agent describes itself. Owner choices win and a lock refuses changes. */
export async function setAgentIdentity(token: TokenRecord, args: Record<string, unknown>, db: postgres.Sql = sql) {
  const actor = normalizeToken(token);
  if (actor.kind !== "token" && actor.kind !== "oauth") throw new AgentIdentityError("Only a connected agent can describe itself.", 403);
  const hasName = Object.hasOwn(args ?? {}, "name"), hasLogo = Object.hasOwn(args ?? {}, "logo");
  if (!hasName && !hasLogo) throw new AgentIdentityError("Pass name, logo or both. Pass an empty string to clear one.");
  const name = hasName ? cleanAgentName(args.name) : undefined;
  const logo = hasLogo ? await cleanAgentLogo(args.logo) : undefined;
  return db.begin(async tx => {
    const [prior] = await tx`SELECT locked FROM agent_identities WHERE org_id = ${actor.orgId} AND actor_kind = ${actor.kind} AND actor_name = ${actor.name} FOR UPDATE`;
    if (prior?.locked) throw new AgentIdentityError("A workspace owner locked this agent's name and logo.", 409);
    const [row] = await tx`
      INSERT INTO agent_identities (org_id, actor_kind, actor_name, reported_name, reported_logo_png, reported_at)
      VALUES (${actor.orgId}, ${actor.kind}, ${actor.name}, ${name ?? null}, ${logo ?? null}, now())
      ON CONFLICT (org_id, actor_kind, actor_name) DO UPDATE SET
        reported_name = CASE WHEN ${hasName} THEN EXCLUDED.reported_name ELSE agent_identities.reported_name END,
        reported_logo_png = CASE WHEN ${hasLogo} THEN EXCLUDED.reported_logo_png ELSE agent_identities.reported_logo_png END,
        reported_at = now(), updated_at = now()
      RETURNING *`;
    const identity = mapAgentIdentity(row);
    return {
      ok: true, name: identity.reportedName, logo: identity.reportedLogo,
      shown: { name: identity.name, logo: Boolean(identity.logo), source: identity.source },
      note: identity.source === "owner" ? "Saved. A workspace owner's choice is shown instead." : "Saved. The Engram app shows it as self-described.",
    };
  });
}

function authorize(token: TokenRecord) {
  const actor = normalizeToken(token), org = currentOrg();
  if (!isHuman(actor) || actor.kind === "oauth" || (org && org.id !== actor.orgId)) throw new AgentIdentityError("forbidden", 403);
  return actor;
}

export async function listAgentIdentities(token: TokenRecord, db: postgres.Sql = sql): Promise<AgentIdentity[]> {
  const actor = authorize(token);
  const rows = await db`SELECT * FROM agent_identities WHERE org_id = ${actor.orgId}
    AND (reported_name IS NOT NULL OR reported_logo_png IS NOT NULL OR owner_name IS NOT NULL OR owner_logo_png IS NOT NULL OR locked)
    ORDER BY updated_at DESC LIMIT 500`;
  return rows.map(mapAgentIdentity);
}

/** Resolve an opaque connection ID to the actor name its calls authenticate as. */
async function connectionActor(tx: postgres.Sql, orgId: number, id: string): Promise<{ kind: "token" | "oauth"; name: string }> {
  if (id.startsWith("token:")) {
    const tokenId = Number(id.slice(6));
    if (tokenId > 2147483647) throw new AgentIdentityError("Choose a valid connection");
    const [row] = await tx`SELECT name FROM tokens WHERE org_id = ${orgId} AND id = ${tokenId} AND left(name, 25) <> 'operator-candidate-smoke-'`;
    if (!row) throw new AgentIdentityError("Connection not found", 404);
    return { kind: "token", name: String(row.name) };
  }
  const rows = await tx`SELECT DISTINCT email, client_id FROM oauth_refresh_tokens WHERE org_id = ${orgId}`;
  const row = rows.find(row => oauthConnectionId(orgId, String(row.email), String(row.client_id)) === id);
  if (!row) throw new AgentIdentityError("Connection not found", 404);
  return { kind: "oauth", name: oauthActorName({ sub: String(row.email), client_id: String(row.client_id) }) };
}

/** Console: an owner renames, replaces the logo, resets or locks one connection's identity. */
export async function updateAgentIdentity(token: TokenRecord, input: unknown, db: postgres.Sql = sql): Promise<AgentIdentity> {
  const actor = authorize(token);
  if (actor.role !== "owner" || actor.kind !== "session" || !actor.email) throw new AgentIdentityError("Only a workspace owner can change an agent's name and logo", 403);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentIdentityError("Choose a connection");
  const body = input as Record<string, unknown>;
  if (typeof body.id !== "string" || !/^(?:token:[1-9]\d{0,9}|oauth:[a-f0-9]{64})$/.test(body.id)) throw new AgentIdentityError("Choose a valid connection");
  const reset = body.reset === true;
  const hasName = Object.hasOwn(body, "name"), hasLogo = Object.hasOwn(body, "logo"), hasLock = Object.hasOwn(body, "locked");
  if (hasLock && typeof body.locked !== "boolean") throw new AgentIdentityError("Locked must be true or false");
  if (!reset && !hasName && !hasLogo && !hasLock) throw new AgentIdentityError("Nothing to change");
  const name = hasName ? cleanAgentName(body.name) : undefined;
  const logo = hasLogo ? await cleanAgentLogo(body.logo) : undefined;
  const id = body.id;
  return db.begin(async tx => {
    const owners = await tx`SELECT id FROM org_members WHERE org_id = ${actor.orgId} AND email = ${actor.email} AND role = 'owner' FOR SHARE`;
    if (!owners.length) throw new AgentIdentityError("Only a workspace owner can change an agent's name and logo", 403);
    await lockConnection(tx as unknown as postgres.Sql, actor.orgId, id);
    const target = await connectionActor(tx as unknown as postgres.Sql, actor.orgId, id);
    // Reset forgets both the owner's choice and what the agent reported, so the
    // app falls back to the detected product mark or the generated face.
    const [row] = reset
      ? await tx`
        INSERT INTO agent_identities (org_id, actor_kind, actor_name, locked) VALUES (${actor.orgId}, ${target.kind}, ${target.name}, ${hasLock ? body.locked === true : false})
        ON CONFLICT (org_id, actor_kind, actor_name) DO UPDATE SET reported_name = NULL, reported_logo_png = NULL, reported_at = NULL,
          owner_name = NULL, owner_logo_png = NULL, locked = CASE WHEN ${hasLock} THEN EXCLUDED.locked ELSE agent_identities.locked END, updated_at = now()
        RETURNING *`
      : await tx`
        INSERT INTO agent_identities (org_id, actor_kind, actor_name, owner_name, owner_logo_png, locked)
        VALUES (${actor.orgId}, ${target.kind}, ${target.name}, ${name ?? null}, ${logo ?? null}, ${hasLock ? body.locked === true : false})
        ON CONFLICT (org_id, actor_kind, actor_name) DO UPDATE SET
          owner_name = CASE WHEN ${hasName} THEN EXCLUDED.owner_name ELSE agent_identities.owner_name END,
          owner_logo_png = CASE WHEN ${hasLogo} THEN EXCLUDED.owner_logo_png ELSE agent_identities.owner_logo_png END,
          locked = CASE WHEN ${hasLock} THEN EXCLUDED.locked ELSE agent_identities.locked END, updated_at = now()
        RETURNING *`;
    return mapAgentIdentity(row);
  });
}

export async function handleAgentIdentitiesApi(req: Request, token: TokenRecord, db: postgres.Sql = sql): Promise<Response> {
  try {
    authorize(token);
    if (req.method === "POST") {
      if (req.headers.get("x-engram-console") !== "1") throw new AgentIdentityError("forbidden", 403);
      if (req.headers.get("x-engram-workspace") !== String(normalizeToken(token).orgId)) throw new AgentIdentityError("The selected workspace changed. Refresh and try again.", 409);
      const origin = req.headers.get("origin");
      if (origin && origin !== new URL(config.publicUrl || req.url).origin) throw new AgentIdentityError("forbidden", 403);
      const limit = 768 * 1024;
      if (Number(req.headers.get("content-length")) > limit) throw new AgentIdentityError("Logo is too large", 413);
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > limit) throw new AgentIdentityError("Logo is too large", 413);
      let input: unknown;
      try { input = JSON.parse(raw); } catch { throw new AgentIdentityError("Choose a connection"); }
      return Response.json({ identity: await updateAgentIdentity(token, input, db) }, { headers: HEADERS });
    }
    if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...HEADERS, Allow: "GET, POST" } });
    return Response.json({ identities: await listAgentIdentities(token, db) }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AgentIdentityError) return Response.json({ error: error.message }, { status: error.status, headers: HEADERS });
    return Response.json({ error: "Agent names are temporarily unavailable" }, { status: 503, headers: HEADERS });
  }
}
