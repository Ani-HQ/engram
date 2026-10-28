// Plain status words for app views. A status reads as normal text: muted by
// default, with the functional danger color only when something failed.
const tones = new Set(['neutral', 'success', 'warning', 'danger', 'info']);

export function statusLabel(value, { tone = 'neutral', className = '' } = {}) {
  const label = document.createElement('span');
  label.className = ['status-label', typeof className === 'string' ? className : ''].filter(Boolean).join(' ');
  label.dataset.tone = tones.has(tone) ? tone : 'neutral';
  label.textContent = String(value);
  return label;
}
