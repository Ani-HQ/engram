// Loopback-only review surface. The production gateway never imports this file.
import { EMAIL_TEMPLATE_IDS, renderEmail, type EmailTemplateInput } from '../gateway/src/mail-templates';
import { mailPreferencePage, type MailPreferenceState } from '../gateway/src/mail-preference-view';

const assetRoot = new URL('./', import.meta.url);
const galleryCsp = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const messageCsp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";
const headers = (type: string, csp = galleryCsp) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': csp, 'X-Robots-Tag': 'noindex, nofollow' });

const definitions = [
  { id: 'login', category: 'Transactional', label: 'Sign in', purpose: 'A requested sign-in link, with one clear next action.', shortTiming: 'When requested', trigger: 'A person requests an email sign-in link.', cadence: 'Immediately after that request. This is not part of the onboarding sequence.', skip: 'Do not schedule a reminder for an unused link. The person can request a fresh link.' },
  { id: 'verify-signup', category: 'Transactional', label: 'Verify invited email', purpose: 'Verify the inbox before an invitation becomes a workspace.', shortTiming: 'When requested', trigger: 'A valid email-bound invite code is entered with its matching email.', cadence: 'Immediately after the verification request.', skip: 'A successful code check alone does not admit the person. The email link must be opened and verified.' },
  { id: 'team-invite', category: 'Transactional', label: 'Join a team workspace', purpose: 'Name the workspace and make the invitation’s consequence clear.', shortTiming: 'Owner invitation', trigger: 'A workspace owner sends a membership invitation.', cadence: 'Once per explicit invitation request.', skip: 'Expired, revoked, or already-used invitations cannot grant new access. A fresh invitation is required when appropriate.' },
  { id: 'agent-authorize', category: 'Transactional', label: 'Authorize an agent', purpose: 'Connect the requested agent to the right Engram workspace.', shortTiming: 'When requested', trigger: 'A person starts an agent connector sign-in flow.', cadence: 'Immediately after the connector’s authorization request.', skip: 'Do not imply that receiving this email or opening the link proves a successful agent tool call.' },
  { id: 'welcome', category: 'Welcome & onboarding', label: 'Welcome to Engram', purpose: 'Give a newly verified user one useful starting point.', shortTiming: 'After verification', trigger: 'A fresh invite-created personal account verifies its inbox, its workspace is ready, and complimentary access is active.', cadence: 'Once when eligible. Later steps wait at least 1, 2, and 4 days after the preceding step completes, preventing a burst after delayed setup.', skip: 'No backfill or enrollment on ordinary sign-in, team invitations, or legacy open signup. Stop on unsubscribe, lost owner membership, or revoked invite/access.' },
  { id: 'connect-agent', category: 'Welcome & onboarding', label: 'Connect your first agent', purpose: 'Help the user make the first real connection.', shortTiming: 'Progress-aware follow-up', trigger: 'An eligible new workspace has no successful observed agent receipt yet.', cadence: 'Due 1 day after verification, and at least 1 day after the welcome step completes. One message at most.', skip: 'Skip after at least one successful authenticated, observed agent receipt. Unused keys, email clicks, and agent reports alone do not count. Global exit conditions still apply.' },
  { id: 'first-memory', category: 'Welcome & onboarding', label: 'Save one useful memory', purpose: 'Turn an empty shared space into useful context.', shortTiming: 'Progress-aware follow-up', trigger: 'An eligible new workspace has not completed the successful save-and-recall pair.', cadence: 'Due 3 days after verification, and at least 2 days after the connect step completes or is skipped. One message at most.', skip: 'Skip only after both a successful memory save and a successful recall are observed. Never count a prompt copy or an email click as either. Global exit conditions still apply.' },
  { id: 'second-agent', category: 'Welcome & onboarding', label: 'Carry context forward', purpose: 'Try recalling saved context from the next agent.', shortTiming: 'Progress-aware follow-up', trigger: 'An eligible new workspace has fewer than two observed usable agent identities.', cadence: 'Due 7 days after verification, and at least 4 days after the memory step completes or is skipped. One message at most.', skip: 'Skip when at least two usable agent identities have successful observed receipts. Do not treat a second unused key as a second connected agent. Global exit conditions still apply.' },
] as const;

function sampleInput(id: typeof EMAIL_TEMPLATE_IDS[number], origin: string): EmailTemplateInput {
  const inert = `${origin}/__mail-preview/action`;
  if (id === 'team-invite') return { template: id, url: `${inert}?example=${id}`, orgName: 'Moonshot Studio', invitedBy: 'alex@example.com' };
  if (id === 'agent-authorize') return { template: id, url: `${inert}?example=${id}`, orgName: 'Alex’s workspace', clientName: 'Example agent' };
  if (id === 'login' || id === 'verify-signup') return { template: id, url: `${inert}?example=${id}`, orgName: 'Alex’s workspace' };
  return { template: id, appUrl: `${inert}?example=${id}`, unsubscribeUrl: `${inert}?example=unsubscribe`, orgName: 'Alex’s workspace' };
}

export async function devMailPreview(req: Request): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname;
  if (path !== '/__mail-preview' && !path.startsWith('/__mail-preview/') && !['/__mail-preview.css', '/__mail-preview.js'].includes(path)) return null;
  const preference = path.match(/^\/__mail-preview\/preference\/(confirm|unsubscribed|unavailable)$/);
  const allowedMethods = preference?.[1] === 'confirm' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
  if (!allowedMethods.includes(req.method)) return new Response(null, { status: 405, headers: { Allow: allowedMethods.join(', '), ...headers('text/plain; charset=utf-8') } });
  const head = req.method === 'HEAD';
  const sampleOrigin = `http://localhost:${url.port || '8099'}`;
  if (path === '/__mail-preview' || path === '/__mail-preview.css' || path === '/__mail-preview.js') {
    const extension = path === '/__mail-preview' ? 'html' : path.endsWith('.css') ? 'css' : 'js';
    const type = extension === 'html' ? 'text/html; charset=utf-8' : extension === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    return new Response(head ? null : Bun.file(new URL(`mail-preview.${extension}`, assetRoot)), { headers: headers(type) });
  }
  if (path === '/__mail-preview/catalogue') {
    const messages = definitions.map(definition => {
      const rendered = renderEmail(sampleInput(definition.id, sampleOrigin));
      return { ...definition, subject: rendered.subject, preheader: rendered.preheader, text: rendered.text };
    });
    return new Response(head ? null : JSON.stringify({ localOnly: true, sampleData: true, messages }), { headers: headers('application/json; charset=utf-8') });
  }
  if (path === '/__mail-preview/action') return new Response(head ? null : '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample email action</title><body><h1>This is a sample link.</h1><p>No sign-in, verification, authorization, subscription, or unsubscribe action was taken. Choose the email again in the studio to restore its preview.</p></body></html>', { headers: headers('text/html; charset=utf-8', messageCsp) });
  if (preference) {
    const page = mailPreferencePage(req.method === 'POST' ? 'unsubscribed' : preference[1] as MailPreferenceState).replace('<div class="ds-mail-preference-shell">', '<div class="ds-mail-preference-shell"><aside class="ds-notice ds-mail-preference-preview"><strong>Local preview.</strong> Sample page only. No real email preferences have changed.</aside>');
    return new Response(head ? null : page, { headers: headers('text/html; charset=utf-8', "default-src 'none'; script-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'") });
  }
  const match = path.match(/^\/__mail-preview\/message\/([a-z-]+)$/);
  if (match && (EMAIL_TEMPLATE_IDS as readonly string[]).includes(match[1]!)) {
    const rendered = renderEmail(sampleInput(match[1] as typeof EMAIL_TEMPLATE_IDS[number], sampleOrigin));
    return new Response(head ? null : rendered.html, { headers: headers('text/html; charset=utf-8', messageCsp) });
  }
  return new Response(head ? null : 'Sample preview not found.', { status: 404, headers: headers('text/plain; charset=utf-8') });
}
