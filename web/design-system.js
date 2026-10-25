// Shared components. Fixed SVG nodes, text and local product marks:
// no markup parsing, arbitrary asset URLs or external hosts. Motion is opt-in.
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
    const selector = '.ds-spinner, .ds-skeleton, .ds-progress[data-indeterminate="true"]';
    const found = new Set(root.querySelectorAll(selector));
    if (root.matches?.(selector)) found.add(root);
    for (const target of targets.keys()) if (!found.has(target)) { observer.unobserve(target); targets.delete(target); target.removeAttribute('data-motion-paused'); }
    for (const target of found) if (!targets.has(target)) { targets.set(target, false); pause(target, false); observer.observe(target); }
  };
  const changed = () => { if (!queued) { queued = true; queueMicrotask(scan); } };
  const mutation = typeof MutationObserver === 'function' ? new MutationObserver(changed) : null;
  mutation?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-indeterminate'] });
  const visibility = () => { for (const [target, visible] of targets) pause(target, visible); };
  document.addEventListener('visibilitychange', visibility); scan();
  return () => { disposed = true; observer.disconnect(); mutation?.disconnect(); document.removeEventListener('visibilitychange', visibility); for (const target of targets.keys()) target.removeAttribute('data-motion-paused'); targets.clear(); };
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
