import { h } from './profile.js';
import { evidenceList, loadingState, statusBadge } from './design-system.js';
import { relativeTime } from './activity-view.js';
import { memoryRuntimeProfile } from './memory-runtime-options.js';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => value === null ? 'Not measured' : new Intl.NumberFormat().format(value);
const bytes = value => value === null ? 'Not measured' : value < 1024 ? `${value} B` : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1024)} KB`;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const declarationLabel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(value) ? value : null;

export function integrationUsePresentation(connection = {}) {
  const memory = connection.memoryUse;
  const value = memory?.integration;
  const seen = timestamp(value?.lastSeenAt), checked = timestamp(value?.checkedAt);
  const expires = timestamp(value?.checkExpiresAt);
  const state = value?.workflowCheck === 'pending' && expires && Date.parse(expires) <= Date.now() ? 'expired' : value?.workflowCheck;
  const passed = state === 'passed' && checked !== null;
  const rows = [
    { label: 'Connection', value: value?.connected === true && seen ? 'Contact verified' : connection.status === 'authorized' ? 'Access authorized' : 'Not verified', note: seen ? `Last received ${relativeTime(seen)}` : 'Access alone does not prove memory use' },
    { label: 'Workflow check', value: passed ? 'Passed' : state === 'pending' ? 'In progress' : state === 'expired' ? 'Expired' : 'Not checked', note: passed ? `Read and save receipts matched · ${relativeTime(checked)}` : state === 'pending' ? 'Waiting for a read and an explicit save in the same check' : state === 'expired' ? 'Start a fresh check from the agent' : 'Run an explicit check from the integration' },
    { label: 'Automatic use', value: 'Not independently verified', note: 'A check does not prove memory is used on every task' },
  ];
  const id = declarationLabel(value?.declaration?.id), version = declarationLabel(value?.declaration?.version), runtime = declarationLabel(value?.declaration?.runtime);
  if (id && version && runtime) rows.push({ label: 'Adapter', value: `${runtime} · ${version}`, note: `Client-declared · ${id}` });
  return { passed, rows };
}

export function memoryUsePresentation(connection = {}) {
  const source = connection.memoryUse;
  if (!source || source.available !== true) return { measured: false, label: 'Not measured yet', tone: 'neutral', rows: [] };
  const reads = count(source.recalls), writes = count(source.remembers), scoped = count(source.runScopedResponses), unscoped = count(source.responseScopedResponses);
  const lastRead = timestamp(source.lastRecallAt), lastWrite = timestamp(source.lastRememberAt);
  const label = reads > 0 && writes > 0 ? 'Recall & save received' : reads > 0 ? 'Recall received' : writes > 0 ? 'Save received' : 'No memory receipts';
  return { measured: true, label, tone: reads > 0 || writes > 0 ? 'accent' : 'neutral', rows: [
    { label: 'Recall', value: reads === null ? 'Not measured' : `${number(reads)} successful ${reads === 1 ? 'read' : 'reads'}`, note: lastRead ? `Last received ${relativeTime(lastRead)}` : 'No successful recall recorded' },
    { label: 'Save', value: writes === null ? 'Not measured' : `${number(writes)} successful ${writes === 1 ? 'save' : 'saves'}`, note: lastWrite ? `Last received ${relativeTime(lastWrite)}` : 'No successful save recorded' },
    { label: 'Context returned', value: bytes(count(source.responseBytes)), note: 'Measured tool response bytes' },
    { label: 'Estimated tokens', value: number(count(source.estimatedTokens)), note: 'UTF-8 bytes ÷ 4. An estimate, not a bill.' },
    { label: 'Task-scoped replies', value: number(scoped), note: unscoped > 0 ? `${number(unscoped)} ${unscoped === 1 ? 'reply had' : 'replies had'} a per-response limit only` : scoped > 0 ? 'Task IDs received from the integration' : 'Use a task-aware integration for a cumulative limit' },
    { label: 'Duplicates skipped', value: number(count(source.duplicateRecalls)) },
    { label: 'Budget stops', value: number(count(source.budgetStops)) },
  ] };
}

export function memoryUsagePanel(connection = {}, { loading = false, error = false } = {}) {
  if (loading) return loadingState({ label: 'Checking memory use…', compact: true });
  const value = memoryUsePresentation(connection);
  const integration = integrationUsePresentation(connection);
  return h('section', { class: 'connection-memory-use ds-stack', 'aria-label': 'Memory use' },
    h('div', { class: 'ds-toolbar' }, h('h3', {}, 'Memory use'), statusBadge(error ? 'Unavailable' : value.label, { tone: error ? 'warning' : value.tone })),
    error ? h('p', { class: 'ds-hint' }, 'Memory use could not load. Refresh Connections to try again.') : value.measured ? evidenceList(value.rows, { label: 'Recorded memory use and estimated context size' })
      : h('p', { class: 'ds-hint' }, 'No measurements yet. The next memory call starts tracking. A connection alone does not prove memory use.'),
    !error && h('details', { class: 'connection-workflow-checks' }, h('summary', {}, 'Integration checks'), evidenceList(integration.rows, { label: 'Connection and workflow verification' })),
    h('p', { class: 'ds-hint' }, 'Estimates cover returned content, not model bills. They exclude tool definitions, inputs and caching.'),
    h('details', {}, h('summary', {}, 'Keep context small'), h('p', { class: 'ds-hint' }, 'Replies default to 4 KB. Reads carrying the same task ID share a cumulative budget and skip duplicates. Other calls have a per-response limit. Explicit detail reads can request up to 16 KB. Jev processing has its own permission and budget.')));
}

function setupHost(endpoint) {
  try {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\x00-\x20\x7f]/.test(endpoint)) return null;
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return `'${url.href.replace(/'/g, `'\\''`)}'`;
  } catch { return null; }
}

export function memorySetupGuide(connection = {}, { copyControl, endpoint } = {}) {
  const grok = connection.harness === 'grok-bot';
  const profile = memoryRuntimeProfile(connection.harness);
  const host = setupHost(endpoint);
  const install = runtime => host ? `engram-mcp memory install ${runtime} --host ${host} --project /absolute/project --topic project-name` : null;
  const command = grok ? 'engram-mcp memory skill grokbot --output ./engram-memory/SKILL.md'
    : profile ? install(profile.target) : 'engram-mcp memory skill generic --output ./engram-memory/SKILL.md';
  const commandRow = (value, label = 'Copy memory setup command') => value
    ? h('div', { class: 'endpoint' }, h('code', { class: 'ds-code-scroll', tabindex: '0', role: 'region', 'aria-label': 'Memory workflow setup command. Scroll horizontally to read.' }, value), copyControl?.(value, label))
    : h('p', { class: 'ds-hint' }, 'The workspace endpoint is unavailable. Refresh Connections before installing.');
  return h('details', { class: 'connection-guide' }, h('summary', {}, 'Set up a memory workflow'),
    h('p', { class: 'ds-hint' }, 'Use the updated Engram connector. Review the project, topic and endpoint before installing.'),
    h('p', { class: 'ds-hint' }, profile ? profile.note
      : grok ? 'Export and enable this skill in Grok Bot using its existing Engram MCP connection. It is agent guidance, with no native task hooks or guaranteed task budget.'
        : 'Enable the portable skill with this agent’s existing Engram MCP connection. Its use is guided by the model. A custom runtime can use the optional task bridge.'),
    commandRow(command),
    !profile && h('details', {}, h('summary', {}, 'Optional runtime bridge'),
      h('p', { class: 'ds-hint' }, grok ? 'For a cumulative task budget, install the CLI and bind the project on the computer where the Bot runs. Grok Bot runs in the cloud; installing on your own computer does not bind it. Use the bridge only when that runtime can run these commands.'
        : 'Bind the project on the agent’s actual computer, then connect its task-start, progress, decision and task-end events. Installation alone does not intercept another app.'),
      commandRow(install(grok ? 'grokbot' : 'generic'), 'Copy optional memory bridge command')),
    connection.canWrite === false && h('p', { class: 'ds-hint' }, 'This connection is read only. Saving memories and reporting work require write access.'),
    h('p', { class: 'ds-hint' }, 'Keep credentials out of command arguments. Setup accepts a hidden token prompt or secure standard input.'));
}
