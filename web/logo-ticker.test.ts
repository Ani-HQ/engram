import { describe, expect, test } from 'bun:test';
import { observeLogoTicker } from './logo-ticker.js';

class Events {
  listeners = new Map<string, Set<Function>>();
  addEventListener(name: string, callback: Function) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(callback); }
  removeEventListener(name: string, callback: Function) { this.listeners.get(name)?.delete(callback); }
  emit(name: string, event = {}) { for (const callback of [...this.listeners.get(name) || []]) callback({ type: name, ...event }); }
  get listenerCount() { return [...this.listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0); }
}
class Node extends Events {
  attrs: Record<string, string> = {}; children: Node[] = []; parent: Node | null = null; ownerDocument: any;
  isConnected = true; width = 2400; clientWidth = 1000; hovered = false; hasInteractive = false; disabled = false; textContent = ''; title = '';
  bounds = { top: 100, bottom: 260, left: 0, right: 1000, width: 1000, height: 160 };
  constructor(public tag = 'DIV') { super(); }
  get id() { return this.attrs.id; }
  setAttribute(name: string, value: string) { this.attrs[name] = String(value); }
  removeAttribute(name: string) { delete this.attrs[name]; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  append(child: Node) { child.remove(); child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  contains(node: any): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string) { return selector === ':hover' && this.hovered; }
  closest() { return null; }
  querySelector() { return this.hasInteractive ? new Node('A') : null; }
  querySelectorAll(selector: string): Node[] { return this.children.flatMap(child => [...(selector === 'img' ? child.tag === 'IMG' ? [child] : [] : child.attrs.id ? [child] : []), ...child.querySelectorAll(selector)]); }
  getBoundingClientRect() { return this.tag === 'UL' ? { ...this.bounds, width: this.width } : this.bounds; }
  cloneNode() { const copy = new Node(this.tag); copy.attrs = { ...this.attrs }; copy.textContent = this.textContent; for (const child of this.children) copy.append(child.cloneNode()); return copy; }
}
function fixture({ reduced = false, supported = true, stored = null as string | null } = {}) {
  const io: any[] = [], ro: any[] = [], mo: any[] = [], animations: any[] = [], storage = new Map<string, string>();
  const preference = Object.assign(new Events(), { matches: reduced });
  if (stored !== null) storage.set('test:logos', stored);
  const view = Object.assign(new Events(), {
    innerWidth: 1280, innerHeight: 800, performance: { now: () => 100 },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    matchMedia: () => preference, getComputedStyle: () => ({ getPropertyValue: () => '30' }),
    IntersectionObserver: class { disconnected = false; constructor(public callback: Function) { io.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    ResizeObserver: class { disconnected = false; constructor(public callback: Function) { ro.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    MutationObserver: class { disconnected = false; constructor(public callback: Function) { mo.push(this); } observe() {} disconnect() { this.disconnected = true; } },
  });
  const doc = Object.assign(new Events(), { defaultView: view, hidden: false, activeElement: new Node(), documentElement: new Node() });
  const root = new Node(), list = new Node('UL'), track: any = new Node(), viewport = new Node(), button = new Node('BUTTON');
  root.ownerDocument = doc; root.setAttribute('id', 'logos'); list.setAttribute('data-ticker-list', ''); list.setAttribute('id', 'original-list'); list.setAttribute('role', 'list');
  for (let index = 0; index < 21; index++) { const item = new Node('LI'), logo = new Node('IMG'); item.textContent = `Agent ${index + 1}`; item.setAttribute('id', `agent-${index}`); item.append(logo); list.append(item); }
  track.append(list); viewport.append(track); root.append(button); root.append(viewport);
  if (supported) track.animate = (frames: any, options: any) => {
    const animation = { frames, options, currentTime: 0, playState: 'running', cancelled: false,
      pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; }, cancel() { this.cancelled = true; this.playState = 'idle'; } };
    animations.push(animation); return animation;
  };
  const options = { list, track, viewport, pauseButton: button, persistenceKey: 'test:logos' };
  const enter = (visible = true) => { root.bounds.top = visible ? 100 : 1000; root.bounds.bottom = root.bounds.top + 160; io.at(-1).callback([{ target: root, isIntersecting: visible, intersectionRatio: visible ? 1 : 0, time: 200 }]); };
  return { root, list, track, viewport, button, options, doc, view, preference, animations, storage, io, ro, mo, enter };
}

describe('accessible local-logo ticker', () => {
  test('one original list plus inert hidden copies fills a seamless measured 30px/sec loop', () => {
    const f = fixture(), controller = observeLogoTicker(f.root, f.options); const animation = f.animations[0];
    expect(f.list.children).toHaveLength(21); expect(f.list.getAttribute('aria-hidden')).toBeNull(); expect(f.track.children).toHaveLength(2);
    const copy = f.track.children[1]; expect(copy.getAttribute('aria-hidden')).toBe('true'); expect(copy.getAttribute('inert')).toBe('');
    expect(copy.getAttribute('data-ticker-list')).toBeNull(); expect(copy.querySelectorAll('[id]')).toHaveLength(0);
    expect(animation.options).toEqual({ duration: 80000, iterations: Infinity, easing: 'linear' });
    expect(animation.frames[1].transform).toBe('translateX(-2400px)'); expect(animation.playState).toBe('paused');
    f.enter(); expect(animation.playState).toBe('running'); expect(f.button.textContent).toBe('Pause logos'); controller.dispose();
  });

  test('hover, focus, offscreen and background freeze the same timeline without changing user preference', () => {
    const f = fixture(), controller = observeLogoTicker(f.root, f.options); f.enter(); const animation = f.animations[0]; animation.currentTime = 2345;
    f.root.emit('pointerenter'); expect(animation.playState).toBe('paused'); f.root.emit('pointerleave'); expect(animation.playState).toBe('running');
    f.root.emit('focusin'); expect(animation.playState).toBe('paused'); f.root.emit('focusout', { relatedTarget: f.doc.activeElement }); expect(animation.playState).toBe('running');
    f.enter(false); expect(animation.playState).toBe('paused'); f.enter();
    f.doc.hidden = true; f.doc.emit('visibilitychange'); expect(animation.playState).toBe('paused'); f.doc.hidden = false; f.doc.emit('visibilitychange');
    expect(animation.currentTime).toBe(2345); expect(animation.playState).toBe('running'); expect(f.storage.size).toBe(0); controller.dispose();
  });

  test('Pause/Resume is immediate, persisted and survives automatic pauses/remounts', () => {
    const f = fixture(), controller = observeLogoTicker(f.root, f.options); f.enter();
    f.button.emit('click', { detail: 0 }); expect(f.animations[0].playState).toBe('paused'); expect(f.button.textContent).toBe('Resume logos'); expect(f.storage.get('test:logos')).toBe('1');
    f.enter(false); f.enter(); expect(f.animations[0].playState).toBe('paused'); controller.dispose();
    const restored = observeLogoTicker(f.root, f.options); f.enter(); expect(f.animations.at(-1).playState).toBe('paused');
    f.button.emit('click', { detail: 0 }); expect(f.button.textContent).toBe('Pause logos'); expect(f.storage.get('test:logos')).toBe('0'); expect(f.animations.at(-1).playState).toBe('running'); restored.dispose();
  });

  test('reduced motion and unsupported/interactive lists retain all original readable items without clipping or copies', async () => {
    const f = fixture({ reduced: true }), controller = observeLogoTicker(f.root, f.options);
    expect(f.root.getAttribute('data-ticker-enhanced')).toBeNull(); expect(f.track.children).toEqual([f.list]); expect(f.list.children).toHaveLength(21); expect(f.button.disabled).toBe(true);
    f.preference.matches = false; f.preference.emit('change'); await Promise.resolve(); expect(f.track.children).toHaveLength(2); f.enter();
    f.preference.matches = true; f.preference.emit('change'); await Promise.resolve(); expect(f.animations[0].cancelled).toBe(true); expect(f.track.children).toEqual([f.list]); controller.dispose();
    for (const interactive of [false, true]) {
      const fallback = fixture({ supported: interactive }); fallback.list.hasInteractive = interactive;
      const staticController = observeLogoTicker(fallback.root, fallback.options); expect(fallback.animations).toHaveLength(0); expect(fallback.track.children).toEqual([fallback.list]); staticController.dispose();
    }
  });

  test('resize preserves cycle position and creates enough copies for a wide viewport', () => {
    const f = fixture(), controller = observeLogoTicker(f.root, f.options); f.enter(); const original = f.animations[0]; original.currentTime = 20000;
    f.list.width = 3000; controller.update(); expect(original.cancelled).toBe(true); expect(f.animations[1].currentTime).toBe(25000); expect(f.animations[1].playState).toBe('running');
    const unchanged = f.animations[1]; controller.update(); expect(f.animations[1]).toBe(unchanged); expect(f.animations).toHaveLength(2);
    f.list.width = 200; controller.update(); expect(f.track.children).toHaveLength(6); expect(f.list.children).toHaveLength(21); controller.dispose();
  });

  test('BFCache restores measured visibility while keeping a persisted user pause', () => {
    for (const paused of [false, true]) {
      const f = fixture(), controller = observeLogoTicker(f.root, f.options); f.enter(); const animation = f.animations[0]; animation.currentTime = 4500;
      if (paused) controller.pause(); f.view.emit('pagehide', { persisted: true }); expect(animation.playState).toBe('paused');
      f.view.emit('pageshow', { persisted: true }); expect(animation.playState).toBe(paused ? 'paused' : 'running'); expect(animation.currentTime).toBe(4500); controller.dispose();
    }
  });

  test('unmount and explicit disposal remove clones/observers/listeners and leave the original list intact', () => {
    const f = fixture(), controller = observeLogoTicker(f.root, f.options); expect(observeLogoTicker(f.root, f.options)).toBe(controller);
    f.root.isConnected = false; f.mo[0].callback([]); controller.dispose();
    expect(f.animations[0].cancelled).toBe(true); expect(f.track.children).toEqual([f.list]); expect(f.list.children).toHaveLength(21);
    expect(f.root.listenerCount + f.button.listenerCount + f.doc.listenerCount + f.view.listenerCount + f.preference.listenerCount).toBe(0);
    expect(f.io[0].disconnected && f.ro[0].disconnected && f.mo[0].disconnected).toBe(true); expect(controller.play()).toBe(false);
  });
});
