import { describe, expect, test } from 'bun:test';
import { devMailPreview } from './mail-preview';
import { EMAIL_TEMPLATE_IDS } from '../gateway/src/mail-templates';

const request = (path: string, method = 'GET') => devMailPreview(new Request(`http://localhost:8099${path}`, { method }));

describe('local-only email review surface', () => {
  test('serves the gallery and fixed assets with strict local review headers', async () => {
    for (const [path, type] of [['/__mail-preview', 'text/html'], ['/__mail-preview.css', 'text/css'], ['/__mail-preview.js', 'text/javascript']]) {
      const response = (await request(path!))!;
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type!);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
      const head = (await request(path!, 'HEAD'))!;
      expect(head.status).toBe(200); expect(await head.text()).toBe('');
    }
    const html = await (await request('/__mail-preview'))!.text();
    expect(html).toContain('width="390"'); expect(html).toContain('width="640"');
    expect(html.match(/sandbox=""/g)).toHaveLength(2);
    expect(html).toContain('No emails are sent here.');
  });

  test('lists all actual templates as sample data without accepting arbitrary render input', async () => {
    const response = (await request('/__mail-preview/catalogue?email=custom-input%40example.invalid&url=javascript%3Aalert(1)'))!;
    const data = await response.json();
    expect(data.localOnly).toBe(true); expect(data.sampleData).toBe(true);
    expect(data.messages.map((message: any) => message.id)).toEqual([...EMAIL_TEMPLATE_IDS]);
    for (const message of data.messages) {
      expect(message.subject.length).toBeGreaterThan(0); expect(message.preheader.length).toBeGreaterThan(0);
      expect(message.text.length).toBeGreaterThan(0); expect(message.html).toBeUndefined();
      expect(message.text).not.toContain('custom-input@example.invalid'); expect(message.text).not.toContain('javascript:');
    }
  });

  test('renders fixed actual messages in scriptless, form-free sandboxed documents', async () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      const response = (await request(`/__mail-preview/message/${id}?url=https%3A%2F%2Fevil.invalid`))!;
      expect(response.status).toBe(200);
      const csp = response.headers.get('content-security-policy')!;
      for (const rule of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "form-action 'none'", 'sandbox']) expect(csp).toContain(rule);
      const html = await response.text();
      expect(html.toLowerCase()).toContain('engram'); expect(html).not.toContain('evil.invalid');
      expect(html).not.toMatch(/<script|<form|<iframe/i);
      expect(html).toContain('http://localhost:8099/__mail-preview/action');
      expect(await (await request(`/__mail-preview/message/${id}`, 'HEAD'))!.text()).toBe('');
    }
    const inert = (await request('/__mail-preview/action'))!;
    expect(await inert.text()).toContain('No sign-in, verification, authorization, subscription, or unsubscribe action was taken.');
  });

  test('previews all browser preference states and keeps confirmation local and inert', async () => {
    for (const state of ['confirm', 'unsubscribed', 'unavailable']) {
      const response = (await request(`/__mail-preview/preference/${state}`))!;
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("style-src 'self'");
      expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
      expect(html).toContain('Sample page only. No real email preferences have changed.');
      expect(html).toContain('ds-mail-preference');
    }
    const confirmed = (await request('/__mail-preview/preference/confirm', 'POST'))!;
    expect(confirmed.status).toBe(200);
    const html = await confirmed.text();
    expect(html).toContain('Getting-started emails are off.');
    expect(html).toContain('No real email preferences have changed.');
    expect(html).not.toContain('<form');
  });

  test('has no real mutation path and does not claim unrelated or arbitrary asset routes', async () => {
    expect(await request('/app')).toBeNull(); expect(await request('/__mail-preview-evil')).toBeNull();
    for (const path of ['/__mail-preview/message/unknown', '/__mail-preview/secrets.txt', '/__mail-preview/message/login/extra']) expect((await request(path))!.status).toBe(404);
    const response = (await request('/__mail-preview', 'POST'))!;
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
