import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const {
  authorizationServerMetadataUrl,
  isAuthorizationServerPath,
  isProtectedResourcePath,
  jwksUrlFor,
  loadAuthorizationServerMetadata,
  protectedResourceMetadata,
  resetAsMetadataCache,
  wwwAuthenticate,
} = await import("../gateway/src/oauth");
const { hasOauthScope, normalizeToken } = await import("../gateway/src/policies");

describe("oauth discovery paths", () => {
  test("serves resource metadata at both probe locations", () => {
    expect(isProtectedResourcePath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isProtectedResourcePath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isAuthorizationServerPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isAuthorizationServerPath("/.well-known/openid-configuration/mcp")).toBe(true);
    expect(isAuthorizationServerPath("/mcp")).toBe(false);
  });

  test("points AuthKit clients at oauth2/jwks", () => {
    expect(jwksUrlFor("https://engram.authkit.app")).toBe("https://engram.authkit.app/oauth2/jwks");
    expect(jwksUrlFor("https://as.example")).toBe("https://as.example/.well-known/jwks.json");
    expect(authorizationServerMetadataUrl("https://engram.authkit.app", false))
      .toBe("https://engram.authkit.app/.well-known/oauth-authorization-server");
  });

  test("a 401 names the resource metadata document", () => {
    const header = wwwAuthenticate("https://engram.ani.computer");
    expect(header).toContain('resource_metadata="https://engram.ani.computer/.well-known/oauth-protected-resource"');
    const meta = protectedResourceMetadata("https://engram.ani.computer");
    expect(meta.resource).toBe("https://engram.ani.computer/mcp");
    expect(meta.scopes_supported).toContain("email");
  });
});

describe("authorization server metadata proxy", () => {
  test("fetches the issuer document for clients that skip PRM", async () => {
    resetAsMetadataCache();
    const delivery = await loadAuthorizationServerMetadata("/.well-known/oauth-authorization-server", {
      issuer: "https://engram.authkit.app",
      fetchImpl: (async (url) => {
        expect(String(url)).toBe("https://engram.authkit.app/.well-known/oauth-authorization-server");
        return Response.json({ issuer: "https://engram.authkit.app", code_challenge_methods_supported: ["S256"] });
      }) as typeof fetch,
    });
    expect(delivery).toEqual({
      issuer: "https://engram.authkit.app",
      code_challenge_methods_supported: ["S256"],
    });
  });

  test("stays quiet when no issuer is configured", async () => {
    expect(await loadAuthorizationServerMetadata("/.well-known/oauth-authorization-server", { issuer: "" })).toBeNull();
  });
});

describe("oauth scopes", () => {
  const member = normalizeToken({
    name: "oauth:user_1",
    role: "member",
    kind: "oauth",
    email: "ada@example.com",
    scopes: ["openid", "email", "offline_access"],
  });

  test("openid/email from AuthKit is enough until a token carries memory scopes", () => {
    expect(hasOauthScope(member, "memory:read")).toBe(true);
    expect(hasOauthScope(member, "memory:write")).toBe(true);
  });

  test("an explicit memory scope is honored", () => {
    const reader = normalizeToken({ ...member, scopes: ["memory:read"] });
    expect(hasOauthScope(reader, "memory:read")).toBe(true);
    expect(hasOauthScope(reader, "memory:write")).toBe(false);
  });
});
