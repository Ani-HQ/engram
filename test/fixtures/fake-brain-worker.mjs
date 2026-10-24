#!/usr/bin/env bun
// Test-only MCP process. The real SDK launches and talks to this child; it never
// opens a database or a network connection. Control and event files are private
// temporary files created by brain-runtime.test.ts.
import { appendFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.GBRAIN_HOME || process.env.HOME;
let control = {};
try { control = JSON.parse(readFileSync(join(home, "control.json"), "utf8")); } catch {}
const event = (kind, extra = {}) => control.events && appendFileSync(control.events, `${JSON.stringify({ kind, pid: process.pid, org: basename(home), at: Date.now(), ...extra })}\n`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ending = false;
function exit() { if (ending) return; ending = true; event("exit"); process.exit(0); }
process.on("SIGTERM", exit);
process.on("SIGINT", exit);

if (process.argv[2] !== "serve") {
  event("init-start"); await delay(control.initDelay || 0); event("init-end"); exit();
}
event("serve-start");
process.stdin.on("end", () => { event("eof"); if (!control.ignoreEof) setTimeout(exit, control.eofDelay || 0); });
// Simulate an engine that logs during initialization, before its initialize
// response. Consumers must drain stderr before beginning the handshake.
if (control.stderrBytes) await new Promise(resolve => process.stderr.write("diagnostic ".repeat(Math.ceil(control.stderrBytes / 11)), resolve));
const keepAlive = setInterval(() => {}, 1000);
const output = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === "initialize") {
    output({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-brain", version: "1" } } });
  } else if (message.method === "tools/list") output({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  else if (message.method === "tools/call") {
    const name = message.params.name;
    event("call-start", { tool: name });
    // Deliberately ignore cancellation notifications: the gateway must not
    // equate an RPC timeout with actual termination of a memory mutation.
    void (async () => {
      await delay(control.toolDelay || 0);
      event(name === "put_page" ? "mutation-end" : "call-end", { tool: name });
      output({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ pid: process.pid }) }] } });
    })();
  }
}
if (!control.ignoreEof) { await delay(control.eofDelay || 0); exit(); }
void keepAlive;
