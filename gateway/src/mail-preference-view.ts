/** Pure browser view. The route owns capability validation, status and security headers. */
export type MailPreferenceState = 'confirm' | 'unsubscribed' | 'unavailable';

const content = {
  confirm: {
    title: 'Stop the getting-started emails?',
    description: 'You can keep using Engram without the inbox nudges. Confirm below to stop optional getting-started emails for this account.',
    note: 'Essential emails, such as a sign-in link you request or a workspace invitation, are separate.',
    badge: 'EMAIL PREFERENCES', tone: 'lilac',
  },
  unsubscribed: {
    title: 'Getting-started emails are off.',
    description: 'Your preference is saved. You will no longer receive optional getting-started emails from Engram.',
    note: 'Your workspace, saved context, and agent connections are unchanged. Essential account emails are separate.',
    badge: 'PREFERENCE SAVED', tone: 'lime',
  },
  unavailable: {
    title: 'This email link is unavailable.',
    description: 'It may have expired or been replaced. Open the latest getting-started email and use its preference link, or contact support for help.',
    note: 'No email preferences were changed by opening this page.',
    badge: 'LINK UNAVAILABLE', tone: 'apricot',
  },
} as const;

export function mailPreferencePage(state: MailPreferenceState): string {
  const view = content[state] || content.unavailable;
  const confirmation = state === 'confirm';
  return `<!doctype html><html lang="en" data-design-system="signal"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${confirmation ? 'Email preferences' : state === 'unsubscribed' ? 'Email preference saved' : 'Email link unavailable'} · Engram</title>
<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/design-system.css">
</head><body class="ds-mail-preference"><div class="ds-mail-preference-shell">
<header class="ds-mail-preference-header"><a href="/" aria-label="Engram home"><img src="/brand/engram-mark.svg" width="32" height="32" alt=""><span>engram</span></a><span class="ds-eyebrow">YOUR INBOX. YOUR CALL.</span></header>
<main class="ds-card ds-mail-preference-card" aria-labelledby="mail-preference-title">
<div class="ds-heading-group"><span class="ds-badge" data-tone="${view.tone}">${view.badge}</span><h1 id="mail-preference-title">${view.title}</h1><p>${view.description}</p></div>
<p class="ds-mail-preference-note">${view.note}</p>
${confirmation ? '<form method="post" class="ds-mail-preference-actions"><button class="primary" type="submit">Stop getting-started emails</button><a href="/app#signin">Back to Engram</a></form><p class="ds-mail-preference-hint">Opening this page has not changed your preferences. The button confirms your choice.</p>' : '<div class="ds-mail-preference-actions"><a class="ds-button primary" href="/app#signin">Back to Engram</a><a href="/support">Get support</a></div>'}
</main>
<footer class="ds-mail-preference-footer"><span>Good context stays with you.</span><nav aria-label="Help and privacy"><a href="/support">Support</a><a href="/privacy">Privacy</a></nav></footer>
</div></body></html>`;
}
