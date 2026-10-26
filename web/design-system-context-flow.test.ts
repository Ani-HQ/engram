import { describe, expect, test } from 'bun:test';
import { observeContextFlow } from './design-system.js';

class Events {
  listeners = new Map<string, Set<Function>>();
  addEventListener(name: string, callback: Function) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(callback); }
  removeEventListener(name: string, callback: Function) { this.listeners.get(name)?.delete(callback); }
  emit(name: string, event = {}) { for (const callback of [...this.listeners.get(name) || []]) callback({ type: name, ...event }); }
  get count() { return [...this.listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0); }
}
function fixture({ reduced = false, supported = true, hover = true } = {}) {
  const doc = Object.assign(new Events(), { hidden: false, activeElement: null as any, documentElement: { getAttribute: () => null } });
  const preference = Object.assign(new Events(), { matches: reduced });
  const frames = new Map<number, Function>(), timers = new Map<number, { callback: Function; delay: number }>();
  const observers: any[] = [], removals: any[] = [];
  let sequence = 0, boundsReads = 0;
  const bounds = { top: 900, bottom: 1100, left: 0, right: 400, width: 400, height: 200 };
  const view = Object.assign(new Events(), {
    innerHeight: 800, innerWidth: 1200, performance: { now: () => 100 },
    matchMedia: (query: string) => query.includes('prefers-reduced-motion') ? preference : { matches: hover },
    requestAnimationFrame: (callback: Function) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (callback: Function, delay: number) => { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout: (id: number) => timers.delete(id),
    IntersectionObserver: supported ? class {
      disconnected = false;
      constructor(public callback: Function, public options: { threshold: number[] }) { observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    } : undefined,
    MutationObserver: class {
      disconnected = false;
      constructor(public callback: Function) { removals.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  });
  Object.assign(doc, { defaultView: view });
  const root = Object.assign(new Events(), { ownerDocument: doc, isConnected: true, hovered: false, attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    removeAttribute(name: string) { delete this.attrs[name]; }, closest: () => null,
    matches(selector: string) { return selector === ':hover' && this.hovered; },
    contains(target: any) { return target === this || target === button; },
    getBoundingClientRect: () => { boundsReads++; return bounds; } });
  const button = Object.assign(new Events(), { disabled: false, textContent: '', getAttribute: () => null });
  const enter = (visible = true, ratio = .5) => {
    bounds.top = visible ? 800 - 200 * ratio : 900; bounds.bottom = bounds.top + bounds.height;
    observers[0].callback([{ target: root, isIntersecting: visible, intersectionRatio: visible ? ratio : 0, time: 200 }]);
  };
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); };
  const start = () => { frame(); frame(); };
  const finish = () => { const callbacks = [...timers.values()]; timers.clear(); for (const timer of callbacks) timer.callback(); };
  return { root, button, doc, view, preference, frames, timers, observers, removals, bounds, get boundsReads() { return boundsReads; }, enter, start, finish };
}

describe('finite illustrative context flow', () => {
  test('waits for visibility, finishes one 2640ms sequence and never loops on reentry', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { replayButton: f.button });
    expect(f.root.attrs['data-flow-state']).toBe('idle'); expect(f.frames.size).toBe(0);
    expect(f.observers[0].options.threshold).toEqual([0, .5]);
    f.enter(true, .49); expect(f.frames.size).toBe(0);
    f.enter(); f.start();
    expect(f.root.attrs['data-flow-state']).toBe('playing');
    expect([...f.timers.values()].map(timer => timer.delay)).toEqual([2640]);
    f.finish(); expect(f.root.attrs['data-flow-state']).toBe('complete');
    expect(f.timers.size).toBe(0); f.enter(false); f.enter(); f.start();
    expect(f.root.attrs['data-flow-state']).toBe('idle'); expect(f.timers.size).toBe(0);
    expect(f.root.attrs['aria-busy']).toBeUndefined(); expect(f.root.attrs.role).toBeUndefined();
    controller.dispose();
  });

  test('keyboard use before first entry consumes autoplay but permits later pointer replay', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { replayButton: f.button });
    f.doc.emit('keydown', { key: 'PageDown' }); f.enter(); f.start();
    expect(f.root.attrs['data-flow-state']).toBe('static');
    expect(f.frames.size + f.timers.size).toBe(0);
    f.button.emit('click', { detail: 1 }); f.start();
    expect(f.root.attrs['data-flow-state']).toBe('playing'); expect(f.timers.size).toBe(1);
    f.enter(true, .49); expect(f.root.attrs['data-flow-state']).toBe('playing');
    f.enter(false); expect(f.root.attrs['data-flow-state']).toBe('idle'); expect(f.timers.size).toBe(0);
    controller.dispose();
  });

  test('partial visibility never autoplays and an automatic run still cancels below half visibility', () => {
    const f = fixture(), controller = observeContextFlow(f.root);
    f.enter(true, .2); f.start(); expect(f.frames.size + f.timers.size).toBe(0);
    f.enter(); f.start(); expect(f.root.attrs['data-flow-state']).toBe('playing');
    f.enter(true, .49); expect(f.root.attrs['data-flow-state']).toBe('idle'); expect(f.timers.size).toBe(0);
    controller.dispose();
  });

  test('partial-visibility replay retains its policy through pending frames, observer updates and completion', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { replayButton: f.button });
    f.enter(true, .2); f.button.emit('click', { detail: 1 });
    f.enter(true, .2); f.start(); expect(f.root.attrs['data-flow-state']).toBe('playing');
    f.enter(true, .1); expect(f.timers.size).toBe(1); f.finish();
    expect(f.root.attrs['data-flow-state']).toBe('complete'); expect(f.boundsReads).toBe(1);
    f.enter(true, 0); expect(f.root.attrs['data-flow-state']).toBe('idle'); controller.dispose();
  });

  test('a deliberate replay uses fresh bounds before observer delivery and ignores an older sample', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { replayButton: f.button });
    f.bounds.top = 760; f.bounds.bottom = 960;
    f.button.emit('click', { detail: 1 });
    f.observers[0].callback([{ target: f.root, isIntersecting: false, intersectionRatio: 0, time: 50 }]);
    f.start(); expect(f.root.attrs['data-flow-state']).toBe('playing'); expect(f.boundsReads).toBe(1);
    f.enter(false); expect(f.timers.size).toBe(0); expect(controller.play({ detail: 1 })).toBe(false);
    controller.dispose();
  });

  test('pointer replay interrupts and restarts while stale completions cannot settle a new run', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { replayButton: f.button, autoplay: false });
    f.enter(); expect(f.frames.size).toBe(0);
    f.button.emit('click', { detail: 1 }); f.start();
    const stale = [...f.timers.values()][0].callback;
    f.button.emit('click', { detail: 1 }); expect(f.timers.size).toBe(0); f.start(); stale();
    expect(f.root.attrs['data-flow-state']).toBe('playing'); expect(f.timers.size).toBe(1);
    f.enter(false); expect(f.timers.size).toBe(0); expect(f.frames.size).toBe(0);
    expect(controller.play({ detail: 1 })).toBe(false); controller.dispose();
  });

  test('keyboard replay and reduced motion are immediate static explanations', () => {
    for (const reduced of [false, true]) {
      const f = fixture({ reduced }), controller = observeContextFlow(f.root, { replayButton: f.button, autoplay: false });
      f.enter(true, .2); f.button.emit('click', { detail: reduced ? 1 : 0 });
      expect(f.root.attrs['data-flow-state']).toBe('static');
      expect(f.frames.size).toBe(0); expect(f.timers.size).toBe(0); controller.dispose();
    }
    const f = fixture(), controller = observeContextFlow(f.root, { reduced: true });
    f.enter(); expect(f.root.attrs['data-flow-state']).toBe('static'); expect(f.frames.size).toBe(0); controller.dispose();
  });

  test('hidden documents, keyboard use and preference changes cancel scheduled movement', () => {
    for (const interruption of ['visibility', 'keyboard', 'preference']) {
      const f = fixture(), controller = observeContextFlow(f.root);
      f.enter(); f.start();
      if (interruption === 'visibility') { f.doc.hidden = true; f.doc.emit('visibilitychange'); }
      if (interruption === 'keyboard') f.doc.emit('keydown', { key: 'Tab' });
      if (interruption === 'preference') { f.preference.matches = true; f.preference.emit('change'); }
      expect(f.root.attrs['data-flow-state']).not.toBe('playing');
      expect(f.frames.size).toBe(0); expect(f.timers.size).toBe(0);
      f.doc.hidden = false; f.doc.emit('visibilitychange'); expect(f.frames.size).toBe(0); controller.dispose();
    }
  });

  test('unmount and disposal remove observers, listeners and scheduled work', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { replayButton: f.button });
    f.enter(); f.start(); f.root.isConnected = false; f.removals[0].callback(); controller.dispose();
    expect(f.observers[0].disconnected).toBe(true); expect(f.removals[0].disconnected).toBe(true);
    expect(f.doc.count + f.view.count + f.preference.count + f.button.count).toBe(0);
    expect(f.timers.size + f.frames.size).toBe(0); expect(f.root.attrs['data-flow-state']).toBeUndefined();
    expect(controller.play({ detail: 1 })).toBe(false);
  });

  test('unsupported browsers stay static and disabled replay does not start work', () => {
    const f = fixture({ supported: false }), controller = observeContextFlow(f.root, { replayButton: f.button });
    f.bounds.top = 760; f.bounds.bottom = 960;
    f.button.emit('click', { detail: 1 }); expect(f.root.attrs['data-flow-state']).toBe('static');
    expect(f.timers.size + f.frames.size).toBe(0); controller.dispose();
    const ready = fixture(), disabled = observeContextFlow(ready.root, { replayButton: ready.button, autoplay: false });
    ready.enter(); ready.button.disabled = true;
    expect(disabled.play({ detail: 1 })).toBe(false); expect(ready.frames.size).toBe(0); disabled.dispose();
  });
});

describe('explicit illustrative circuit loop', () => {
  test('starts on entry with no JavaScript loop and preserves a deliberate pause', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseButton: f.button });
    expect(f.root.attrs['data-flow-mode']).toBe('loop'); expect(f.root.attrs['data-flow-paused']).toBe('true');
    expect(f.button.textContent).toBe('Play animation'); expect(f.observers[0].options.threshold).toEqual([0, .01]);
    f.enter(true, .005); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.enter(true, .01); expect(f.root.attrs['data-flow-paused']).toBe('false'); expect(f.frames.size + f.timers.size).toBe(0);
    f.button.emit('click', { detail: 1 }); expect(f.root.attrs['data-flow-paused']).toBe('true'); expect(f.button.textContent).toBe('Resume animation');
    f.enter(false); f.enter(); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.button.emit('click', { detail: 1 }); expect(f.root.attrs['data-flow-paused']).toBe('false'); expect(f.button.textContent).toBe('Pause animation');
    controller.dispose();
  });

  test('a tall mobile composition starts even when half its area cannot fit on screen', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseButton: f.button });
    f.view.innerHeight = 280;
    Object.assign(f.bounds, { top: 0, bottom: 654, height: 654 });
    f.observers[0].callback([{ target: f.root, isIntersecting: true, intersectionRatio: 280 / 654, time: 200 }]);
    expect(f.root.attrs['data-flow-paused']).toBe('false'); expect(f.button.textContent).toBe('Pause animation');
    f.observers[0].callback([{ target: f.root, isIntersecting: false, intersectionRatio: 0, time: 210 }]);
    expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.observers[0].callback([{ target: f.root, isIntersecting: true, intersectionRatio: .1, time: 220 }]);
    expect(f.root.attrs['data-flow-paused']).toBe('false'); controller.dispose();
  });

  test('Play starts the first visible frame before an observer sample arrives', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseButton: f.button });
    Object.assign(f.bounds, { top: 790, bottom: 990 });
    expect(f.button.textContent).toBe('Play animation');
    f.button.emit('click', { detail: 1 });
    expect(f.root.attrs['data-flow-paused']).toBe('false'); expect(f.button.textContent).toBe('Pause animation');
    expect(f.frames.size + f.timers.size).toBe(0); controller.dispose();
  });

  test('viewport and background suspend the same animation timeline and resume only while visible', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseButton: f.button });
    f.enter(); f.enter(false); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.enter(true, .2); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.doc.hidden = true; f.doc.emit('visibilitychange'); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.doc.hidden = false; f.doc.emit('visibilitychange'); expect(f.root.attrs['data-flow-paused']).toBe('false');
    controller.dispose();
  });

  test('reduced motion stays static and keyboard pause/resume updates immediately', () => {
    const reduced = fixture(), staticController = observeContextFlow(reduced.root, { mode: 'loop', pauseButton: reduced.button, reduced: true });
    reduced.enter(); expect(reduced.root.attrs['data-flow-state']).toBe('static'); expect(reduced.button.disabled).toBe(true);
    expect(reduced.button.textContent).toBe('Reduced motion'); expect(staticController.play()).toBe(false); staticController.dispose();
    const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseButton: f.button });
    f.enter(); f.doc.emit('keydown', { key: 'Tab' }); expect(f.root.attrs['data-flow-state']).toBe('static'); expect(f.button.textContent).toBe('Resume animation');
    f.doc.emit('keydown', { key: 'Enter', target: f.button }); f.button.emit('click', { detail: 0 });
    expect(f.root.attrs['data-flow-state']).toBe('playing'); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.preference.matches = true; f.preference.emit('change'); expect(f.root.attrs['data-flow-state']).toBe('static'); expect(f.button.disabled).toBe(true);
    expect(f.frames.size + f.timers.size).toBe(0); controller.dispose();
  });

  test('BFCache restoration reconciles fresh visibility while preserving user and reduced-motion choices', () => {
    for (const choice of ['running', 'paused', 'keyboard', 'reduced']) {
      const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseButton: f.button }); f.enter();
      if (choice === 'paused') controller.pause();
      if (choice === 'keyboard') f.doc.emit('keydown', { key: 'Tab' });
      if (choice === 'reduced') { f.preference.matches = true; f.preference.emit('change'); }
      f.view.emit('pagehide', { persisted: true }); expect(f.root.attrs['data-flow-paused']).toBe('true');
      f.view.emit('pageshow', { persisted: true });
      expect(f.root.attrs['data-flow-paused']).toBe(choice === 'running' ? 'false' : 'true'); expect(f.boundsReads).toBe(1);
      controller.dispose();
    }
  });

  test('loop teardown removes all lifecycle listeners and an absent pause control retains static fallback', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseButton: f.button });
    f.enter(); f.root.isConnected = false; f.removals[0].callback(); controller.dispose();
    expect(f.doc.count + f.view.count + f.preference.count + f.button.count).toBe(0);
    expect(f.observers[0].disconnected && f.removals[0].disconnected).toBe(true);
    expect(f.root.attrs['data-flow-mode']).toBeUndefined(); expect(controller.play()).toBe(false);
    const fallback = fixture(), staticController = observeContextFlow(fallback.root, { mode: 'loop' });
    expect(fallback.root.attrs['data-flow-state']).toBe('static'); expect(fallback.frames.size + fallback.timers.size).toBe(0); staticController.dispose();
  });

  test('explicit interaction-only loops balance hover and focus without sticky touch pause', () => {
    const f = fixture(), controller = observeContextFlow(f.root, { mode: 'loop', pauseOnInteraction: true });
    f.enter(true, .01); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.root.emit('pointerenter', { pointerType: 'mouse' }); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.root.emit('focusin'); f.root.emit('pointerleave'); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.root.emit('focusout', { relatedTarget: f.button }); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.root.emit('focusout', { relatedTarget: null }); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.root.emit('pointerenter', { pointerType: 'touch' }); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.enter(false); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.enter(); f.doc.hidden = true; f.doc.emit('visibilitychange'); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.doc.hidden = false; f.doc.emit('visibilitychange'); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.doc.emit('keydown', { key: 'Tab', target: f.doc }); expect(f.root.attrs['data-flow-state']).toBe('static');
    f.root.emit('pointerleave'); expect(f.root.attrs['data-flow-paused']).toBe('true');
    expect(f.frames.size + f.timers.size).toBe(0);
    f.root.isConnected = false; f.removals[0].callback(); controller.dispose();
    expect(f.root.count + f.doc.count + f.view.count + f.preference.count).toBe(0);
    expect(f.observers[0].disconnected && f.removals[0].disconnected).toBe(true);
  });

  test('interaction-only loops reconcile existing focus and BFCache hover while reduced motion remains static', () => {
    const f = fixture(); f.doc.activeElement = f.button;
    const controller = observeContextFlow(f.root, { mode: 'loop', pauseOnInteraction: true });
    f.enter(); expect(f.root.attrs['data-flow-paused']).toBe('true');
    f.doc.activeElement = null; f.root.emit('focusout', { relatedTarget: null });
    f.root.hovered = true; f.root.emit('pointerenter', { pointerType: 'mouse' });
    f.view.emit('pagehide', { persisted: true }); f.root.hovered = false;
    f.view.emit('pageshow', { persisted: true }); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.root.hovered = true; f.doc.hidden = true; f.doc.emit('visibilitychange');
    f.root.hovered = false; f.doc.hidden = false; f.doc.emit('visibilitychange'); expect(f.root.attrs['data-flow-paused']).toBe('false');
    f.preference.matches = true; f.preference.emit('change'); expect(f.root.attrs['data-flow-state']).toBe('static');
    f.root.emit('pointerleave'); expect(controller.play()).toBe(false); controller.dispose();
    const explicit = fixture(), staticController = observeContextFlow(explicit.root, { mode: 'loop', pauseOnInteraction: true, reduced: true });
    explicit.enter(); expect(explicit.root.attrs['data-flow-state']).toBe('static'); expect(explicit.root.attrs['data-flow-paused']).toBe('true');
    expect(explicit.frames.size + explicit.timers.size).toBe(0); staticController.dispose();
    expect(explicit.root.count + explicit.doc.count + explicit.view.count + explicit.preference.count).toBe(0);
    const touch = fixture({ hover: false }); touch.root.hovered = true;
    const touchController = observeContextFlow(touch.root, { mode: 'loop', pauseOnInteraction: true });
    touch.enter(); expect(touch.root.attrs['data-flow-paused']).toBe('false'); touchController.dispose();
  });
});
