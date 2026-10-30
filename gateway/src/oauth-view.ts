/** Presentation only: authorization validation, delivery and redirects stay in oauth-as. */
export interface OAuthAuthorizeViewParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  readonly resource: string;
  readonly scope: string;
}

export function renderOAuthAuthorizePage(parsed: OAuthAuthorizeViewParams, message = "", link = ""): Response {
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
  const scopes = parsed.scope.split(/\s+/).filter(Boolean);
  const readOnly = scopes.some(scope => scope.startsWith("memory:")) && !scopes.includes("memory:write");
  const access = readOnly
    ? `<p id="oauth-access" class="ds-notice" data-tone="warning" role="note">This app is asking for read-only access. It will be able to recall memory but not save it.</p>`
    : "";
  const feedback = link
    ? `<p id="oauth-feedback" class="oauth-feedback" role="status"><span class="ds-icon" data-icon="mail" aria-hidden="true"></span><span>Local mailer is off. Open <a href="${escapeHtml(link)}">this sign-in link</a> to continue.</span></p>`
    : message ? `<p id="oauth-feedback" class="oauth-feedback" role="status"><span class="ds-icon" data-icon="info" aria-hidden="true"></span><span>${escapeHtml(message)}</span></p>` : "";
  const html = `<!doctype html>
<html lang="en" data-design-system="signal">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, noarchive">
  <title>Connect to Engram</title>
  <link rel="icon" href="/favicon.ico" type="image/x-icon" sizes="16x16 32x32 48x48">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
  <link rel="stylesheet" href="/design-system.css">
  <link rel="stylesheet" href="/oauth.css">
</head>
<body class="oauth-surface">
  <main class="ds-auth oauth-page">
    <div class="ds-auth-main">
      <a class="ds-auth-brand oauth-brand" href="/" aria-label="Engram home"><img src="/brand/engram-mark.svg" alt="" width="24" height="24"><span>engram</span></a>
      <section class="ds-auth-body oauth-card" aria-labelledby="oauth-title">
        <header class="ds-auth-heading oauth-heading">
          <p class="oauth-context"><span class="ds-icon" data-icon="plug" aria-hidden="true"></span>Agent connection</p>
          <h1 id="oauth-title" class="ds-auth-title">Connect to Engram</h1>
          <p id="oauth-description" class="ds-auth-subtitle oauth-description">Sign in with your workspace email. We’ll email you a link to continue.</p>
        </header>
        ${feedback}
        <form method="post" class="oauth-form">
          ${fields}
          <div class="oauth-field">
            <label for="oauth-email">Email address</label>
            <input id="oauth-email" type="email" name="email" autocomplete="email" inputmode="email" spellcheck="false" required placeholder="you@example.com" aria-describedby="oauth-description${feedback ? " oauth-feedback" : ""}">
          </div>
          <button type="submit" class="ds-button primary">Send sign-in link</button>
        </form>
        ${access}
        <p class="oauth-reassurance"><span class="ds-icon" data-icon="shield-check" aria-hidden="true"></span>Your existing workspace permissions still apply.</p>
      </section>
      <footer class="ds-auth-legal oauth-footer"><p>By continuing, you acknowledge Engram’s <a href="/privacy">Privacy Policy</a>.</p></footer>
    </div>
    <aside class="ds-auth-aside ds-dotgrid" aria-label="About Engram">
      <div class="ds-auth-statement">
        <p>A shared drive for your agents’ context. <span>Save a decision in one agent, recall it in another.</span></p>
        <ul class="ds-auth-facts">
          <li><span class="ds-icon" data-icon="plug" aria-hidden="true"></span>Agents connect over MCP and act within your workspace permissions.</li>
          <li><span class="ds-icon" data-icon="brain" aria-hidden="true"></span>Memory pages, decisions and a readable history of work in one console.</li>
          <li><span class="ds-icon" data-icon="key-round" aria-hidden="true"></span>Every connection is listed in the console for you to review.</li>
        </ul>
      </div>
    </aside>
  </main>
</body>
</html>`;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  } });
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch] ?? ch));
}
