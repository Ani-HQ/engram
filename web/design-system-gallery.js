import { memoryOrbit, memoryStream } from './design-system.js';
import { createJevSettingsPanel } from './jev-settings.js';
import { friendAccessCard } from './access-view.js';

// Local review utilities are deliberately absent from the published gallery.
if (document.querySelector('meta[name="engram-demo"]')) {
  const emailStudio = document.createElement('a');
  emailStudio.href = '/__mail-preview'; emailStudio.textContent = 'Email studio';
  document.querySelector('.ds-gallery-header nav')?.append(emailStudio);
}

document.querySelector('#orbit-example').append(memoryOrbit());
document.querySelector('#agent-orbit-example').append(memoryOrbit({ agents: true, label: 'Illustrative agent ecosystem: Claude, OpenClaw, Grok Bot, Muse and Instinct around shared memory. Not live connections.' }));
document.querySelector('#ink-orbit-example').append(memoryOrbit({ compact: true, className: 'ds-orbit--on-ink' }));
document.querySelector('#stream-example').append(memoryStream({ label: 'A decision is saved to shared memory and recalled for the next task. This is an illustration.' }));
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
  feedback.textContent = 'One finite SVG reveal: 220ms nodes and 500ms rings. No loop.';
});
document.querySelector('#loading-replay').addEventListener('click', async () => {
  const button = document.querySelector('#loading-replay'), example = document.querySelector('#loading-example'), feedback = document.querySelector('#loading-feedback');
  if (button.disabled) return;
  button.disabled = true; example.setAttribute('aria-busy', 'true'); feedback.textContent = 'Loading component preview. No real data is being fetched.';
  await new Promise(resolve => setTimeout(resolve, 1200));
  example.setAttribute('aria-busy', 'false'); button.disabled = false; feedback.textContent = reduced() ? 'Preview finished. Loading stayed static because reduced motion is enabled.' : 'Preview finished. The skeleton is still again.';
});
