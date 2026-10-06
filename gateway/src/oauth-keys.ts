import { createHash, createPrivateKey, createPublicKey, createSign, type KeyObject } from "node:crypto";

function secretValue(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return !value || value === "unset" ? "" : value;
}

export function signingPem(): string {
  return secretValue(process.env.ENGRAM_OAUTH_PRIVATE_KEY);
}

export function oauthSigningEnabled(): boolean {
  return Boolean(signingPem());
}

export interface PublicJwk {
  kid: string;
  kty: "RSA";
  alg: "RS256";
  use: "sig";
  n: string;
  e: string;
}

function material(pem = signingPem()): { key: KeyObject; jwk: PublicJwk } | null {
  if (!pem) return null;
  const key = createPrivateKey(pem);
  const pub = createPublicKey(key).export({ format: "jwk" }) as { n?: string; e?: string };
  if (!pub.n || !pub.e) return null;
  const kid = createHash("sha256").update(pub.n).digest("base64url").slice(0, 12);
  return { key, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: pub.n, e: pub.e } };
}

export function localJwks(): PublicJwk[] {
  const loaded = material();
  return loaded ? [loaded.jwk] : [];
}

export function signJwt(
  payload: Record<string, unknown>,
  options: { issuer: string; audience: string; expiresInSec?: number; now?: number } ,
): string {
  const loaded = material();
  if (!loaded) throw new Error("oauth signing key missing");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iss: options.issuer,
    aud: options.audience,
    iat: now,
    exp: now + (options.expiresInSec ?? 3600),
  };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: loaded.jwk.kid })).toString("base64url");
  const packed = Buffer.from(JSON.stringify(body)).toString("base64url");
  const input = `${header}.${packed}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(loaded.key).toString("base64url");
  return `${input}.${signature}`;
}
