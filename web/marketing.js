import { memoryStream, observeContextFlow, contextFlowArt, observeLogoTicker } from './design-system.js';
import { publicAgentCatalog } from './public-agent-catalog.js';

for (const slot of document.querySelectorAll('[data-marketing-stream]')) {
  slot.replaceChildren(memoryStream({ motion: 'intro', label: 'Illustration of saving a decision to shared memory and recalling it for the next task.' }));
}

// Fixed, vetted local examples. Rotating identities are illustrative, never live.
const heroAgents = new Map(publicAgentCatalog.map(product => [product.id, product]));
const heroSlots = { 'source-one': ['claude-code', 'windsurf', 'openclaw'], 'source-two': ['cursor', 'muse', 'instinct'], 'recipient-one': ['codex', 'devin', 'chatgpt'], 'recipient-two': ['chatgpt', 'grok-bot', 'codex'] };
for (const slot of document.querySelectorAll('[data-agent-slot]')) {
  const agents = heroSlots[slot.getAttribute('data-agent-slot')]; if (!agents) continue;
  const description = slot.querySelector('small')?.textContent || '';
  const stack = document.createElement('span'); stack.className = 'ds-context-identities'; stack.setAttribute('aria-hidden', 'true');
  agents.forEach((key, index) => {
    const { label: name, logo: src } = heroAgents.get(key);
    const layer = document.createElement('span'); layer.className = 'ds-context-identity m-agent-identity'; layer.setAttribute('data-flow-identity', String(index));
    const backplate = document.createElement('span'); backplate.className = 'ds-product-logo-frame'; backplate.setAttribute('data-tone', 'inverse');
    const logo = document.createElement('img'); logo.className = 'ds-product-logo'; logo.src = src; logo.width = logo.height = 24; logo.alt = ''; backplate.append(logo);
    const copy = document.createElement('span'), title = document.createElement('strong'), subtitle = document.createElement('small'); title.textContent = name; subtitle.textContent = description; copy.append(title, subtitle);
    layer.append(backplate, copy); stack.append(layer);
  });
  const sheen = document.createElement('span'); sheen.className = 'ds-context-sheen'; sheen.setAttribute('aria-hidden', 'true');
  slot.setAttribute('role', 'img'); slot.setAttribute('aria-label', `Agent examples: ${agents.map(key => heroAgents.get(key).label).join(', ')}. ${description}.`); slot.replaceChildren(stack, sheen);
}
for (const slot of document.querySelectorAll('[data-context-flow-art]')) slot.replaceWith(contextFlowArt({ variant: slot.getAttribute('data-context-flow-art') }));
for (const flow of document.querySelectorAll('[data-context-flow]')) {
  const replayButton = flow.querySelector('[data-context-flow-replay]');
  observeContextFlow(flow, { replayButton, pauseOnInteraction: flow.hasAttribute('data-context-flow-pause-on-interaction'), mode: flow.getAttribute('data-context-flow-mode') === 'loop' ? 'loop' : 'finite' });
  if (replayButton) replayButton.hidden = false;
}
for (const root of document.querySelectorAll('[data-logo-ticker]')) {
  observeLogoTicker(root);
}
