import { memoryStream } from './design-system.js';

for (const slot of document.querySelectorAll('[data-marketing-stream]')) {
  slot.replaceChildren(memoryStream({ motion: 'intro', label: 'Illustration of saving a decision to shared memory and recalling it for the next task.' }));
}
