import { createPublicKey, createVerify } from "node:crypto";
import { config } from "./config";
import { findMemberByEmail, getOrg } from "./orgs";
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
  return Boolean(config.oauth.issuer);
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
  const resource = canonicalResource(host);
  return {
    resource,
    authorization_servers: config.oauth.issuer ? [config.oauth.issuer] : [],
    scopes_supported: ["memory:read", "memory:write"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${host.replace(/\/$/, "")}/`,
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
    return {
      header: JSON.parse(base64urlJson(parts[0])),
      payload: JSON.parse(base64urlJson(parts[1])),
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
  if (typeof payload.exp === "number" && now >= payload.exp) return null;
  if (typeof payload.nbf === "number" && now < payload.nbf) return null;
  if (!payload.sub) return null;

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
  if (!expected) return true;
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.includes(expected);
}

export async function loadJwks(): Promise<Jwk[]> {
  const url = config.oauth.jwksUrl || (config.oauth.issuer
    ? `${config.oauth.issuer.replace(/\/$/, "")}/.well-known/jwks.json`
    : "");
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
  const jwks = await loadJwks();
  const claims = await verifyJwt(raw, {
    issuer: config.oauth.issuer,
    audience: config.oauth.audience || audience,
    jwks,
  });
  if (!claims?.sub) return null;
  const email = typeof claims.email === "string"
    ? claims.email
    : typeof claims.preferred_username === "string" ? claims.preferred_username : "";
  const member = email ? await findMemberByEmail(email) : null;
  if (!member) return null;
  const org = await getOrg(member.orgId);
  if (!org) return null;
  return normalizeToken({
    name: `oauth:${claims.sub}`,
    orgId: member.orgId,
    role: member.role,
    canWrite: true,
    kind: "oauth",
    email: member.email,
    scopes: typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [],
  });
}

export function parseScopes(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}
