import { describe, expect, test } from "bun:test";
import { renderOAuthAuthorizePage, type OAuthAuthorizeViewParams } from "../gateway/src/oauth-view";

const params: OAuthAuthorizeViewParams = Object.freeze({
  clientId: "connector", redirectUri: "http://localhost:4242/callback", challenge: "pkce-challenge",
  state: "opaque-state", resource: "https://engram.example/mcp", scope: "openid memory:read",
});

describe("OAuth sign-in presentation", () => {
  test("preserves the existing POST fields and native required email form", async () => {
    const html = await renderOAuthAuthorizePage(params).text();
    const fields = [...html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map(match => [match[1], match[2]]);
    expect(Object.fromEntries(fields)).toEqual({
      client_id: params.clientId, redirect_uri: params.redirectUri, code_challenge: params.challenge,
      code_challenge_method: "S256", state: params.state, resource: params.resource, scope: params.scope, response_type: "code",
    });
    expect(fields).toHaveLength(8);
    expect(html).toContain('<form method="post" class="oauth-form">');
    expect(html).not.toMatch(/<form[^>]*\saction=/);
    expect(html).toContain('<label for="oauth-email">Email address</label>');
    expect(html).toMatch(/<input id="oauth-email" type="email" name="email" autocomplete="email"[^>]* required/);
    expect(html).toContain('aria-labelledby="oauth-title"');
    expect(html).toContain("Connect to Engram");
    expect(html).toContain("Your existing workspace permissions still apply.");
  });

  test("says when an app asks for read-only access", async () => {
    expect(await renderOAuthAuthorizePage(params).text()).toContain("This app is asking for read-only access.");
    for (const scope of ["openid email offline_access memory:read memory:write", "openid email"]) {
      expect(await renderOAuthAuthorizePage({ ...params, scope }).text()).not.toContain("read-only access");
    }
  });

  test("escapes every hidden value and feedback without interpreting markup", async () => {
    const hostile = `a&<>"' onfocus="alert(1)`;
    const escaped = "a&amp;&lt;&gt;&quot;&#39; onfocus=&quot;alert(1)";
    const input = Object.freeze(Object.fromEntries(Object.keys(params).map(key => [key, hostile])) as unknown as OAuthAuthorizeViewParams);
    const html = await renderOAuthAuthorizePage(input, `<img src=x onerror="bad"> & '`).text();
    expect(html.split(`value="${escaped}"`).length - 1).toBe(6);
    expect(html).toContain('&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; &#39;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('value="a&<>');
    expect(html).toContain('aria-describedby="oauth-description oauth-feedback"');
    expect(html).toContain('role="status"');
  });

  test("preserves and escapes the server-provided local development sign-in link", async () => {
    const html = await renderOAuthAuthorizePage(params, "not selected", 'https://engram.example/oauth/continue?invite=a&rid=b" data-bad="x').text();
    expect(html).toContain('href="https://engram.example/oauth/continue?invite=a&amp;rid=b&quot; data-bad=&quot;x"');
    expect(html).toContain("Local mailer is off.");
    expect(html).not.toContain("not selected");
    expect(html).not.toContain('rid=b" data-bad="x');
    expect(await renderOAuthAuthorizePage(params).text()).not.toContain("Local mailer is off.");
  });

  test("loads only local presentation assets and prevents query referrer/cache disclosure", async () => {
    const response = renderOAuthAuthorizePage(params);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
    expect(html).toContain('href="/oauth.css"');
    expect(html).toContain('src="/brand/engram-mark.svg"');
    expect(html).toContain('href="/privacy"');
    expect(html).not.toMatch(/<(?:script|style)\b|\son\w+=|\s(?:src|href)="https?:/);
  });

  test("rendering a GET view is deterministic and creates no session or redirect", async () => {
    const first = renderOAuthAuthorizePage(params);
    const second = renderOAuthAuthorizePage(params);
    expect(first.headers.has("Set-Cookie")).toBe(false);
    expect(first.headers.has("Location")).toBe(false);
    expect(await first.text()).toBe(await second.text());
    expect(params.state).toBe("opaque-state");
  });
});
