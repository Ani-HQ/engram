// Shared components. Fixed SVG nodes, text and local product marks:
// no markup parsing, arbitrary asset URLs or external hosts. Motion is opt-in.
export { enhanceSelect, observeSelects } from './select-control.js';
export { observeLogoTicker } from './logo-ticker.js';
const namespace = 'http://www.w3.org/2000/svg';
const tones = new Set(['neutral', 'accent', 'lime', 'lilac', 'apricot', 'success', 'warning', 'danger', 'info']);
function node(tag, attrs = {}, text) {
  const element = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function graphic(className, viewBox, label) {
  const svg = node('svg', { xmlns: namespace, viewBox, class: className, focusable: 'false', 'aria-hidden': label ? 'false' : 'true' });
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', String(label)); }
  return svg;
}
function text(svg, value, x, y, className = 'ds-motif-text', attrs = {}) { svg.append(node('text', { x, y, class: className, ...attrs }, value)); }

const orbitAgents = [
  { name: 'Claude', src: '/vendor/simple-icons/claude.svg', x: 104, y: 103, width: 148 },
  { name: 'OpenClaw', src: '/vendor/brands/openclaw.svg', x: 430, y: 40, width: 174 },
  { name: 'Grok Bot', src: '/vendor/brands/grok-bot.png', x: 546, y: 245, width: 164 },
  { name: 'Muse', src: '/vendor/brands/muse.svg', x: 278, y: 430, width: 130 },
  { name: 'Instinct', src: '/vendor/brands/instinct.png', x: 72, y: 383, width: 152 },
];

export function memoryOrbit({ label, className = '', compact = false, motion = 'none', agents = false } = {}) {
  const svg = graphic(['ds-orbit', agents ? 'ds-orbit--agents' : '', compact ? 'ds-orbit--compact' : '', motion === 'intro' ? 'ds-motif-intro' : '', className].filter(Boolean).join(' '), '0 0 720 520', label);
  const paths = node('g', { class: 'ds-motif-rings' });
  paths.append(node('rect', { x: 116, y: 86, width: 488, height: 348, rx: 8, class: 'ds-motif-track' }),
    node('path', { d: 'M190 272h84m172-20h42M360 156v34m0 140v38M190 292h42v98h230', class: 'ds-motif-line' }));
  const core = node('g', { class: 'ds-motif-core' });
  core.append(node('rect', { x: 274, y: 190, width: 172, height: 140, rx: 8, class: 'ds-motif-lime' }),
    node('rect', { x: 284, y: 200, width: 152, height: 120, rx: 4, class: 'ds-motif-track' }));
  text(core, 'shared', 360, 252, 'ds-motif-editorial', { 'text-anchor': 'middle' });
  text(core, 'memory', 360, 284, 'ds-motif-editorial', { 'text-anchor': 'middle', fill: 'var(--ds-accent)' });
  svg.append(paths, core);
  if (agents) {
    for (const [index, agent] of orbitAgents.entries()) {
      const pod = node('g', { class: 'ds-motif-node ds-motif-agent', 'data-order': index });
      pod.append(node('title', {}, agent.name),
        node('rect', { x: agent.x, y: agent.y, width: agent.width, height: 62, rx: 6, class: 'ds-motif-paper' }),
        node('rect', { x: agent.x + 11, y: agent.y + 11, width: 40, height: 40, rx: 5, fill: 'var(--ds-inverse)' }),
        node('image', { href: agent.src, x: agent.x + 16, y: agent.y + 16, width: 30, height: 30, preserveAspectRatio: 'xMidYMid meet', class: 'ds-motif-agent-mark' }));
      text(pod, agent.name, agent.x + 62, agent.y + 38, 'ds-motif-text');
      svg.append(pod);
    }
  } else {
    const labels = [
      { x: 55, y: 240, width: 135, title: 'Useful context', caption: 'CONTEXT' },
      { x: 488, y: 220, width: 177, title: 'Agreed decisions', caption: 'REMEMBER' },
      { x: 282, y: 368, width: 158, title: 'The next task', caption: 'RECALL' },
    ];
    for (const [index, item] of labels.entries()) {
      const card = node('g', { class: 'ds-motif-node', 'data-order': index });
      card.append(node('rect', { x: item.x, y: item.y, width: item.width, height: 68, rx: 6, class: 'ds-motif-paper' }));
      text(card, item.caption, item.x + 12, item.y + 23, 'ds-motif-mono');
      text(card, item.title, item.x + 12, item.y + 47); svg.append(card);
    }
    for (const [cx, cy] of [[274,272],[446,252],[360,190],[360,330]]) svg.append(node('circle', { cx, cy, r: 3, fill: 'var(--ds-accent)' }));
  }
  return svg;
}

export function memoryStream({ label, className = '', motion = 'none' } = {}) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('class', ['ds-memory-stream', typeof className === 'string' ? className : ''].filter(Boolean).join(' '));
  const svg = graphic(['ds-memory-stream-graphic', motion === 'intro' ? 'ds-motif-intro' : ''].filter(Boolean).join(' '), '0 0 900 260', label);
  svg.append(node('path', { d: 'M242 128h80m-9-7 9 7-9 7m255-7h83m-9-7 9 7-9 7', class: 'ds-motif-line', 'stroke-width': 2 }), node('path', { d: 'M133 182Q450 290 765 182', class: 'ds-motif-track' }));
  const cards = [
    { x: 22, width: 220, tone: 'paper', title: 'Agreed context', label: '01 / CURRENT TASK', description: 'Save agreed context' },
    { x: 328, width: 235, tone: 'lime', title: 'Shared memory', label: '02 / SHARED MEMORY', description: 'Keep the source' },
    { x: 655, width: 220, tone: 'lilac', title: 'Relevant context', label: '03 / YOUR NEXT TASK', description: 'Ask for it again' },
  ];
  const steps = document.createElement('ol'); steps.setAttribute('class', 'ds-memory-stream-steps'); steps.setAttribute('role', 'list');
  if (label) steps.setAttribute('aria-label', String(label));
  else steps.setAttribute('aria-hidden', 'true');
  for (const [index, card] of cards.entries()) {
    const group = node('g', { class: 'ds-motif-node', 'data-order': index });
    group.append(node('rect', { x: card.x, y: 57, width: card.width, height: 126, rx: 6, class: `ds-motif-${card.tone}` }));
    text(group, card.label, card.x + 18, 87, 'ds-motif-mono');
    text(group, card.title, card.x + 18, 126, 'ds-motif-text', { 'font-size': 18 });
    text(group, card.description, card.x + 18, 155, 'ds-motif-mono', { 'letter-spacing': 0 }); svg.append(group);
    const step = document.createElement('li'); step.setAttribute('class', 'ds-card ds-heading-group ds-memory-stream-step');
    if (card.tone !== 'paper') step.setAttribute('data-tone', card.tone === 'lime' ? 'accent' : card.tone);
    for (const [tag, className, value] of [['span', 'ds-eyebrow', card.label], ['h3', 'ds-memory-stream-step-title', card.title], ['p', 'ds-hint', card.description]]) {
      const content = document.createElement(tag); content.setAttribute('class', className); content.textContent = value; step.append(content);
    }
    steps.append(step);
  }
  wrapper.append(svg, steps);
  return wrapper;
}

export function statusBadge(value, { tone = 'neutral', className = '' } = {}) {
  const badge = document.createElement('span'); badge.className = ['ds-badge', typeof className === 'string' ? className : ''].filter(Boolean).join(' '); badge.dataset.tone = tones.has(tone) ? tone : 'neutral'; badge.textContent = String(value); return badge;
}

/** Compact, text-only evidence. Unknown values must be supplied as words, not zeroes. */
export function evidenceList(rows = [], { label = 'Recorded evidence' } = {}) {
  const list = document.createElement('dl'); list.setAttribute('class', 'ds-evidence-list'); list.setAttribute('aria-label', String(label));
  for (const item of rows) {
    const row = document.createElement('div'); row.setAttribute('class', 'ds-evidence-row');
    const term = document.createElement('dt'); term.textContent = String(item.label ?? '');
    const value = document.createElement('dd'); value.textContent = String(item.value ?? 'Not measured');
    if (item.note) { const note = document.createElement('small'); note.textContent = String(item.note); value.append(note); }
    row.append(term, value); list.append(row);
  }
  return list;
}

/** Readable status copy, with an optional decorative sheen for fresh work only. */
export function statusText(label, { active = false, className = '' } = {}) {
  const value = String(label);
  const text = document.createElement('span');
  text.setAttribute('class', ['ds-status-text', typeof className === 'string' ? className : ''].filter(Boolean).join(' '));
  text.setAttribute('data-active', String(active === true));
  text.setAttribute('data-motion-paused', 'true');
  const copy = document.createElement('span'); copy.setAttribute('class', 'ds-status-copy'); copy.textContent = value;
  const sheen = document.createElement('span'); sheen.setAttribute('class', 'ds-status-sheen'); sheen.setAttribute('aria-hidden', 'true');
  const shine = document.createElement('span'); shine.setAttribute('class', 'ds-status-shine'); shine.setAttribute('data-text', value);
  sheen.append(shine); text.append(copy, sheen);
  return text;
}

const publicProfilePhoto = /^\/api\/public\/activity\/(?=[a-z0-9-]{3,48}\/photo\.png)[a-z0-9]+(?:-[a-z0-9]+)*\/photo\.png\?v=[a-f0-9]{64}$/;
const draftProfilePhoto = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
/** A human profile identity. The local memory bloom is a fallback, never a status. */
export function profileAvatar({ src = '', label = 'Profile photo', size = 'md' } = {}) {
  const avatar = document.createElement('span');
  avatar.setAttribute('class', 'ds-profile-avatar');
  avatar.setAttribute('data-size', ['sm', 'md', 'lg'].includes(size) ? size : 'md');
  avatar.setAttribute('data-state', 'empty');
  avatar.setAttribute('role', 'img');
  avatar.setAttribute('aria-label', typeof label === 'string' && label.trim() ? label : 'Profile photo');
  const bloom = graphic('ds-profile-avatar-fallback', '0 0 112 112');
  bloom.append(node('circle', { cx: 56, cy: 56, r: 39, class: 'ds-profile-avatar-halo' }),
    node('circle', { cx: 56, cy: 56, r: 23, class: 'ds-profile-avatar-core' }));
  for (const rotation of [-30, 30, 90]) bloom.append(node('ellipse', { cx: 56, cy: 56, rx: 33, ry: 13, transform: `rotate(${rotation} 56 56)`, class: 'ds-profile-avatar-orbit' }));
  bloom.append(node('path', { d: 'M56 49 63 56 56 63 49 56Z', class: 'ds-profile-avatar-seed' }),
    node('circle', { cx: 84.6, cy: 39.5, r: 2.5, class: 'ds-profile-avatar-seed' }),
    node('circle', { cx: 27.4, cy: 72.5, r: 2.5, class: 'ds-profile-avatar-seed' }));
  avatar.append(bloom);
  // Only the bounded local upload pipeline can supply images. No remote tracking,
  // SVG, object URL, HTML parsing or third-party image fallback is allowed here.
  if (typeof src !== 'string' || src.length > 700_000 || !(publicProfilePhoto.test(src) || draftProfilePhoto.test(src))) return avatar;
  const image = document.createElement('img');
  image.setAttribute('class', 'ds-profile-avatar-image');
  image.setAttribute('alt', ''); image.setAttribute('aria-hidden', 'true');
  image.setAttribute('width', '112'); image.setAttribute('height', '112');
  image.setAttribute('decoding', 'async'); image.setAttribute('draggable', 'false');
  avatar.setAttribute('data-state', 'loading');
  image.addEventListener('load', () => avatar.setAttribute('data-state', 'ready'), { once: true });
  image.addEventListener('error', () => { avatar.setAttribute('data-state', 'error'); image.hidden = true; }, { once: true });
  image.setAttribute('src', src); avatar.append(image);
  return avatar;
}

/** A resource identity with a locally rendered mark. Text never becomes markup. */
export function resourceChip(value, { visual, trailing, onClick, title, actionLabel, disabled = false } = {}) {
  const interactive = typeof onClick === 'function';
  const chip = document.createElement(interactive ? 'button' : 'span');
  chip.className = 'ds-resource-chip';
  chip.setAttribute('title', String(title || value));
  if (interactive) {
    chip.setAttribute('type', 'button'); chip.disabled = Boolean(disabled);
    if (actionLabel) chip.setAttribute('aria-label', String(actionLabel));
    chip.addEventListener('click', onClick);
  }
  if (visual instanceof Node) {
    const mark = document.createElement('span'); mark.className = 'ds-resource-chip-mark'; mark.setAttribute('aria-hidden', 'true'); mark.append(visual); chip.append(mark);
  }
  const label = document.createElement('span'); label.className = 'ds-resource-chip-label'; label.textContent = String(value); chip.append(label);
  if (trailing instanceof Node) { trailing.setAttribute('aria-hidden', 'true'); chip.append(trailing); }
  return chip;
}

export function sticker(value, { tone = 'lime', tilt = 'left' } = {}) {
  const badge = statusBadge(value, { tone }); badge.className = `ds-sticker${['left', 'right'].includes(tilt) ? ` ds-sticker--${tilt}` : ''}`; return badge;
}

const progressFills = new WeakMap();
/** Measured work uses a value; unknown-duration work deliberately omits it. */
export function progressBar({ label = 'Progress', value, max = 100, valueText, className = '' } = {}) {
  const bar = document.createElement('div');
  bar.setAttribute('class', ['ds-progress', typeof className === 'string' ? className : ''].filter(Boolean).join(' '));
  bar.setAttribute('role', 'progressbar');
  const fill = document.createElement('span'); fill.setAttribute('class', 'ds-progress-fill'); fill.setAttribute('aria-hidden', 'true');
  bar.append(fill); progressFills.set(bar, fill);
  return setProgress(bar, { label, value, max, valueText });
}

export function setProgress(bar, { label = 'Progress', value, max = 100, valueText } = {}) {
  if (!bar) return bar;
  const measured = typeof value === 'number' && Number.isFinite(value);
  const total = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : 100;
  const current = measured ? Math.min(total, Math.max(0, value)) : null;
  bar.setAttribute('aria-label', String(label || 'Progress'));
  bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-busy', String(!measured)); bar.setAttribute('data-indeterminate', String(!measured));
  if (measured) bar.setAttribute('aria-valuenow', String(current));
  else bar.removeAttribute?.('aria-valuenow');
  if (typeof valueText === 'string' && valueText) bar.setAttribute('aria-valuetext', valueText);
  else bar.removeAttribute?.('aria-valuetext');
  const fill = progressFills.get(bar) || bar.querySelector?.('.ds-progress-fill');
  // Direct CSSOM assignment preserves the existing CSP: no inline style string
  // or dynamic stylesheet is parsed. The only value is a bounded numeric ratio.
  if (fill?.style) {
    if (measured) fill.style.transform = `scaleX(${current / total})`;
    else fill.style.removeProperty('transform');
  }
  return bar;
}

/** A labeled pending read. Its request owner replaces it on success or failure. */
export function loadingState({ label = 'Loading…', description = '', compact = false, lines = 0 } = {}) {
  const wrapper = document.createElement('div'); wrapper.setAttribute('class', 'ds-loading');
  wrapper.setAttribute('role', 'status'); wrapper.setAttribute('aria-live', 'polite'); wrapper.setAttribute('aria-busy', 'true');
  wrapper.setAttribute('data-compact', String(Boolean(compact)));
  const spinner = document.createElement('span'); spinner.setAttribute('class', 'ds-spinner'); spinner.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div'); body.setAttribute('class', 'ds-loading-body');
  const title = document.createElement('span'); title.setAttribute('class', 'ds-loading-label'); title.textContent = String(label); body.append(title);
  if (description) { const detail = document.createElement('span'); detail.setAttribute('class', 'ds-loading-description'); detail.textContent = String(description); body.append(detail); }
  wrapper.append(spinner, body);
  if (!compact) wrapper.append(progressBar({ label: String(label), valueText: 'Waiting for the current request.' }));
  const lineCount = Number.isInteger(lines) ? Math.min(5, Math.max(0, lines)) : 0;
  if (!compact && lineCount) {
    const scaffold = document.createElement('div'); scaffold.setAttribute('class', 'ds-loading-lines'); scaffold.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < lineCount; index++) { const line = document.createElement('span'); line.setAttribute('class', 'ds-skeleton'); scaffold.append(line); }
    wrapper.append(scaffold);
  }
  return wrapper;
}

/** One observer pair per live surface; dispose when that surface unmounts. */
export function observeLoadingMotion(root = document) {
  if (!root?.querySelectorAll || typeof IntersectionObserver !== 'function') return () => {};
  const targets = new Map();
  let disposed = false, queued = false;
  const pause = (target, visible) => {
    target.setAttribute('data-motion-paused', String(document.hidden || !visible));
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (targets.has(entry.target)) {
      targets.set(entry.target, entry.isIntersecting); pause(entry.target, entry.isIntersecting);
    }
  });
  const scan = () => {
    queued = false; if (disposed) return;
    const selector = '.ds-spinner, .ds-skeleton, .ds-progress[data-indeterminate="true"], .ds-status-text[data-active="true"]';
    const found = new Set(root.querySelectorAll(selector));
    if (root.matches?.(selector)) found.add(root);
    for (const target of targets.keys()) if (!found.has(target)) { observer.unobserve(target); targets.delete(target); target.removeAttribute('data-motion-paused'); }
    for (const target of found) if (!targets.has(target)) { targets.set(target, false); pause(target, false); observer.observe(target); }
  };
  const changed = () => { if (!queued) { queued = true; queueMicrotask(scan); } };
  const mutation = typeof MutationObserver === 'function' ? new MutationObserver(changed) : null;
  mutation?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-indeterminate', 'data-active'] });
  const visibility = () => { for (const [target, visible] of targets) pause(target, visible); };
  document.addEventListener('visibilitychange', visibility); scan();
  return () => { disposed = true; observer.disconnect(); mutation?.disconnect(); document.removeEventListener('visibilitychange', visibility); for (const target of targets.keys()) target.removeAttribute('data-motion-paused'); targets.clear(); };
}

/** One finite illustration, never a request, connection, or activity state. */
export function observeContextFlow(root, { replayButton, pauseOnInteraction = false, mode = 'finite', autoplay = true, reduced = false } = {}) {
  if (mode === 'loop') return observeLoopingContextFlow(root, { pauseOnInteraction, autoplay, reduced });
  if (!root?.setAttribute) return { play: () => false, dispose() {} };
  const doc = root.ownerDocument;
  const view = doc?.defaultView;
  const preference = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const supported = Boolean(view?.IntersectionObserver && view?.requestAnimationFrame);
  let disposed = false, seen = false, visible = !supported, intersecting = !supported;
  let manualRun = false, measuredAt = 0, frame = null, timer = null, generation = 0;
  const isReduced = () => reduced || preference?.matches || Boolean(root.closest?.('[data-motion="reduced"]')) || !supported;
  const setState = value => root.setAttribute('data-flow-state', value);
  const stop = (state = isReduced() ? 'static' : 'idle') => {
    generation++;
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (timer !== null) view.clearTimeout(timer);
    frame = timer = null; manualRun = false; measuredAt = 0; setState(state);
  };
  const play = (event, manual = true) => {
    if (disposed || !root.isConnected || doc.hidden || replayButton?.disabled || replayButton?.getAttribute('aria-disabled') === 'true') return false;
    let freshAt = 0;
    // A deliberate action gets one fresh viewport check, never a per-frame read.
    if (manual && root.getBoundingClientRect) {
      const bounds = root.getBoundingClientRect();
      const height = view.innerHeight || doc.documentElement.clientHeight;
      const width = view.innerWidth || doc.documentElement.clientWidth;
      intersecting = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < height && bounds.left < width;
      freshAt = view.performance?.now?.() ?? 0;
    }
    if (!(manual ? intersecting : visible)) { stop(); return false; }
    seen = true; stop(); manualRun = manual; measuredAt = freshAt;
    if (isReduced() || event?.detail === 0 || event?.type === 'keydown' || doc.documentElement?.getAttribute('data-input') === 'keyboard') {
      setState('static'); return true;
    }
    const current = generation;
    const canContinue = () => !doc.hidden && root.isConnected && (manual ? intersecting : visible);
    // Two frames let an interrupted CSS sequence reset without forcing layout.
    frame = view.requestAnimationFrame(() => {
      if (current !== generation || disposed) return;
      if (!canContinue()) { stop(); return; }
      frame = view.requestAnimationFrame(() => {
        if (current !== generation || disposed) return;
        if (!canContinue()) { stop(); return; }
        frame = null;
        setState('playing');
        timer = view.setTimeout(() => {
          if (current !== generation || disposed) return;
          if (!canContinue()) { stop(); return; }
          timer = null; setState('complete');
        }, 2640);
      });
    });
    return true;
  };
  const visibility = () => { if (doc.hidden) stop(); else if (visible && autoplay && !seen) play(undefined, false); };
  const keyboard = event => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) { seen = true; stop('static'); } };
  const changedPreference = () => { if (isReduced()) stop('static'); };
  const replay = event => play(event);
  const pagehide = event => { if (event.persisted) stop(); else dispose(); };
  const observer = supported ? new view.IntersectionObserver(entries => {
    if (disposed) return;
    for (const entry of entries) if (entry.target === root) {
      // Ignore an observer sample taken before a deliberate fresh bounds check.
      if (manualRun && typeof entry.time === 'number' && entry.time < measuredAt) continue;
      intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
      visible = entry.isIntersecting && entry.intersectionRatio >= .5;
      if (!intersecting || (!visible && !manualRun)) stop();
      else if (visible && !doc.hidden && autoplay && !seen) play(undefined, false);
    }
  }, { threshold: [0, .5] }) : null;
  const removal = view?.MutationObserver ? new view.MutationObserver(() => { if (!root.isConnected) dispose(); }) : null;
  function dispose() {
    if (disposed) return;
    stop('idle'); disposed = true;
    observer?.disconnect(); removal?.disconnect();
    doc?.removeEventListener('visibilitychange', visibility); doc?.removeEventListener('keydown', keyboard);
    view?.removeEventListener('pagehide', pagehide); replayButton?.removeEventListener('click', replay);
    preference?.removeEventListener?.('change', changedPreference);
    root.removeAttribute('data-flow-state');
  }
  setState(isReduced() ? 'static' : 'idle');
  doc?.addEventListener('visibilitychange', visibility); doc?.addEventListener('keydown', keyboard);
  view?.addEventListener('pagehide', pagehide); replayButton?.addEventListener('click', replay);
  preference?.addEventListener?.('change', changedPreference);
  observer?.observe(root);
  if (doc?.documentElement) removal?.observe(doc.documentElement, { childList: true, subtree: true });
  return { play, dispose };
}

/** Explicitly opted-in decorative loop; CSS owns time, JS owns permission. */
function observeLoopingContextFlow(root, { pauseOnInteraction, autoplay, reduced }) {
  if (!root?.setAttribute) return { play: () => false, pause() {}, dispose() {} };
  const doc = root.ownerDocument, view = doc?.defaultView;
  const preference = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const supported = Boolean(view?.IntersectionObserver);
  // Tall mobile compositions may never fit half their area in the viewport.
  const entryThreshold = .01;
  let disposed = false, entered = false, intersecting = false, userPaused = !autoplay, keyboardPaused = false;
  let hovered = false, focused = false;
  let measuredAt = 0;
  const measureInteraction = () => { if (pauseOnInteraction) { hovered = Boolean(view?.matchMedia?.('(hover: hover)')?.matches && root.matches?.(':hover')); focused = Boolean(doc?.activeElement && root.contains?.(doc.activeElement)); } };
  const isReduced = () => reduced || preference?.matches || Boolean(root.closest?.('[data-motion="reduced"]')) || !supported;
  const measure = () => {
    if (!root.getBoundingClientRect) return;
    const bounds = root.getBoundingClientRect();
    const width = Math.max(0, Math.min(bounds.right, view.innerWidth) - Math.max(0, bounds.left));
    const height = Math.max(0, Math.min(bounds.bottom, view.innerHeight) - Math.max(0, bounds.top));
    intersecting = bounds.width > 0 && bounds.height > 0 && width > 0 && height > 0;
    measuredAt = view.performance?.now?.() ?? 0;
    if (autoplay && intersecting && width * height / (bounds.width * bounds.height) >= entryThreshold) entered = true;
  };
  const sync = () => {
    if (disposed) return;
    const staticMode = isReduced() || keyboardPaused;
    const paused = staticMode || userPaused || hovered || focused || !entered || !intersecting || doc.hidden;
    root.setAttribute('data-flow-state', staticMode ? 'static' : 'playing');
    root.setAttribute('data-flow-paused', String(Boolean(paused)));
  };
  const play = () => {
    if (disposed || !root.isConnected || doc.hidden || isReduced()) return false;
    measure();
    if (!intersecting) return false;
    entered = true; userPaused = keyboardPaused = false; sync(); return true;
  };
  const pause = () => { if (!disposed) { userPaused = true; sync(); } };
  const keyboard = event => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    keyboardPaused = true; sync();
  };
  const visibility = () => { measureInteraction(); sync(); };
  const pointerenter = event => { if (event.pointerType !== 'touch') { hovered = true; sync(); } };
  const pointerleave = () => { hovered = false; sync(); };
  const focusin = () => { focused = true; sync(); };
  const focusout = event => { focused = Boolean(event.relatedTarget && root.contains?.(event.relatedTarget)); sync(); };
  const interactions = pauseOnInteraction ? [['pointerenter', pointerenter], ['pointerleave', pointerleave], ['focusin', focusin], ['focusout', focusout]] : [];
  const pagehide = event => { if (event.persisted) { intersecting = false; sync(); } else dispose(); };
  const pageshow = event => { if (event.persisted && !disposed && root.isConnected) { measure(); measureInteraction(); sync(); } };
  const observer = supported ? new view.IntersectionObserver(entries => {
    if (disposed) return;
    for (const entry of entries) if (entry.target === root) {
      if (typeof entry.time === 'number' && entry.time < measuredAt) continue;
      intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
      if (autoplay && intersecting && entry.intersectionRatio >= entryThreshold) entered = true;
      sync();
    }
  }, { threshold: [0, entryThreshold] }) : null;
  const removal = view?.MutationObserver ? new view.MutationObserver(() => { if (!root.isConnected) dispose(); }) : null;
  function dispose() {
    if (disposed) return;
    disposed = true; observer?.disconnect(); removal?.disconnect();
    doc?.removeEventListener('visibilitychange', visibility); doc?.removeEventListener('keydown', keyboard);
    view?.removeEventListener('pagehide', pagehide); view?.removeEventListener('pageshow', pageshow);
    preference?.removeEventListener?.('change', visibility);
    for (const [name, handler] of interactions) root.removeEventListener(name, handler);
    root.removeAttribute('data-flow-mode'); root.removeAttribute('data-flow-paused'); root.removeAttribute('data-flow-state');
  }
  root.setAttribute('data-flow-mode', 'loop'); measureInteraction(); sync();
  observer?.observe(root); if (doc?.documentElement) removal?.observe(doc.documentElement, { childList: true, subtree: true });
  doc?.addEventListener('visibilitychange', visibility); doc?.addEventListener('keydown', keyboard);
  view?.addEventListener('pagehide', pagehide); view?.addEventListener('pageshow', pageshow);
  preference?.addEventListener?.('change', visibility);
  for (const [name, handler] of interactions) root.addEventListener(name, handler);
  return { play, pause, dispose };
}

/** Decorative shared core layers; the glow variant omits circuit geometry. */
export function contextFlowArt({ variant = 'circuit' } = {}) {
  const art = document.createElement('span'); art.className = 'ds-context-core-art'; art.setAttribute('aria-hidden', 'true');
  const layers = variant === 'glow' ? ['ds-context-glow', 'ds-context-sheen'] : ['ds-context-glow', 'ds-context-ring ds-context-ring--outer', 'ds-context-ring ds-context-ring--inner', 'ds-context-sheen'];
  for (const className of layers) {
    const layer = document.createElement('span'); layer.className = className; art.append(layer);
  }
  if (variant === 'glow') return art;
  for (let index = 0; index < 3; index++) {
    const orbit = document.createElement('span'); orbit.className = 'ds-context-orbit'; orbit.setAttribute('data-orbit', String(index));
    const particle = document.createElement('span'); particle.className = 'ds-context-particle'; orbit.append(particle); art.append(orbit);
  }
  return art;
}

/** Static geometry for an explicitly illustrative highlight, never activity. */
export function highlightArt({ variant = 'orbit', label } = {}) {
  const safeVariant = ['orbit', 'grid', 'layers'].includes(variant) ? variant : 'orbit';
  const svg = graphic(`ds-highlight-art ds-highlight-art--${safeVariant}`, '0 0 480 220', label);
  const attrs = { fill: 'none', stroke: 'var(--ds-line-strong)', 'stroke-width': 1 };
  if (safeVariant === 'orbit') {
    svg.append(node('circle', { cx: 240, cy: 110, r: 57, fill: 'var(--ds-accent-muted)', stroke: 'var(--ds-line-strong)' }),
      node('ellipse', { cx: 240, cy: 110, rx: 122, ry: 42, transform: 'rotate(-18 240 110)', ...attrs }),
      node('ellipse', { cx: 240, cy: 110, rx: 85, ry: 76, transform: 'rotate(24 240 110)', ...attrs }),
      node('circle', { cx: 125, cy: 130, r: 5, fill: 'var(--ds-accent)' }),
      node('circle', { cx: 314, cy: 66, r: 4, fill: 'var(--ds-muted)' }));
  } else if (safeVariant === 'grid') {
    for (let index = 0; index < 7; index++) svg.append(node('path', { d: `M${132 + index * 36} 36v148`, ...attrs }));
    for (let index = 0; index < 5; index++) svg.append(node('path', { d: `M132 ${36 + index * 36}h216`, ...attrs }));
    svg.append(node('rect', { x: 204, y: 72, width: 72, height: 72, rx: 5, fill: 'var(--ds-accent-muted)', stroke: 'var(--ds-accent)' }),
      node('circle', { cx: 240, cy: 108, r: 17, fill: 'none', stroke: 'var(--ds-accent)' }));
  } else {
    for (const [x, y, rotate, fill] of [[142, 75, -13, 'var(--ds-surface-soft)'], [163, 57, -5, 'var(--ds-paper)'], [182, 41, 6, 'var(--ds-accent-muted)']]) svg.append(node('rect', { x, y, width: 156, height: 116, rx: 7, transform: `rotate(${rotate} ${x + 78} ${y + 58})`, fill, stroke: 'var(--ds-line-strong)' }));
    svg.append(node('path', { d: 'M208 81h81m-81 17h62m-62 17h74', stroke: 'var(--ds-accent)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  }
  return svg;
}

/** Local structural thumbnails. No sample names, metrics, or activity claims. */
export function profileLayoutPreview(layout = 'studio') {
  const studio = layout !== 'field-notes';
  const svg = graphic('ds-layout-preview', '0 0 320 190');
  const rect = (x, y, width, height, fill = 'var(--ds-line)', extra = {}) => node('rect', { x, y, width, height, rx: 3, fill, ...extra });
  svg.append(rect(12, 12, 296, 166, 'var(--ds-paper)', { rx: 8, stroke: 'var(--ds-line-strong)' }),
    node('circle', { cx: 35, cy: 32, r: 8, fill: 'var(--ds-surface-soft)' }), rect(50, 25, 90, 5, 'var(--ds-line-strong)'), rect(50, 36, 67, 4), rect(244, 25, 47, 13, 'var(--ds-accent-muted)'));
  if (studio) {
    svg.append(rect(27, 59, 128, 58, 'var(--ds-surface)', { stroke: 'var(--ds-line)' }), rect(165, 59, 128, 58, 'var(--ds-surface)', { stroke: 'var(--ds-line)' }),
      node('circle', { cx: 91, cy: 88, r: 18, fill: 'var(--ds-accent-muted)', stroke: 'var(--ds-line-strong)' }),
      node('ellipse', { cx: 91, cy: 88, rx: 32, ry: 9, transform: 'rotate(-20 91 88)', fill: 'none', stroke: 'var(--ds-accent)' }),
      rect(202, 72, 48, 29, 'var(--ds-surface-soft)', { transform: 'rotate(-10 226 87)', stroke: 'var(--ds-line-strong)' }),
      rect(210, 76, 48, 29, 'var(--ds-accent-muted)', { transform: 'rotate(6 234 91)', stroke: 'var(--ds-line-strong)' }));
    for (let index = 0; index < 7; index++) svg.append(rect(28 + index * 38, 135, 27, 25, index === 3 ? 'var(--ds-accent-muted)' : 'var(--ds-surface-soft)'));
  } else {
    svg.append(rect(27, 57, 97, 92, 'var(--ds-surface)', { stroke: 'var(--ds-line)' }),
      node('circle', { cx: 75, cy: 103, r: 27, fill: 'var(--ds-accent-muted)', stroke: 'var(--ds-line-strong)' }),
      node('ellipse', { cx: 75, cy: 103, rx: 37, ry: 12, transform: 'rotate(-20 75 103)', fill: 'none', stroke: 'var(--ds-accent)' }),
      rect(139, 63, 148, 8, 'var(--ds-line-strong)'), rect(139, 83, 121, 5), rect(139, 96, 145, 5), rect(139, 109, 131, 5), rect(139, 129, 75, 15, 'var(--ds-accent-muted)'), rect(28, 163, 262, 4));
  }
  return svg;
}
