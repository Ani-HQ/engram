import { createPublicKey, createVerify } from "node:crypto";
import type postgres from "postgres";
import { config } from "./config";
import { connectorBranding } from "../../shim/branding.js";
import { sql } from "./db";
import { localJwks, oauthSigningEnabled } from "./oauth-keys";
import { oauthConnectionId } from "./connection-identity";
import { getOrg, memberInOrg, type OrgMember } from "./orgs";
import { normalizeToken, type TokenRecord } from "./policies";

export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  preferred_username?: string;
  scope?: string;
  client_id?: string;
  azp?: string;
  org_id?: number;
  membership_id?: number;
  connection_generation?: number;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

let jwksCache: { fetchedAt: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

export function oauthEnabled(): boolean {
  return oauthSigningEnabled();
}

export function oauthIssuer(host: string): string {
  const explicit = (config.oauth.issuer || config.publicUrl || host).trim();
  return explicit.replace(/\/$/, "");
}

export function resourceHost(req: Request): string {
  if (config.publicUrl) return config.publicUrl;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export function canonicalResource(host: string): string {
  return `${host.replace(/\/$/, "")}/mcp`;
}

export function protectedResourceMetadata(host: string) {
  const branding = connectorBranding(host);
  const issuer = oauthIssuer(host);
  return {
    resource: canonicalResource(host),
    authorization_servers: oauthEnabled() ? [issuer] : [],
    scopes_supported: ["openid", "email", "offline_access", "memory:read", "memory:write"],
    bearer_methods_supported: ["header"],
    resource_name: branding.title,
    resource_documentation: branding.websiteUrl,
    logo_uri: branding.icons[0].src,
  };
}

export function isProtectedResourcePath(pathname: string): boolean {
  return pathname === "/.well-known/oauth-protected-resource"
    || pathname === "/.well-known/oauth-protected-resource/mcp";
}

export function isAuthorizationServerPath(pathname: string): boolean {
  return pathname === "/.well-known/oauth-authorization-server"
    || pathname === "/.well-known/oauth-authorization-server/mcp"
    || pathname === "/.well-known/openid-configuration"
    || pathname === "/.well-known/openid-configuration/mcp";
}

export function jwksUrlFor(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
}

export function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export function wwwAuthenticate(host: string, extra?: string): string {
  const metadata = `${host.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
  const parts = [`Bearer resource_metadata="${metadata}"`, `scope="memory:read"`];
  if (extra) parts.push(extra);
  return parts.join(", ");
}

export function unauthorizedResponse(req: Request, message = "unauthorized", status = 401): Response {
  const host = resourceHost(req);
  return Response.json({ error: message }, {
    status,
    headers: { "WWW-Authenticate": wwwAuthenticate(host) },
  });
}

export function insufficientScope(req: Request): Response {
  const host = resourceHost(req);
  return Response.json({ error: "insufficient_scope" }, {
    status: 403,
    headers: {
      "WWW-Authenticate": wwwAuthenticate(host, `error="insufficient_scope"`),
    },
  });
}

export function isJwt(raw: string): boolean {
  const parts = raw.split(".");
  return parts.length === 3 && !raw.startsWith("eng_") && !raw.startsWith("ens_") && !raw.startsWith("inv_");
}

export function decodeJwt(raw: string): { header: any; payload: JwtClaims; signingInput: string; signature: Buffer } | null {
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64urlJson(parts[0]));
    const payload = JSON.parse(base64urlJson(parts[1]));
    if (!header || typeof header !== "object" || Array.isArray(header)
      || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], "base64url"),
    };
  } catch {
    return null;
  }
}

function base64urlJson(part: string): string {
  return Buffer.from(part, "base64url").toString("utf8");
}

export async function verifyJwt(
  raw: string,
  options: { issuer: string; audience: string; jwks: Jwk[]; now?: number },
): Promise<JwtClaims | null> {
  const decoded = decodeJwt(raw);
  if (!decoded) return null;
  const { header, payload, signingInput, signature } = decoded;
  if (header.alg !== "RS256" || header.typ && header.typ !== "JWT") return null;
  if (payload.iss !== options.issuer) return null;
  if (!audienceMatches(payload.aud, options.audience)) return null;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || now >= payload.exp) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || now < payload.nbf)) return null;
  if (typeof payload.sub !== "string" || !payload.sub.trim()) return null;

  const jwk = options.jwks.find(key => !header.kid || key.kid === header.kid);
  if (!jwk?.n || !jwk?.e) return null;
  const key = createPublicKey({
    key: { kty: "RSA", n: jwk.n, e: jwk.e },
    format: "jwk",
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  return verifier.verify(key, signature) ? payload : null;
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (!expected) return false;
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.includes(expected);
}

export async function loadJwks(): Promise<Jwk[]> {
  const local = localJwks();
  if (local.length) return local;
  const url = config.oauth.jwksUrl;
  if (!url) return [];
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = await res.json() as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { fetchedAt: Date.now(), keys };
  return keys;
}

export function resetJwksCache() {
  jwksCache = null;
}

export async function authenticateJwt(raw: string, audience: string): Promise<TokenRecord | null> {
  if (!oauthEnabled()) return null;
  const expectedAudience = config.oauth.audience || audience || (config.publicUrl ? canonicalResource(config.publicUrl) : "");
  if (!expectedAudience) return null;
  const jwks = await loadJwks();
  const issuer = (config.oauth.issuer || config.publicUrl || audience.replace(/\/mcp\/?$/, "")).replace(/\/$/, "");
  if (!issuer) return null;
  const claims = await verifyJwt(raw, {
    issuer,
    audience: expectedAudience,
    jwks,
  });
  if (!claims?.sub) return null;
  const member = await oauthMemberForClaims(claims);
  if (!member || !await oauthConnectionForClaims(claims)) return null;
  return normalizeToken({
    name: oauthActorName(claims),
    orgId: member.orgId,
    role: member.role,
    canWrite: true,
    kind: "oauth",
    email: member.email,
    scopes: typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [],
  });
}

export async function oauthMemberForClaims(claims: JwtClaims, db: postgres.Sql = sql): Promise<OrgMember | null> {
  const orgId = claims.org_id;
  if (typeof orgId !== "number" || !Number.isSafeInteger(orgId) || orgId < 1) return null;
  const membershipId = claims.membership_id;
  // Email ownership is insufficient after removal and rejoining: the new
  // membership must never reactivate an access token from the previous stay.
  // Unbound pre-upgrade JWTs require a fresh connector authorization.
  if (typeof membershipId !== "number" || !Number.isSafeInteger(membershipId) || membershipId < 1) return null;
  const email = typeof claims.email === "string"
    ? claims.email
    : typeof claims.preferred_username === "string" ? claims.preferred_username : "";
  if (!email) return null;
  // Keep the workspace chosen at authorization. A later invite or membership
  // ordering change must not redirect an existing connected client elsewhere.
  const member = await memberInOrg(orgId, email, db);
  if (!member || member.id !== membershipId || !await getOrg(orgId, db)) return null;
  return member;
}

export async function oauthConnectionForClaims(claims: JwtClaims, db: postgres.Sql = sql): Promise<boolean> {
  const orgId = claims.org_id;
  if (typeof orgId !== "number" || !Number.isSafeInteger(orgId) || orgId < 1) return false;
  const email = typeof claims.email === "string" ? claims.email : typeof claims.preferred_username === "string" ? claims.preferred_username : "";
  if (!email) return false;
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : null;
  if (!clientId) return false;
  const rows = await db`SELECT generation, archived_at, deleted_at FROM connection_lifecycle WHERE org_id = ${orgId} AND connection_id = ${oauthConnectionId(orgId, email, clientId)}`;
  const generation = claims.connection_generation === undefined ? 0 : claims.connection_generation;
  return Number.isSafeInteger(generation) && generation >= 0 && generation === Number(rows[0]?.generation ?? 0) && !rows[0]?.archived_at && !rows[0]?.deleted_at;
}

export function oauthActorName(claims: JwtClaims): string {
  const client = typeof claims.client_id === "string" ? claims.client_id
    : typeof claims.azp === "string" ? claims.azp : null;
  return client ? `oauth:${encodeURIComponent(claims.sub ?? "")}:${encodeURIComponent(client)}` : `oauth:${claims.sub}`;
}

export function parseScopes(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}
