import { describe, expect, test } from 'bun:test';
import { mailPreferencePage } from '../gateway/src/mail-preference-view';

describe('mail preference browser views', () => {
  test('confirm is an explicit current-URL POST and never reflects capability input', () => {
    const html = mailPreferencePage('confirm');
    expect(html).toContain('<form method="post"');
    expect(html).toContain('Stop getting-started emails');
    expect(html).toContain('Opening this page has not changed your preferences');
    expect(html).not.toMatch(/\baction=|<input|token=|proof=|unsubscribe=/i);
  });

  test('success and unavailable states have no mutation form', () => {
    const success = mailPreferencePage('unsubscribed'), unavailable = mailPreferencePage('unavailable');
    expect(success).toContain('Your preference is saved.');
    expect(success).toContain('workspace, saved context, and agent connections are unchanged');
    expect(unavailable).toContain('No email preferences were changed');
    for (const html of [success, unavailable]) expect(html).not.toContain('<form');
  });

  test('all variants use local DS assets and work without script or inline styling', () => {
    for (const state of ['confirm', 'unsubscribed', 'unavailable'] as const) {
      const html = mailPreferencePage(state);
      expect(html).toContain('href="/design-system.css"');
      expect(html).toContain('src="/brand/engram-mark.svg"');
      expect(html).toContain('noindex,nofollow'); expect(html).toContain('content="no-referrer"');
      expect(html).toContain('class="ds-heading-group"');
      expect(html).toContain('href="/support"'); expect(html).toContain('href="/app#signin"');
      expect(html).not.toMatch(/<script|<style|\bstyle=|https?:\/\/|\s+on\w+=/i);
    }
  });
});
