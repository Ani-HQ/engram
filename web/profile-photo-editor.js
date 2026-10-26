import { h } from './profile.js';
import { profileAvatar } from './design-system.js';

const photoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxFileBytes = 5 * 1024 * 1024;
const maxImageEdge = 8192;
const maxImagePixels = 32 * 1024 * 1024;
let editorSequence = 0;

export const profilePhotoChanged = (left, right) => (left?.photo ?? null) !== (right?.photo ?? null);

// Omission preserves a newer photo saved elsewhere when editing unrelated fields.
export const profilePhotoUpdate = (draft, saved) => profilePhotoChanged(draft, saved) ? { photo: draft?.photo ?? null } : {};

export function validateProfilePhoto(file) {
  if (!file || !photoTypes.has(file.type)) throw new Error('Choose a JPG, PNG or WebP image.');
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('This image is empty. Choose another photo.');
  if (file.size > maxFileBytes) throw new Error('This image is too large. Choose one under 5 MB.');
}

/** Decode locally, crop a square, and serialize fresh pixels without source metadata. */
export async function convertProfilePhoto(file, { decode = globalThis.createImageBitmap, createCanvas = () => document.createElement('canvas') } = {}) {
  validateProfilePhoto(file);
  if (typeof decode !== 'function') throw new Error('This browser cannot prepare photos. Try a current browser.');
  let bitmap;
  try {
    bitmap = await decode(file, { imageOrientation: 'from-image' });
    const { width, height } = bitmap;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
      || width > maxImageEdge || height > maxImageEdge || width * height > maxImagePixels) {
      throw new Error('This image has too many pixels. Choose a smaller photo.');
    }
    const canvas = createCanvas();
    canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare your photo. Try again.');
    const edge = Math.min(width, height);
    context.drawImage(bitmap, (width - edge) / 2, (height - edge) / 2, edge, edge, 0, 0, 256, 256);
    const photo = canvas.toDataURL('image/png');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(photo) || photo.length > 550_000) {
      throw new Error('This photo could not be prepared. Choose another image.');
    }
    return photo;
  } catch (error) {
    if (error instanceof Error && /^(This (?:browser|image|photo)|Choose)/.test(error.message)) throw error;
    throw new Error('This image could not be opened. Choose another JPG, PNG or WebP.');
  } finally {
    bitmap?.close?.();
  }
}

/** A staged local edit. The owning form controls when the photo is saved. */
export function createProfilePhotoEditor({ photo = null, isCurrent = () => true, onChange = () => {}, convert = convertProfilePhoto } = {}) {
  const prefix = `profile-photo-${++editorSequence}`;
  let value = typeof photo === 'string' && photo ? photo : null;
  let active = true, generation = 0, converting = false, pending = false;
  const current = () => active && isCurrent();
  const preview = h('div', { class: 'profile-photo-preview' });
  const feedback = h('p', { id: `${prefix}-feedback`, class: 'ds-field-error', hidden: true, role: 'alert', 'aria-atomic': 'true' });
  const hint = h('p', { id: `${prefix}-hint`, class: 'field-hint' }, 'JPG, PNG or WebP. Up to 5 MB.');
  const input = h('input', { id: `${prefix}-input`, type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true, 'aria-label': 'Choose a profile photo' });
  const upload = h('button', { type: 'button', 'aria-describedby': `${prefix}-hint ${prefix}-feedback`, onclick: () => {
    if (current() && !pending && !converting) input.click();
  } });
  const remove = h('button', { type: 'button', class: 'text', hidden: !value, onclick: () => {
    if (!current() || pending) return;
    ++generation; converting = false; value = null; input.value = ''; report(''); render(); upload.focus(); onChange();
  } }, 'Remove photo');
  const progress = h('p', { class: 'profile-photo-progress field-hint', hidden: true, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    h('span', { class: 'ds-spinner', 'aria-hidden': 'true' }), 'Converting photo…');
  const element = h('section', { class: 'profile-photo-editor', 'aria-labelledby': `${prefix}-label` },
    h('h3', { id: `${prefix}-label`, class: 'profile-photo-label' }, 'Profile photo'),
    h('div', { class: 'profile-photo-controls' }, preview,
      h('div', { class: 'profile-photo-details' }, h('div', { class: 'profile-photo-actions' }, upload, remove), hint,
        h('p', { class: 'field-hint' }, 'Visible when your profile is public.'), progress, feedback)), input);

  function report(message) { feedback.textContent = message; feedback.hidden = !message; }
  function render() {
    preview.replaceChildren(profileAvatar({ src: value || '', label: value ? 'Your profile photo' : 'Default profile avatar', size: 'lg' }));
    upload.textContent = value ? 'Change photo' : 'Upload photo';
    upload.disabled = pending || converting; input.disabled = pending || converting;
    remove.hidden = !value; remove.disabled = pending;
    progress.hidden = !converting;
    element.setAttribute('aria-busy', String(pending || converting));
  }
  async function select() {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !current() || pending) return;
    const version = ++generation;
    report('');
    try { validateProfilePhoto(file); }
    catch (error) { converting = false; report(error.message); render(); onChange(); return; }
    converting = true; render(); onChange();
    if (!current() || version !== generation || pending) return;
    try {
      const prepared = await convert(file);
      if (!current() || version !== generation || pending) return;
      value = prepared; report('');
    } catch (error) {
      if (!current() || version !== generation || pending) return;
      report(error instanceof Error ? error.message : 'This photo could not be prepared. Try another image.');
    } finally {
      if (current() && version === generation && !pending) { converting = false; render(); onChange(); }
    }
  }
  input.addEventListener('change', select);
  render();
  return {
    element,
    read: () => value,
    isBusy: () => converting,
    setPending(next) {
      pending = Boolean(next);
      if (pending) { ++generation; converting = false; input.value = ''; }
      if (active) render();
    },
    dispose() { active = false; ++generation; converting = false; input.removeEventListener('change', select); }
  };
}
