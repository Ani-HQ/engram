'use strict';

const { randomBytes } = require('node:crypto');
const readline = require('node:readline');

const HOSTED_URL = 'https://engram.ani.computer';
const HARNESSES = ['claude', 'codex', 'cursor', 'vscode', 'windsurf'];
const LABELS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', vscode: 'VS Code', windsurf: 'Windsurf' };
const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 256_000;

function endpointForHost(value) {
  let url;
  const raw = String(value).trim();
  // URL parsers silently discard embedded tabs/newlines. Reject these before
  // parsing so a pasted value cannot change the credential destination.
  if (/[\s\x00-\x1f\x7f-\x9f]/u.test(raw)) throw new Error('The Engram URL must not contain internal whitespace or control characters.');
  try { url = new URL(raw); } catch { throw new Error('Use a complete Engram URL, such as https://engram.ani.computer.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Engram requires HTTPS. HTTP is allowed only for a local loopback server.');
  if (url.username || url.password || url.search || url.hash) throw new Error('The Engram URL must not contain credentials, a query, or a fragment.');
  if (url.href.length > 2048) throw new Error('The Engram URL is too long.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '') + '/mcp';
  return { endpoint: url.href, host: url.href.replace(/\/mcp$/, '') };
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (arg === '--token-stdin') { result.tokenStdin = true; continue; }
    if (arg === '--host') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--host requires a URL.');
      result.host = args[++i]; continue;
    }
    if (arg.startsWith('--host=')) { result.host = arg.slice(7); continue; }
    if (arg === '--token' || arg.startsWith('--token=')) throw new Error('Keep your token out of command history. Paste it at the hidden prompt, use ENGRAM_TOKEN, or pipe it with --token-stdin.');
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg.split('=')[0]}`);
    if (result.harness) throw new Error('Choose one agent per command.');
    result.harness = arg.toLowerCase();
  }
  if (result.harness && !HARNESSES.includes(result.harness)) throw new Error(`Choose one of: ${HARNESSES.join(', ')}.`);
  return result;
}

function printHelp(command, output) {
  output.write(`Usage: engram-mcp ${command} [${HARNESSES.join('|')}] [--host <url>] [--token-stdin]\n\n`);
  output.write(command === 'setup'
    ? 'Guided setup checks access, then updates only this agent’s Engram entry.\n'
    : 'Read-only checks of live identity and tool discovery. No memory is read or written.\n');
  output.write('Tokens use a hidden terminal prompt or ENGRAM_TOKEN. For automation, pipe a token with --token-stdin.\n');
}

function askLine(label, input, output) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    let answered = false;
    rl.once('SIGINT', () => { rl.close(); reject(new Error('Cancelled. No configuration was changed.')); });
    rl.once('close', () => { if (!answered) reject(new Error('Input ended. No configuration was changed.')); });
    rl.question(label, value => { answered = true; rl.close(); resolve(value.trim()); });
  });
}

function askSecret(input, output) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('A hidden token prompt requires a terminal. Use ENGRAM_TOKEN or --token-stdin for automation.');
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = Boolean(input.isRaw);
    const finish = (error) => {
      input.removeListener('data', data);
      input.removeListener('end', ended);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const ended = () => finish(new Error('Input ended. No configuration was changed.'));
    const data = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return finish(new Error('Cancelled. No configuration was changed.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char <= '~') value += char;
        else return finish(new Error('The token contains an unsupported character. Paste the access token only.'));
        if (value.length > 4096) return finish(new Error('The token is too long. Paste the access token only.'));
      }
    };
    input.setRawMode(true);
    input.on('data', data);
    input.once('end', ended);
    output.write('Access token (hidden; paste, then press Enter): ');
    input.resume();
  });
}

async function tokenFromStdin(input) {
  let value = '';
  const timer = setTimeout(() => input.destroy(new Error('Timed out waiting for the piped token. Send the access token and close the input stream.')), TIMEOUT_MS);
  try {
    for await (const chunk of input) {
      value += chunk.toString('utf8');
      if (value.length > 4096) throw new Error('The token is too long. Pipe the access token only.');
    }
    return value.trim();
  } finally {
    clearTimeout(timer);
  }
}

function tokenValue(value) {
  const token = String(value || '').trim();
  if (!token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new Error('An access token is required. Copy it from Connections in your Engram workspace.');
  return token;
}

function safeLabel(value, token) {
  return String(value).split(token).join('[redacted]').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160);
}

async function readJson(response) {
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Engram returned an oversized response.');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (size > MAX_RESPONSE_BYTES) throw error;
    throw new Error('Engram returned an invalid response. Check the endpoint and any proxy or firewall.');
  }
}

async function inspectConnection(target, fetchImpl = fetch) {
  let id = 0;
  async function rpc(method, params) {
    let response;
    try {
      response = await fetchImpl(target.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'engram-mcp-onboarding/1', Authorization: `Bearer ${target.token}`, 'Mcp-Method': method, ...(params?.name ? { 'Mcp-Name': params.name } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
      });
    } catch {
      throw new Error('Could not reach Engram within the connection check. Check the URL and network, then retry; a sleeping self-hosted server may need time to start.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new Error('Access token rejected (HTTP 401). Create or copy an active token from Connections, then retry.');
      if (response.status === 403) throw new Error('Access denied (HTTP 403). Check token permissions and any proxy or firewall, then retry.');
      throw new Error(`Engram returned HTTP ${response.status}. Check server readiness and retry.`);
    }
    const payload = await readJson(response);
    if (payload?.error || !payload?.result || payload.result.isError) throw new Error(`${method === 'tools/list' ? 'Tool discovery' : 'Identity check'} was rejected. Check the token and workspace access, then retry.`);
    return payload.result;
  }
  const identityResult = await rpc('tools/call', { name: 'whoami', arguments: {} });
  let identity;
  try { identity = identityResult.content?.filter(item => item.type === 'text').map(item => JSON.parse(item.text)).find(item => typeof item.token === 'string' && item.token.trim()); } catch { /* Invalid identity is not verified. */ }
  if (!identity) throw new Error('Engram did not return a usable identity. Check that this is an Engram MCP endpoint.');
  const catalog = await rpc('tools/list');
  const tools = Array.isArray(catalog.tools) ? catalog.tools.filter(tool => tool && typeof tool.name === 'string' && tool.name.trim()) : [];
  if (!tools.length || !tools.some(tool => tool.name === 'whoami') || !tools.some(tool => tool.name === 'recall')) throw new Error('The live catalog is missing Engram identity or recall tools. Check server readiness and retry.');
  return { identity: safeLabel(identity.token, target.token), tools };
}

function printChecks(checks, output) {
  output.write(`✓ Authenticated as ${checks.identity}\n✓ Live tool discovery: ${checks.tools.length} tools\n`);
  output.write(`  Memory tools: recall${checks.tools.some(tool => tool.name === 'remember') ? ', remember' : ''} listed.\n`);
  output.write('  Memory reads and writes have not been tested. Listed tools do not prove write permission or billing access.\n');
}

function nextPrompt() {
  const marker = `engram-check-${randomBytes(5).toString('hex')}`;
  return `Use Engram to remember “My connection check is ${marker}” under topic “connection-check”. Only after that succeeds, recall “${marker}” and show the matching result. If a call fails, report the failure without claiming it worked.`;
}

async function runOnboarding(command, args, dependencies) {
  const { input = process.stdin, output = process.stdout, env = process.env, configure, configPath, readConnection, cacheTools, fetchImpl } = dependencies;
  const parsed = parseArgs(args);
  if (parsed.help) { printHelp(command, output); return 0; }
  const interactive = Boolean(input.isTTY && output.isTTY);
  output.write(command === 'setup' ? '\nConnect your agent to Engram\n' : '\nCheck your Engram connection\n');
  let harness = parsed.harness;
  if (command === 'setup' && !harness) {
    if (!interactive) throw new Error('Choose an agent: engram-mcp setup <claude|codex|cursor|vscode|windsurf>. Use ENGRAM_TOKEN or --token-stdin outside a terminal.');
    output.write(HARNESSES.map((name, i) => `  ${i + 1}. ${LABELS[name]}`).join('\n') + '\n');
    const choice = await askLine('Which agent? [1-5 or name]: ', input, output);
    harness = HARNESSES[Number(choice) - 1] || choice.toLowerCase();
    if (!HARNESSES.includes(harness)) throw new Error(`Choose one of: ${HARNESSES.join(', ')}. Run setup again to choose.`);
  }

  let stored;
  if (command !== 'setup' && harness) {
    stored = readConnection(harness);
    output.write(`Config: ${configPath(harness)}\n`);
  }
  let host = parsed.host || env.ENGRAM_HOST || stored?.host;
  if (!host && command === 'setup' && interactive) {
    output.write('  1. Engram hosted\n  2. My self-hosted server\n');
    const source = await askLine('Where is your memory? [1]: ', input, output);
    if (!source || source === '1' || source.toLowerCase() === 'hosted') host = HOSTED_URL;
    else if (source === '2' || source.toLowerCase() === 'self-hosted') host = await askLine('Your Engram base URL: ', input, output);
    else throw new Error('Choose 1 for Engram hosted or 2 for your self-hosted server.');
  }
  const target = endpointForHost(host || HOSTED_URL);
  output.write(`Endpoint: ${target.endpoint}\n`);
  // A --host override must never silently forward a saved credential to a
  // different server. An explicitly supplied environment token remains usable.
  const sameStoredEndpoint = stored?.host && endpointForHost(stored.host).endpoint === target.endpoint;
  let token = env.ENGRAM_TOKEN || (sameStoredEndpoint ? stored?.token : undefined);
  if (parsed.tokenStdin) {
    if (input.isTTY) throw new Error('--token-stdin expects piped input. Omit it to use the hidden terminal prompt.');
    token = await tokenFromStdin(input);
  }
  if (!token && interactive) {
    output.write(`In ${target.host}/#connect, create an access token for this agent.\n`);
    token = await askSecret(input, output);
  }
  if (!token && !interactive) throw new Error('Token missing. Run this command in a terminal for a hidden prompt, set ENGRAM_TOKEN, or pipe a token with --token-stdin.');
  target.token = tokenValue(token);
  output.write('Checking your live identity and tool catalog…\n');
  const checks = await inspectConnection(target, fetchImpl);
  printChecks(checks, output);

  if (command === 'setup') {
    output.write(`\nUpdating ${LABELS[harness]}: ${configPath(harness)}\nOnly the Engram entry is replaced. Existing configuration is backed up first.\n`);
    let code;
    try { code = configure(harness, target.endpoint, target.token); }
    catch (error) { throw new Error(`Live access passed, but agent configuration failed. ${safeLabel(error.message || 'Could not update the config file.', target.token)} Setup is not complete.`); }
    if (code !== 0) throw new Error('Live access passed, but agent configuration failed. Review the configuration error above; setup is not complete.');
    if (cacheTools && cacheTools(target.host, target.token, checks.tools) === false) output.write('Tool catalog cache could not be saved; live access passed and agent configuration was written.\n');
    output.write(`\nEngram is configured. Restart ${LABELS[harness]} or refresh its MCP connections.\n`);
    output.write(`Check this config again: engram-mcp doctor ${harness}\n`);
  } else output.write('\nLive access passed. This check does not prove your agent has loaded the connection.\n');
  output.write('\nNext, paste this into your agent to explicitly test one memory write and recall:\n' + nextPrompt() + '\n');
  return 0;
}

module.exports = { HOSTED_URL, endpointForHost, inspectConnection, runOnboarding, askSecret, nextPrompt };
