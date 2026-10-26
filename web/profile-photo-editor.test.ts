import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { convertProfilePhoto, createProfilePhotoEditor, profilePhotoChanged, profilePhotoUpdate } from './profile-photo-editor.js';

class Element {
  attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {};
  disabled = false; hidden = false; text = ''; value = ''; files: any[] = []; clicked = 0;
  constructor(public tag: string, text = '') { this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === 'hidden') this.hidden = true; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = []; this.text = ''; this.append(...children); }
  addEventListener(type: string, callback: Function) { this.events[type] = callback; }
  removeEventListener(type: string, callback: Function) { if (this.events[type] === callback) delete this.events[type]; }
  click() { this.clicked++; return this.events.click?.({ currentTarget: this }); }
  focus() { (document as any).activeElement = this; }
  fire(type: string) { return this.events[type]?.({ currentTarget: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const byClass = (node: Element, name: string) => all(node).find(item => item.attrs.class?.split(' ').includes(name))!;
const button = (node: Element, text: string) => all(node).find(item => item.tag === 'button' && item.textContent === text)!;
const input = (node: Element) => all(node).find(item => item.tag === 'input')!;
const feedback = (node: Element) => all(node).find(item => item.attrs.role === 'alert')!;
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: {
  createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element('#text', text)
} }));
afterEach(() => Object.assign(globalThis, original));
const png = 'data:image/png;base64,iVBORw0KGgo=';
const alternate = 'data:image/png;base64,YW5vdGhlcg==';
const file = (attrs = {}) => ({ type: 'image/jpeg', size: 1024, ...attrs });
const deferred = () => {
  let resolve!: (value: string) => void, reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const select = (view: Element, value: any) => { const picker = input(view); picker.files = value ? [value] : []; picker.value = 'selected.jpg'; return picker.fire('change'); };

test('only explicit photo edits send bytes or removal, preserving concurrent changes for other edits', () => {
  expect(profilePhotoUpdate({ photo: png }, { photo: png })).toEqual({});
  expect(profilePhotoUpdate({}, { photo: null })).toEqual({});
  expect(profilePhotoChanged({ photo: null }, {})).toBe(false);
  expect(profilePhotoUpdate({ photo: png }, {})).toEqual({ photo: png });
  expect(profilePhotoUpdate({ photo: alternate }, { photo: png })).toEqual({ photo: alternate });
  expect(profilePhotoUpdate({ photo: null }, { photo: png })).toEqual({ photo: null });
});

describe('profile photo conversion', () => {
  test('rejects unsupported, empty and oversized files before decoding', async () => {
    let decodes = 0;
    const decode = async () => { decodes++; return {} as any; };
    for (const [candidate, message] of [[file({ type: 'image/svg+xml' }), 'Choose a JPG'], [file({ size: 0 }), 'empty'], [file({ size: 5 * 1024 * 1024 + 1 }), 'under 5 MB']] as const) {
      await expect(convertProfilePhoto(candidate, { decode })).rejects.toThrow(message);
    }
    expect(decodes).toBe(0);
  });
  test('honors image orientation, crops the center, and produces a new bounded PNG', async () => {
    let closed = 0, calls: any[] = [], mime = '', options: any;
    const bitmap = { width: 1200, height: 800, close() { closed++; } };
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args: any[]) => calls.push(args) }), toDataURL: (value: string) => { mime = value; return png; } };
    const result = await convertProfilePhoto(file(), { decode: async (_: any, value: any) => { options = value; return bitmap; }, createCanvas: () => canvas });
    expect(options).toEqual({ imageOrientation: 'from-image' });
    expect(calls).toEqual([[bitmap, 200, 0, 800, 800, 0, 0, 256, 256]]);
    expect(canvas.width).toBe(256); expect(canvas.height).toBe(256); expect(mime).toBe('image/png');
    expect(result).toBe(png); expect(closed).toBe(1);
  });
  test('rejects excessive dimensions and closes decoded resources on every failure', async () => {
    let closed = 0, canvases = 0;
    for (const [width, height] of [[9000, 4], [8192, 8192], [0, 2], [NaN, 2]]) {
      await expect(convertProfilePhoto(file(), { decode: async () => ({ width, height, close() { closed++; } }), createCanvas: () => { canvases++; return null as any; } })).rejects.toThrow('too many pixels');
    }
    expect(closed).toBe(4); expect(canvases).toBe(0);
    await expect(convertProfilePhoto(file(), { decode: async () => ({ width: 10, height: 10, close() { closed++; } }), createCanvas: () => ({ getContext: () => null }) })).rejects.toThrow('could not prepare');
    expect(closed).toBe(5);
    await expect(convertProfilePhoto(file(), { decode: async () => ({ width: 10, height: 10, close() { closed++; } }), createCanvas: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,abcd' }) })).rejects.toThrow('could not be prepared');
    expect(closed).toBe(6);
  });
  test('explains unavailable decoding and invalid image bytes', async () => {
    await expect(convertProfilePhoto(file(), { decode: null as any })).rejects.toThrow('current browser');
    await expect(convertProfilePhoto(file(), { decode: async () => { throw new Error('Invalid image bytes'); } })).rejects.toThrow('could not be opened');
  });
});

describe('staged profile photo editor', () => {
  test('opens the native picker, prepares locally, and notifies without saving', async () => {
    let calls = 0, notifications = 0;
    const wait = deferred();
    const editor = createProfilePhotoEditor({ convert: async () => { calls++; return wait.promise; }, onChange: () => notifications++ });
    const view = editor.element as unknown as Element;
    expect(editor.read()).toBeNull(); expect(button(view, 'Remove photo').hidden).toBe(true);
    button(view, 'Upload photo').click(); expect(input(view).clicked).toBe(1);
    const conversion = select(view, file());
    expect(editor.isBusy()).toBe(true); expect(editor.read()).toBeNull(); expect(input(view).value).toBe('');
    expect(view.getAttribute('aria-busy')).toBe('true'); expect(byClass(view, 'profile-photo-progress').hidden).toBe(false);
    expect(button(view, 'Upload photo').disabled).toBe(true); expect(notifications).toBe(1); expect(calls).toBe(1);
    wait.resolve(png); await conversion;
    expect(editor.read()).toBe(png); expect(editor.isBusy()).toBe(false); expect(button(view, 'Change photo').disabled).toBe(false);
    expect(button(view, 'Remove photo').hidden).toBe(false); expect(notifications).toBe(2);
    button(view, 'Remove photo').click(); expect(editor.read()).toBeNull(); expect(notifications).toBe(3);
    expect(document.activeElement).toBe(button(view, 'Upload photo') as any);
  });
  test('invalid selection and decoding failure retain the current photo and allow same-file retry', async () => {
    let attempts = 0;
    const editor = createProfilePhotoEditor({ photo: png, convert: async () => { attempts++; if (attempts === 1) throw new Error('This image could not be opened. Choose another photo.'); return alternate; } });
    const view = editor.element as unknown as Element;
    await select(view, file({ size: 6 * 1024 * 1024 }));
    expect(attempts).toBe(0); expect(editor.read()).toBe(png); expect(feedback(view).textContent).toContain('under 5 MB');
    expect(input(view).value).toBe('');
    await select(view, file());
    expect(editor.read()).toBe(png); expect(editor.isBusy()).toBe(false); expect(feedback(view).hidden).toBe(false);
    await select(view, file());
    expect(editor.read()).toBe(alternate); expect(feedback(view).hidden).toBe(true); expect(input(view).value).toBe('');
  });
  test('removing a photo cancels an in-flight replacement', async () => {
    const wait = deferred(); let notifications = 0;
    const editor = createProfilePhotoEditor({ photo: png, convert: () => wait.promise, onChange: () => notifications++ });
    const view = editor.element as unknown as Element;
    const conversion = select(view, file());
    button(view, 'Remove photo').click(); expect(editor.read()).toBeNull(); expect(editor.isBusy()).toBe(false);
    wait.resolve(alternate); await conversion;
    expect(editor.read()).toBeNull(); expect(notifications).toBe(2);
  });
  test('a later selection wins even if an earlier decoder finishes last', async () => {
    const first = deferred(), second = deferred(); let selected = 0;
    const editor = createProfilePhotoEditor({ convert: () => ++selected === 1 ? first.promise : second.promise });
    const view = editor.element as unknown as Element;
    const old = select(view, file()), recent = select(view, file());
    second.resolve(alternate); await recent; first.resolve(png); await old;
    expect(editor.read()).toBe(alternate); expect(editor.isBusy()).toBe(false);
  });
  test('pending saves, obsolete workspaces and disposal cannot accept late pixels or errors', async () => {
    for (const cancel of ['pending', 'workspace', 'dispose']) {
      let current = true, notifications = 0;
      const wait = deferred();
      const editor = createProfilePhotoEditor({ photo: png, isCurrent: () => current, convert: () => wait.promise, onChange: () => notifications++ });
      const view = editor.element as unknown as Element;
      const conversion = select(view, file());
      if (cancel === 'pending') editor.setPending(true);
      if (cancel === 'workspace') current = false;
      if (cancel === 'dispose') editor.dispose();
      wait.reject(new Error('Late private decode error')); await conversion;
      expect(editor.read()).toBe(png); expect(feedback(view).textContent).not.toContain('Late private'); expect(notifications).toBe(1);
      button(view, 'Remove photo').click(); button(view, 'Change photo').click();
      expect(editor.read()).toBe(png); expect(input(view).clicked).toBe(0);
      if (cancel === 'pending') {
        expect(input(view).disabled).toBe(true); expect(button(view, 'Remove photo').disabled).toBe(true);
        editor.setPending(false); expect(input(view).disabled).toBe(false);
      }
    }
  });
  test('canceling the native file picker leaves the draft untouched', async () => {
    let calls = 0;
    const editor = createProfilePhotoEditor({ photo: png, convert: async () => { calls++; return alternate; } });
    await select(editor.element as unknown as Element, null);
    expect(calls).toBe(0); expect(editor.read()).toBe(png); expect(editor.isBusy()).toBe(false);
  });
});
