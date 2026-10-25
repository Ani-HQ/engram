import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadingState, memoryStream, progressBar, setProgress } from './design-system.js';

class Element {
  attrs: Record<string, string> = {};
  children: Element[] = [];
  text = '';
  style: Record<string, unknown> = { removeProperty(name: string) { delete this[name]; } };
  constructor(public tag: string) {}
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  append(...children: Element[]) { this.children.push(...children); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.children = []; this.text = value; }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const hasClass = (node: Element, value: string) => node.attrs.class?.split(' ').includes(value);
const original = globalThis.document;
beforeEach(() => Object.assign(globalThis, { document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag) } }));
afterEach(() => Object.assign(globalThis, { document: original }));

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
