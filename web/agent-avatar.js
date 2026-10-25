import { beamData } from './vendor/boring-avatars/beam.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const publicSeed = 'engram-public-agent-v1';
const palette = Object.freeze(Array.from({ length: 5 }, (_, index) => `var(--ds-avatar-${index + 1})`));

/** A local visual variation, never a public identifier or an authentication signal. */
export function agentAvatarSeed(name, { publicSafe = false } = {}) {
  const value = publicSafe ? publicSeed : `engram-agent-v1:${typeof name === 'string' ? name.trim().slice(0, 4096) : 'Agent'}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const svgElement = (tag, attributes) => {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
};

/** Safe DOM adaptation of Boring Avatars Beam. No strings are parsed as markup. */
export function agentAvatar(seed, { size = 24, class: className = '', label } = {}) {
  const data = beamData(seed, palette.length);
  const dimension = Number.isFinite(size) && size >= 1 && size <= 512 ? size : 24;
  const svg = svgElement('svg', {
    viewBox: '0 0 36 36', width: dimension, height: dimension, fill: 'none', overflow: 'hidden',
    focusable: 'false', class: ['icon', 'ds-agent-avatar', className].filter(Boolean).join(' '),
    'data-avatar': 'beam', 'aria-hidden': label ? 'false' : 'true',
  });
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', String(label)); }
  const background = svgElement('rect', { width: 36, height: 36, fill: palette[data.backgroundIndex] });
  const shape = svgElement('rect', {
    x: 0, y: 0, width: 36, height: 36,
    transform: `translate(${data.wrapperTranslateX} ${data.wrapperTranslateY}) rotate(${data.wrapperRotate} 18 18) scale(${data.wrapperScale})`,
    fill: palette[data.wrapperIndex], rx: data.isCircle ? 36 : 6,
  });
  const face = svgElement('g', { transform: `translate(${data.faceTranslateX} ${data.faceTranslateY}) rotate(${data.faceRotate} 18 18)` });
  const faceColor = 'var(--ds-avatar-face)';
  face.append(svgElement('path', data.isMouthOpen ? {
    d: `M15 ${19 + data.mouthSpread}c2 1 4 1 6 0`, stroke: faceColor, fill: 'none', 'stroke-linecap': 'round',
  } : { d: `M13,${19 + data.mouthSpread} a1,0.75 0 0,0 10,0`, fill: faceColor }));
  for (const x of [14 - data.eyeSpread, 20 + data.eyeSpread]) face.append(svgElement('rect', { x, y: 14, width: 1.5, height: 2, rx: 1, stroke: 'none', fill: faceColor }));
  svg.append(background, shape, face);
  return svg;
}
