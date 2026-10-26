import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadingState, memoryStream, observeLoadingMotion, profileAvatar, progressBar, setProgress, statusText } from './design-system.js';

class Element {
  attrs: Record<string, string> = {};
  children: Element[] = [];
  text = '';
  hidden = false;
  listeners: Record<string, Function[]> = {};
  style: Record<string, unknown> = { removeProperty(name: string) { delete this[name]; } };
  constructor(public tag: string) {}
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  append(...children: Element[]) { this.children.push(...children); }
  addEventListener(event: string, callback: Function) { (this.listeners[event] ||= []).push(callback); }
  dispatch(event: string) { for (const callback of this.listeners[event] || []) callback(); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.children = []; this.text = value; }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const hasClass = (node: Element, value: string) => node.attrs.class?.split(' ').includes(value);
const original = globalThis.document;
beforeEach(() => Object.assign(globalThis, { document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag) } }));
afterEach(() => Object.assign(globalThis, { document: original }));

describe('human profile images', () => {
  const publicPhoto = `/api/public/activity/alex-jane/photo.png?v=${'a'.repeat(64)}`;
  const draftPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  test('uses one safe image label and a static local fallback at bounded sizes', () => {
    const label = '<img src=x onerror=alert(1)> Alex’s profile photo';
    const avatar = profileAvatar({ label, size: 'lg' }) as Element;
    expect(avatar.attrs.role).toBe('img'); expect(avatar.attrs['aria-label']).toBe(label);
    expect(avatar.attrs['data-state']).toBe('empty'); expect(avatar.attrs['data-size']).toBe('lg');
    expect(avatar.children).toHaveLength(1); expect(avatar.children[0].tag).toBe('svg');
    expect(avatar.children[0].attrs['aria-hidden']).toBe('true');
    expect(all(avatar).filter(element => element.tag === 'ellipse')).toHaveLength(3);
    expect(all(avatar).some(element => ['img', 'script', 'image', 'animate'].includes(element.tag))).toBe(false);
    expect(avatar.attrs.tabindex).toBeUndefined(); expect(avatar.attrs['aria-busy']).toBeUndefined();
    expect((profileAvatar({ label: ' ', size: 'huge' }) as Element).attrs).toMatchObject({ 'aria-label': 'Profile photo', 'data-size': 'md' });
  });

  test('accepts only versioned local public photos or bounded local PNG drafts', () => {
    for (const src of [publicPhoto, draftPhoto, `/api/public/activity/${'a'.repeat(48)}/photo.png?v=${'0'.repeat(64)}`]) {
      const avatar = profileAvatar({ src }) as Element;
      expect(avatar.attrs['data-state']).toBe('loading');
      const image = avatar.children[1]; expect(image.tag).toBe('img'); expect(image.attrs.src).toBe(src);
      expect(image.attrs.alt).toBe(''); expect(image.attrs['aria-hidden']).toBe('true');
    }
    for (const src of [
      'https://example.com/photo.png', `https://example.com${publicPhoto}`, `//example.com${publicPhoto}`,
      '/photo.png', publicPhoto.replace('alex-jane', 'ab'), publicPhoto.replace('alex-jane', 'a'.repeat(49)),
      publicPhoto.replace('alex-jane', '-alex'), publicPhoto.replace('alex-jane', 'alex--jane'),
      publicPhoto.replace('alex-jane', 'alex%2fjane'), publicPhoto.replace('?v=', '?redirect='), publicPhoto + '&x=1',
      publicPhoto.replace(/a$/, 'A'), publicPhoto.split('?')[0], 'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,<svg/>', 'blob:https://example.com/1', 'javascript:alert(1)', `data:image/png;base64,${'a'.repeat(700_000)}`,
    ]) {
      const avatar = profileAvatar({ src }) as Element;
      expect(avatar.attrs['data-state']).toBe('empty'); expect(all(avatar).some(element => element.tag === 'img')).toBe(false);
    }
  });

  test('image success reveals the same photo and failure retains the labeled fallback', () => {
    const ready = profileAvatar({ src: publicPhoto, label: 'Alex’s profile photo' }) as Element;
    const [fallback, image] = ready.children;
    image.dispatch('load'); expect(ready.attrs['data-state']).toBe('ready');
    expect(ready.children[0]).toBe(fallback); expect(ready.children[1]).toBe(image);
    expect(ready.attrs['aria-label']).toBe('Alex’s profile photo');
    const failed = profileAvatar({ src: draftPhoto }) as Element;
    failed.children[1].dispatch('error'); expect(failed.attrs['data-state']).toBe('error');
    expect(failed.children[1].hidden).toBe(true); expect(failed.children[0].tag).toBe('svg');
    expect(failed.attrs.role).toBe('img'); expect(failed.attrs['aria-label']).toBe('Profile photo');
    expect(failed.attrs.tabindex).toBeUndefined();
  });
});

describe('shared pending and measured progress', () => {
  test('unknown to measured to unknown preserves the bar and fill while exposing only actual counts', () => {
    const bar = progressBar({ label: 'Checking setup' }) as Element;
    const fill = bar.children[0];
    expect(bar.attrs.role).toBe('progressbar');
    expect(bar.attrs['aria-valuenow']).toBeUndefined();
    expect(bar.attrs['data-indeterminate']).toBe('true');
    expect(setProgress(bar, { label: 'Setup checks', value: 2, max: 3, valueText: '2 of 3 checks observed' })).toBe(bar);
    expect(bar.children[0]).toBe(fill);
    expect(bar.attrs['aria-valuenow']).toBe('2');
    expect(bar.attrs['aria-valuemax']).toBe('3');
    expect(bar.attrs['aria-valuetext']).toBe('2 of 3 checks observed');
    expect(fill.style.transform).toBe('scaleX(0.6666666666666666)');
    expect(setProgress(bar, { label: 'Checking setup' })).toBe(bar);
    expect(bar.children[0]).toBe(fill);
    expect(bar.attrs['aria-valuenow']).toBeUndefined();
    expect(bar.attrs['aria-valuetext']).toBeUndefined();
    expect(fill.style.transform).toBeUndefined();
  });

  test('measured counts clamp to their real bounds and nonfinite values remain unknown', () => {
    const bar = progressBar({ value: -1, max: 3 }) as Element;
    expect(bar.attrs['aria-valuenow']).toBe('0');
    expect(bar.children[0].style.transform).toBe('scaleX(0)');
    setProgress(bar, { value: 8, max: 3 });
    expect(bar.attrs['aria-valuenow']).toBe('3');
    expect(bar.children[0].style.transform).toBe('scaleX(1)');
    for (const value of [NaN, Infinity, null]) {
      setProgress(bar, { value, max: 3 });
      expect(bar.attrs['aria-valuenow']).toBeUndefined();
      expect(bar.attrs['data-indeterminate']).toBe('true');
    }
  });

  test('loading has one truthful label, bounded decorative lines and no fabricated stages or percentage', () => {
    const view = loadingState({ label: 'Loading memory…', lines: 100 }) as Element;
    expect(view.attrs.role).toBe('status');
    expect(view.attrs['aria-busy']).toBe('true');
    expect(view.textContent).toBe('Loading memory…');
    expect(view.textContent).not.toMatch(/\d+%|stage|complete|verified|success/i);
    const bars = all(view).filter(node => node.attrs.role === 'progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0].attrs['aria-valuenow']).toBeUndefined();
    const lines = all(view).filter(node => hasClass(node, 'ds-skeleton'));
    expect(lines).toHaveLength(5);
    expect(lines.every(node => !node.textContent)).toBe(true);
    expect(all(loadingState({ label: 'Checking…', compact: true }) as Element).some(node => node.attrs.role === 'progressbar')).toBe(false);
  });
});

test('responsive memory sequence shares exact step copy and keeps labels as safe DOM text', () => {
  const label = '<img src=x onerror=alert(1)> Illustration only.';
  const wrapper = memoryStream({ label }) as Element;
  expect(wrapper.tag).toBe('div');
  const [wide, narrow] = wrapper.children;
  expect(wide.tag).toBe('svg'); expect(narrow.tag).toBe('ol');
  expect(wide.attrs['aria-label']).toBe(label); expect(narrow.attrs['aria-label']).toBe(label);
  expect(narrow.children).toHaveLength(3);
  expect(narrow.children.map(step => step.children.map(child => child.textContent))).toEqual([
    ['01 / CURRENT TASK', 'Agreed context', 'Save agreed context'],
    ['02 / SHARED MEMORY', 'Shared memory', 'Keep the source'],
    ['03 / YOUR NEXT TASK', 'Relevant context', 'Ask for it again'],
  ]);
  for (const step of narrow.children) for (const text of step.children) expect(wide.textContent).toContain(text.textContent);
  expect(all(wrapper).some(node => ['img', 'script', 'iframe'].includes(node.tag))).toBe(false);
  expect(wide.attrs.class).not.toContain('ds-motif-intro');
  const decorative = memoryStream() as Element;
  expect(decorative.children.every(node => node.attrs['aria-hidden'] === 'true')).toBe(true);
});

describe('quiet activity text', () => {
  test('keeps one safe readable label and starts static even when activity is fresh', () => {
    const label = '<img src=x onerror=alert(1)> File activity';
    const active = statusText(label, { active: true, className: 'activity-label' }) as Element;
    expect(active.attrs.class).toBe('ds-status-text activity-label');
    expect(active.attrs['data-active']).toBe('true');
    expect(active.attrs['data-motion-paused']).toBe('true');
    expect(active.textContent).toBe(label);
    expect(active.children[0].textContent).toBe(label);
    expect(active.children[1].attrs['aria-hidden']).toBe('true');
    expect(active.children[1].textContent).toBe('');
    expect(active.children[1].children[0].attrs['data-text']).toBe(label);
    expect(all(active).some(node => ['img', 'script'].includes(node.tag))).toBe(false);
    expect(active.attrs.role).toBeUndefined();
    expect(active.attrs['aria-busy']).toBeUndefined();
    expect((statusText('Completed') as Element).attrs['data-active']).toBe('false');
  });

  test('shares visibility observation and stops observing settled activity without changing its text', () => {
    const saved = { IntersectionObserver: globalThis.IntersectionObserver, MutationObserver: globalThis.MutationObserver, queueMicrotask: globalThis.queueMicrotask };
    const active = statusText('File activity', { active: true }) as Element;
    const listeners = new Map<string, Function>(), queued: Function[] = [];
    const observed = new Set<Element>();
    let intersection: Function, mutation: Function, observedOptions: any, disconnected = false, mutationDisconnected = false;
    const doc = { hidden: false, addEventListener: (event: string, callback: Function) => listeners.set(event, callback), removeEventListener: (event: string) => listeners.delete(event) };
    const root = { querySelectorAll: (selector: string) => { expect(selector).toContain('.ds-status-text[data-active="true"]'); return active.attrs['data-active'] === 'true' ? [active] : []; } };
    try {
      Object.assign(globalThis, {
        document: doc,
        queueMicrotask: (callback: Function) => queued.push(callback),
        IntersectionObserver: class { constructor(callback: Function) { intersection = callback; } observe(target: Element) { observed.add(target); } unobserve(target: Element) { observed.delete(target); } disconnect() { disconnected = true; observed.clear(); } },
        MutationObserver: class { constructor(callback: Function) { mutation = callback; } observe(_root: any, options: any) { observedOptions = options; } disconnect() { mutationDisconnected = true; } },
      });
      const dispose = observeLoadingMotion(root as any);
      expect(observed.has(active)).toBe(true);
      expect(active.attrs['data-motion-paused']).toBe('true');
      expect(observedOptions.attributeFilter).toContain('data-active');
      intersection!([{ target: active, isIntersecting: true }]);
      expect(active.attrs['data-motion-paused']).toBe('false');
      doc.hidden = true; listeners.get('visibilitychange')!();
      expect(active.attrs['data-motion-paused']).toBe('true');
      doc.hidden = false; listeners.get('visibilitychange')!();
      expect(active.attrs['data-motion-paused']).toBe('false');
      intersection!([{ target: active, isIntersecting: false }]);
      expect(active.attrs['data-motion-paused']).toBe('true');
      active.setAttribute('data-active', 'false'); mutation!(); queued.shift()!();
      expect(observed.has(active)).toBe(false);
      expect(active.attrs['data-motion-paused']).toBeUndefined();
      expect(active.textContent).toBe('File activity');
      active.setAttribute('data-active', 'true'); mutation!(); queued.shift()!();
      expect(observed.has(active)).toBe(true);
      dispose();
      expect(disconnected).toBe(true); expect(mutationDisconnected).toBe(true);
      expect(listeners.has('visibilitychange')).toBe(false);
      expect(active.attrs['data-motion-paused']).toBeUndefined();
    } finally { Object.assign(globalThis, saved); }
  });

  test('no visibility observer leaves fresh text static', () => {
    const saved = globalThis.IntersectionObserver;
    try {
      Object.assign(globalThis, { IntersectionObserver: undefined });
      const active = statusText('File activity', { active: true }) as Element;
      expect(typeof observeLoadingMotion({ querySelectorAll: () => [active] } as any)).toBe('function');
      expect(active.attrs['data-motion-paused']).toBe('true');
    } finally { Object.assign(globalThis, { IntersectionObserver: saved }); }
  });
});
