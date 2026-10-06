import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.ENGRAM_OAUTH_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const {
  isAuthorizationServerPath,
  isProtectedResourcePath,
  jwksUrlFor,
  oauthEnabled,
  protectedResourceMetadata,
  verifyJwt,
  wwwAuthenticate,
} = await import("../gateway/src/oauth");
const {
  authorizationServerMetadata,
  fetchCimd,
  pkceChallenge,
  redirectAllowed,
  verifyPkce,
} = await import("../gateway/src/oauth-as");
const { localJwks, signJwt } = await import("../gateway/src/oauth-keys");
const { hasOauthScope, normalizeToken } = await import("../gateway/src/policies");

describe("oauth discovery paths", () => {
  test("serves resource and authorization metadata at both probe locations", () => {
    expect(isProtectedResourcePath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isProtectedResourcePath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isAuthorizationServerPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isAuthorizationServerPath("/.well-known/openid-configuration/mcp")).toBe(true);
    expect(isAuthorizationServerPath("/mcp")).toBe(false);
  });

  test("names this host as the authorization server when a signing key is present", () => {
    expect(oauthEnabled()).toBe(true);
    const header = wwwAuthenticate("https://engram.example");
    expect(header).toContain('resource_metadata="https://engram.example/.well-known/oauth-protected-resource"');
    const resource = protectedResourceMetadata("https://engram.example");
    expect(resource.resource).toBe("https://engram.example/mcp");
    expect(resource.authorization_servers).toEqual(["https://engram.example"]);
    const as = authorizationServerMetadata("https://engram.example");
    expect(as.authorization_endpoint).toBe("https://engram.example/oauth/authorize");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(jwksUrlFor("https://engram.example")).toBe("https://engram.example/.well-known/jwks.json");
  });
});

describe("pkce and redirects", () => {
  test("S256 challenge matches the verifier", () => {
    const verifier = "a".repeat(43);
    expect(verifyPkce(verifier, pkceChallenge(verifier))).toBe(true);
    expect(verifyPkce("other", pkceChallenge(verifier))).toBe(false);
  });

  test("only chat-connector and local redirects are allowed", () => {
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(redirectAllowed("https://grok.com/oauth/callback")).toBe(true);
    expect(redirectAllowed("http://localhost:1234/cb")).toBe(true);
    expect(redirectAllowed("https://evil.example/cb")).toBe(false);
    expect(redirectAllowed("https://user:pass@claude.ai/cb")).toBe(false);
  });

  test("CIMD only fetches https hosts on the redirect allowlist", async () => {
    let called = 0;
    const fake: typeof fetch = async () => {
      called += 1;
      return new Response("no");
    };
    expect(await fetchCimd("http://claude.ai/client.json", fake)).toBeNull();
    expect(await fetchCimd("https://evil.example/client.json", fake)).toBeNull();
    expect(await fetchCimd("https://user:pass@claude.ai/client.json", fake)).toBeNull();
    expect(called).toBe(0);

    const ok: typeof fetch = async () => Response.json({
      client_id: "https://claude.ai/client.json",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const client = await fetchCimd("https://claude.ai/client.json", ok);
    expect(client?.redirectUris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });
});

describe("local jwt", () => {
  test("a token we sign verifies against our jwks", async () => {
    const token = signJwt(
      { sub: "ada@example.com", email: "ada@example.com", scope: "openid email" },
      { issuer: "https://engram.example", audience: "https://engram.example/mcp" },
    );
    const claims = await verifyJwt(token, {
      issuer: "https://engram.example",
      audience: "https://engram.example/mcp",
      jwks: localJwks(),
    });
    expect(claims?.email).toBe("ada@example.com");
  });
});

describe("oauth scopes", () => {
  const member = normalizeToken({
    name: "oauth:ada@example.com",
    role: "member",
    kind: "oauth",
    email: "ada@example.com",
    scopes: ["openid", "email", "offline_access"],
  });

  test("openid/email is enough until a token carries memory scopes", () => {
    expect(hasOauthScope(member, "memory:read")).toBe(true);
    expect(hasOauthScope(member, "memory:write")).toBe(true);
  });

  test("an explicit memory scope is honored", () => {
    const reader = normalizeToken({ ...member, scopes: ["memory:read"] });
    expect(hasOauthScope(reader, "memory:read")).toBe(true);
    expect(hasOauthScope(reader, "memory:write")).toBe(false);
  });
});
