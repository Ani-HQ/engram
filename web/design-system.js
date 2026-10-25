// Shared decorative components. Fixed SVG nodes, text and local product marks:
// no markup parsing, arbitrary asset URLs or external hosts. Motion is opt-in.
const namespace = 'http://www.w3.org/2000/svg';
const tones = new Set(['neutral', 'lime', 'lilac', 'apricot', 'success', 'warning', 'danger', 'info']);
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
  const rings = node('g', { class: 'ds-motif-rings' });
  rings.append(node('ellipse', { cx: 360, cy: 260, rx: 284, ry: 137, transform: 'rotate(-24 360 260)', class: 'ds-motif-line' }),
    node('ellipse', { cx: 360, cy: 260, rx: 236, ry: 181, transform: 'rotate(33 360 260)', class: 'ds-motif-track' }),
    node('path', { d: 'M110 298Q224 120 360 260T610 222M236 102Q259 359 497 415', class: 'ds-motif-track' }));
  const core = node('g', { class: 'ds-motif-core' });
  core.append(node('circle', { cx: 360, cy: 260, r: 86, class: 'ds-motif-lime' }),
    node('circle', { cx: 360, cy: 260, r: 98, class: 'ds-motif-line', 'stroke-dasharray': '2 9' }));
  text(core, 'shared', 360, 251, 'ds-motif-editorial', { 'text-anchor': 'middle' });
  text(core, 'memory', 360, 286, 'ds-motif-editorial', { 'text-anchor': 'middle' });
  svg.append(rings, core);
  const labels = [
    { x: 55, y: 268, width: 135, fill: 'paper', title: 'the useful bits', caption: 'CONTEXT' },
    { x: 488, y: 118, width: 149, fill: 'apricot', title: 'a good decision', caption: 'REMEMBER' },
    { x: 462, y: 368, width: 158, fill: 'paper', title: 'your next task', caption: 'RECALL' },
  ];
  for (const [index, item] of labels.entries()) {
    const card = node('g', { class: 'ds-motif-node', 'data-order': index });
    card.append(node('rect', { x: item.x + 3, y: item.y + 3, width: item.width, height: 68, rx: 10, fill: 'var(--ds-ink)' }), node('rect', { x: item.x, y: item.y, width: item.width, height: 68, rx: 10, class: `ds-motif-${item.fill}` }));
    text(card, item.caption, item.x + 12, item.y + 23, 'ds-motif-mono'); text(card, item.title, item.x + 12, item.y + 47); svg.append(card);
  }
  svg.append(node('circle', { cx: 241, cy: 116, r: 14, class: 'ds-motif-paper' }), node('circle', { cx: 241, cy: 116, r: 4, fill: 'var(--ds-ink)' }), node('circle', { cx: 184, cy: 402, r: 10, class: 'ds-motif-apricot' }), node('circle', { cx: 617, cy: 287, r: 7, fill: 'var(--ds-ink)' }),
    node('path', { d: 'M544 72v22m-11-11h22M97 177v18m-9-9h18', class: 'ds-motif-line', 'stroke-width': 2 }), node('path', { d: 'm351 76 4 9 10 1-8 6 2 10-8-5-8 5 2-10-8-6 10-1Z', class: 'ds-motif-paper' }));
  if (agents) for (const [index, agent] of orbitAgents.entries()) {
    const pod = node('g', { class: 'ds-motif-node ds-motif-agent', 'data-order': index });
    pod.append(node('title', {}, agent.name),
      node('rect', { x: agent.x + 3, y: agent.y + 3, width: agent.width, height: 62, rx: 18, fill: 'var(--ds-ink)' }),
      node('rect', { x: agent.x, y: agent.y, width: agent.width, height: 62, rx: 18, class: 'ds-motif-paper' }),
      node('image', { href: agent.src, x: agent.x + 13, y: agent.y + 13, width: 36, height: 36, preserveAspectRatio: 'xMidYMid meet', class: 'ds-motif-agent-mark' }));
    text(pod, agent.name, agent.x + 59, agent.y + 38, 'ds-motif-text');
    svg.append(pod);
  }
  return svg;
}

export function memoryStream({ label, className = '', motion = 'none' } = {}) {
  const svg = graphic(['ds-memory-stream', motion === 'intro' ? 'ds-motif-intro' : '', className].filter(Boolean).join(' '), '0 0 900 260', label);
  svg.append(node('path', { d: 'M242 128h80m-9-7 9 7-9 7m255-7h83m-9-7 9 7-9 7', class: 'ds-motif-line', 'stroke-width': 2 }), node('path', { d: 'M133 182Q450 290 765 182', class: 'ds-motif-track' }));
  const cards = [
    { x: 22, width: 220, tone: 'paper', title: 'One good decision.', label: '01 / YOUR CURRENT TASK' },
    { x: 328, width: 235, tone: 'lime', title: 'A place to keep it.', label: '02 / SHARED MEMORY' },
    { x: 655, width: 220, tone: 'lilac', title: 'A useful head start.', label: '03 / YOUR NEXT TASK' },
  ];
  for (const [index, card] of cards.entries()) {
    const group = node('g', { class: 'ds-motif-node', 'data-order': index });
    group.append(node('rect', { x: card.x + 3, y: 60, width: card.width, height: 126, rx: 16, fill: 'var(--ds-ink)' }), node('rect', { x: card.x, y: 57, width: card.width, height: 126, rx: 16, class: `ds-motif-${card.tone}` }));
    text(group, card.label, card.x + 18, 87, 'ds-motif-mono');
    text(group, card.title, card.x + 18, 126, 'ds-motif-text', { 'font-size': 18 });
    text(group, card.x === 22 ? 'Save agreed context' : card.x === 328 ? 'Keep the source' : 'Ask for it again', card.x + 18, 155, 'ds-motif-mono', { 'letter-spacing': 0 }); svg.append(group);
  }
  return svg;
}

export function statusBadge(value, { tone = 'neutral' } = {}) {
  const badge = document.createElement('span'); badge.className = 'ds-badge'; badge.dataset.tone = tones.has(tone) ? tone : 'neutral'; badge.textContent = String(value); return badge;
}

export function sticker(value, { tone = 'lime', tilt = 'left' } = {}) {
  const badge = statusBadge(value, { tone }); badge.className = `ds-sticker${['left', 'right'].includes(tilt) ? ` ds-sticker--${tilt}` : ''}`; return badge;
}
