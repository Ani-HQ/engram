// Live agent-to-agent handoff lab. Local gateway, scratch repos, test tokens only.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

// Usage: copy into a scratch directory with tokens/<agent> files and run `bun continuation-lab.ts all 5`.
const L = process.env.LAB_DIR ?? path.dirname(new URL(import.meta.url).pathname);
const REPO = process.env.ENGRAM_REPO ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE = process.execPath.includes("bun") ? (await Bun.$`which node`.text()).trim() : process.execPath;
const SHIM = `${REPO}/shim/index.js`;
const HOST = "http://localhost:8787";
const XDG = { XDG_CONFIG_HOME: `${L}/xdg/config`, XDG_STATE_HOME: `${L}/xdg/state` };
const RUNTIMES = { claude: "claude-code", codex: "codex", cursor: "cursor" } as const;
type Runtime = keyof typeof RUNTIMES;
const token = (runtime: Runtime) => readFileSync(`${L}/tokens/${RUNTIMES[runtime]}`, "utf8").trim();
const data = postgres("postgresql://engram_test:engram_test@127.0.0.1:25432/brain_org_2", { max: 2, onnotice() {} });
const gateway = postgres("postgresql://engram_test:engram_test@127.0.0.1:25432/engram_gateway", { max: 2, onnotice() {} });

const TASK_FILES = {
  "inventory.js": "// Inventory helpers. Implement the functions below.\n'use strict';\n\nfunction addItem(inventory, name, quantity, price) { throw new Error('not implemented'); }\nfunction removeItem(inventory, name, quantity) { throw new Error('not implemented'); }\nfunction totalValue(inventory) { throw new Error('not implemented'); }\n\nmodule.exports = { addItem, removeItem, totalValue };\n",
  "README.md": "# Inventory\n\nImplement `addItem`, `removeItem` and `totalValue` in `inventory.js`. Inventory is a plain object mapping item name to `{ quantity, price }`. `addItem` adds stock (creating the item), `removeItem` reduces stock and throws if there is not enough, `totalValue` sums quantity × price. Add `node:test` tests for each in `test.js` and run `node --test`.\n",
};

function bindingFor(project: string, runtime: Runtime) {
  return { project, runtime: RUNTIMES[runtime] === "claude-code" ? "claude" : runtime, host: HOST, token: token(runtime), topic: path.basename(project), budget: 4096, reportAvailable: true, memoryWriteAvailable: true };
}

function setup(id: string, runtimes: Runtime[]) {
  const project = `${L}/runs/${id}`;
  mkdirSync(`${project}/.cursor`, { recursive: true }); mkdirSync(`${project}/.codex`, { recursive: true });
  for (const [file, body] of Object.entries(TASK_FILES)) writeFileSync(`${project}/${file}`, body);
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  Bun.spawnSync(["git", "add", "-A"], { cwd: project });
  Bun.spawnSync(["git", "-c", "user.email=lab@example.test", "-c", "user.name=lab", "commit", "-qm", "start"], { cwd: project });
  // Hooks carry the lab's private bridge config themselves; agent processes keep their own config dirs.
  const hook = (runtime: string, event?: string) => `env XDG_CONFIG_HOME='${XDG.XDG_CONFIG_HOME}' XDG_STATE_HOME='${XDG.XDG_STATE_HOME}' '${NODE}' '${SHIM}' memory hook ${runtime}${event ? ` ${event}` : ""}`;
  // Claude: per-run MCP + hook settings.
  writeFileSync(`${project}/.lab-claude-mcp.json`, JSON.stringify({ mcpServers: { engramlab: { type: "http", url: `${HOST}/mcp`, headers: { Authorization: `Bearer ${token("claude")}` } } } }));
  writeFileSync(`${project}/.lab-claude-settings.json`, JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop"].map(event => [event, [{ hooks: [{ type: "command", command: hook("claude"), timeout: 10 }] }]])) }));
  // Codex: project hooks; MCP through -c overrides.
  writeFileSync(`${project}/.codex/hooks.json`, JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"].map(event => [event, [{ hooks: [{ type: "command", command: hook("codex", event), timeout: 10 }] }]])) }));
  // Cursor: project MCP + hooks.
  writeFileSync(`${project}/.cursor/mcp.json`, JSON.stringify({ mcpServers: { engramlab: { url: `${HOST}/mcp`, headers: { Authorization: `Bearer ${token("cursor")}` } } } }));
  writeFileSync(`${project}/.cursor/hooks.json`, JSON.stringify({ version: 1, hooks: Object.fromEntries(["sessionStart", "beforeSubmitPrompt", "postToolUse", "stop", "sessionEnd"].map(event => [event, [{ command: hook("cursor", event), timeout: 10 }]])) }));
  // Scoped Cursor CLI permissions instead of a blanket --force.
  writeFileSync(`${project}/.cursor/cli.json`, JSON.stringify({ permissions: { allow: ["Shell(node)", "Shell(git)", `Shell(${NODE})`, "Read(**)", "Write(**)"], deny: [] } }));
  writeFileSync(`${project}/.gitignore`, ".lab-*\n.cursor/\n.codex/\n");
  if (runtimes.includes("cursor")) {
    Bun.spawnSync(["cursor-agent", "mcp", "enable", "engramlab"], { cwd: project });
    Bun.spawnSync(["cursor-agent", "mcp", "disable", "engram"], { cwd: project });
  }
  return project;
}

function writeBindings(projects: { project: string; runtimes: Runtime[] }[]) {
  const file = `${XDG.XDG_CONFIG_HOME}/engram/memory.json`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); chmodSync(path.dirname(file), 0o700);
  mkdirSync(XDG.XDG_STATE_HOME, { recursive: true, mode: 0o700 });
  const bindings = projects.flatMap(({ project, runtimes }) => [...new Set(runtimes)].map(runtime => bindingFor(project, runtime)));
  writeFileSync(file, JSON.stringify({ version: 1, bindings }, null, 2), { mode: 0o600 });
}

function command(runtime: Runtime, project: string, prompt: string): string[] {
  if (runtime === "claude") return ["claude", "-p", prompt, "--mcp-config", `${project}/.lab-claude-mcp.json`, "--strict-mcp-config", "--settings", `${project}/.lab-claude-settings.json`,
    "--allowedTools", "ToolSearch,mcp__engramlab__checkpoint_task,mcp__engramlab__find_tasks,mcp__engramlab__resume_task,mcp__engramlab__recall,mcp__engramlab__remember,Read,Write,Edit,Bash", "--permission-mode", "acceptEdits", "--model", "sonnet"];
  if (runtime === "codex") return ["codex", "exec", prompt, "-m", "gpt-6-sol", "-C", project, "--sandbox", "workspace-write", "-c", `projects."${project}".trust_level="trusted"`,
    "-c", "mcp_servers.engram.enabled=false", "-c", `mcp_servers.engramlab.url="${HOST}/mcp"`, "-c", 'mcp_servers.engramlab.bearer_token_env_var="ENGRAM_LAB_TOKEN"', "-c", "sandbox_workspace_write.network_access=true", "-c", 'mcp_servers.engramlab.default_tools_approval_mode="approve"'];
  return ["cursor-agent", "-p", prompt, "--trust", "--workspace", project, "--output-format", "text"];
}

async function headCount(project: string) {
  const rows = await data`SELECT count(*)::int AS n FROM continuation_checkpoints c JOIN continuation_tasks t ON t.id = c.task_id WHERE lower(t.project) = lower(${path.basename(project)})`;
  return rows[0].n as number;
}

async function runAgent(runtime: Runtime, project: string, prompt: string, log: string, { interruptAfterCheckpoints = 0, timeoutMs = 420_000 } = {}) {
  const started = Date.now();
  const child = Bun.spawn(command(runtime, project, prompt), { cwd: project, env: { ...process.env, ...(runtime === "cursor" ? {} : XDG), ENGRAM_LAB_TOKEN: token("codex") }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let interrupted = false;
  const watcher = (async () => {
    while (child.exitCode === null) {
      await Bun.sleep(2000);
      if (Date.now() - started > timeoutMs) { child.kill("SIGKILL"); break; }
      if (interruptAfterCheckpoints && (await headCount(project)) >= interruptAfterCheckpoints) { interrupted = true; child.kill("SIGKILL"); break; }
    }
  })();
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited; await watcher;
  writeFileSync(log, `$ ${runtime}\n--- stdout\n${out}\n--- stderr\n${err.slice(-4000)}\n`);
  return { exitCode: child.exitCode, interrupted, seconds: Math.round((Date.now() - started) / 1000) };
}

const OUT = (projectName: string, mode: string) => mode === "handoff"
  ? `You are working in this repository. Use Engram (the engramlab MCP server) for task continuation, with Engram project "${projectName}" and a short task title. First save a start checkpoint with a plan of three steps (addItem, removeItem, totalValue). Then implement ONLY addItem in inventory.js with a node:test test in test.js and run \`node --test\`. Then hand off the remaining work to another agent: save a checkpoint with trigger "handoff" whose next step says exactly what remains. Stop after the handoff; do not implement the other functions.`
  : `You are working in this repository. Use Engram (the engramlab MCP server) for task continuation, with Engram project "${projectName}" and a short task title. Save a start checkpoint with a plan of three steps (addItem, removeItem, totalValue), then implement all three in inventory.js with node:test tests in test.js, saving a checkpoint after each function. Run \`node --test\` at the end.`;
const IN = (projectName: string) => `Another agent was working on a task in this repository and saved it in Engram (the engramlab MCP server) under project "${projectName}". Find that task, resume it, and continue from its next step: finish implementing addItem, removeItem and totalValue in inventory.js with node:test tests in test.js, and run \`node --test\`. Save checkpoints on that same task as you go (continue it, do not start a new task), and save a final checkpoint with trigger "completed" when the tests pass.`;

async function verify(id: string, project: string, from: Runtime, to: Runtime, mode: string, outgoing: any, incoming: any) {
  const name = path.basename(project);
  const tasks = await data`SELECT * FROM continuation_tasks WHERE lower(project) = lower(${name}) ORDER BY created_at`;
  const cps = tasks.length ? await data`SELECT id, task_id, author, trigger, revision, lineage, parent_id, run_id, created_at FROM continuation_checkpoints WHERE task_id IN ${data(tasks.map(t => t.id))} ORDER BY created_at` : [];
  const outAuthor = RUNTIMES[from], inAuthor = RUNTIMES[to];
  const sameAuthor = outAuthor === inAuthor;
  const firstIn = sameAuthor ? cps.findIndex((c: any) => c.created_at > outgoing.endedAt) : cps.findIndex((c: any) => c.author === inAuthor);
  const outCps = firstIn === -1 ? cps : cps.slice(0, firstIn), inCps = firstIn === -1 ? [] : cps.slice(firstIn);
  const resumed = await gateway`SELECT count(*)::int AS n FROM audit_log WHERE org_id = 2 AND token_name = ${inAuthor} AND tool = 'resume_task' AND outcome = 'ok' AND ts > ${outgoing.endedAt}`;
  const tests = Bun.spawnSync([NODE, "--test"], { cwd: project, stdout: "pipe", stderr: "pipe" });
  const chain = inCps.length > 0 && outCps.length > 0 && inCps[0].task_id === outCps.at(-1).task_id && inCps[0].parent_id === outCps.at(-1).id;
  const checks = {
    outgoingSaved: outCps.length > 0,
    outgoingTrigger: mode === "handoff" ? outCps.at(-1)?.trigger === "handoff" : outgoing.interrupted === true,
    incomingResumed: resumed[0].n > 0,
    incomingContinuedSameTask: chain && inCps.every((c: any) => c.task_id === outCps[0].task_id),
    singleTask: tasks.length === 1,
    noForks: cps.every((c: any) => c.lineage === "main"),
    completed: inCps.at(-1)?.trigger === "completed",
    testsPass: tests.exitCode === 0,
  };
  const bridgeUsed = cps.some((c: any) => /^em_[a-f0-9]{64}$/.test(c.run_id ?? ""));
  return { id, from, to, mode, pass: Object.values(checks).every(Boolean), checks, checkpoints: cps.map((c: any) => `${c.author}:${c.trigger}:r${c.revision}`), bridgeUsed, outgoing, incoming };
}

const SCENARIOS: [Runtime, Runtime, string][] = [];
const pairs: [Runtime, Runtime][] = [["claude", "codex"], ["claude", "cursor"], ["codex", "claude"], ["codex", "cursor"], ["cursor", "claude"], ["cursor", "codex"]];
const only = process.argv[2];
for (const [from, to] of pairs) for (const mode of ["handoff", "interrupt"]) SCENARIOS.push([from, to, mode]);
for (const runtime of ["claude", "codex", "cursor"] as Runtime[]) SCENARIOS.push([runtime, runtime, "restart"]);
const selected = only ? SCENARIOS.filter(([from, to, mode]) => `${from}-${to}-${mode}` === only || only === "all") : SCENARIOS;
const concurrency = Number(process.argv[3] || 5);

const projects = selected.map(([from, to, mode]) => ({ id: `${from}-${to}-${mode}`, from, to, mode, project: setup(`lab-${from}-${to}-${mode}-${Date.now().toString(36)}`, [from, to]) }));
writeBindings(projects.map(p => ({ project: p.project, runtimes: [p.from, p.to] })));
mkdirSync(`${L}/logs`, { recursive: true });

const results: any[] = [];
let index = 0;
async function worker() {
  while (index < projects.length) {
    const p = projects[index++];
    const name = path.basename(p.project);
    const mode = p.mode === "handoff" ? "handoff" : "interrupt";
    const outgoing: any = await runAgent(p.from, p.project, OUT(name, mode), `${L}/logs/${p.id}-out.log`, mode === "interrupt" ? { interruptAfterCheckpoints: 2 } : {});
    outgoing.endedAt = new Date();
    const incoming = await runAgent(p.to, p.project, IN(name), `${L}/logs/${p.id}-in.log`);
    const result = await verify(p.id, p.project, p.from, p.to, p.mode, outgoing, incoming);
    results.push(result);
    console.log(JSON.stringify({ id: result.id, pass: result.pass, checks: result.checks, checkpoints: result.checkpoints, bridgeUsed: result.bridgeUsed, out: outgoing, in: incoming }));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker));
writeFileSync(`${L}/results-${Date.now()}.json`, JSON.stringify(results, null, 2));
console.log(`PASSED ${results.filter(r => r.pass).length}/${results.length}`);
await data.end(); await gateway.end();
