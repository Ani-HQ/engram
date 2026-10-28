'use strict';

// One-step setup for a whole computer: find the installed agents, approve the
// computer in the browser, then connect each agent with its own access key.
// Nothing is written into project folders; Engram works in every repository.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AGENTS = [
  { harness: 'claude', server: 'claude-code', label: 'Claude Code', commands: ['claude'], paths: ['.claude'], apps: ['/Applications/Claude.app'] },
  { harness: 'codex', server: 'codex', label: 'Codex', commands: ['codex'], paths: ['.codex'], apps: ['/Applications/ChatGPT.app/Contents/Resources/codex-cli', '/Applications/Codex.app'] },
  { harness: 'cursor', server: 'cursor', label: 'Cursor', commands: ['cursor-agent', 'cursor'], paths: ['.cursor'], apps: ['/Applications/Cursor.app'] },
];

function onPath(command, env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some(dir => {
    try { fs.accessSync(path.join(dir, command), fs.constants.X_OK); return true; } catch { return false; }
  });
}

/** Agents with a command, a config folder or a desktop app on this computer. */
function detectAgents({ env = process.env, home = env.HOME || os.homedir(), exists = fs.existsSync } = {}) {
  return AGENTS.filter(agent => agent.commands.some(command => onPath(command, env))
    || agent.paths.some(dir => exists(path.join(home, dir)))
    || agent.apps.some(app => exists(app)));
}

function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function openBrowser(url, platform = process.platform) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* The URL is printed as well. */ }
}

async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  let data = null;
  try { data = await response.json(); } catch { /* Reported below. */ }
  if (response.status === 429) throw new Error('Too many connection attempts from this network. Wait a few minutes and try again.');
  if (!response.ok || !data || typeof data !== 'object') throw new Error(`Engram did not accept the request (HTTP ${response.status}). Check the address and try again.`);
  return data;
}

function computerName(env = process.env) {
  const name = String(env.ENGRAM_DEVICE_NAME || os.hostname() || 'This computer').replace(/\.local$/i, '').replace(/[^\x20-\x7e]/g, '').trim();
  return (name || 'This computer').slice(0, 80);
}

/** Waits for the browser decision. Resolves with the approved grant. */
async function waitForApproval(fetchImpl, base, start, { sleep, now }) {
  let interval = Math.max(1, Number(start.interval) || 3) * 1000;
  const deadline = now() + Math.max(30, Number(start.expiresIn) || 600) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    let result;
    try { result = await postJson(fetchImpl, `${base}/api/device/poll`, { deviceCode: start.deviceCode }); }
    catch (error) { if (/Too many/.test(error.message)) { interval += 2000; continue; } throw error; }
    if (result.status === 'pending') continue;
    if (result.status === 'slow_down') { interval += 2000; continue; }
    if (result.status === 'approved') return result;
    if (result.status === 'denied') throw new Error('The request was denied in the browser. Nothing was changed.');
    if (result.status === 'consumed') throw new Error('This approval was already used. Run the command again to connect this computer.');
    throw new Error('The approval code expired. Run the command again for a new code.');
  }
  throw new Error('The approval code expired. Run the command again for a new code.');
}

/** Connects one agent with its key. Returns the files it changed. */
async function connectAgent(agent, grant, token, dependencies) {
  const { endpointForHost, inspectConnection } = require('./onboarding');
  const memory = require('./memory'), files = require('./setup-files');
  const target = endpointForHost(grant.host);
  target.token = token;
  const checks = await inspectConnection(target, dependencies.fetchImpl);
  if (!checks.identity) throw new Error('the new key could not be verified');
  const prepared = await memory.prepareInstall(agent.harness, { everywhere: true, host: target.host, token }, { checks, fetchImpl: dependencies.fetchImpl });
  const mcp = dependencies.planConnection(agent.harness, target.endpoint, token, prepared.writes);
  const writes = [...prepared.writes.filter(write => path.resolve(write.file) !== path.resolve(mcp.file)), mcp];
  const committed = files.commitWrites(files.planWrites(writes, memory.internals), memory.internals, dependencies);
  if (dependencies.cacheTools) dependencies.cacheTools(target.host, token, checks.tools);
  return committed;
}

async function connectComputer(args, dependencies) {
  const { output = process.stdout, env = process.env, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, open = openBrowser } = dependencies;
  let host = env.ENGRAM_HOST || require('./onboarding').HOSTED_URL;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) host = args[++i];
    else if (args[i].startsWith('--host=')) host = args[i].slice(7);
    else throw new Error(`Unknown option: ${args[i]}. Run engram-mcp setup with no options to connect this computer.`);
  }
  const base = require('./onboarding').endpointForHost(host).host;
  output.write('\nConnect this computer to Engram\n\n');
  const agents = (dependencies.detect || detectAgents)({ env });
  if (!agents.length) {
    output.write('No supported agents found. Install Claude Code, Codex or Cursor, then run this again.\n');
    return 1;
  }
  output.write(`Found ${listNames(agents.map(agent => agent.label))}.\n`);
  const device = computerName(env);
  const start = await postJson(fetchImpl, `${base}/api/device/start`, { device, agents: agents.map(agent => ({ harness: agent.server, label: agent.label })) });
  if (typeof start.deviceCode !== 'string' || typeof start.userCode !== 'string' || typeof start.verificationUri !== 'string') throw new Error('Engram returned an unexpected response. Update with npx @ani-hq/engram-mcp@latest.');
  output.write(`\nApprove it in your browser. Check the code matches: ${start.userCode}\n`);
  output.write(`If the page doesn't open, visit ${start.verificationUri} and enter the code.\n`);
  open(start.verificationUriComplete || start.verificationUri);
  output.write('\nWaiting for approval…\n');
  const grant = await waitForApproval(fetchImpl, base, start, { sleep, now });
  const workspace = grant.workspace?.name ? ` to ${grant.workspace.name}` : '';
  output.write(`Approved${workspace}.\n\n`);
  const tokens = new Map((grant.tokens || []).map(item => [item.harness, item.token]));
  const connected = [], failed = [];
  for (const agent of agents) {
    const token = tokens.get(agent.server);
    try {
      if (typeof token !== 'string' || !token) throw new Error('no key was issued');
      await connectAgent(agent, { ...grant, host: grant.host || base }, token, dependencies);
      connected.push(agent);
      output.write(`✓ ${agent.label}\n`);
    } catch (error) {
      failed.push(agent);
      const safe = String(error.message || 'setup failed').split(token || '\u0000').join('[key]').slice(0, 240);
      output.write(`✗ ${agent.label}: ${safe}\n`);
    }
  }
  if (!connected.length) {
    output.write('\nNo agent was connected. Run this again, or ask for help at https://engram.ani.computer/support.\n');
    return 1;
  }
  output.write(`\nDone. Engram now works in every repo on this computer, in the command line and desktop apps.\n`);
  output.write('Restart any agent that is already open so it picks up Engram.\n');
  if (connected.some(agent => agent.harness === 'codex')) output.write('Codex asks once before running new hooks: open Codex, run /hooks, and approve Engram.\n');
  if (failed.length) output.write(`Run this again later to finish ${listNames(failed.map(agent => agent.label))}.\n`);
  return failed.length ? 1 : 0;
}

module.exports = { AGENTS, detectAgents, connectComputer, waitForApproval, computerName, listNames };
