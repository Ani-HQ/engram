import { describe, expect, test } from 'bun:test';
import { enhanceSelect, observeSelects, selectPopupPosition } from './select-control.js';

// Small DOM model: native value/selection accessors are deliberately independent
// from rendered menu nodes, so tests detect divergence and accidental commits.
class TextNode {
  nodeType = 3; parentNode: any = null;
  constructor(public textContent: string) {}
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
}
class Element extends EventTarget {
  nodeType = 1; parentNode: any = null; childNodes: any[] = []; attrs = new Map<string, string>();
  style: any = {}; scrollTop = 0; scrollLeft = 0; offsetHeight = 36; clientHeight = 200;
  constructor(public tagName: string, public ownerDocument: any) { super(); }
  get parentElement() { return this.parentNode; }
  get children(): Element[] { return this.childNodes.filter(child => child.nodeType === 1); }
  get isConnected(): boolean { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get className() { return this.getAttribute('class') || ''; } set className(value) { this.setAttribute('class', value); }
  classList = { contains: (name: string) => this.className.split(' ').includes(name), add: (name: string) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); }, remove: (name: string) => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); } };
  get id() { return this.getAttribute('id') || ''; } set id(value) { this.setAttribute('id', value); }
  get title() { return this.getAttribute('title') || ''; } set title(value) { this.setAttribute('title', value); }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(value) { this.toggleAttribute('hidden', value); }
  get disabled() { return this.hasAttribute('disabled'); } set disabled(value) { this.toggleAttribute('disabled', value); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? 0); } set tabIndex(value) { this.setAttribute('tabindex', String(value)); }
  get textContent(): string { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(new TextNode(String(value))); }
  set innerHTML(_value: string) { throw new Error('Markup parsing is not supported'); }
  get offsetTop() { return Math.max(0, this.parentNode?.children.indexOf(this) || 0) * 36; }
  get scrollHeight() { return Math.max(36, this.querySelectorAll('[role="option"]').length * 36 + 8); }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  toggleAttribute(name: string, force?: boolean) { const enabled = force ?? !this.hasAttribute(name); if (enabled) this.setAttribute(name, ''); else this.removeAttribute(name); return enabled; }
  append(...nodes: any[]) { for (const node of nodes) { if (typeof node === 'string') { this.append(new TextNode(node)); continue; } node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  insertBefore(node: any, before: any) { node.remove(); const index = this.childNodes.indexOf(before); node.parentNode = this; this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node); }
  replaceChildren(...nodes: any[]) { for (const node of [...this.childNodes]) node.remove(); this.append(...nodes); }
  remove() { if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  contains(node: any): boolean { return node === this || this.childNodes.some(child => child.nodeType === 1 && child.contains(node)); }
  matches(selector: string): boolean {
    return selector.split(',').some(value => { const query = value.trim();
      if (query === ':disabled') return this.disabled || Boolean(this.parentElement?.closest('fieldset')?.disabled);
      if (query.startsWith('.')) return this.classList.contains(query.slice(1));
      if (query.startsWith('[')) { const match = query.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)!; return match[2] === undefined ? this.hasAttribute(match[1]) : this.getAttribute(match[1]) === match[2]; }
      return this.tagName.toLowerCase() === query.toLowerCase();
    });
  }
  closest(selector: string): any { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focus')); }
  getBoundingClientRect() { return { left: 20, top: 20, width: 200, height: 36, right: 220, bottom: 56 }; }
}
class Option extends Element {
  constructor(doc: any, text: string, value: string) { super('OPTION', doc); this.textContent = text; this.setAttribute('value', value); }
  get value() { return this.getAttribute('value') ?? this.textContent; }
  get text() { return this.textContent; }
  get label() { return this.getAttribute('label') ?? this.textContent; }
  get selected() { const select = this.closest('select'); return Boolean(select && select.options[select.selectedIndex] === this); }
  set selected(value) { const select = this.closest('select'); if (select && value) select.selectedIndex = select.options.indexOf(this); else if (select && this.selected) select.selectedIndex = -1; }
}
class Select extends Element {
  index = 0;
  constructor(doc: any) { super('SELECT', doc); }
  get options(): Option[] { return this.querySelectorAll('option') as Option[]; }
  get selectedIndex() { return this.options.length ? Math.min(this.index, this.options.length - 1) : -1; }
  set selectedIndex(value) { this.index = Number(value); }
  get value() { return this.options[this.selectedIndex]?.value || ''; }
  set value(value) { this.index = this.options.findIndex(option => option.value === String(value)); }
  get required() { return this.hasAttribute('required'); } set required(value) { this.toggleAttribute('required', value); }
  get multiple() { return this.hasAttribute('multiple'); } set multiple(value) { this.toggleAttribute('multiple', value); }
  get size() { return Number(this.getAttribute('size') || 0); } set size(value) { this.setAttribute('size', String(value)); }
  get form() { return this.closest('form'); }
  get labels() { return this.ownerDocument.body.querySelectorAll('label').filter((label: Element) => label.contains(this) || label.getAttribute('for') === this.id); }
  get validity() { return { valid: !this.required || Boolean(this.value) }; }
  get validationMessage() { return this.validity.valid ? '' : 'Choose an option.'; }
  checkValidity() { if (this.validity.valid) return true; this.dispatchEvent(new Event('invalid', { cancelable: true })); return false; }
}
function fixture() {
  const observers: any[] = [];
  const view = Object.assign(new EventTarget(), { Event, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance,
    MutationObserver: class { disconnected = false; callback: Function; constructor(callback: Function) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
  });
  const doc: any = Object.assign(new EventTarget(), { defaultView: view });
  doc.createElement = (tag: string) => new Element(tag.toUpperCase(), doc); doc.createElementNS = (_ns: string, tag: string) => doc.createElement(tag);
  doc.body = doc.createElement('body'); doc.documentElement = doc.body; doc.activeElement = doc.body;
  const form = doc.createElement('form'), label = doc.createElement('label'), native = new Select(doc);
  native.setAttribute('name', 'choice'); native.setAttribute('data-setup-focus', 'agent'); native.required = true;
  native.append(new Option(doc, 'Choose an option', ''), new Option(doc, 'Alpha', 'alpha'), new Option(doc, 'Unavailable', 'disabled'), new Option(doc, 'Beta', 'beta'));
  native.options[2].disabled = true; label.append('Agent source', native); form.append(label); doc.body.append(form);
  return { doc, form, label, native, observers };
}
function key(target: Element, value: string) { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value }); target.dispatchEvent(event); return event; }
const click = (target: Element) => target.dispatchEvent(new Event('click'));

describe('enhanced native select', () => {
  test('opening and highlighting never commit; Escape cancels, Enter commits exactly once', () => {
    const f = fixture(), control = enhanceSelect(f.native)!; let input = 0, change = 0;
    f.native.addEventListener('input', () => input++); f.native.addEventListener('change', () => change++);
    expect(control.trigger.getAttribute('aria-label')).toBe('Agent source');
    expect(control.trigger.getAttribute('data-setup-focus')).toBe('agent');
    key(control.trigger, 'ArrowDown'); key(control.trigger, 'ArrowDown'); key(control.trigger, 'ArrowDown');
    expect(f.native.value).toBe(''); expect(change).toBe(0); expect(control.trigger.getAttribute('aria-activedescendant')).toEndWith('option-3');
    key(control.trigger, 'Escape'); expect(control.popup.hidden).toBe(true); expect(f.native.value).toBe('');
    key(control.trigger, 'End'); key(control.trigger, 'Enter');
    expect(f.native.value).toBe('beta'); expect(input).toBe(1); expect(change).toBe(1); expect(control.popup.hidden).toBe(true);
    key(control.trigger, 'Enter'); key(control.trigger, 'Enter'); expect(change).toBe(1); control.dispose();
  });

  test('Tab commits without preventing natural focus traversal and typeahead only highlights', () => {
    const f = fixture(), control = enhanceSelect(f.native)!; let changes = 0;
    f.native.addEventListener('change', () => changes++);
    key(control.trigger, 'b'); expect(f.native.value).toBe(''); expect(control.trigger.getAttribute('aria-activedescendant')).toEndWith('option-3');
    const tab = key(control.trigger, 'Tab'); expect(tab.defaultPrevented).toBe(false); expect(f.native.value).toBe('beta'); expect(changes).toBe(1); control.dispose();
  });

  test('native setters, no-op polling, option.selected and disabled stay synchronized without events', () => {
    const f = fixture(), control = enhanceSelect(f.native)!; let changes = 0; f.native.addEventListener('change', () => changes++);
    f.native.value = 'alpha'; expect(control.trigger.textContent).toBe('Alpha');
    key(control.trigger, 'End'); const active = control.trigger.getAttribute('aria-activedescendant');
    f.native.value = 'alpha'; expect(control.trigger.getAttribute('aria-activedescendant')).toBe(active);
    f.native.options[3].selected = true; expect(control.trigger.textContent).toBe('Beta'); expect(changes).toBe(0);
    f.native.disabled = true; expect(control.trigger.disabled).toBe(true); expect(control.popup.hidden).toBe(true);
    f.native.disabled = false; expect(control.trigger.disabled).toBe(false); control.dispose();
  });

  test('pre-enhancement/native focus, validity recovery and native reset preserve form behavior', async () => {
    const f = fixture(); f.native.focus(); const control = enhanceSelect(f.native)!;
    expect(f.doc.activeElement).toBe(control.trigger); f.native.focus(); expect(f.doc.activeElement).toBe(control.trigger);
    expect(f.native.getAttribute('name')).toBe('choice'); expect(f.native.checkValidity()).toBe(false);
    expect(control.trigger.getAttribute('aria-invalid')).toBe('true'); expect(f.doc.activeElement).toBe(control.trigger);
    f.native.value = 'alpha'; expect(control.trigger.getAttribute('aria-invalid')).toBeNull();
    f.native.value = ''; f.native.checkValidity(); f.native.required = false; expect(control.trigger.getAttribute('aria-invalid')).toBeNull();
    f.native.value = 'beta'; f.form.dispatchEvent(new Event('reset')); f.native.index = 0; await Promise.resolve();
    expect(control.trigger.textContent).toBe('Choose an option'); control.dispose();
  });

  test('safe labels, groups/hidden rows and empty options preserve menu identity', () => {
    const f = fixture(); f.native.options[2].hidden = true;
    f.native.options[1].textContent = '<img src=x onerror=alert(1)> Alpha';
    const group = f.doc.createElement('optgroup'); group.label = 'Unavailable group'; group.disabled = true; group.append(new Option(f.doc, 'Grouped choice', 'grouped')); f.native.append(group);
    const control = enhanceSelect(f.native)!; click(control.trigger);
    const rows = control.popup.querySelectorAll('[role="option"]'); expect(rows).toHaveLength(4);
    expect(control.popup.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Unavailable group'); expect(rows[3].getAttribute('aria-disabled')).toBe('true');
    expect(rows[1].textContent).toBe('<img src=x onerror=alert(1)> Alpha');
    expect(rows[1].querySelectorAll('img')).toHaveLength(0);
    f.native.value = ''; expect(control.popup.querySelectorAll('[role="option"]')[1]).toBe(rows[1]);
    f.native.replaceChildren(); control.update(); expect(control.trigger.textContent).toBe('No options available');
    expect(control.popup.textContent).toContain('No options available.'); control.dispose();
  });

  test('outside dismissal keeps the original value and repeated mounting is idempotent', () => {
    const f = fixture(), control = enhanceSelect(f.native)!;
    expect(enhanceSelect(f.native)).toBe(control); key(control.trigger, 'End');
    f.doc.dispatchEvent(new Event('pointerdown')); expect(control.popup.hidden).toBe(true); expect(f.native.value).toBe('');
    control.dispose(); control.dispose(); expect(Object.hasOwn(f.native.options[1], 'selected')).toBe(false);
  });

  test('popup stays inside its dialog; commit is settled before a synchronous unmount', () => {
    const f = fixture(), dialog = f.doc.createElement('dialog'); f.doc.body.append(dialog); dialog.append(f.form);
    const control = enhanceSelect(f.native)!; click(control.trigger); expect(control.popup.parentNode).toBe(dialog);
    f.native.addEventListener('change', () => { expect(control.popup.hidden).toBe(true); expect(f.doc.activeElement).toBe(control.trigger); f.form.remove(); control.dispose(); });
    key(control.trigger, 'End'); key(control.trigger, 'Enter'); expect(f.native.value).toBe('beta'); expect(control.popup.isConnected).toBe(false);
  });

  test('dispose restores descriptors without resurrecting a removed/moved native', () => {
    const f = fixture(), control = enhanceSelect(f.native)!;
    expect(Object.hasOwn(f.native, 'value')).toBe(true); f.native.remove(); control.dispose();
    expect(f.native.isConnected).toBe(false); expect(Object.hasOwn(f.native, 'value')).toBe(false);
    expect(f.native.getAttribute('aria-hidden')).toBeNull(); expect(f.native.getAttribute('tabindex')).toBeNull();
    const moved = fixture(), moving = enhanceSelect(moved.native)!, destination = moved.doc.createElement('div'); moved.doc.body.append(destination); destination.append(moved.native); moving.dispose();
    expect(moved.native.parentNode).toBe(destination); expect(destination.children).toEqual([moved.native]);
  });

  test('one lifecycle observer handles new selects, reparenting, removal and native fallback', () => {
    const f = fixture(), owner = observeSelects(f.doc.body); expect(f.observers).toHaveLength(1);
    const extra = new Select(f.doc); extra.append(new Option(f.doc, 'Newly mounted', 'new')); f.doc.body.append(extra); owner.update(); expect(extra.parentNode.classList.contains('ds-select')).toBe(true);
    const oldWrapper = f.native.parentNode, destination = f.doc.createElement('div'); f.doc.body.append(destination); destination.append(f.native); owner.update();
    expect(oldWrapper.isConnected).toBe(false); expect(f.native.parentNode.parentNode).toBe(destination);
    f.native.remove(); owner.update(); expect(f.native.isConnected).toBe(false);
    owner.dispose(); expect(f.observers[0].disconnected).toBe(true);
    const fallback = fixture(); fallback.native.multiple = true; expect(enhanceSelect(fallback.native)).toBeNull(); expect(fallback.native.parentNode).toBe(fallback.label);
    fallback.native.multiple = false; Object.defineProperty(fallback.native, 'value', { value: '', configurable: false });
    expect(enhanceSelect(fallback.native)).toBeNull(); expect(fallback.native.parentNode).toBe(fallback.label);
  });
});

test('popup placement chooses useful space above and clamps to narrow/zoomed viewports', () => {
  const roomy = selectPopupPosition({ left: 300, top: 650, bottom: 694, width: 180 }, { left: 0, top: 0, width: 390, height: 890 }, 320);
  expect(roomy.side).toBe('above'); expect(roomy.maxHeight).toBe(320); expect(roomy.left + roomy.width).toBeLessThanOrEqual(382);
  const zoomed = selectPopupPosition({ left: 430, top: 300, bottom: 344, width: 400 }, { left: 400, top: 200, width: 280, height: 360 }, 500);
  expect(zoomed.width).toBe(264); expect(zoomed.left).toBe(408); expect(zoomed.top).toBeGreaterThanOrEqual(208);
  expect(zoomed.top + zoomed.maxHeight).toBeLessThanOrEqual(552);
});
