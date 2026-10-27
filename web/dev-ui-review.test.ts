import { describe, expect, test } from 'bun:test';
import { reviewApi, uiReviewScenario } from './dev-ui-review';

const request = (state: string, path = '/api/pages', method = 'GET') => new Request(`http://localhost:8107${path}`, { method, headers: { referer: `http://localhost:8107/__ui-review/app?state=${state}` } });
describe('local interaction review boundaries', () => {
  test('scenarios require a matching review document, origin and allowlisted state', () => {
    expect(uiReviewScenario(request('empty'))).toBe('empty');
    for (const referer of ['http://other.example/__ui-review/app?state=error', 'http://localhost:8107/app?state=error', 'http://localhost:8107/__ui-review/app?state=arbitrary', 'invalid']) {
      expect(uiReviewScenario(new Request('http://localhost:8107/api/pages', { headers: { referer } }))).toBeNull();
    }
  });
  test('empty state keeps pagination and shape and cannot affect another tab', async () => {
    const next = async () => Response.json({ pages: [{ title: 'Example' }], more: true });
    expect(await (await reviewApi(request('empty'), next)).json()).toEqual({ pages: [], more: false });
    expect(await (await reviewApi(new Request('http://localhost:8107/api/pages'), next)).json()).toEqual({ pages: [{ title: 'Example' }], more: true });
  });
  test('mutation failures never call the fixture mutation and preserve session switches', async () => {
    let calls = 0;
    const next = async () => { calls++; return Response.json({ ok: true }); };
    expect((await reviewApi(request('mutation-error', '/api/capture', 'POST'), next)).status).toBe(503);
    expect(calls).toBe(0);
    expect((await reviewApi(request('mutation-error', '/api/session/switch', 'POST'), next)).status).toBe(200);
    expect(calls).toBe(1);
  });
  test('switch-error is scoped to its review document and cannot mutate the fixture session', async () => {
    let calls = 0;
    const next = async () => { calls++; return Response.json({ ok: true }); };
    expect((await reviewApi(request('switch-error', '/api/session/switch', 'POST'), next)).status).toBe(503);
    expect(calls).toBe(0);
    expect((await reviewApi(new Request('http://localhost:8107/api/session/switch', { method: 'POST' }), next)).status).toBe(200);
    expect(calls).toBe(1);
  });
  test('empty Sharing clears received and outgoing content without changing workspace kind', async () => {
    const next = async () => Response.json({ sourceKind: 'team', received: [{ text: 'Approved fixture' }], shares: [{ id: 'fixture' }], more: true });
    expect(await (await reviewApi(request('empty', '/api/sharing'), next)).json()).toEqual({ sourceKind: 'team', received: [], shares: [], more: false });
  });
});
