// Local fixture review only. Production never imports this module. A scenario
// is scoped to its document's same-origin referrer, not a shared cookie/global.
const scenarios = new Set(['ready', 'loading', 'empty', 'error', 'mutation-error', 'read-only', 'slow-memory', 'long-content', 'signed-out', 'auth-error', 'auth-loading']);
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const contentPaths = new Set(['/api/activities', '/api/pages', '/api/connections', '/api/review', '/api/billing', '/api/members', '/api/policies', '/api/sharing', '/api/showcase', '/api/jev', '/api/insights']);

export function uiReviewScenario(req: Request): string | null {
  try {
    const current = new URL(req.url), referrer = new URL(req.headers.get('referer') || '');
    if (referrer.origin !== current.origin || referrer.pathname !== '/__ui-review/app') return null;
    const scenario = referrer.searchParams.get('state') || 'ready';
    return scenarios.has(scenario) ? scenario : null;
  } catch { return null; }
}

export async function reviewApi(req: Request, next: () => Promise<Response>): Promise<Response> {
  const scenario = uiReviewScenario(req), path = new URL(req.url).pathname;
  if (!scenario || scenario === 'ready') return next();
  const read = req.method === 'GET', content = contentPaths.has(path) || path === '/api/page' || path.startsWith('/api/activities/');
  if (['signed-out', 'auth-error', 'auth-loading'].includes(scenario) && path === '/api/me') return Response.json({ error: 'Sign in to continue.' }, { status: 401 });
  if (scenario === 'auth-loading' && ['/api/login/email', '/api/orgs'].includes(path)) await Bun.sleep(2500);
  if (scenario === 'auth-error' && ['/api/login/email', '/api/orgs'].includes(path)) return Response.json({ error: 'This local sign-in request failed. Check your address and try again.' }, { status: 503 });
  if (scenario === 'loading' && (content || (!read && !path.startsWith('/api/session')))) await Bun.sleep(2500);
  if (scenario === 'slow-memory' && path === '/api/page') await Bun.sleep(20000);
  if ((scenario === 'error' && read && content) || (scenario === 'mutation-error' && !read && !path.startsWith('/api/session'))) {
    return Response.json({ error: 'This local review request failed. Your changes were not saved. Try again.' }, { status: 503 });
  }
  const response = await next();
  if (!read || !response.ok || !['empty', 'read-only', 'long-content'].includes(scenario)) return response;
  const data = await response.json();
  if (scenario === 'empty' && ['/api/activities', '/api/pages', '/api/connections', '/api/review'].includes(path)) {
    for (const key of ['activities', 'pages', 'connections', 'items', 'reviews', 'agents', 'tools']) if (Array.isArray(data[key])) data[key] = [];
    if (data.stats) data.stats = Object.fromEntries(Object.keys(data.stats).map(key => [key, 0]));
    data.more = false;
  }
  if (scenario === 'read-only' && path === '/api/me') data.canWrite = false;
  if (scenario === 'long-content') {
    if (path === '/api/me') {
      const name = 'A workspace for a deliberately long cross-agent project and research context';
      data.org.name = name;
      data.orgs = data.orgs.map((org: { id: number }) => org.id === data.org.id ? { ...org, name } : org);
    }
    if (path === '/api/pages' && data.pages?.[0]) data.pages[0].title = 'A deliberately long memory title about decisions, implementation constraints, and everything the next agent needs to understand';
    if (path === '/api/activities' && data.activities?.[0]) {
      data.activities[0].taskTitle = 'Review a deliberately long cross-agent task with detailed implementation constraints and a narrow-screen layout';
    }
  }
  return Response.json(data, { status: response.status, headers: response.headers });
}

export function uiReviewPage(head = false): Response {
  const views = [['activity', 'Activity'], ['memory', 'Memory'], ['connect', 'Connections'], ['attention', 'Attention'], ['sharing', 'Sharing'], ['workspace', 'Workspace'], ['billing', 'Plan & billing'], ['showcase', 'Public profile']];
  const html = `<!doctype html><html lang="en" data-design-system="signal"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Interaction review · Engram</title><link rel="stylesheet" href="/design-system.css"><style>body{padding:var(--ds-space-8)}main{max-width:1100px;margin:auto;display:grid;gap:var(--ds-space-6)}.review-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:var(--ds-space-4)}article{display:grid;gap:var(--ds-space-4)}nav{display:flex;flex-wrap:wrap;gap:var(--ds-space-2)}h1{font-size:var(--ds-text-2xl)}p{color:var(--ds-muted)}@media(max-width:600px){body{padding:var(--ds-space-4)}}</style></head><body><main><div class="ds-heading-group"><span class="ds-badge" data-tone="accent">Local interaction review</span><h1>Every view. The states in between.</h1><p>Actual app components with sample data. Scenarios affect only API requests from the selected review document. No email, provider, or payment request is sent. Loading deliberately slows fixture requests; errors and empty lists are simulated.</p></div><nav><a class="ds-button" href="/design-system">Shared components</a><a class="ds-button" href="/__mail-preview">Email states</a><a class="ds-button" href="/app#signin">Sign-in</a><a class="ds-button" href="/app#invite">Invitation</a></nav><section class="review-grid">${[...scenarios].map(state => `<article class="ds-card"><h2>${state.replaceAll('-', ' ')}</h2><nav aria-label="${state} views">${views.map(([view, label]) => `<a class="ds-button small" href="/__ui-review/app?state=${state}#${view}">${label}</a>`).join('')}</nav></article>`).join('')}</section></main></body></html>`;
  return new Response(head ? null : html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" } });
}

// Generated screenshots stay out of the repository and contain fixture data.
// Only fixed image basenames inside this local review directory are served.
export async function uiReviewGallery(req: Request): Promise<Response | null> {
  const url = new URL(req.url), imagePath = url.pathname.match(/^\/__ui-review\/screenshots\/([a-z0-9-]+\.jpg)$/);
  if (url.pathname !== '/__ui-review/gallery' && !imagePath) return null;
  if (!['GET', 'HEAD'].includes(req.method)) return new Response('Method Not Allowed', { status: 405 });
  const directory = join(tmpdir(), 'engram-ui-audit');
  if (imagePath) {
    const image = Bun.file(join(directory, imagePath[1]));
    return new Response(req.method === 'HEAD' ? null : await image.exists() ? image : 'Not Found', { status: await image.exists() ? 200 : 404, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  const manifest = Bun.file(join(directory, 'screenshots.json'));
  const files: string[] = await manifest.exists() ? await manifest.json() : [];
  const width = ['1280', '768', '390', '320'].includes(url.searchParams.get('width') || '') ? url.searchParams.get('width')! : '390';
  const group = ['all', 'ready', 'public', 'states', 'interactions'].includes(url.searchParams.get('group') || '') ? url.searchParams.get('group')! : 'all';
  const isState = (name: string) => /-(loading|empty|error|read-only|long-content)\.jpg$/.test(name);
  const safeFiles = files.filter(name => new RegExp(`^${width}-[a-z0-9-]+\\.jpg$`).test(name)).filter(name => group === 'all' || (group === 'ready' ? name.endsWith('-ready.jpg') : group === 'public' ? name.endsWith('-public.jpg') : group === 'states' ? isState(name) : !name.endsWith('-ready.jpg') && !name.endsWith('-public.jpg') && !isState(name)));
  const html = `<!doctype html><html lang="en" data-design-system="signal"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Screenshot review · Engram</title><link rel="stylesheet" href="/design-system.css"><style>body{padding:24px}main{max-width:1500px;margin:auto}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;margin-top:24px}article{min-width:0;padding:12px;border:1px solid var(--ds-line);border-radius:var(--ds-radius-card);background:var(--ds-surface)}article img{display:block;width:100%;height:auto;background:var(--ds-paper)}article a{display:block;height:480px;overflow:auto;scrollbar-width:thin}h2{font-size:13px;margin-top:12px;overflow-wrap:anywhere}nav{display:flex;flex-wrap:wrap;gap:12px;margin-block:16px}p{color:var(--ds-muted);margin-top:12px}</style></head><body><main><h1>Responsive & interaction review</h1><p>Local sample-data captures. Scroll each capture or open it at full size. ${safeFiles.length} captures in this selection · ${files.length} total. Captures include populated, pending, empty, error, read-only and long-content states.</p><nav>${['1280','768','390','320'].map(size => `<a class="ds-button${size === width ? ' primary' : ''}" href="?width=${size}&amp;group=${group}" ${size === width ? 'aria-current="page"' : ''}>${size}px</a>`).join('')}<a class="ds-button" href="/__ui-review">Run scenarios</a><a class="ds-button" href="/design-system#feedback-states">Motion & state controls</a></nav><nav aria-label="Screenshot groups">${['all','ready','public','states','interactions'].map(value => `<a class="ds-button${group === value ? ' primary' : ''}" href="?width=${width}&amp;group=${value}" ${group === value ? 'aria-current="page"' : ''}>${value === 'ready' ? 'App views' : value[0].toUpperCase()+value.slice(1)}</a>`).join('')}</nav><section class="shots">${safeFiles.map(name => `<article><a href="/__ui-review/screenshots/${name}"><img src="/__ui-review/screenshots/${name}" alt="${name.replaceAll('-', ' ').replace('.jpg', '')}" loading="eager"></a><h2>${name.replaceAll('-', ' ').replace('.jpg', '')}</h2></article>`).join('')}</section></main></body></html>`;
  return new Response(req.method === 'HEAD' ? null : html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'self'" } });
}
