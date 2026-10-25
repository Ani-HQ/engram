import { memoryOrbit, memoryStream } from './design-system.js';

for (const slot of document.querySelectorAll('[data-marketing-orbit]')) {
  slot.replaceChildren(memoryOrbit({ agents: true, motion: 'intro', label: 'Illustration: Claude, OpenClaw, Grok Bot, Muse and Instinct around shared memory, saved decisions and the next task. Agent examples, not live connections.' }));
}
for (const slot of document.querySelectorAll('[data-marketing-stream]')) {
  slot.replaceChildren(memoryStream({ motion: 'intro', label: 'Illustration of saving a decision to shared memory and recalling it for the next task.' }));
}
