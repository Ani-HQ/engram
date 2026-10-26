import { h } from './profile.js';
import { icon } from './icons.js';
import { profileLayoutPreview } from './design-system.js';

let editorSequence = 0;
export function profilePresentationValue(profile = {}) {
  return {
    layout: profile.layout === 'field-notes' ? 'field-notes' : 'studio',
    highlights: (Array.isArray(profile.highlights) ? profile.highlights : []).slice(0, 3).map(item => ({
      title: typeof item?.title === 'string' ? item.title : '',
      body: typeof item?.body === 'string' ? item.body : '',
      url: typeof item?.url === 'string' ? item.url : '',
    })),
  };
}
export function profilePresentationChanged(left, right) {
  return JSON.stringify(profilePresentationValue(left)) !== JSON.stringify(profilePresentationValue(right));
}
export function highlightUrlError(value) {
  if (!value.trim()) return '';
  if (value.trim().length > 2048) return 'Use a link of at most 2,048 characters.';
  try {
    if (!/^https?:\/\//i.test(value.trim()) || /[\u0000-\u001f\u007f]/.test(value.trim())) throw new Error();
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return '';
  } catch { return 'Use a complete http:// or https:// link without a username or password.'; }
}

/** Local drafts only. The owning form validates, saves and publishes explicitly. */
export function createProfilePresentationEditor({ profile, onChange = () => {}, isCurrent = () => true }) {
  const initial = profilePresentationValue(profile);
  const prefix = `profile-presentation-${++editorSequence}`;
  let layout = initial.layout, pending = false, sequence = 0;
  const entries = [];
  const status = h('p', { class: 'ds-hint', role: 'status', 'aria-live': 'polite' });
  const list = h('div', { class: 'profile-highlight-list ds-stack' });
  const read = () => ({ layout, highlights: entries.map(row => ({ title: row.title.value, body: row.body.value, url: row.url.value })) });
  const changed = () => { if (!pending && isCurrent()) onChange(read()); };
  const setError = (control, error, message = '') => {
    control.setAttribute('aria-invalid', String(Boolean(message))); control.setCustomValidity(message);
    error.textContent = message; error.hidden = !message;
  };
  const choiceInputs = ['studio', 'field-notes'].map(value => {
    const title = value === 'studio' ? 'Living studio' : 'Field notes';
    const input = h('input', { type: 'radio', name: `${prefix}-layout`, value, checked: layout === value });
    input.addEventListener('change', () => { if (pending || !isCurrent() || !input.checked) return; layout = value; changed(); });
    return { input, label: h('label', { class: 'ds-choice-card' }, input, h('span', { class: 'ds-choice-visual', 'aria-hidden': 'true' }, profileLayoutPreview(value)), h('span', { class: 'ds-choice-copy' },
      h('strong', { class: 'ds-choice-title' }, title), h('small', { class: 'ds-choice-description' }, value === 'studio' ? 'A live desk, activity history, and room for highlights.' : 'Your chosen stories first, with activity quietly underneath.'))) };
  });
  const choices = h('fieldset', { class: 'ds-choice-group' }, h('legend', {}, 'Profile layout'),
    h('div', { class: 'ds-choice-options' }, choiceInputs.map(item => item.label)),
    h('p', { class: 'ds-hint' }, 'Try either layout in the preview. Switching keeps your highlights.'));
  const add = h('button', { type: 'button', class: 'small' }, icon('plus', { size: 14 }), 'Add highlight');
  const refresh = () => {
    entries.forEach((row, index) => {
      row.heading.textContent = `Highlight ${index + 1}`;
      row.remove.setAttribute('aria-label', `Remove highlight ${index + 1}`);
      for (const [control, label] of [[row.title, 'title'], [row.body, 'note'], [row.url, 'public link (optional)']]) control.setAttribute('aria-label', `Highlight ${index + 1} ${label}`);
      row.up.disabled = pending || index === 0; row.down.disabled = pending || index === entries.length - 1;
      row.up.setAttribute('aria-label', `Move highlight ${index + 1} up`); row.down.setAttribute('aria-label', `Move highlight ${index + 1} down`);
    });
    add.disabled = pending || entries.length >= 3;
    limit.textContent = `${entries.length} of 3 highlights. ${entries.length === 3 ? 'Remove one to add another.' : 'Add only what you want to share.'}`;
  };
  function move(row, offset, control) {
    if (pending || !isCurrent()) return;
    const from = entries.indexOf(row), to = from + offset;
    if (from < 0 || to < 0 || to >= entries.length) return;
    entries.splice(from, 1); entries.splice(to, 0, row);
    list.replaceChildren(...entries.map(entry => entry.element)); refresh(); changed();
    const target = !control.disabled ? control : !row.up.disabled ? row.up : !row.down.disabled ? row.down : row.title;
    target.focus(); status.textContent = `Moved to highlight ${to + 1}.`;
  }
  function append(value = {}, focus = false) {
    if (entries.length >= 3) return;
    const id = `${prefix}-highlight-${++sequence}`;
    const titleError = h('p', { id: `${id}-title-error`, class: 'ds-field-error', hidden: true });
    const bodyError = h('p', { id: `${id}-body-error`, class: 'ds-field-error', hidden: true });
    const urlError = h('p', { id: `${id}-url-error`, class: 'ds-field-error', hidden: true });
    const title = h('input', { name: `${id}-title`, value: value.title || '', maxlength: 80, required: true, autocomplete: 'off', placeholder: 'A useful decision, something you made…', 'aria-describedby': titleError.id || `${id}-title-error` });
    const body = h('textarea', { name: `${id}-body`, maxlength: 600, rows: 4, placeholder: 'What is worth sharing about it?', 'aria-describedby': `${id}-body-hint ${id}-body-error` }, value.body || '');
    const url = h('input', { name: `${id}-url`, type: 'url', value: value.url || '', maxlength: 2048, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'https://…', 'aria-describedby': `${id}-url-hint ${id}-url-error` });
    const count = h('p', { class: 'ds-hint', id: `${id}-body-hint` }, `${body.value.length} / 600`);
    const heading = h('h3', { id: `${id}-heading` });
    const remove = h('button', { type: 'button', class: 'text small' }, 'Remove');
    const up = h('button', { type: 'button', class: 'small' }, 'Up');
    const down = h('button', { type: 'button', class: 'small' }, 'Down');
    const row = { title, body, url, heading, remove, up, down, errors: [[title, titleError], [body, bodyError], [url, urlError]] };
    row.element = h('section', { class: 'ds-panel profile-highlight-editor', 'aria-labelledby': `${id}-heading` },
      h('div', { class: 'ds-panel-header' }, heading, h('div', { class: 'ds-row' }, up, down, remove)),
      h('div', { class: 'ds-panel-body ds-stack' }, h('label', { class: 'field' }, 'Title', title), titleError,
        h('label', { class: 'field' }, 'Note', body), count, bodyError,
        h('label', { class: 'field' }, 'Public link (optional)', url), h('p', { id: `${id}-url-hint`, class: 'ds-hint' }, 'Use a link that anyone visiting your profile may open.'), urlError));
    for (const [control, error] of row.errors) control.addEventListener('input', () => { if (pending || !isCurrent()) return; setError(control, error); count.textContent = `${body.value.length} / 600`; changed(); });
    remove.addEventListener('click', () => {
      if (pending || !isCurrent()) return;
      const index = entries.indexOf(row); entries.splice(index, 1); row.element.remove(); refresh(); changed();
      (entries[index]?.title || entries[index - 1]?.title || add).focus(); status.textContent = 'Highlight removed from your draft. Save to apply the change.';
    });
    up.addEventListener('click', () => move(row, -1, up)); down.addEventListener('click', () => move(row, 1, down));
    entries.push(row); list.append(row.element);
    if (focus) { refresh(); changed(); title.focus(); status.textContent = 'Highlight added to your draft.'; }
  }
  const limit = h('p', { class: 'ds-hint', id: `${prefix}-limit` });
  add.setAttribute('aria-describedby', `${prefix}-limit`);
  add.addEventListener('click', () => { if (!pending && isCurrent()) append({}, true); });
  initial.highlights.forEach(item => append(item)); refresh();
  const element = h('div', { class: 'profile-presentation-editor ds-stack' }, choices,
    h('section', { class: 'ds-stack', 'aria-label': 'Profile highlights' },
      h('div', { class: 'ds-heading-group' }, h('h3', {}, 'A few things worth opening.'), h('p', { class: 'ds-hint' }, 'Write up to three highlights. You choose the words and links; private task text is never filled in for you.')),
      h('p', { class: 'ds-notice' }, 'Highlights become public when your profile is published, even when the activity stream is off. Saving a private profile keeps them private.'), list,
      h('div', { class: 'ds-toolbar' }, add, limit), status));
  return {
    element, layoutElement: choices, read,
    setPending(value) {
      pending = Boolean(value); choices.disabled = pending;
      for (const row of entries) for (const control of [row.title, row.body, row.url, row.remove]) control.disabled = pending;
      refresh();
    },
    validate() {
      let firstInvalid;
      for (const row of entries) {
        const messages = [row.title.value.trim().length > 0 && row.title.value.trim().length <= 80 ? '' : 'Give this highlight a title of 1–80 characters.', row.body.value.trim().length <= 600 ? '' : 'Keep this note within 600 characters.', highlightUrlError(row.url.value)];
        row.errors.forEach(([control, error], index) => { setError(control, error, messages[index]); if (messages[index] && !firstInvalid) firstInvalid = control; });
      }
      if (firstInvalid) { firstInvalid.focus(); status.textContent = 'Check the highlighted field before saving.'; return false; }
      return true;
    },
  };
}
