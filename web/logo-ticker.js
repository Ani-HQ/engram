// Informational logo lists only. The original list stays in the accessibility
// tree; visual copies are inert/hidden. No interval, frame loop or remote asset.
const tickers = new WeakMap();
const interactive = 'a, button, input, select, textarea, summary, [tabindex], [contenteditable], audio[controls], video[controls]';

export function observeLogoTicker(root, { list = root?.querySelector('[data-ticker-list]'), track = root?.querySelector('.ds-logo-ticker-track'), viewport = root?.querySelector('.ds-logo-ticker-viewport'), speed, reduced = false } = {}) {
  if (tickers.has(root)) return tickers.get(root);
  if (!root || !list || !track || !viewport) return { play: () => false, pause() {}, update() {}, dispose() {} };
  const doc = root.ownerDocument, view = doc.defaultView;
  const preference = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const supported = Boolean(track.animate && view.IntersectionObserver);
  let disposed = false, intersecting = false, hovered = Boolean(root.matches?.(':hover')), focused = root.contains(doc.activeElement), userPaused = false;
  let animation = null, distance = 0, duration = 0, copyCount = 0, queued = false, updating = false, measuredAt = 0;
  const copies = [];
  const isReduced = () => reduced || preference?.matches || Boolean(root.closest?.('[data-motion="reduced"]'));
  const sync = () => {
    if (disposed) return;
    const staticMode = !animation || isReduced();
    const paused = staticMode || userPaused || hovered || focused || doc.hidden || !intersecting;
    root.setAttribute('data-ticker-paused', String(Boolean(paused)));
    if (animation) { if (paused) animation.pause(); else animation.play(); }
  };
  const clear = () => { animation?.cancel(); animation = null; for (const copy of copies) copy.remove(); copies.length = 0; distance = duration = copyCount = 0; root.removeAttribute('data-ticker-enhanced'); };
  const measureVisibility = () => {
    const bounds = root.getBoundingClientRect();
    intersecting = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < view.innerHeight && bounds.left < view.innerWidth;
    measuredAt = view.performance?.now?.() ?? 0;
  };
  function update() {
    if (disposed || updating) return;
    if (!root.isConnected) { dispose(); return; }
    updating = true;
    try {
      if (!supported || isReduced() || !list.children.length || list.querySelector(interactive)) { clear(); sync(); return; }
      root.setAttribute('data-ticker-enhanced', 'true');
      const width = list.getBoundingClientRect().width;
      const viewportWidth = viewport.clientWidth || viewport.getBoundingClientRect().width;
      const velocity = Number(speed ?? view.getComputedStyle(root).getPropertyValue('--ds-ticker-speed')) || 30;
      const nextDuration = width / Math.max(10, Math.min(80, velocity)) * 1000;
      const count = Math.ceil(viewportWidth / width);
      if (!Number.isFinite(count) || width < 1 || count < 1 || count > 16) { clear(); sync(); return; }
      if (animation && Math.abs(distance - width) < .1 && duration === nextDuration && copyCount === count) { sync(); return; }
      const phase = animation && duration ? (Number(animation.currentTime) || 0) % duration / duration : 0;
      clear(); root.setAttribute('data-ticker-enhanced', 'true');
      distance = width; duration = nextDuration; copyCount = count;
      for (let index = 0; index < count; index++) {
        const copy = list.cloneNode(true);
        copy.removeAttribute('id'); copy.removeAttribute('data-ticker-list'); copy.setAttribute('data-ticker-clone', '');
        copy.setAttribute('aria-hidden', 'true'); copy.setAttribute('inert', ''); copy.setAttribute('role', 'presentation');
        for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');
        for (const image of copy.querySelectorAll('img')) image.setAttribute('loading', 'eager');
        track.append(copy); copies.push(copy);
      }
      animation = track.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-distance}px)` }], { duration, iterations: Infinity, easing: 'linear' });
      animation.pause(); animation.currentTime = phase * duration; sync();
    } finally { updating = false; }
  }
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; if (!disposed) update(); }); } };
  const play = () => { if (disposed || !root.isConnected || isReduced()) return false; userPaused = false; measureVisibility(); sync(); return Boolean(animation); };
  const pause = () => { if (!disposed) { userPaused = true; sync(); } };
  const enter = () => { hovered = true; sync(); }, leave = () => { hovered = false; sync(); };
  const focusin = () => { focused = true; sync(); };
  const focusout = event => { if (!root.contains(event.relatedTarget)) { focused = false; sync(); } };
  const visibility = () => sync();
  const restored = event => { if (event.persisted && !disposed && root.isConnected) { measureVisibility(); hovered = Boolean(root.matches?.(':hover')); focused = root.contains(doc.activeElement); update(); sync(); } };
  const pagehide = event => { if (event.persisted) { intersecting = false; sync(); } else dispose(); };
  const observer = supported ? new view.IntersectionObserver(entries => {
    if (disposed) return;
    for (const entry of entries) if (entry.target === root && !(typeof entry.time === 'number' && entry.time < measuredAt)) { intersecting = entry.isIntersecting && entry.intersectionRatio > 0; sync(); }
  }, { threshold: 0 }) : null;
  const resize = view.ResizeObserver ? new view.ResizeObserver(schedule) : null;
  const mutation = view.MutationObserver ? new view.MutationObserver(records => {
    if (!root.isConnected) dispose();
    else if (records.some(record => list.contains(record.target) || record.type === 'attributes' && record.attributeName === 'data-motion')) schedule();
  }) : null;
  function dispose() {
    if (disposed) return;
    disposed = true; observer?.disconnect(); resize?.disconnect(); mutation?.disconnect(); clear();
    root.removeEventListener('pointerenter', enter); root.removeEventListener('pointerleave', leave);
    root.removeEventListener('focusin', focusin); root.removeEventListener('focusout', focusout);
    doc.removeEventListener('visibilitychange', visibility);
    view.removeEventListener('resize', schedule); view.removeEventListener('pageshow', restored); view.removeEventListener('pagehide', pagehide);
    preference?.removeEventListener?.('change', schedule); root.removeAttribute('data-ticker-paused'); tickers.delete(root);
  }
  const api = { play, pause, update, dispose };
  tickers.set(root, api);
  root.addEventListener('pointerenter', enter); root.addEventListener('pointerleave', leave);
  root.addEventListener('focusin', focusin); root.addEventListener('focusout', focusout);
  doc.addEventListener('visibilitychange', visibility); view.addEventListener('resize', schedule);
  view.addEventListener('pageshow', restored); view.addEventListener('pagehide', pagehide);
  preference?.addEventListener?.('change', schedule);
  observer?.observe(root); resize?.observe(viewport); resize?.observe(list);
  mutation?.observe(list, { childList: true, characterData: true, subtree: true });
  if (doc.documentElement) mutation?.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-motion'] });
  update(); doc.fonts?.ready?.then(() => { if (!disposed) update(); });
  return api;
}
