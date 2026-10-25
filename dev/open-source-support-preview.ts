// Local review only. Production never imports this module or exposes this route.
import { CHECKOUT_OPEN_SOURCE_MESSAGE } from "../gateway/src/billing";

export function openSourceSupportPreview(head = false): Response {
  const html = `<!doctype html><html lang="en" data-design-system="signal"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow"><title>Open-source support · Local copy review</title>
  <link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/design-system.css">
  </head><body class="ds-gallery"><div class="ds-gallery-shell">
  <header class="ds-gallery-header"><a class="ds-gallery-brand" href="/"><img src="/brand/engram-mark.svg" width="35" height="35" alt="">engram</a><span class="ds-badge" data-tone="lilac">Local review</span></header>
  <main><section class="ds-gallery-section ds-stack" aria-labelledby="review-title">
  <div class="ds-heading-group"><span class="ds-eyebrow">A little back / Copy review</span><h1 id="review-title">Built with open source.<br><span class="ds-editorial">Built to give back.</span></h1><p>Proposed website, billing, and checkout copy. Nothing on this page creates a payment or changes a subscription.</p></div>
  <div class="ds-gallery-grid">
  <article class="ds-card ds-heading-group"><span class="ds-eyebrow">Website &amp; billing</span><h2>A future commitment.</h2><p>${CHECKOUT_OPEN_SOURCE_MESSAGE}</p><p class="ds-hint">The memory engine is <a href="https://github.com/garrytan/gbrain">gbrain</a> by Garry Tan, used through a pinned fork. Sponsorship recipients can include other open-source projects too.</p></article>
  <article class="ds-card ds-heading-group" data-tone="lilac"><span class="ds-eyebrow">Stripe Checkout / Submit message</span><h2>The checkout note.</h2><p>${CHECKOUT_OPEN_SOURCE_MESSAGE}</p><p class="ds-hint">This is the exact message supplied to new subscription Checkout sessions. It uses subscription revenue; it does not add a donation or another payment item.</p><details><summary>Inspect the request field</summary><p><code>custom_text[submit][message]</code></p><p>${CHECKOUT_OPEN_SOURCE_MESSAGE}</p></details></article>
  </div><nav class="ds-row" aria-label="Review the actual surfaces"><a class="ds-button" href="/pricing#open-source-support">Pricing note</a><a class="ds-button" href="/self-host#open-source-support">Self-host credit</a><a class="ds-button" href="/app#billing">Plan &amp; billing</a><a class="ds-button" href="/#open-source-footer">Homepage footer</a></nav>
  <p class="ds-hint">Review scope: future sponsorships, no fixed percentage, no claim that donations have already been made. Prices, checkout redirects, and line items are unchanged.</p>
  </section></main></div></body></html>`;
  return new Response(head ? null : html, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'none'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  } });
}
