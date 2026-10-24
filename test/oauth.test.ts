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
    expect(resource.resource_name).toBe("Engram");
    expect(resource.logo_uri).toBe("https://engram.example/brand/engram-mark.png");
    const as = authorizationServerMetadata("https://engram.example");
    expect(as.authorization_endpoint).toBe("https://engram.example/oauth/authorize");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.display_name).toBe("Engram");
    expect(as.logo_uri).toBe(resource.logo_uri);
    expect(as.service_documentation).toBe(resource.resource_documentation);
    expect(jwksUrlFor("https://engram.example")).toBe("https://engram.example/.well-known/jwks.json");
  });

  test("normalizes public branding URLs while preserving authorization-bearing base paths", () => {
    const host = "https://brand-user:brand-password@engram.example/private-path?token=brand-token#brand-fragment";
    const resource = protectedResourceMetadata(host);
    const as = authorizationServerMetadata(host);
    expect(resource.resource_documentation).toBe("https://engram.example/");
    const publicBranding = { resourceDocumentation: resource.resource_documentation, resourceLogo: resource.logo_uri, serviceDocumentation: as.service_documentation, serverLogo: as.logo_uri };
    for (const value of ["brand-user", "brand-password", "private-path", "brand-token", "brand-fragment"]) expect(JSON.stringify(publicBranding)).not.toContain(value);
    const basedResource = protectedResourceMetadata("https://engram.example/self-hosted");
    const basedServer = authorizationServerMetadata("https://engram.example/self-hosted");
    expect(basedResource.resource).toBe("https://engram.example/self-hosted/mcp");
    expect(basedResource.authorization_servers).toEqual(["https://engram.example/self-hosted"]);
    expect(basedServer.issuer).toBe("https://engram.example/self-hosted");
    expect(basedServer.authorization_endpoint).toBe("https://engram.example/self-hosted/oauth/authorize");
    expect(basedServer.token_endpoint).toBe("https://engram.example/self-hosted/oauth/token");
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
    orgId: 7,
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
