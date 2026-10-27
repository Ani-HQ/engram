// First-party, cookieless visit counting. Sends only the page path, the
// referring site's host and campaign tags to this site's own server. Nothing
// is sent when Do Not Track or Global Privacy Control is on.
const FIRST_TOUCH = 'engram-first-touch';
const CTAS = [
  [/^https:\/\/(?:www\.)?x\.com\/anirudh_twt\/?$/, 'ask-invite'],
  [/^\/app#invite$/, 'redeem-invite'], [/^\/app#signin$/, 'sign-in'],
  [/^\/self-host\/?$/, 'self-host'], [/^\/pricing\/?$/, 'pricing'], [/^\/how-it-works\/?/, 'how-it-works'],
  [/^\/support\/?$/, 'support'], [/^https:\/\/github\.com\/Ani-HQ\/engram/, 'source'],
];

const browser = typeof window !== 'undefined' && typeof location !== 'undefined' && typeof document !== 'undefined';
const optedOut = () => !browser || navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true;
const tag = value => (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(value) ? value.toLowerCase() : undefined);

function referrerHost() {
  try { const host = new URL(document.referrer).hostname; return host && host !== location.hostname ? host : undefined; } catch { return undefined; }
}

/** First touch for this browser tab only (sessionStorage), so a sign-up can say
 * which campaign brought it. Cleared when the tab closes. */
export function attribution() {
  if (!browser) return {};
  try {
    const saved = JSON.parse(sessionStorage.getItem(FIRST_TOUCH) || 'null');
    if (saved) return saved;
  } catch { /* Storage unavailable. */ }
  const params = new URLSearchParams(location.search);
  const touch = { utmSource: tag(params.get('utm_source')), utmMedium: tag(params.get('utm_medium')), utmCampaign: tag(params.get('utm_campaign')), referrerHost: referrerHost(), landingPath: location.pathname };
  try { sessionStorage.setItem(FIRST_TOUCH, JSON.stringify(touch)); } catch { /* Storage unavailable. */ }
  return touch;
}

function send(body) {
  if (optedOut()) return;
  const payload = JSON.stringify({ path: location.pathname, ...attribution(), ...body });
  try {
    if (navigator.sendBeacon?.('/api/e', new Blob([payload], { type: 'application/json' }))) return;
  } catch { /* Fall through. */ }
  fetch('/api/e', { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'application/json' }, credentials: 'omit' }).catch(() => {});
}

export function trackPage() { send({ name: 'pageview' }); }

function ctaFor(anchor) {
  const raw = anchor.getAttribute('href') || '';
  const value = raw.startsWith('http') ? raw : raw.split('?')[0];
  return CTAS.find(([pattern]) => pattern.test(value))?.[1];
}

export function startAnalytics() {
  if (optedOut()) return;
  attribution();
  trackPage();
  document.addEventListener('click', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const cta = anchor && ctaFor(anchor);
    if (cta) send({ name: 'cta', cta });
  }, { capture: true });
}

if (browser) startAnalytics();
