import { resourceChip, loadingState, progressBar, setProgress, observeLoadingMotion, observeSelects, statusBadge, statusText, profileAvatar, highlightArt, profileLayoutPreview, evidenceList, taskRecord } from './design-system.js';
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

document.getElementById('task-record-full')?.append(taskRecord({ objective: 'Illustrative: let another agent continue a coding task.', next: 'Write the storage migration and its retry tests.', plan: [{ id: 's1', step: 'Agree the record shape', status: 'done' }, { id: 's2', step: 'Storage and receipts', status: 'doing' }, { id: 's3', step: 'Console view', status: 'todo' }, { id: 's4', step: 'Timer-based saves', status: 'dropped' }], decisions: [{ text: 'Checkpoints are the authoritative snapshot.', why: 'Memory indexing is best effort.' }], blockers: ['Waiting on a design review.'], refs: [{ kind: 'path', path: 'docs/EXAMPLE.md' }, { kind: 'commit', sha: '0a1b2c3' }] }));
document.getElementById('task-record-minimal')?.append(taskRecord({ objective: 'Illustrative minimal record.', next: 'Ask the user which lineage to continue.' }));
document.getElementById('task-record-long')?.append(taskRecord({ objective: 'Illustrative long identifier: ' + 'a'.repeat(120), next: 'Keep long values wrapping inside the card.', questions: ['Does https://example.com/' + 'b'.repeat(80) + ' wrap?'] }));
document.getElementById('memory-evidence-ready').append(evidenceList([{ label: 'Recall', value: 'Received', note: 'Illustrative successful call' }, { label: 'Context returned', value: '3.2 KB', note: 'About 800 tokens · estimate' }, { label: 'Task budget', value: '4 KB', note: 'Requires a task-aware adapter' }]));
document.getElementById('memory-evidence-empty').append(evidenceList([{ label: 'Recall', value: 'No receipt yet' }, { label: 'Context returned', value: 'Not measured' }]));
document.getElementById('memory-evidence-error').append(evidenceList([{ label: 'Memory use', value: 'Unavailable', note: 'Refresh the connection to try again.' }, { label: 'Token usage', value: 'Unknown' }]));
document.getElementById('memory-evidence-workflow').append(evidenceList([{ label: 'Workflow check', value: 'Passed', note: 'Illustrative read and save receipts from one explicit check' }, { label: 'Automatic use', value: 'Not independently verified', note: 'A check does not prove memory is used on every task' }, { label: 'Runtime', value: 'Example adapter · 0.4', note: 'Client-declared, not an identity guarantee' }]));
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
// Product marks beside their names. One-color marks (tone "mono") are fill=currentColor
// files that render black as <img>, so data-tone="mono" lightens them on the dark canvas.
const monoMark = product => product.tone === 'mono';
function logoItem(product, tag) {
  const item = document.createElement(tag), logo = document.createElement('img'), name = document.createElement('span');
  logo.className = 'ds-product-logo'; logo.setAttribute('data-size', '28'); if (monoMark(product)) logo.setAttribute('data-tone', 'mono');
  logo.src = product.logo; logo.width = logo.height = 28; logo.alt = ''; name.textContent = product.label;
  item.append(logo, name); return item;
}
const productLogos = document.getElementById('product-logo-examples');
productLogos.setAttribute('role', 'list');
productLogos.replaceChildren(...publicAgentCatalog.slice(0, 6).map(product => { const item = logoItem(product, 'div'); item.setAttribute('role', 'listitem'); return item; }));
document.getElementById('gallery-logo-list').replaceChildren(...publicAgentCatalog.map(product => logoItem(product, 'li')));
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
document.getElementById('compact-copy').prepend(icon('copy', { size: 14 }));
const commandCopy = document.getElementById('command-copy-example');
commandCopy.prepend(icon('copy', { size: 14 }));
commandCopy.addEventListener('click', () => {
  commandCopy.dataset.feedback = 'success';
  document.getElementById('command-copy-feedback').textContent = 'Preview only. In the product, Copy confirms with a check and returns after two seconds.';
});
for (const id of ['compact-close', 'compact-close-disabled']) document.getElementById(id).append(icon('x', { size: 16 }));
for (const id of ['compact-default', 'compact-small', 'compact-large', 'compact-copy', 'compact-close']) document.getElementById(id).addEventListener('click', () => { document.getElementById('compact-button-feedback').textContent = 'Compact control preview selected.'; });
for (const id of ['long-action-example', 'icon-action-example']) document.getElementById(id).addEventListener('click', () => { document.getElementById('fit-feedback').textContent = 'Preview received. The control keeps its full label and focus.'; });

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

// Identity, icons and motion: every vendored brand mark, presence, status, icons, empty state and live rows.
import { identityMark, markStack, emptyState, staggerIn, flashNew } from './design-system.js';
import { brandCatalog } from './brand-catalog.js';
import { brandIcon } from './tooling.js';
import { ICON_NAMES } from './icons.js';
{
  const wall = document.getElementById('identity-brand-wall');
  wall?.replaceChildren(...Object.entries(brandCatalog).map(([id, entry]) => {
    const item = document.createElement('li'), name = document.createElement('span');
    name.textContent = entry.label; item.title = `${entry.label} · ${entry.tone}`;
    item.append(identityMark(brandIcon(id, { size: 18 }), { size: 'md' }), name); return item;
  }));
  const presence = document.getElementById('identity-presence');
  presence?.replaceChildren(...[['recent', 'Seen recently', 'claude'], ['working', 'Running report', 'codex'], ['quiet', 'Quiet', 'cursor'], ['reconnect', 'Reconnect needed', 'openai']].map(([state, label, brand]) => {
    const item = document.createElement('div'), copy = document.createElement('span'); copy.textContent = label;
    item.className = 'ds-gallery-presence'; item.append(identityMark(brandIcon(brand, { size: 22 }), { size: 'lg', presence: state }), copy); return item;
  }));
  document.getElementById('identity-stack')?.replaceChildren(markStack(['claude', 'codex', 'cursor', 'gemini', 'amp'].map(id => identityMark(brandIcon(id, { size: 14 }), { size: 'sm' })), { max: 3, label: 'Five contributors' }));
  const statuses = document.getElementById('identity-status');
  statuses?.replaceChildren(...[['running', 'loader-circle', 'In progress'], ['completed', 'circle-check', 'Completed'], ['failed', 'circle-alert', 'Needs attention'], ['stale', 'clock', 'Awaiting update']].map(([state, glyph, label]) => {
    const item = document.createElement('span'), text = document.createElement('span'); text.textContent = label;
    item.className = 'ds-status-icon'; item.setAttribute('data-state', state); item.append(icon(glyph, { size: 14 }), text); return item;
  }));
  const icons = document.getElementById('identity-icons');
  icons?.replaceChildren(...ICON_NAMES.map(name => { const item = document.createElement('li'), label = document.createElement('span'); label.textContent = name; item.title = name; item.append(icon(name, { size: 18 }), label); return item; }));
  document.getElementById('identity-empty')?.replaceChildren(emptyState({ glyph: icon('activity', { size: 22 }), title: 'No activity yet', description: 'Connect an agent and its memory calls appear here.' }));
  const rows = document.getElementById('identity-rows');
  const renderRows = () => {
    rows.replaceChildren(...['Saved a memory', 'Searched memory', 'Opened a pull request (reported)'].map(text => { const row = document.createElement('div'); row.className = 'ds-row-hover ds-gallery-row'; row.textContent = text; return row; }));
    staggerIn(rows);
  };
  if (rows) { renderRows(); document.getElementById('identity-replay')?.addEventListener('click', () => { rows.classList.remove('ds-stagger'); void rows.offsetWidth; renderRows(); }); }
  document.getElementById('identity-flash')?.addEventListener('click', () => { const row = document.createElement('div'); row.className = 'ds-row-hover ds-gallery-row'; row.textContent = 'New: recalled job retries'; rows.prepend(row); flashNew([row]); });
}

// App shell examples.
import { pill, showToast, banner, commandPalette } from './design-system.js';
{
  const kbd = text => { const key = document.createElement('kbd'); key.textContent = text; return key; };
  document.getElementById('shell-pills')?.replaceChildren(pill('Team'), pill('Read only', { tone: 'accent' }), pill('Beta', { tone: 'warning' }), pill('Revoked', { tone: 'danger' }), kbd('⌘K'), kbd('Esc'));
  document.getElementById('shell-toast')?.addEventListener('click', () => showToast('Settings saved', { glyph: icon('circle-check', { size: 16 }) }));
  document.getElementById('shell-toast-error')?.addEventListener('click', () => showToast('Could not save settings. Try again.', { tone: 'danger', glyph: icon('circle-alert', { size: 16 }), action: { label: 'Retry', run: () => {} } }));
  const demoPalette = commandPalette([{ label: 'Pages', items: [{ label: 'Activity', glyph: icon('activity', { size: 16 }), run: () => {} }, { label: 'Memory', glyph: icon('brain', { size: 16 }), run: () => {} }] }, { label: 'Actions', items: [{ label: 'Connect an agent', glyph: icon('plug-zap', { size: 16 }), run: () => {} }] }]);
  document.getElementById('shell-palette')?.addEventListener('click', () => demoPalette.open());
  const action = document.createElement('button'); action.type = 'button'; action.className = 'ds-button primary small'; action.textContent = 'Learn more';
  document.getElementById('shell-banner')?.replaceChildren(banner({ glyph: icon('sparkles', { size: 18 }), title: 'Search by intent', description: 'Find related work by meaning when model processing is on.', action, onDismiss: () => {} }));
}
