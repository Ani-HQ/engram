import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProfilePresentationEditor, highlightUrlError, profilePresentationChanged, profilePresentationValue } from './profile-presentation-editor.js';

class Element {
  attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {};
  parentElement: Element | null = null; disabled = false; checked = false; hidden = false; text = ''; validity = ''; _value?: string;
  constructor(public tag: string, text = '') { this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === 'value') this._value = value; if (key === 'checked') this.checked = true; if (key === 'disabled') this.disabled = true; if (key === 'hidden') this.hidden = true; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  get id() { return this.attrs.id || ''; }
  get value() { return this._value ?? (this.tag === 'textarea' ? this.textContent : ''); }
  set value(value: string) { this._value = value; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  replaceChildren(...children: Element[]) { this.children = []; this.text = ''; this.append(...children); }
  addEventListener(type: string, fn: Function) { this.events[type] = fn; }
  setCustomValidity(value: string) { this.validity = value; }
  focus() { (document as any).activeElement = this; }
  fire(type: string) { return this.events[type]?.({ currentTarget: this, target: this, preventDefault() {} }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const byLabel = (node: Element, label: string) => all(node).find(item => item.attrs['aria-label'] === label)!;
const button = (node: Element, text: string) => all(node).find(item => item.tag === 'button' && item.textContent === text)!;
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { activeElement: null, createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element('#text', text) } }));
afterEach(() => Object.assign(globalThis, original));

describe('profile presentation drafts', () => {
  test('old profiles default to studio without changing their identity or adding sample highlights', () => {
    expect(profilePresentationValue({ displayName: 'Ada' })).toEqual({ layout: 'studio', highlights: [] });
    expect(profilePresentationChanged({}, { layout: 'studio', highlights: [] })).toBe(false);
    expect(profilePresentationChanged({}, { layout: 'field-notes', highlights: [] })).toBe(true);
  });
  test('switching layouts keeps edited highlights and does not mutate the saved profile', () => {
    const saved = { layout: 'studio', highlights: [{ title: 'A public decision', body: 'The original note.', url: '' }] };
    const changes: any[] = [], editor = createProfilePresentationEditor({ profile: saved, onChange: value => changes.push(value) });
    const view = editor.element as Element;
    const note = byLabel(view, 'Highlight 1 note'); note.value = 'A revised draft.'; note.fire('input');
    const radio = all(view).find(node => node.tag === 'input' && node.attrs.value === 'field-notes')!;
    radio.checked = true; radio.fire('change');
    expect(editor.read()).toEqual({ layout: 'field-notes', highlights: [{ title: 'A public decision', body: 'A revised draft.', url: '' }] });
    expect(saved.highlights[0].body).toBe('The original note.'); expect(changes).toHaveLength(2);
    expect(profilePresentationChanged(saved, editor.read())).toBe(true);
  });
  test('adding, moving and removing highlights preserves text and restores a useful focus target', () => {
    const editor = createProfilePresentationEditor({ profile: {} }), view = editor.element as Element;
    const add = button(view, 'Add highlight');
    for (const name of ['First', 'Second', 'Third']) { add.fire('click'); const title = document.activeElement as unknown as Element; title.value = name; title.fire('input'); }
    expect(add.disabled).toBe(true); add.fire('click'); expect(editor.read().highlights).toHaveLength(3);
    byLabel(view, 'Move highlight 2 up').fire('click'); expect(editor.read().highlights.map(item => item.title)).toEqual(['Second', 'First', 'Third']);
    expect(document.activeElement).toBe(byLabel(view, 'Move highlight 1 down') as any);
    byLabel(view, 'Remove highlight 2').fire('click'); expect(editor.read().highlights.map(item => item.title)).toEqual(['Second', 'Third']);
    expect(add.disabled).toBe(false); expect(document.activeElement).toBe(byLabel(view, 'Highlight 2 title') as any);
  });
  test('invalid links and blank titles keep drafts and identify the field to correct', () => {
    const editor = createProfilePresentationEditor({ profile: { highlights: [{ title: '', body: 'Do not lose this note.', url: 'javascript:alert(1)' }] } }), view = editor.element as Element;
    expect(editor.validate()).toBe(false); const title = byLabel(view, 'Highlight 1 title'); expect(document.activeElement).toBe(title as any); expect(title.attrs['aria-invalid']).toBe('true');
    title.value = 'A title'; title.fire('input'); expect(title.attrs['aria-invalid']).toBe('false');
    expect(editor.validate()).toBe(false); const link = byLabel(view, 'Highlight 1 public link (optional)'); expect(document.activeElement).toBe(link as any); expect(link.validity).toContain('http');
    link.value = 'https://example.com/public-note'; link.fire('input'); expect(editor.validate()).toBe(true);
    expect(editor.read().highlights[0].body).toBe('Do not lose this note.');
    for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:secret@example.com', '/private/path', 'https:example.com', 'https://example.com/\nprivate']) expect(highlightUrlError(value)).not.toBe('');
    for (const value of ['', ' https://example.com/note ', 'http://localhost:8107/u/sample']) expect(highlightUrlError(value)).toBe('');
  });
  test('pending and obsolete editors cannot change layout, remove records, or notify a new workspace', () => {
    let current = true, calls = 0;
    const editor = createProfilePresentationEditor({ profile: { highlights: [{ title: 'Keep me', body: '', url: '' }] }, isCurrent: () => current, onChange: () => calls++ }), view = editor.element as Element;
    editor.setPending(true); button(view, 'Add highlight').fire('click'); byLabel(view, 'Remove highlight 1').fire('click');
    expect(editor.read().highlights).toHaveLength(1); expect(calls).toBe(0); expect(byLabel(view, 'Highlight 1 title').disabled).toBe(true);
    editor.setPending(false); expect(byLabel(view, 'Highlight 1 title').disabled).toBe(false);
    current = false; button(view, 'Add highlight').fire('click'); byLabel(view, 'Remove highlight 1').fire('click');
    expect(editor.read().highlights).toHaveLength(1); expect(calls).toBe(0);
  });
});
