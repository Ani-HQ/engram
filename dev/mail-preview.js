import { h } from '/profile.js';

const list = document.querySelector('#mail-template-list');
const frames = document.querySelector('#mail-frames');
const error = document.querySelector('#mail-error');
let messages = [], selected = '', format = 'html', width = 'desktop';

function setText(id, value) { document.querySelector(`#${id}`).textContent = value; }
function updateView() {
  frames.hidden = format !== 'html';
  document.querySelector('#mail-text-panel').hidden = format !== 'text';
  document.querySelector('#mail-width-controls').hidden = format !== 'html';
  frames.dataset.width = width;
  for (const button of document.querySelectorAll('[data-format]')) button.setAttribute('aria-pressed', String(button.dataset.format === format));
  for (const button of document.querySelectorAll('[data-width]')) button.setAttribute('aria-pressed', String(button.dataset.width === width));
  for (const panel of document.querySelectorAll('[data-frame]')) panel.hidden = width !== 'both' && panel.dataset.frame !== width;
}
function selectMessage(id, announce = true) {
  const message = messages.find(item => item.id === id) || messages[0];
  if (!message) return;
  selected = message.id;
  for (const button of list.querySelectorAll('[data-template]')) button.setAttribute('aria-pressed', String(button.dataset.template === selected));
  setText('mail-title', message.label);
  setText('mail-purpose', message.purpose);
  setText('mail-kind', message.category);
  setText('mail-count', `${messages.indexOf(message) + 1} / ${messages.length}`);
  setText('mail-subject', message.subject);
  setText('mail-preheader', message.preheader);
  setText('mail-text', message.text);
  setText('mail-trigger', message.trigger);
  setText('mail-cadence', message.cadence);
  setText('mail-skip', message.skip);
  frames.setAttribute('aria-busy', 'true');
  const sampleUrl = `/__mail-preview/message/${encodeURIComponent(selected)}`;
  for (const frame of frames.querySelectorAll('iframe')) frame.src = sampleUrl;
  if (announce) setText('mail-status', `${message.label} selected. Sample content only; no email was sent.`);
  updateView();
}
function drawList() {
  const nodes = [];
  for (const category of [...new Set(messages.map(item => item.category))]) {
    nodes.push(h('h2', {}, category));
    for (const message of messages.filter(item => item.category === category)) {
      nodes.push(h('button', { type: 'button', 'data-template': message.id, 'aria-pressed': 'false', onclick: () => {
        history.replaceState(null, '', `#${message.id}`); selectMessage(message.id);
      } }, h('span', { 'aria-hidden': 'true' }, String(messages.indexOf(message) + 1).padStart(2, '0')), h('span', {}, message.label, h('small', {}, message.shortTiming))));
    }
  }
  list.replaceChildren(...nodes); list.setAttribute('aria-busy', 'false');
}
async function load() {
  error.hidden = true;
  for (const control of document.querySelectorAll('[data-format], [data-width]')) control.disabled = true;
  try {
    const response = await fetch('/__mail-preview/catalogue', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Templates could not be loaded.');
    const data = await response.json();
    if (!Array.isArray(data.messages) || !data.messages.length) throw new Error('No sample templates are available.');
    messages = data.messages; drawList();
    for (const control of document.querySelectorAll('[data-format], [data-width]')) control.disabled = false;
    selectMessage(location.hash.slice(1), false);
  } catch {
    list.setAttribute('aria-busy', 'false');
    setText('mail-title', 'The renderer isn’t ready yet.');
    setText('mail-purpose', 'Restart the local preview server, then try again.');
    frames.hidden = true; document.querySelector('#mail-text-panel').hidden = true;
    list.replaceChildren(h('p', { class: 'ds-hint' }, 'The local renderer is not ready yet.'));
    error.hidden = false; error.replaceChildren('Email previews could not load. ', h('button', { type: 'button', class: 'text small', onclick: load }, 'Try again'));
    frames.setAttribute('aria-busy', 'false');
  }
}
for (const button of document.querySelectorAll('[data-format]')) button.addEventListener('click', () => { format = button.dataset.format; updateView(); });
for (const button of document.querySelectorAll('[data-width]')) button.addEventListener('click', () => { width = button.dataset.width; updateView(); });
for (const frame of frames.querySelectorAll('iframe')) frame.addEventListener('load', () => frames.setAttribute('aria-busy', 'false'));
window.addEventListener('hashchange', () => selectMessage(location.hash.slice(1)));
document.addEventListener('pointerdown', () => { document.documentElement.dataset.input = 'pointer'; }, { passive: true });
document.addEventListener('keydown', () => { document.documentElement.dataset.input = 'keyboard'; });
load();
