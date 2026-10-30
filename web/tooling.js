// Product marks: vendored SVG files listed in brand-catalog.js, plus inline paths below.
// Sources, commit, licence, and trademark caveat: vendor/simple-icons/SOURCE.md.
import { icon } from "./icons.js";
import { agentAvatar, agentAvatarSeed } from "./agent-avatar.js";
import { brandCatalog } from "./brand-catalog.js";

// Inline marks follow currentColor (text color). Everything else is a vendored file.
const brands = {
  "github": "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
};

export const agentSources = Object.freeze([
  ['grok-bot', 'Grok Bot'], ['grok', 'Grok'], ['codex', 'Codex'], ['claude-code', 'Claude Code'],
  ['claude', 'Claude'], ['cursor', 'Cursor'], ['chatgpt', 'ChatGPT'], ['gemini-cli', 'Gemini CLI'],
  ['opencode', 'OpenCode'], ['cline', 'Cline'], ['windsurf', 'Windsurf'], ['goose', 'Goose'],
  ['amp', 'Amp'], ['github-copilot', 'GitHub Copilot'], ['openclaw', 'OpenClaw'],
  ['hermes', 'Hermes Agent'], ['other', 'Custom agent'],
].map(source => Object.freeze(source)));
const sourceBrands = Object.freeze({
  'grok-bot': 'grok-bot', grok: 'grok', codex: 'codex', 'claude-code': 'claude', claude: 'claude',
  cursor: 'cursor', chatgpt: 'openai', 'gemini-cli': 'gemini', gemini: 'gemini', opencode: 'opencode',
  cline: 'cline', windsurf: 'windsurf', goose: 'goose', amp: 'amp', 'github-copilot': 'githubcopilot',
  openclaw: 'openclaw', hermes: 'hermesagent', 'hermes-agent': 'hermesagent', devin: 'devin', 'devin-cli': 'devin',
});
// Agents recognized by name only (not offered as setup sources). Anchored at the start, like the rules above.
const extraAgents = Object.freeze([
  [/^devin(?:[-_ ]cli)?(?:$|[-_ .:/])/, 'Devin', 'devin'], [/^aider(?:$|[-_ .:/])/, 'Aider', 'aider'],
  [/^(?:vscode|vs[-_ ]code|visual[-_ ]studio[-_ ]code)(?:$|[-_ .:/])/, 'Visual Studio Code', 'vscode'],
  [/^augment(?:[-_ ]code)?(?:$|[-_ .:/])/, 'Augment', 'augment'], [/^roo(?:[-_ ]?code)?(?:$|[-_ .:/])/, 'Roo Code', 'roo'],
  [/^kilo(?:[-_ ]?code)?(?:$|[-_ .:/])/, 'Kilo Code', 'kilocode'], [/^qwen(?:[-_ ]code)?(?:$|[-_ .:/])/, 'Qwen Code', 'qwen'],
  [/^kiro(?:$|[-_ .:/])/, 'Kiro', 'kiro'], [/^zed(?:$|[-_ .:/])/, 'Zed', 'zed'], [/^warp(?:$|[-_ .:/])/, 'Warp', 'warp'],
  [/^junie(?:$|[-_ .:/])/, 'Junie', 'junie'], [/^trae(?:$|[-_ .:/])/, 'Trae', 'trae'],
].map(rule => Object.freeze(rule)));
const sourceLabels = Object.freeze({ 'hermes-agent': 'Hermes Agent', devin: 'Devin CLI', 'devin-cli': 'Devin CLI' });

/** Safe, local catalog for known tool namespaces. Labels and marks are display hints. */
export const toolCatalog = Object.freeze([
  ['github', 'GitHub', 'code', 'github', ['github']],
  ['git', 'Git', 'git-branch', 'git', ['git']],
  ['gmail', 'Gmail', 'mail', 'gmail', ['gmail', 'googlemail', 'google_mail', 'google-mail']],
  ['googlecalendar', 'Google Calendar', 'calendar', 'googlecalendar', ['googlecalendar', 'google_calendar', 'google-calendar', 'gcal']],
  ['googledrive', 'Google Drive', 'file-text', 'googledrive', ['googledrive', 'google_drive', 'google-drive', 'gdrive']],
  ['googledocs', 'Google Docs', 'file-text', 'googledocs', ['googledocs', 'google_docs', 'google-docs', 'gdocs']],
  ['googlesheets', 'Google Sheets', 'database', 'googlesheets', ['googlesheets', 'google_sheets', 'google-sheets', 'gsheets']],
  ['docker', 'Docker', 'cloud', 'docker', ['docker']],
  ['figma', 'Figma', 'layers', 'figma', ['figma']],
  ['slack', 'Slack', 'hash', 'slack', ['slack']],
  ['notion', 'Notion', 'file-text', 'notion', ['notion']],
  ['linear', 'Linear', 'layers', 'linear', ['linear']],
  ['playwright', 'Playwright', 'globe', 'playwright', ['playwright']],
  ['puppeteer', 'Puppeteer', 'globe', 'puppeteer', ['puppeteer']],
  ['googlechrome', 'Chrome', 'globe', 'googlechrome', ['chrome', 'googlechrome', 'google_chrome', 'google-chrome']],
  ['microsoftedge', 'Microsoft Edge', 'globe', 'microsoftedge', ['edge', 'microsoftedge', 'microsoft_edge', 'microsoft-edge']],
  ['safari', 'Safari', 'globe', 'safari', ['safari']],
  ['microsoftoutlook', 'Outlook', 'mail', 'microsoftoutlook', ['outlook', 'microsoftoutlook', 'microsoft_outlook', 'microsoft-outlook']],
  ['dropbox', 'Dropbox', 'file-text', 'dropbox', ['dropbox']],
  ['postgresql', 'PostgreSQL', 'database', 'postgresql', ['postgres', 'postgresql']],
  ['supabase', 'Supabase', 'database', 'supabase', ['supabase']],
  ['vercel', 'Vercel', 'cloud', 'vercel', ['vercel']],
  ['browser', 'Browser', 'globe', null, ['browser', 'web']],
  ['terminal', 'Terminal', 'terminal', null, ['terminal', 'shell', 'bash', 'zsh', 'exec_command', 'execute_command', 'exec']],
  ['calendar', 'Calendar', 'calendar', null, ['calendar']],
  ['email', 'Email', 'mail', null, ['email', 'mail']],
  ['memory', 'Memory', 'brain', null, ['engram', 'gbrain', 'memory']],
  ['files', 'Files', 'file-text', null, ['files', 'file', 'fs', 'drive', 'read_text', 'write_text', 'read_file', 'write_file']],
  ['deployment', 'Deployment', 'cloud', null, ['deploy', 'deployment', 'cloud', 'aws', 'azure', 'kubernetes', 'terraform']],
  ['database', 'Database', 'database', null, ['database', 'db', 'mysql', 'sql', 'sqlite', 'spreadsheet', 'sheets', 'query']],
].map(([id, label, iconName, brand, namespaces]) => Object.freeze({ id, label, icon: iconName, brand, namespaces: Object.freeze(namespaces) })));

/** Fixed provider identity only. Resource parsing and tool namespace inference
 * are separate boundaries; arbitrary input can never supply an asset URL. */
export function providerVisual(service) {
  const aliases = { cloud: "deployment", data: "database" };
  const id = typeof service === "string" && Object.hasOwn(aliases, service) ? aliases[service] : service;
  if (id === "code") return { label: "Code", icon: "code", brand: null };
  const entry = toolCatalog.find(entry => entry.id === id);
  if (entry) return { label: entry.label, icon: entry.icon, brand: entry.brand };
  if (id === "gitlab") return { label: "GitLab", icon: "git-branch", brand: null };
  return { label: "Other service", icon: "link", brand: null };
}
export const serviceVisual = providerVisual;

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toolRules = toolCatalog.map(entry => [entry, new RegExp(`^(?:${entry.namespaces.map(escapePattern).join('|')})(?:$|[._:/-])`)]);
const memoryOperations = new Set(['remember', 'recall', 'search', 'get_page', 'list_pages', 'put_page', 'add_tag', 'add_link', 'add_timeline_entry']);
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function words(value) { return text(value).replace(/[._:/-]+/g, ' ').replace(/\s+/g, ' '); }

function toolIdentifier(value) {
  const name = text(value).toLowerCase();
  if (!name || name.length > 256 || !/^[a-z0-9][a-z0-9._:/-]*$/.test(name) || name.includes('://')) return null;
  if (!name.startsWith('mcp__')) return { name, namespace: null };
  const separator = name.indexOf('__', 5);
  if (separator < 0) return null;
  const namespace = name.slice(5, separator), operation = name.slice(separator + 2);
  // An MCP server must match an alias exactly. A lookalike server or a provider
  // mentioned only in the operation cannot inherit that provider's mark.
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/.test(namespace) || !/^[a-z0-9][a-z0-9._:/-]*$/.test(operation)) return null;
  return { name: `${namespace}.${operation}`, namespace };
}

/** Anchored tool identity only: never infer a vendor from resource URLs or substrings. */
export function toolVisual(tool) {
  const identifier = toolIdentifier(tool);
  if (identifier) {
    for (const [entry, pattern] of toolRules) {
      if (identifier.namespace ? entry.namespaces.includes(identifier.namespace) : pattern.test(identifier.name)) {
        return { label: entry.label, icon: entry.icon, brand: entry.brand };
      }
    }
    if (!identifier.namespace && memoryOperations.has(identifier.name)) return { label: 'Memory', icon: 'brain', brand: null };
  }
  const label = words(tool);
  return { label: label ? label[0].toUpperCase() + label.slice(1) : 'Tool', icon: 'plug', brand: null };
}

function initials(value) {
  const parts = words(value).split(' ').filter(Boolean);
  if (!parts.length) return 'AG';
  return (parts.length > 1
    ? Array.from(parts[0])[0] + Array.from(parts.at(-1))[0]
    : Array.from(parts[0]).slice(0, 2).join('')).toUpperCase();
}

// Names and logos an agent reported about itself through set_identity, or a
// workspace owner chose. Keyed by the authenticated agent name. Display hints
// only, and never used on public pages.
const customIdentities = new Map();
export function setAgentIdentities(list = []) {
  customIdentities.clear();
  for (const identity of Array.isArray(list) ? list : []) {
    if (typeof identity?.agent !== 'string' || !(identity.name || identity.logo || identity.locked)) continue;
    const logo = typeof identity.logo === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(identity.logo) ? identity.logo : null;
    customIdentities.set(identity.agent, { ...identity, name: text(identity.name) || null, logo });
  }
}
export function agentIdentity(name) { return customIdentities.get(text(name)) ?? null; }

/** A display hint, not a verification badge or proof of the connected product. */
export function agentVisual(name, options = {}) {
  const visual = detectedAgentVisual(name, options);
  const custom = options.publicSafe ? null : customIdentities.get(text(name));
  if (!custom?.name && !custom?.logo) return visual;
  const { avatar, ...rest } = visual;
  return { ...(custom.logo ? { ...rest, brand: null, logo: custom.logo } : visual), label: custom.name || visual.label, custom: custom.source || 'agent' };
}

/** The mark detected from the connection alone, ignoring any custom identity. */
export function detectedAgentVisual(name, { harness, sourceLabel, publicSafe = false } = {}) {
  const original = text(name) || 'Agent';
  const displayName = publicSafe ? 'Agent' : original;
  const source = text(harness).toLowerCase();
  const fallback = () => ({ avatar: { style: 'beam', seed: agentAvatarSeed(original, { publicSafe }) } });
  if (source) {
    const brand = Object.hasOwn(sourceBrands, source) ? sourceBrands[source] : null;
    return { label: (!publicSafe && text(sourceLabel)) || agentSources.find(([id]) => id === source)?.[1] || (Object.hasOwn(sourceLabels, source) ? sourceLabels[source] : null) || 'Custom agent', initials: initials(displayName), icon: 'bot', brand, ...(!brand ? fallback() : {}) };
  }
  let identity = original;
  if (identity.startsWith('oauth:')) {
    try { identity = decodeURIComponent(identity.slice(identity.lastIndexOf(':') + 1)); } catch { identity = original; }
    try { identity = new URL(identity).hostname; } catch { /* opaque client IDs retain their own name */ }
  }
  const value = identity.toLowerCase();
  if (/^grok[-_ ]?bot(?:$|[-_ .:/])/.test(value)) return { label: 'Grok Bot', initials: 'GB', icon: 'bot', brand: 'grok-bot' };
  if (/^grok(?:$|[-_ .:/])/.test(value)) return { label: 'Grok', initials: 'GR', icon: 'bot', brand: 'grok' };
  if (/^(?:mac[-_])?claude(?:$|[-_ .:/])/.test(value)) {
    return { label: /^claude[-_ ]code(?:$|[-_ .:/])/.test(value) ? 'Claude Code' : 'Claude', initials: 'CL', icon: 'bot', brand: 'claude' };
  }
  if (/^cursor(?:$|[-_ .:/])/.test(value)) return { label: 'Cursor', initials: 'CU', icon: 'bot', brand: 'cursor' };
  if (/^codex(?:$|[-_ .:/])/.test(value)) return { label: 'Codex', initials: 'CX', icon: 'code', brand: 'codex' };
  for (const [pattern, source] of [[/^openclaw(?:$|[-_ .:/])/, 'openclaw'], [/^hermes[-_ ]agent(?:$|[-_ .:/])/, 'hermes'], [/^chatgpt(?:$|[-_ .:/])/, 'chatgpt'], [/^gemini(?:[-_ ]cli)?(?:$|[-_ .:/])/, 'gemini-cli'], [/^opencode(?:$|[-_ .:/])/, 'opencode'], [/^cline(?:$|[-_ .:/])/, 'cline'], [/^windsurf(?:$|[-_ .:/])/, 'windsurf'], [/^goose(?:$|[-_ .:/])/, 'goose'], [/^amp(?:$|[-_ .:/])/, 'amp'], [/^(?:github[-_ ]?)?copilot(?:$|[-_ .:/])/, 'github-copilot']]) {
    if (pattern.test(value)) return { label: agentSources.find(([id]) => id === source)[1], initials: initials(displayName), icon: 'bot', brand: sourceBrands[source] };
  }
  for (const [pattern, label, brand] of extraAgents) if (pattern.test(value)) return { label, initials: initials(displayName), icon: 'bot', brand };
  return { label: displayName, initials: initials(displayName), icon: 'bot', brand: null, ...fallback() };
}

const svgNamespace = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');

/** Return a monochrome inline SVG, with the same size/class/label API as icon(). */
export function brandIcon(brand, { size = 16, class: className = '', label } = {}) {
  if (!Object.hasOwn(brands, brand) && Object.hasOwn(brandCatalog, brand)) {
    const image = document.createElement('img');
    image.src = `/vendor/brands/${brandCatalog[brand].file}`;
    image.setAttribute('data-tone', brandCatalog[brand].tone);
    image.width = size; image.height = size; image.alt = label || ''; image.draggable = false;
    image.className = ['icon', 'brand-icon', `brand-${brand}`, className].filter(Boolean).join(' ');
    image.setAttribute('data-brand', brand);
    if (!label) image.setAttribute('aria-hidden', 'true');
    return image;
  }
  if (!Object.hasOwn(brands, brand)) return icon('plug', { size, class: className, label });
  const svg = document.createElementNS(svgNamespace, 'svg');
  for (const [key, value] of Object.entries({
    width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor',
    focusable: 'false', class: ['icon', 'brand-icon', `brand-${brand}`, className].filter(Boolean).join(' '),
    'data-brand': brand, 'aria-hidden': label ? 'false' : 'true',
  })) svg.setAttribute(key, String(value));
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', String(label)); }
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('d', brands[brand]);
  svg.append(path);
  return svg;
}

/** Known products keep their source logo. Unknown agents get a local Beam face. */
export function visualIcon(visual, options) {
  if (visual?.logo) {
    const { size = 16, class: className = '', label } = options || {};
    const image = document.createElement('img');
    image.src = visual.logo; image.width = size; image.height = size; image.alt = label || ''; image.draggable = false;
    image.className = ['icon', 'agent-logo', className].filter(Boolean).join(' ');
    if (!label) image.setAttribute('aria-hidden', 'true');
    return image;
  }
  if (visual?.brand) return brandIcon(visual.brand, options);
  if (visual?.avatar?.style === 'beam') return agentAvatar(visual.avatar.seed, options);
  return icon(visual?.icon || 'plug', options);
}
