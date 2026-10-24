import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const shim = require("../shim/index.js");
const root = path.resolve(import.meta.dir, "..");
const basicTools = [{ name: "recall", inputSchema: { type: "object" } }];
const fullTools = [...basicTools, { name: "record_action", inputSchema: { type: "object" } }, { name: "list_actions", inputSchema: { type: "object" } }];
const TOKEN_A = "eng_process-fixture-a-never-a-real-secret";
const TOKEN_B = "eng_process-fixture-b-never-a-real-secret";

function seedCatalog(host: string, token: string, cache: string) {
  const previous = process.env.XDG_CACHE_HOME; process.env.XDG_CACHE_HOME = cache;
  try { expect(shim.writeToolCache(host, token, fullTools)).toBe(true); return shim.toolCachePath(host, token); }
  finally { process.env.XDG_CACHE_HOME = previous; }
}

function childClient(host: string, token: string, cache: string) {
  const child = Bun.spawn([process.execPath, path.join(root, "shim/index.js")], {
    cwd: root, env: { ...process.env, ENGRAM_HOST: host, ENGRAM_TOKEN: token, ENGRAM_TIMEOUT_MS: "3000", XDG_CACHE_HOME: cache },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let id = 0, output = "";
  const responses = new Map<number, (value: any) => void>();
  const notifications: any[] = [];
  const stderr = new Response(child.stderr).text();
  const reading = (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      const text = decoder.decode(value, { stream: true }); output += text; buffer += text;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) { responses.get(message.id)?.(message); responses.delete(message.id); }
        else notifications.push(message);
      }
    }
  })();
  const write = (value: any) => { child.stdin.write(`${JSON.stringify(value)}\n`); child.stdin.flush(); };
  const request = (method: string, params?: any): Promise<any> => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { responses.delete(requestId); reject(new Error(`Fixture RPC timed out: ${method}`)); }, 6000);
      responses.set(requestId, value => { clearTimeout(timeout); resolve(value); });
      write({ jsonrpc: "2.0", id: requestId, method, ...(params ? { params } : {}) });
    });
  };
  return {
    request, notifications,
    async initialize() {
      const result = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engram-process-fixture", version: "1" } });
      write({ jsonrpc: "2.0", method: "notifications/initialized" }); return result;
    },
    async changed() {
      const deadline = Date.now() + 5000;
      while (!notifications.some(value => value.method === "notifications/tools/list_changed")) {
        if (Date.now() >= deadline) throw new Error("Fixture did not receive tool-list-changed notification");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    async close() {
      child.stdin.end(); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
      try { await child.exited; await reading; return { stdout: output, stderr: await stderr }; }
      finally { clearTimeout(timer); }
    },
  };
}

describe("actual stdio discovery and reporting", () => {
  test("initializes locally with canonical guidance, exposes reports and forwards only the requested real lifecycle", async () => {
    const cache = mkdtempSync(path.join(tmpdir(), "engram-shim-process-"));
    let catalogCalls = 0;
    const actions: any[] = [];
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
      const message = await request.json() as any;
      if (message.method === "tools/list") { catalogCalls++; return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: fullTools } }); }
      actions.push(message.params);
      if (message.params.arguments.eventId === "fixture-denied") return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "denied: fixture report was not recorded" }], isError: true } });
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ action: { ...message.params.arguments, evidence: "reported" } }) }] } });
    } });
    const client = childClient(upstream.url.origin, TOKEN_A, cache);
    try {
      const initialized = await client.initialize();
      expect(initialized.result.instructions).toBe(shim.SERVER_INSTRUCTIONS);
      expect(initialized.result.serverInfo).toEqual(require("../shim/branding.js").connectorBranding(upstream.url.origin));
      expect(JSON.stringify(initialized.result.serverInfo)).not.toContain(TOKEN_A);
      expect(initialized.result.capabilities.tools.listChanged).toBe(true);
      expect(catalogCalls).toBe(0);
      for (const term of ["record_action", "agent.task", "running", "completed", "failed", "actionKey", "eventId", "runId", "must not block", "not recorded"]) expect(initialized.result.instructions).toContain(term);
      const catalog = await client.request("tools/list");
      expect(catalog.result.tools.map((tool: any) => tool.name)).toContain("record_action");
      expect(actions).toEqual([]);
      const reports = [
        { tool: "agent.task", taskTitle: "Inspect a fixture", summary: "Started the fixture inspection", status: "running", currentStep: "Reading fixture metadata", runId: "fixture-run", actionKey: "fixture-task", eventId: "fixture-start" },
        { tool: "agent.task", summary: "Checked fixture metadata", status: "running", currentStep: "Checking the assertions", runId: "fixture-run", actionKey: "fixture-task", eventId: "fixture-update" },
        { tool: "agent.task", summary: "Finished the fixture inspection", status: "completed", outcome: "Fixture assertions passed", runId: "fixture-run", actionKey: "fixture-task", eventId: "fixture-complete" },
      ];
      for (const report of reports) {
        const result = await client.request("tools/call", { name: "record_action", arguments: report });
        expect(JSON.parse(result.result.content[0].text).action).toMatchObject({ ...report, evidence: "reported" });
      }
      expect(actions).toEqual(reports.map(argumentsValue => ({ name: "record_action", arguments: argumentsValue })));
      const denied = await client.request("tools/call", { name: "record_action", arguments: { ...reports[0], eventId: "fixture-denied" } });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content[0].text).toContain("not recorded");
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(actions).toHaveLength(4);
      expect((await client.request("ping")).result).toEqual({});
      const files = readdirSync(path.join(cache, "engram-mcp"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^tools-v2-[a-f0-9]{64}\.json$/);
      const saved = readFileSync(path.join(cache, "engram-mcp", files[0]), "utf8");
      expect(saved).not.toContain(TOKEN_A);
    } finally {
      const output = await client.close(); upstream.stop(true); rmSync(cache, { recursive: true, force: true });
      expect(output.stdout + output.stderr).not.toContain(TOKEN_A);
    }
  }, 12000);

  test("falls back quickly, then notifies and exposes new tools in the same process", async () => {
    const cache = mkdtempSync(path.join(tmpdir(), "engram-shim-refresh-"));
    let writes = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
      const message = await request.json() as any;
      if (message.method !== "tools/list") writes++;
      await new Promise(resolve => setTimeout(resolve, 1250));
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: fullTools } });
    } });
    const previous = process.env.XDG_CACHE_HOME; process.env.XDG_CACHE_HOME = cache;
    try { expect(shim.writeToolCache(upstream.url.origin, TOKEN_A, basicTools)).toBe(true); }
    finally { process.env.XDG_CACHE_HOME = previous; }
    const client = childClient(upstream.url.origin, TOKEN_A, cache);
    try {
      await client.initialize();
      const first = await client.request("tools/list");
      expect(first.result.tools.map((tool: any) => tool.name)).toEqual(["recall"]);
      await client.changed();
      const refreshed = await client.request("tools/list");
      expect(refreshed.result.tools.map((tool: any) => tool.name)).toContain("record_action");
      expect(writes).toBe(0);
    } finally {
      await client.close(); upstream.stop(true); rmSync(cache, { recursive: true, force: true });
    }
  }, 12000);

  test("a different rejected credential cannot see an earlier credential's catalog", async () => {
    const cache = mkdtempSync(path.join(tmpdir(), "engram-shim-credentials-"));
    let received = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
      received++; return Response.json({ error: "Unauthorized fixture" }, { status: 401 });
    } });
    const previous = process.env.XDG_CACHE_HOME; process.env.XDG_CACHE_HOME = cache;
    try { expect(shim.writeToolCache(upstream.url.origin, TOKEN_A, fullTools)).toBe(true); }
    finally { process.env.XDG_CACHE_HOME = previous; }
    const client = childClient(upstream.url.origin, TOKEN_B, cache);
    try {
      await client.initialize();
      const catalog = await client.request("tools/list");
      expect(catalog.result).toBeUndefined(); expect(catalog.error.message).toContain("HTTP 401");
      expect(received).toBe(1); expect(client.notifications).toEqual([]);
    } finally {
      const output = await client.close(); upstream.stop(true); rmSync(cache, { recursive: true, force: true });
      expect(output.stdout + output.stderr).not.toContain(TOKEN_A); expect(output.stdout + output.stderr).not.toContain(TOKEN_B);
    }
  }, 12000);

  test("an applied write followed by HTTP504 is never replayed automatically", async () => {
    const cache = mkdtempSync(path.join(tmpdir(), "engram-shim-uncertain-write-"));
    let appliedWrites = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
      const message = await request.json() as any;
      if (message.method === "tools/call") appliedWrites++;
      return new Response("Gateway timeout after fixture mutation", { status: 504 });
    } });
    const client = childClient(upstream.url.origin, TOKEN_A, cache);
    try {
      await client.initialize();
      const response = await client.request("tools/call", { name: "record_action", arguments: { tool: "agent.task", summary: "Actual fixture operation", eventId: "uncertain-fixture" } });
      expect(response.result).toBeUndefined(); expect(response.error.message).toContain("HTTP 504");
      expect(appliedWrites).toBe(1);
      expect((await client.request("ping")).result).toEqual({});
    } finally {
      await client.close(); upstream.stop(true); rmSync(cache, { recursive: true, force: true });
    }
  }, 12000);

  test("HTML401 and403 reject a same-credential cache and remove only that credential's file", async () => {
    for (const status of [401, 403]) {
      const cache = mkdtempSync(path.join(tmpdir(), "engram-shim-html-auth-"));
      const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
        return new Response("<html>Authorization required</html>", { status, headers: { "content-type": "text/html" } });
      } });
      const ownFile = seedCatalog(upstream.url.origin, TOKEN_A, cache);
      const otherFile = seedCatalog(upstream.url.origin, TOKEN_B, cache);
      const client = childClient(upstream.url.origin, TOKEN_A, cache);
      try {
        await client.initialize(); const response = await client.request("tools/list");
        expect(response.result).toBeUndefined(); expect(response.error.message).toContain(`HTTP ${status}`);
        expect(existsSync(ownFile)).toBe(false); expect(existsSync(otherFile)).toBe(true);
        expect(client.notifications).toEqual([]);
      } finally {
        await client.close(); upstream.stop(true); rmSync(cache, { recursive: true, force: true });
      }
    }
  }, 12000);

  test("late HTML authorization rejection clears advertised tools once without a refetch loop", async () => {
    for (const status of [401, 403]) {
      const cache = mkdtempSync(path.join(tmpdir(), "engram-shim-late-auth-"));
      let requests = 0;
      const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
        requests++;
        await new Promise(resolve => setTimeout(resolve, 1200));
        return new Response("<html>Authorization required</html>", { status, headers: { "content-type": "text/html" } });
      } });
      const ownFile = seedCatalog(upstream.url.origin, TOKEN_A, cache);
      const client = childClient(upstream.url.origin, TOKEN_A, cache);
      try {
        await client.initialize(); const fallback = await client.request("tools/list");
        expect(fallback.result.tools.map((tool: any) => tool.name)).toContain("record_action");
        await client.changed();
        const cleared = await client.request("tools/list");
        expect(cleared.result.tools).toEqual([]);
        expect(cleared.result._meta["engram/discoveryError"]).toBe("authorization_required");
        expect((await client.request("tools/list")).result.tools).toEqual([]);
        expect(existsSync(ownFile)).toBe(false); expect(requests).toBe(1);
        expect(client.notifications).toHaveLength(1);
      } finally {
        await client.close(); upstream.stop(true); rmSync(cache, { recursive: true, force: true });
      }
    }
  }, 12000);
});

test("canonical instructions and branding are included by npm and the runtime image without ESM ambiguity", () => {
  const packaged = JSON.parse(readFileSync(path.join(root, "shim/package.json"), "utf8"));
  expect(packaged.files).toContain("instructions.js");
  expect(packaged.files).toContain("branding.js");
  expect(packaged.type ?? "commonjs").toBe("commonjs");
  expect(readFileSync(path.join(root, "Dockerfile"), "utf8")).toMatch(/^COPY shim \.\/shim$/m);
  expect(shim.SERVER_INSTRUCTIONS.length).toBeLessThan(3000);
});
