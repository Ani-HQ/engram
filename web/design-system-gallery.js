import { memoryOrbit, memoryStream, resourceChip, loadingState, progressBar, setProgress, observeLoadingMotion, observeContextFlow, contextFlowArt, observeLogoTicker, observeSelects, statusBadge, statusText, profileAvatar, highlightArt, profileLayoutPreview } from './design-system.js';
import { publicAgentCatalog } from './public-agent-catalog.js';
import { icon } from './icons.js';
import { agentVisual, toolVisual, visualIcon } from './tooling.js';
import { createJevSettingsPanel } from './jev-settings.js';
import { friendAccessCard } from './access-view.js';

// Local review utilities are deliberately absent from the published gallery.
if (document.querySelector('meta[name="engram-demo"]')) {
  const emailStudio = document.createElement('a');
  emailStudio.href = '/__mail-preview'; emailStudio.textContent = 'Email studio';
  document.querySelector('.ds-gallery-header nav')?.append(emailStudio);
}

document.querySelector('#orbit-example').append(memoryOrbit());
document.getElementById('status-text-active').append(statusText('File activity', { active: true }));
document.getElementById('status-text-completed').append(statusText('File activity'));
document.getElementById('status-text-reduced').append(statusText('File activity', { active: true }));
for (const size of ['sm', 'md', 'lg']) document.getElementById('profile-avatar-sizes').append(profileAvatar({ size, label: `Default profile image, ${size} example` }));
// Locally generated geometric PNG fixture, not a photograph or a remote image.
const profileAvatarSample = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiUlEQVR42u3Ouw2AMBAD0BuFjo6KNRiECZiKgZgGlAIJRRflvgIkFy5tPxqm8XwzBICltB07m3RA69gDoehzLYIyzjUIyjqXIr4N8J5LEABQ9nkPAQAAALCAeV3CAWWzRAyIRNx7AKgBEYjn1j8BHkS9YwZYENyGC6BBtPpuQA/S64UBPAGg/roAwAOSfPbIJ90AAAAASUVORK5CYII=';
document.getElementById('profile-avatar-uploaded').append(profileAvatar({ src: profileAvatarSample, size: 'lg', label: 'Uploaded profile image component example' }));
const loadingAvatar = profileAvatar({ label: 'Profile image while loading' }); loadingAvatar.setAttribute('data-state', 'loading');
document.getElementById('profile-avatar-loading').append(loadingAvatar);
document.getElementById('profile-avatar-unavailable').append(profileAvatar({ src: 'data:image/png;base64,invalid', label: 'Unavailable profile image fallback' }));
document.getElementById('profile-avatar-narrow').append(profileAvatar({ size: 'sm', label: 'Default profile image in a narrow layout' }));
const productLogos = document.getElementById('product-logo-examples');
productLogos.replaceChildren(...publicAgentCatalog.map(product => {
  const sample = document.createElement('div'); sample.className = 'ds-gallery-product';
  const frame = document.createElement('span'); frame.className = 'ds-product-logo-frame'; frame.setAttribute('data-tone', 'inverse');
  const logo = document.createElement('img'); logo.className = 'ds-product-logo'; logo.setAttribute('data-size', '28'); logo.src = product.logo; logo.width = logo.height = 28; logo.alt = '';
  const name = document.createElement('span'); name.textContent = product.label; frame.append(logo); sample.append(frame, name); return sample;
}));
for (const id of ['gallery-logo-ticker', 'gallery-logo-ticker-static']) {
  const root = document.getElementById(id), list = root.querySelector('[data-ticker-list]');
  for (const product of publicAgentCatalog) {
    const item = document.createElement('li'), frame = document.createElement('span'), logo = document.createElement('img'), name = document.createElement('span');
    frame.className = 'ds-product-logo-frame'; frame.setAttribute('data-tone', 'inverse'); logo.className = 'ds-product-logo'; logo.src = product.logo; logo.width = logo.height = 28; logo.alt = ''; name.textContent = product.label;
    frame.append(logo); item.append(frame, name); list.append(item);
  }
  observeLogoTicker(root, { reduced: id.endsWith('-static') }); root.querySelector('[data-ticker-pause]').hidden = false;
}
document.querySelector('#agent-orbit-example').append(memoryOrbit({ agents: true, label: 'Illustrative agent ecosystem: Claude, OpenClaw, Grok Bot, Muse and Instinct around shared memory. Not live connections.' }));
document.querySelector('#ink-orbit-example').append(memoryOrbit({ compact: true, className: 'ds-orbit--on-ink' }));
document.querySelector('#stream-example').append(memoryStream({ label: 'A decision is saved to shared memory and recalled for the next task. This is an illustration.' }));
const resourceExamples = document.querySelector('#resource-chip-examples');
for (const [tool, label] of [['github.create_pull_request', 'example / shared-memory'], ['googledocs.get_document', 'Project notes'], ['linear.get_issue', 'ENG-42'], ['figma.get_file', 'Activity canvas']]) {
  resourceExamples.append(resourceChip(label, { visual: visualIcon(toolVisual(tool), { size: 16 }), onClick: () => { document.querySelector('#resource-chip-feedback').textContent = `Selected illustrative resource: ${label}. No resource was opened.`; } }));
}
document.querySelector('#redacted-chip-examples').append(resourceChip('GitHub · Repository', { visual: visualIcon(toolVisual('github'), { size: 16 }) }), resourceChip('Google Docs · Document', { visual: visualIcon(toolVisual('googledocs'), { size: 16 }) }), resourceChip('A deliberately long resource name that stays inside its available space', { visual: icon('file-text', { size: 16 }), onClick: () => {}, disabled: true }));
let consentExample;
const sampleJev = { enabled: false, available: false, canManage: true, configured: true, eligibility: 'operator-funded', unavailableReason: 'disabled', pricing: { currency: 'usd', inputPerMillionUsd: null, outputPerMillionUsd: null, markupBps: null, rateVersion: null }, budget: { monthlyUsd: '0' }, usage: { calls: 0, inputTokens: '0', outputTokens: '0', pendingCalls: 0, unknownCalls: 0 } };
function renderConsentExample(data) {
  consentExample?.dispose();
  consentExample = createJevSettingsPanel({ data, api: { saveJev: async input => ({ ...data, enabled: input.enabled, available: input.enabled, unavailableReason: input.enabled ? null : 'disabled', budget: { monthlyUsd: input.monthlyBudgetUsd } }) }, saved: next => { renderConsentExample(next); document.querySelector('#consent-feedback').textContent = 'Local example updated. No provider was called, no setting was saved, and no charge was made.'; } });
  document.querySelector('#jev-consent-example').replaceChildren(consentExample.element);
}
renderConsentExample(sampleJev);
const friendExample = { serverNow: '2026-10-25T09:00:00.000Z', canWrite: true, entitlementSource: 'complimentary', complimentary: { active: true, source: 'invite', durationDays: 60, grantedAt: '2026-10-12T09:00:00.000Z', expiresAt: '2026-12-11T09:00:00.000Z', revokedAt: null, unlimitedKnowledgeTransfers: true, extensionUrl: 'https://x.com/anirudh_twt' } };
document.querySelector('#friend-access-example').append(friendAccessCard(friendExample));
document.querySelector('#friend-expired-example').append(friendAccessCard({ ...friendExample, serverNow: '2026-12-12T09:00:00.000Z', canWrite: false, entitlementSource: 'none', complimentary: { ...friendExample.complimentary, active: false, unlimitedKnowledgeTransfers: false } }));
const motionOrbit = document.querySelector('#motion-orbit');
for (const id of ['long-action-example', 'icon-action-example']) document.getElementById(id).addEventListener('click', () => { document.getElementById('fit-feedback').textContent = 'Preview received. The control keeps its full label and focus.'; });
motionOrbit.append(memoryOrbit());

document.addEventListener('pointerdown', () => { document.documentElement.dataset.input = 'pointer'; }, { passive: true });
document.addEventListener('keydown', () => { document.documentElement.dataset.input = 'keyboard'; });
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const dialog = document.querySelector('#example-dialog');
document.querySelector('#dialog-open').addEventListener('click', () => dialog.showModal());
document.querySelector('#dialog-back').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });

for (const id of ['press-example', 'quiet-example']) document.querySelector(`#${id}`).addEventListener('click', () => {
  document.querySelector('#button-feedback').textContent = 'Heard you. That was local feedback; no request was sent.';
});
document.querySelector('#toast-show').addEventListener('click', () => {
  document.querySelector('.ds-toast')?.remove();
  const toast = document.createElement('div'); toast.className = 'ds-toast'; toast.setAttribute('role', 'status'); toast.textContent = 'Feedback example. Nothing was saved.';
  document.body.append(toast); setTimeout(() => toast.remove(), 4000);
});
document.querySelector('#sample-form').addEventListener('submit', async event => {
  event.preventDefault();
  const save = document.querySelector('#sample-save'), feedback = document.querySelector('#form-feedback');
  if (save.disabled) return;
  save.disabled = true;
  const spinner = document.createElement('span'); spinner.className = 'ds-spinner'; spinner.setAttribute('aria-hidden', 'true');
  save.replaceChildren(spinner, 'Saving example…'); feedback.textContent = 'Showing the busy state. No server request is being made.';
  await new Promise(resolve => setTimeout(resolve, 700));
  save.disabled = false; save.textContent = 'Try saving again'; feedback.textContent = 'Saved state preview. Your text is still here; no memory was written.';
});
document.querySelector('#motion-replay').addEventListener('click', event => {
  const feedback = document.querySelector('#motion-feedback');
  if (reduced() || event.detail === 0) { motionOrbit.replaceChildren(memoryOrbit()); feedback.textContent = 'Feedback received. Movement is skipped for reduced motion and keyboard input.'; return; }
  motionOrbit.replaceChildren(memoryOrbit({ motion: 'intro' }));
  feedback.textContent = 'One finite SVG reveal: 120ms nodes, 180ms core, 220ms connectors. No loop.';
});
document.querySelector('#loading-replay').addEventListener('click', async () => {
  const button = document.querySelector('#loading-replay'), example = document.querySelector('#loading-example'), feedback = document.querySelector('#loading-feedback');
  if (button.disabled) return;
  button.disabled = true; example.setAttribute('aria-busy', 'true'); feedback.textContent = 'Loading component preview. No real data is being fetched.';
  await new Promise(resolve => setTimeout(resolve, 1200));
  example.setAttribute('aria-busy', 'false'); button.disabled = false; feedback.textContent = reduced() ? 'Preview finished. Loading stayed static because reduced motion is enabled.' : 'Preview finished. The skeleton is still again.';
});


// Native tab controls retain immediate keyboard feedback and never fetch data.
const previewTabs = [...document.querySelectorAll('.ds-gallery-workspace [role="tab"]')];
function selectPreviewTab(tab, focus = false) {
  for (const item of previewTabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of previewTabs.entries()) {
  tab.addEventListener('click', () => selectPreviewTab(tab));
  tab.addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % previewTabs.length : event.key === 'ArrowLeft' ? (index + previewTabs.length - 1) % previewTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? previewTabs.length - 1 : null;
    if (next !== null) { event.preventDefault(); selectPreviewTab(previewTabs[next], true); }
  });
}
for (const id of ['preview-clear', 'preview-retry']) document.getElementById(id).addEventListener('click', () => {
  selectPreviewTab(previewTabs[0]);
  document.getElementById('workspace-preview-feedback').textContent = 'Preview restored. No network request was made.';
});


const previewStage = document.getElementById('pending-preview-stage');
const previewState = document.getElementById('pending-preview-state');
const previewStatus = document.getElementById('pending-preview-status');
function renderPendingPreview() {
  const state = previewState.value;
  previewStage.setAttribute('data-motion', document.getElementById('pending-preview-reduced').checked ? 'reduced' : 'normal');
  if (state === 'loading') previewStage.replaceChildren(loadingState({ label: 'Loading preview…', description: 'A controlled waiting-state preview. No request is sent.', lines: 3 }));
  else {
    const box = document.createElement('div'); box.className = 'ds-stack';
    const note = document.createElement('p'); note.className = 'ds-notice';
    const labels = { idle: 'Ready when you are. Start the example to see its pending state.', success: 'Example saved. The confirmed result stays visible.', error: 'The example could not load. Your entered text is preserved. Try again.', disabled: 'Choose a workspace before starting this example.' };
    note.textContent = labels[state];
    if (state === 'success' || state === 'error') { note.dataset.tone = state === 'error' ? 'danger' : 'success'; note.setAttribute('role', state === 'error' ? 'alert' : 'status'); }
    const action = document.createElement('button'); action.type = 'button'; action.className = 'ds-button'; action.disabled = state === 'disabled';
    action.textContent = state === 'error' ? 'Retry preview' : state === 'disabled' ? 'Unavailable' : 'Start preview';
    action.addEventListener('click', () => { previewState.value = 'loading'; renderPendingPreview(); });
    box.append(note, action); previewStage.replaceChildren(box);
  }
  previewStatus.textContent = `${state[0].toUpperCase() + state.slice(1)} preview. ${state === 'loading' ? 'Waiting-state motion only; no request is sent.' : 'No request in progress.'}`;
}
previewState.addEventListener('change', renderPendingPreview);
document.getElementById('pending-preview-reduced').addEventListener('change', renderPendingPreview);
renderPendingPreview();
const measuredBar = progressBar({ label: 'Sample setup checks observed', value: 0, max: 3, valueText: '0 of 3 sample checks observed.' });
document.getElementById('measured-progress-example').append(measuredBar);
document.getElementById('measured-preview-count').addEventListener('change', event => {
  const value = Number(event.target.value);
  setProgress(measuredBar, { label: 'Sample setup checks observed', value, max: 3, valueText: `${value} of 3 sample checks observed.` });
  document.getElementById('measured-preview-label').textContent = `${value} of 3 observed`;
});
document.getElementById('copy-feedback-preview').addEventListener('click', event => {
  const button = event.currentTarget; button.dataset.feedback = 'success';
  const check = icon('check', { size: 14 }); check.classList.add('ds-feedback-icon');
  button.replaceChildren(check, 'Copied state preview');
  document.getElementById('copy-preview-status').textContent = 'Copied-state preview. Your clipboard was not changed.';
});
const navigationToggle = document.getElementById('navigation-example-toggle');
const navigationPanel = document.getElementById('navigation-example-content');
document.getElementById('navigation-example-icon').append(icon('chevron-down', { size: 14 }));
function closeNavigationPreview() { navigationToggle.setAttribute('aria-expanded', 'false'); navigationPanel.hidden = true; }
navigationToggle.addEventListener('click', () => {
  const open = navigationToggle.getAttribute('aria-expanded') === 'true';
  navigationToggle.setAttribute('aria-expanded', String(!open)); navigationPanel.hidden = open;
});
for (const element of [navigationToggle, navigationPanel]) element.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !navigationPanel.hidden) { event.preventDefault(); closeNavigationPreview(); navigationToggle.focus(); }
});
navigationPanel.addEventListener('click', event => { if (event.target.closest('a')) closeNavigationPreview(); });
const stopLoadingMotion = observeLoadingMotion(document.body);
window.addEventListener('pagehide', event => { if (!event.persisted) stopLoadingMotion(); });
observeContextFlow(document.getElementById('context-flow-example'), { replayButton: document.getElementById('context-flow-example-replay') });
document.getElementById('context-flow-glow-art').replaceWith(contextFlowArt({ variant: 'glow' }));
observeContextFlow(document.getElementById('context-flow-glow-example'), { pauseButton: document.getElementById('context-flow-glow-pause'), mode: 'loop' });
document.getElementById('context-flow-loop-art').replaceWith(contextFlowArt());
observeContextFlow(document.getElementById('context-flow-loop-example'), { pauseButton: document.getElementById('context-flow-loop-pause'), mode: 'loop' });
observeContextFlow(document.getElementById('context-flow-reduced-example'), { pauseButton: document.getElementById('context-flow-reduced-replay'), mode: 'loop', reduced: true });
observeContextFlow(document.getElementById('context-flow-line-example'), { mode: 'loop', pauseOnInteraction: true });
observeContextFlow(document.getElementById('context-flow-line-reduced-example'), { mode: 'loop', pauseOnInteraction: true, reduced: true });


for (const [name, publicSafe] of [['Research helper', false], ['Build helper', false], ['Review helper', false], ['Public fallback', true]]) {
  const sample = document.createElement('div'); sample.className = 'ds-gallery-avatar-example';
  const label = document.createElement('span'); label.textContent = name;
  sample.append(visualIcon(agentVisual(publicSafe ? '' : name, { harness: 'custom', publicSafe }), { size: 36 }), label);
  document.getElementById('avatar-examples').append(sample);
}


// Local structural layout choices preserve native radio semantics.
document.getElementById('layout-preview-studio').append(profileLayoutPreview('studio'));
document.getElementById('layout-preview-notes').append(profileLayoutPreview('field-notes'));
const layoutChoices = document.getElementById('layout-choice-example');
layoutChoices.addEventListener('change', event => {
  if (event.target.type === 'radio') document.getElementById('layout-choice-feedback').textContent = `${event.target.value === 'studio' ? 'Living studio' : 'Field notes'} selected. Local preview only.`;
});
document.getElementById('layout-choice-disabled').addEventListener('change', event => {
  layoutChoices.disabled = event.target.checked;
  document.getElementById('layout-choice-feedback').textContent = event.target.checked ? 'Layout choice is disabled for this preview. Its selection is preserved.' : 'Layout choice is available. Use arrow keys to change the selected radio.';
});
document.getElementById('focus-row-icon').append(icon('file-text', { size: 18 }));
const highlightState = document.getElementById('highlight-preview-state');
function renderHighlightExample() {
  const slot = document.getElementById('highlight-card-example');
  if (highlightState.value === 'loading') { slot.replaceChildren(loadingState({ label: 'Loading highlight preview…', description: 'A local waiting-state example. No public content is fetched.', lines: 3 })); return; }
  if (highlightState.value === 'empty' || highlightState.value === 'error') {
    const box = document.createElement('div'); box.className = 'ds-card ds-stack';
    const note = document.createElement('p'); note.className = 'ds-notice';
    note.textContent = highlightState.value === 'error' ? 'This example could not load. Retry the local preview.' : 'This example has no approved highlights to show.';
    if (highlightState.value === 'error') { note.dataset.tone = 'danger'; note.setAttribute('role', 'alert'); }
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = highlightState.value === 'error' ? 'Retry preview' : 'Show the example';
    reset.addEventListener('click', () => { highlightState.value = 'ready'; renderHighlightExample(); }); box.append(note, reset); slot.replaceChildren(box); return;
  }
  const card = document.createElement('article'); card.className = 'ds-card ds-highlight-card';
  const visual = document.createElement('div'); visual.className = 'ds-highlight-visual'; visual.setAttribute('aria-hidden', 'true'); visual.append(highlightArt({ variant: 'orbit' }));
  const content = document.createElement('div'); content.className = 'ds-highlight-content';
  const title = document.createElement('h3'); title.className = 'ds-highlight-title'; title.textContent = 'An illustrative highlight';
  const description = document.createElement('p'); description.className = 'ds-highlight-description'; description.textContent = 'A short, deliberately public note. The art is decorative and makes no claim about activity or results.';
  const details = document.createElement('details'); details.className = 'ds-highlight-disclosure';
  const summary = document.createElement('summary'); summary.append('Read the example note');
  const indicator = document.createElement('span'); indicator.className = 'ds-disclosure-indicator'; indicator.setAttribute('aria-hidden', 'true'); indicator.append(icon('chevron-down', { size: 14 })); summary.append(indicator);
  const note = document.createElement('p'); note.textContent = 'The expanded text stays in normal document flow. Native Enter and Space actions are immediate, and the optional public reference remains a separate link.'; details.append(summary, note);
  const actions = document.createElement('div'); actions.className = 'ds-highlight-actions';
  const link = document.createElement('a'); link.className = 'ds-touch-target'; link.href = '#profile-patterns'; link.textContent = 'Example reference'; actions.append(link);
  content.append(statusBadge('Component example', { tone: 'neutral' }), title, description, details, actions); card.append(visual, content); slot.replaceChildren(card);
}
highlightState.addEventListener('change', renderHighlightExample); renderHighlightExample();
const weekExample = document.getElementById('week-pulse-example');
const sampleCounts = [2, 0, 4, 3, 7, 1, 5];
const weekButtons = sampleCounts.map((count, index) => {
  const date = `2026-10-${19 + index}`;
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index];
  const item = document.createElement('li'); item.className = 'ds-week-day';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'ds-week-button'; button.tabIndex = index === 6 ? 0 : -1;
  button.setAttribute('aria-label', `${count} sample actions on ${date} UTC`); button.setAttribute('aria-pressed', String(index === 6)); button.style.setProperty('--ds-pulse-ratio', String(count / 7));
  const bar = document.createElement('span'); bar.className = 'ds-week-bar'; bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('span'); fill.className = 'ds-week-bar-fill'; bar.append(fill);
  const label = document.createElement('span'); label.className = 'ds-week-label'; label.textContent = day;
  const value = document.createElement('span'); value.className = 'ds-week-count'; value.textContent = String(count); button.append(bar, label, value);
  const select = focus => { for (const other of weekButtons) { other.tabIndex = other === button ? 0 : -1; other.setAttribute('aria-pressed', String(other === button)); } document.getElementById('week-pulse-feedback').textContent = `${date} UTC: ${count} sample actions. Component data only.`; if (focus) { button.focus(); button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } };
  button.addEventListener('click', () => select(false));
  button.addEventListener('keydown', event => { const next = event.key === 'ArrowRight' ? Math.min(6, index + 1) : event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? 6 : null; if (next !== null) { event.preventDefault(); weekButtons[next].click(); weekButtons[next].focus(); weekButtons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' }); } });
  item.append(button); weekExample.append(item); return button;
});

const selectExample = document.getElementById('select-agent-example');
const selectFeedback = document.getElementById('select-example-feedback');
selectExample.addEventListener('change', () => { selectFeedback.textContent = `Selected: ${selectExample.selectedOptions[0]?.label || 'No choice'}. Local example only.`; });
document.getElementById('select-example-form').addEventListener('submit', event => { event.preventDefault(); selectFeedback.textContent = 'The example choice is valid. Nothing was submitted to a server.'; });
document.getElementById('select-example-form').addEventListener('reset', () => { selectFeedback.textContent = 'The example is reset to its original choice.'; });
document.getElementById('select-programmatic').addEventListener('click', () => { selectExample.value = 'custom'; selectFeedback.textContent = 'The native value was changed programmatically. The visible select stays in sync.'; });
document.getElementById('select-disabled-preview').addEventListener('change', event => { selectExample.disabled = event.target.checked; });
let gallerySelects = observeSelects(document.body);
window.addEventListener('pagehide', () => gallerySelects.dispose());
window.addEventListener('pageshow', event => { if (event.persisted) gallerySelects = observeSelects(document.body); });
