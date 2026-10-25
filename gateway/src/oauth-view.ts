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
  const feedback = link
    ? `<p id="oauth-feedback" class="oauth-feedback" role="status">Local mailer is off. Open <a href="${escapeHtml(link)}">this sign-in link</a> to continue.</p>`
    : message ? `<p id="oauth-feedback" class="oauth-feedback" role="status">${escapeHtml(message)}</p>` : "";
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
  <main class="oauth-page">
    <section class="oauth-card ds-card" aria-labelledby="oauth-title">
      <a class="oauth-brand" href="/" aria-label="Engram home"><img src="/brand/engram-mark.svg" alt="" width="36" height="36"><span>engram</span></a>
      <header class="oauth-heading">
        <p class="oauth-context ds-eyebrow">Agent connection</p>
        <h1 id="oauth-title">Connect to Engram</h1>
        <p id="oauth-description" class="oauth-description">Sign in with your workspace email. We’ll email you a link to continue.</p>
      </header>
      ${feedback}
      <form method="post" class="oauth-form">
        ${fields}
        <div class="oauth-field">
          <label for="oauth-email">Email address</label>
          <input id="oauth-email" type="email" name="email" autocomplete="email" inputmode="email" spellcheck="false" required placeholder="you@example.com" aria-describedby="oauth-description${feedback ? " oauth-feedback" : ""}">
        </div>
        <button type="submit" class="ds-button primary">Email a sign-in link <span aria-hidden="true">→</span></button>
      </form>
      <p class="oauth-reassurance">Your existing workspace permissions still apply.</p>
    </section>
    <footer class="oauth-footer"><span>Shared memory for your agents.</span><a href="/privacy">Privacy</a></footer>
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
