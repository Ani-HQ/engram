import { describe, expect, test } from "bun:test";
import { handleSharedContextMcp } from "../gateway/src/shared-context-mcp";
import { authenticateSecret, authenticateStoredSecret } from "../gateway/src/auth";

const raw = `egs_${"A".repeat(32)}`, shareId = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const grant = { shareId, items: [{ id, title: "Approved", text: "Only the approved launch context." }] };
const request = (method: string, params: any = {}, token = raw, headers: Record<string,string> = {}) => new Request("http://engram.local/mcp/shared", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});
const authenticate = async (token: string) => token === raw ? grant : null;

describe("stateless restricted MCP endpoint", () => {
  test("read-only scoped shares cannot issue a read/save compatibility probe", async () => {
    const request = new Request("https://example.test/mcp/shared", { method: "POST", headers: { authorization: `Bearer egs_${"a".repeat(32)}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: { "com.engram/context": { runId: "test", integration: { id: "test", version: "1", runtime: "test" }, verification: "begin" } } } }) });
    const response = await handleSharedContextMcp(request, async () => ({ shareId: 1, items: [] }) as any);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("read-only shares");
  });
  test("long approved snapshots stay bounded and page without access to any source workspace", async () => {
    const text = 'A useful shared decision. '.repeat(2000);
    const approve = async () => ({ ...grant, items: [{ id, title: 'Approved', text }] });
    const params = { name: 'get_page', arguments: { slug: `shared-context/${shareId}/${id}` }, _meta: { 'com.engram/context': { runId: 'task-1', maxBytes: 4096 } } };
    const first = (await (await handleSharedContextMcp(request('tools/call', params), approve)).json()).result;
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4096);
    const page = JSON.parse(first.content[0].text);
    expect(page.compiled_truth.length).toBeLessThan(text.length);
    expect(page._page.partial).toBe(true);
    expect(first._meta.engramContext.runScoped).toBe(false);
    const second = (await (await handleSharedContextMcp(request('tools/call', { ...params, arguments: { ...params.arguments, cursor: page._page.next_cursor } }), approve)).json()).result;
    const next = JSON.parse(second.content[0].text);
    expect(next._page.offset).toBe(page._page.next_offset);
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(4096);
  });
  test("initializes and lists only read tools without workspace/brain access", async () => {
    const init = await handleSharedContextMcp(request("initialize", { protocolVersion: "2025-06-18" }), authenticate);
    expect(init.headers.get("cache-control")).toBe("no-store");
    expect((await init.json()).result.capabilities).toEqual({ tools: {} });
    const list = await (await handleSharedContextMcp(request("tools/list"), authenticate)).json();
    expect(list.result.tools.map((tool: any) => tool.name)).toEqual(["recall", "search", "list_pages", "get_page", "whoami"]);
    const read = await (await handleSharedContextMcp(request("tools/call", { name: "get_page", arguments: { slug: `shared-context/${shareId}/${id}`, orgId: 1 } }), authenticate)).json();
    expect(JSON.parse(read.result.content[0].text).compiled_truth).toBe(grant.items[0].text);
    expect(JSON.stringify(read)).not.toContain(raw);
    expect(JSON.stringify(read)).not.toContain("ownerEmail");
  });
  test("ordinary credentials, cookies, URL secrets and missing bearer cannot authenticate", async () => {
    let attempts = 0;
    const auth = async () => { attempts++; return grant; };
    for (const token of ["eng_workspace", "ens_session", "eyJhbGciOiJIUzI1NiJ9.e30.signature", "egs_bad"]) {
      expect((await handleSharedContextMcp(request("tools/list", {}, token), auth)).status).toBe(401);
    }
    const noBearer = new Request(`http://engram.local/mcp/shared?token=${raw}`, { method: "POST", headers: { cookie: `engram_session=${raw}` }, body: "{}" });
    expect((await handleSharedContextMcp(noBearer, auth)).status).toBe(401);
    expect(attempts).toBe(0);
    let queries = 0;
    const db = (() => { queries++; throw new Error("Unexpected ordinary credential lookup"); }) as any;
    expect(await authenticateStoredSecret(raw, db)).toBeNull();
    expect(await authenticateSecret(raw)).toBeNull();
    expect(queries).toBe(0);
  });
  test("rechecks revocation on every stateless call", async () => {
    let active = true, checks = 0;
    const auth = async () => { checks++; return active ? grant : null; };
    expect((await handleSharedContextMcp(request("ping"), auth)).status).toBe(200);
    active = false;
    expect((await handleSharedContextMcp(request("tools/call", { name: "get_page", arguments: { slug: `shared-context/${shareId}/${id}` } }), auth)).status).toBe(401);
    expect(checks).toBe(2);
  });
  test("bounds declared and actual request bytes without reflecting the body", async () => {
    const declared = await handleSharedContextMcp(request("ping", {}, raw, { "Content-Length": "20001" }), authenticate);
    expect(declared.status).toBe(413);
    for (const extra of ["a".repeat(20_000), "😀".repeat(6_000)]) {
      const oversized = await handleSharedContextMcp(request("ping", { privateNote: extra }), authenticate);
      expect(oversized.status).toBe(413);
      expect(await oversized.text()).not.toContain(extra);
    }
    const malformed = new Request("http://engram.local/mcp/shared", { method: "POST", headers: { Authorization: `Bearer ${raw}` }, body: "{bad" });
    expect((await handleSharedContextMcp(malformed, authenticate)).status).toBe(400);
  });
  test("rejects writes, activity, resources, prompts and routing conflicts", async () => {
    for (const method of ["resources/list", "resources/read", "prompts/list", "prompts/get", "export"]) {
      expect((await (await handleSharedContextMcp(request(method), authenticate)).json()).error.code).toBe(-32601);
    }
    for (const name of ["remember", "put_page", "list_actions", "record_action", "delete_page"]) {
      expect((await (await handleSharedContextMcp(request("tools/call", { name, arguments: {} }), authenticate)).json()).error.code).toBe(-32601);
    }
    const conflict = await handleSharedContextMcp(request("tools/call", { name: "get_page" }, raw, { "Mcp-Name": "remember" }), authenticate);
    expect(conflict.status).toBe(400);
    const get = await handleSharedContextMcp(new Request("http://engram.local/mcp/shared"), authenticate);
    expect(get.status).toBe(405);
  });
});
