// Local-only responsive review shell. Production never imports this module.
export function devReviewPage(url: URL, head = false): Response {
  const pages = [
    ["/", "Homepage"], ["/app#signin", "Sign-in / app"],
    ["/app#invite", "Invite page"], ["/how-it-works", "How it works"],
    ["/app#workspace", "Workspace settings"], ["/app#billing", "Plan & billing"],
    ["/pricing", "Pricing"], ["/support", "Support"],
    ["/privacy", "Privacy"], ["/self-host", "Self-host"],
    ["/changelog", "Changelog"],
    ["/design-system", "Design system"],
    ["/__open-source-review", "Open-source support copy"],
    ["/__mail-preview/preference/confirm", "Email preferences"],
    ["/__mail-preview/preference/unsubscribed", "Email preference saved"],
    ["/__mail-preview/preference/unavailable", "Email link unavailable"],
  ];
  const selected = pages.find(([path]) => path === url.searchParams.get("path"))?.[0] ?? "/";
  const html = `<!doctype html><html lang="en" data-design-system="signal"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
  <title>Phone review · Engram local preview</title><link rel="stylesheet" href="/design-system.css">
  <style>body{padding:var(--ds-space-8)}main{display:flex;align-items:flex-start;justify-content:center;gap:var(--ds-space-8)}aside{width:240px;flex-shrink:0}aside h1{font-size:var(--ds-text-2xl)}aside p{color:var(--ds-muted);font-size:var(--ds-text-sm)}nav{display:grid;gap:var(--ds-space-2)}.phone{width:390px;flex:0 0 390px;padding:0;overflow:hidden}iframe{display:block;width:390px;height:844px;border:0;background:var(--ds-paper)}@media(max-width:720px){body{padding:var(--ds-space-4)}main{flex-direction:column;align-items:center}aside{width:min(100%,390px)}nav{grid-template-columns:1fr 1fr}}</style>
  </head><body><main><aside class="ds-stack"><div class="ds-heading-group"><span class="ds-eyebrow">LOCAL REVIEW / 390 × 844</span><h1>Small screen.<br>Same system.</h1></div><p>These are the actual local pages in a phone-sized viewport. Sign-in and data are simulated; payments are disabled.</p><nav aria-label="Phone preview pages">${pages.map(([path, label]) => `<a class="ds-button" href="${path}" target="review-frame">${label}</a>`).join("")}</nav><a href="/">Open full-size homepage ↗</a></aside><section class="ds-card phone" aria-label="Phone viewport"><iframe name="review-frame" title="Phone-sized Engram preview" src="${selected}" width="390" height="844"></iframe></section></main></body></html>`;
  return new Response(head ? null : html, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  } });
}
