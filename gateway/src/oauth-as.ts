import { createHash, randomBytes } from "node:crypto";
import { authenticateSecret, createLoginInvite, createSession } from "./auth";
import { parseSessionCookie, serializeSessionCookie } from "./cookies";
import { sql } from "./db";
import { sha256 } from "./hash";
import { loginLinkText, sendMail } from "./mail";
import { localJwks, oauthSigningEnabled, signJwt } from "./oauth-keys";
import { canonicalResource, corsHeaders, oauthIssuer, resourceHost } from "./oauth";
import { acceptInvite, findMemberByEmail, normalizeEmail } from "./orgs";

const CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_TTL_DAYS = 30;
const REQUEST_TTL_MS = 15 * 60 * 1000;

const REDIRECT_HOSTS = new Set([
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "www.claude.com",
  "chatgpt.com",
  "chat.openai.com",
  "x.ai",
  "grok.com",
  "www.grok.com",
]);

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return Boolean(verifier) && pkceChallenge(verifier) === challenge;
}

export function redirectAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  return url.protocol === "https:" && REDIRECT_HOSTS.has(url.hostname);
}

export function authorizationServerMetadata(host: string) {
  const issuer = oauthIssuer(host);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    scopes_supported: ["openid", "email", "offline_access", "memory:read", "memory:write"],
    token_endpoint_auth_methods_supported: ["none"],
    resource_indicator_parameter_supported: true,
  };
}

export async function handleOauth(req: Request, url: URL): Promise<Response | null> {
  const cors = corsHeaders();
  if (req.method === "OPTIONS" && (
    url.pathname === "/.well-known/jwks.json"
    || url.pathname === "/oauth/jwks"
    || url.pathname === "/oauth/register"
    || url.pathname === "/oauth/token"
  )) {
    return new Response(null, { status: 204, headers: cors });
  }
  if (url.pathname === "/.well-known/jwks.json" || url.pathname === "/oauth/jwks") {
    if (!oauthSigningEnabled()) return new Response("Not Found", { status: 404, headers: cors });
    return Response.json({ keys: localJwks() }, { headers: cors });
  }
  if (url.pathname === "/oauth/register" && req.method === "POST") return withCors(await registerClient(req));
  if (url.pathname === "/oauth/authorize") return authorize(req, url);
  if (url.pathname === "/oauth/token" && req.method === "POST") return withCors(await issueToken(req));
  if (url.pathname === "/oauth/continue") return continueAuthorize(req, url);
  return null;
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
  return new Response(res.body, { status: res.status, headers });
}

async function registerClient(req: Request): Promise<Response> {
  const body = await readBody(req);
  const redirectUris = stringList(body.redirect_uris);
  if (!redirectUris.length || redirectUris.some(uri => !redirectAllowed(uri))) {
    return oauthError("invalid_redirect_uri", "redirect is not an allowed chat connector", 400);
  }
  const clientId = `oc_${randomBytes(16).toString("base64url")}`;
  await sql`
    INSERT INTO oauth_clients (client_id, redirect_uris, client_name)
    VALUES (${clientId}, ${sql.json(redirectUris)}, ${text(body.client_name) ?? "connector"})`;
  return Response.json({
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    code_challenge_methods: ["S256"],
  }, { status: 201 });
}

async function authorize(req: Request, url: URL): Promise<Response> {
  if (!oauthSigningEnabled()) return new Response("OAuth is not configured.", { status: 503 });
  const params = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
  const parsed = parseAuthorize(params);
  if ("error" in parsed) return authorizeError(parsed);
  const client = await resolveClient(parsed.clientId);
  if (!client || !client.redirectUris.includes(parsed.redirectUri)) {
    return new Response("Unknown client or redirect.", { status: 400 });
  }
  if (req.method === "POST") {
    const email = normalizeEmail(text(params.email) ?? "");
    if (!email) return authorizePage(parsed, "Enter the email on your engram org.");
    return sendAuthorizeLink(req, parsed, email);
  }
  const session = await sessionFromCookie(req);
  if (session?.email) return completeAuthorize(req, parsed, session.email, session.orgId);
  return authorizePage(parsed);
}

async function sendAuthorizeLink(
  req: Request,
  parsed: AuthorizeParams,
  email: string,
): Promise<Response> {
  const member = await findMemberByEmail(email);
  if (!member) return authorizePage(parsed, "No org for that email.");
  const rid = `oar_${randomBytes(16).toString("base64url")}`;
  await sql`
    INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, resource, scope, email, expires_at)
    VALUES (
      ${rid},
      ${parsed.clientId},
      ${parsed.redirectUri},
      ${parsed.state},
      ${parsed.challenge},
      ${parsed.resource},
      ${parsed.scope},
      ${email},
      ${new Date(Date.now() + REQUEST_TTL_MS)}
    )`;
  const invite = await createLoginInvite(email, resourceHost(req));
  if (!invite) return authorizePage(parsed, "No org for that email.");
  const continueUrl = `${oauthIssuer(resourceHost(req))}/oauth/continue?invite=${invite.raw}&rid=${rid}`;
  const delivery = await sendMail({
    to: email,
    subject: "Sign in to engram",
    text: loginLinkText(continueUrl),
  });
  if (delivery === "failed") return authorizePage(parsed, "Could not send the email.");
  if (delivery === "skipped") return authorizePage(parsed, "", continueUrl);
  return authorizePage(parsed, "Check your email.");
}

async function continueAuthorize(req: Request, url: URL): Promise<Response> {
  const invite = url.searchParams.get("invite") ?? "";
  const rid = url.searchParams.get("rid") ?? "";
  if (!invite || !rid) return new Response("Missing login link.", { status: 400 });
  const accepted = await acceptInvite(invite);
  if (!accepted?.member.email) return new Response("That login link is not valid.", { status: 401 });
  const rows = await sql`
    SELECT * FROM oauth_requests
    WHERE id = ${rid} AND email = ${accepted.member.email} AND used_at IS NULL AND expires_at > now()`;
  if (!rows.length) return new Response("That sign-in request expired.", { status: 401 });
  const parsed = requestToParams(rows[0]);
  await sql`UPDATE oauth_requests SET used_at = now() WHERE id = ${rid}`;
  const session = await createSession({
    orgId: accepted.org.id,
    name: accepted.member.email,
    role: accepted.member.role,
    email: accepted.member.email,
  });
  const completed = await completeAuthorize(req, parsed, accepted.member.email, accepted.org.id);
  completed.headers.append("Set-Cookie", serializeSessionCookie(session));
  return completed;
}

async function completeAuthorize(
  req: Request,
  parsed: AuthorizeParams,
  email: string,
  orgId: number,
): Promise<Response> {
  const code = `oac_${randomBytes(24).toString("base64url")}`;
  await sql`
    INSERT INTO oauth_codes (sha256_hash, client_id, email, org_id, redirect_uri, code_challenge, resource, scope, expires_at)
    VALUES (
      ${sha256(code)},
      ${parsed.clientId},
      ${email},
      ${orgId},
      ${parsed.redirectUri},
      ${parsed.challenge},
      ${parsed.resource},
      ${parsed.scope},
      ${new Date(Date.now() + CODE_TTL_MS)}
    )`;
  const target = new URL(parsed.redirectUri);
  target.searchParams.set("code", code);
  if (parsed.state) target.searchParams.set("state", parsed.state);
  return Response.redirect(target.toString(), 302);
}

async function issueToken(req: Request): Promise<Response> {
  if (!oauthSigningEnabled()) return oauthError("temporarily_unavailable", "oauth is not configured", 503);
  const body = await readBody(req);
  const grant = text(body.grant_type);
  if (grant === "refresh_token") return refreshAccess(req, body);
  if (grant !== "authorization_code") return oauthError("unsupported_grant_type", "use authorization_code", 400);
  const code = text(body.code);
  const verifier = text(body.code_verifier);
  const redirectUri = text(body.redirect_uri);
  const clientId = text(body.client_id);
  if (!code || !verifier || !redirectUri || !clientId) {
    return oauthError("invalid_request", "code, code_verifier, redirect_uri, and client_id are required", 400);
  }
  const rows = await sql`
    SELECT * FROM oauth_codes
    WHERE sha256_hash = ${sha256(code)} AND used_at IS NULL AND expires_at > now()`;
  if (!rows.length) return oauthError("invalid_grant", "code is invalid", 400);
  const row = rows[0];
  if (String(row.client_id) !== clientId || String(row.redirect_uri) !== redirectUri) {
    return oauthError("invalid_grant", "code does not match the client", 400);
  }
  if (!verifyPkce(verifier, String(row.code_challenge))) {
    return oauthError("invalid_grant", "pkce failed", 400);
  }
  await sql`UPDATE oauth_codes SET used_at = now() WHERE id = ${row.id}`;
  return mintedTokens(req, {
    clientId,
    email: String(row.email),
    orgId: Number(row.org_id),
    resource: String(row.resource),
    scope: String(row.scope ?? ""),
  });
}

async function refreshAccess(req: Request, body: Record<string, unknown>): Promise<Response> {
  const raw = text(body.refresh_token);
  const clientId = text(body.client_id);
  if (!raw || !clientId) return oauthError("invalid_request", "refresh_token and client_id are required", 400);
  const rows = await sql`
    SELECT * FROM oauth_refresh_tokens
    WHERE sha256_hash = ${sha256(raw)}
      AND client_id = ${clientId}
      AND revoked_at IS NULL
      AND expires_at > now()`;
  if (!rows.length) return oauthError("invalid_grant", "refresh token is invalid", 400);
  const row = rows[0];
  return mintedTokens(req, {
    clientId,
    email: String(row.email),
    orgId: Number(row.org_id),
    resource: String(row.resource),
    scope: String(row.scope ?? ""),
  }, false);
}

async function mintedTokens(
  req: Request,
  input: { clientId: string; email: string; orgId: number; resource: string; scope: string },
  issueRefresh = true,
): Promise<Response> {
  const host = resourceHost(req);
  const issuer = oauthIssuer(host);
  const audience = input.resource || canonicalResource(host);
  const access = signJwt({
    sub: input.email,
    email: input.email,
    org_id: input.orgId,
    client_id: input.clientId,
    scope: input.scope || "openid email offline_access memory:read memory:write",
  }, { issuer, audience });
  const payload: Record<string, unknown> = {
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    scope: input.scope || "openid email offline_access memory:read memory:write",
  };
  if (issueRefresh) {
    const refresh = `orf_${randomBytes(24).toString("base64url")}`;
    await sql`
      INSERT INTO oauth_refresh_tokens (sha256_hash, client_id, email, org_id, resource, scope, expires_at)
      VALUES (
        ${sha256(refresh)},
        ${input.clientId},
        ${input.email},
        ${input.orgId},
        ${audience},
        ${String(payload.scope)},
        ${new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000)}
      )`;
    payload.refresh_token = refresh;
  }
  return Response.json(payload);
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  resource: string;
  scope: string;
}

function parseAuthorize(params: Record<string, unknown>): AuthorizeParams | { error: string; description: string; redirectUri?: string; state?: string } {
  const clientId = text(params.client_id);
  const redirectUri = text(params.redirect_uri);
  const challenge = text(params.code_challenge);
  const method = text(params.code_challenge_method) ?? "S256";
  const state = text(params.state) ?? "";
  const resource = text(params.resource) ?? "";
  const scope = text(params.scope) ?? "openid email offline_access memory:read memory:write";
  if (!clientId || !redirectUri) return { error: "invalid_request", description: "client_id and redirect_uri are required" };
  if (!redirectAllowed(redirectUri)) return { error: "invalid_request", description: "redirect_uri is not allowed" };
  if (!challenge || method !== "S256") {
    return { error: "invalid_request", description: "PKCE S256 is required", redirectUri, state };
  }
  if (text(params.response_type) && text(params.response_type) !== "code") {
    return { error: "unsupported_response_type", description: "only code is supported", redirectUri, state };
  }
  return { clientId, redirectUri, challenge, state, resource, scope };
}

function requestToParams(row: any): AuthorizeParams {
  return {
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    challenge: String(row.code_challenge),
    state: row.state ? String(row.state) : "",
    resource: row.resource ? String(row.resource) : "",
    scope: row.scope ? String(row.scope) : "",
  };
}

async function resolveClient(clientId: string): Promise<{ clientId: string; redirectUris: string[] } | null> {
  const rows = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`;
  if (rows[0]) {
    return { clientId, redirectUris: stringList(rows[0].redirect_uris) };
  }
  if (clientId.startsWith("https://")) return fetchCimd(clientId);
  return null;
}

export async function fetchCimd(clientId: string, fetchImpl: typeof fetch = fetch): Promise<{ clientId: string; redirectUris: string[] } | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!REDIRECT_HOSTS.has(url.hostname)) return null;
  try {
    const res = await fetchImpl(clientId, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = await res.json() as Record<string, unknown>;
    if (typeof body.client_id === "string" && body.client_id !== clientId) return null;
    const redirectUris = stringList(body.redirect_uris);
    if (!redirectUris.length || redirectUris.some(uri => !redirectAllowed(uri))) return null;
    return { clientId, redirectUris };
  } catch {
    return null;
  }
}

async function sessionFromCookie(req: Request) {
  const raw = parseSessionCookie(req.headers.get("cookie"));
  return raw ? authenticateSecret(raw) : null;
}

function authorizeError(error: { error: string; description: string; redirectUri?: string; state?: string }): Response {
  if (!error.redirectUri || !redirectAllowed(error.redirectUri)) {
    return new Response(`${error.error}: ${error.description}`, { status: 400 });
  }
  const target = new URL(error.redirectUri);
  target.searchParams.set("error", error.error);
  target.searchParams.set("error_description", error.description);
  if (error.state) target.searchParams.set("state", error.state);
  return Response.redirect(target.toString(), 302);
}

function authorizePage(parsed: AuthorizeParams, message = "", link = ""): Response {
  const fields = [
    hidden("client_id", parsed.clientId),
    hidden("redirect_uri", parsed.redirectUri),
    hidden("code_challenge", parsed.challenge),
    hidden("code_challenge_method", "S256"),
    hidden("state", parsed.state),
    hidden("resource", parsed.resource),
    hidden("scope", parsed.scope),
    hidden("response_type", "code"),
  ].join("");
  const extra = link
    ? `<p>Local mailer is off. Open <a href="${escapeHtml(link)}">this link</a>.</p>`
    : message ? `<p>${escapeHtml(message)}</p>` : "<p>We email a login link. Same one as the console.</p>";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram</title>
<style>
  body { font: 16px/1.4 ui-sans-serif, system-ui; background: #111; color: #f4f1ea; margin: 0; }
  main { max-width: 28rem; margin: 12vh auto; padding: 0 1.25rem; }
  input, button { width: 100%; box-sizing: border-box; font: inherit; padding: 0.7rem 0.8rem; margin: 0.4rem 0; }
  button { background: #f4f1ea; color: #111; border: 0; cursor: pointer; }
</style></head>
<body><main>
  <h1>engram</h1>
  ${extra}
  <form method="post">
    ${fields}
    <label>email <input type="email" name="email" autocomplete="email" required></label>
    <button type="submit">email a link</button>
  </form>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] ?? ch));
}

function oauthError(error: string, description: string, status: number): Response {
  return Response.json({ error, error_description: description }, { status });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    const textBody = await req.text();
    return Object.fromEntries(new URLSearchParams(textBody));
  }
  try {
    const json = await req.json();
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}
