// Local monochrome brand paths from the vendored CC0 Simple Icons subset.
// Sources, commit, licence, and trademark caveat: vendor/simple-icons/SOURCE.md.
import { icon } from "./icons.js";
import { agentAvatar, agentAvatarSeed } from "./agent-avatar.js";

const brands = {
  "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  "cursor": "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  "docker": "M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z",
  "figma": "M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z",
  "git": "M13.09 23.549a1.54 1.54 0 0 1-2.18 0L.451 13.089a1.54 1.54 0 0 1 0-2.179l7.191-7.19 2.733 2.733a1.85 1.85 0 0 0 .964 2.326v6.66a1.849 1.849 0 1 0 1.54 0V8.957l2.508 2.508a1.85 1.85 0 1 0 1.09-1.09l-2.634-2.634a1.85 1.85 0 0 0-2.378-2.377L8.73 2.63 10.91.451a1.54 1.54 0 0 1 2.179 0l10.459 10.46a1.54 1.54 0 0 1 0 2.179z",
  "github": "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  "gmail": "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  "googlecalendar": "M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z"
};

// Product assets are pinned and bundled locally. See vendor/brands/SOURCE.md.
const brandAssets = Object.freeze(Object.fromEntries([
  ['grok-bot', 'grok-bot.png'],
  ...['codex', 'grok', 'openai', 'gemini', 'cline', 'windsurf', 'goose', 'amp', 'opencode', 'githubcopilot',
    'openclaw', 'hermesagent', 'slack', 'notion', 'linear', 'googledrive', 'googledocs', 'googlesheets',
    'googlechrome', 'playwright', 'puppeteer', 'microsoftedge', 'microsoftoutlook', 'dropbox', 'postgresql',
    'supabase', 'vercel', 'safari'].map(name => [name, `${name}.svg`]),
]));
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
  openclaw: 'openclaw', hermes: 'hermesagent', 'hermes-agent': 'hermesagent',
});
const sourceLabels = Object.freeze({ 'hermes-agent': 'Hermes Agent' });

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

/** A display hint, not a verification badge or proof of the connected product. */
export function agentVisual(name, { harness, sourceLabel, publicSafe = false } = {}) {
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
  return { label: displayName, initials: initials(displayName), icon: 'bot', brand: null, ...fallback() };
}

const svgNamespace = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');

/** Return a monochrome inline SVG, with the same size/class/label API as icon(). */
export function brandIcon(brand, { size = 16, class: className = '', label } = {}) {
  if (Object.hasOwn(brandAssets, brand)) {
    const image = document.createElement('img');
    image.src = `/vendor/brands/${brandAssets[brand]}`;
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
  if (visual?.brand) return brandIcon(visual.brand, options);
  if (visual?.avatar?.style === 'beam') return agentAvatar(visual.avatar.seed, options);
  return icon(visual?.icon || 'plug', options);
}
