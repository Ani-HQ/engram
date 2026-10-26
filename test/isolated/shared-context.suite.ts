import { beforeEach, describe, expect, mock, test } from "bun:test";
import { runWithContext } from "../../gateway/src/context";
import { DEFAULT_POLICIES, normalizeToken } from "../../gateway/src/policies";

const shareId = "11111111-1111-4111-8111-111111111111", itemId = "22222222-2222-4222-8222-222222222222";
const sharedSlug = `shared-context/${shareId}/${itemId}`;
const approvedText = "Approved October launch.\nExact approved context, with no evolving source body.";
const item = { shareId, id: itemId, title: "Launch context", text: approvedText };
const localPage = { slug: "notes/team-note", title: "Team October", type: "note", compiled_truth: "Target workspace note.", updated_at: "2026-10-01T00:00:00Z" };
let active = true, engineAvailable = true;
const calls: any[] = [], accessOrgs: number[] = [], reranked: any[][] = [];
const org = { id: 7, name: "Recipient", slug: "recipient", kind: "team" as const, brainDb: "brain_org_7", dataDb: "brain_org_7", homeDir: "org-7", policies: { ...DEFAULT_POLICIES } };
const actor = normalizeToken({ name: "Recipient owner", orgId: 7, role: "owner", kind: "session", email: "recipient@example.test" });
const inOrg = (work: () => any) => runWithContext({ org, token: actor, dataSql: {} as any }, work);
const jsonTool = (data: any) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const payload = (data: any) => JSON.parse(data.content[0].text);

const realAccess = await import("../../gateway/src/context-sharing-access");
mock.module("../../gateway/src/context-sharing-access", () => ({ ...realAccess, listApprovedTeamItems: async (id: number) => {
  accessOrgs.push(id); return active && id === 7 ? [item] : [];
} }));
const realBrain = await import("../../gateway/src/brain");
mock.module("../../gateway/src/brain", () => ({ ...realBrain,
  ensureBrain: async () => { if (!engineAvailable) throw new Error("Engine unavailable"); },
  brainClient: () => ({ callTool: async (request: any) => {
    calls.push(request);
    if (!engineAvailable) throw new Error("Engine unavailable");
    const args = request.arguments;
    if (request.name === "list_pages") {
      // Include a physical shadow: it must never stand in for an approved grant.
      return jsonTool([localPage, { slug: sharedSlug, title: "Shadow", compiled_truth: "UNAPPROVED_PHYSICAL_BODY" }].slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 25)));
    }
    if (request.name === "search") return jsonTool([{ ...localPage, chunk_text: localPage.compiled_truth, score: .5 }, { slug: sharedSlug, title: "Shadow", chunk_text: "UNAPPROVED_PHYSICAL_BODY", score: 99 }]);
    if (request.name === "get_page" && args.slug === localPage.slug) return jsonTool(localPage);
    throw new Error("No source workspace pages in the recipient brain");
  } }),
}));
const realAudit = await import("../../gateway/src/audit");
mock.module("../../gateway/src/audit", () => ({ ...realAudit, audit: async () => {}, provenance: async () => ({ origin: null, contributors: [] }), provenanceFor: async () => new Map() }));
const realTrails = await import("../../gateway/src/trails");
mock.module("../../gateway/src/trails", () => ({ ...realTrails, attributionForSlugs: async () => new Map() }));
const realReflex = await import("../../gateway/src/reflex");
mock.module("../../gateway/src/reflex", () => ({ ...realReflex, rerankRecallHits: async (_query: string, hits: any[], keep: number) => { reranked.push(hits); return hits.slice(0, keep); } }));
const realAuth = await import("../../gateway/src/auth");
mock.module("../../gateway/src/auth", () => ({ ...realAuth, authenticateSecret: async (raw: string) => raw === "ens_fixture" ? actor : null }));
const realOrgs = await import("../../gateway/src/orgs");
mock.module("../../gateway/src/orgs", () => ({ ...realOrgs, resolveOrg: async () => org, withOrg: async (_org: unknown, _actor: unknown, work: () => any) => inOrg(work) }));
const realUsage = await import("../../gateway/src/memory-usage");
mock.module("../../gateway/src/memory-usage", () => ({ ...realUsage, applyContextBudget: async (_token: any, _name: any, _args: any, result: any) => result }));
const { callTool } = await import("../../gateway/src/proxy");
const { handleWeb } = await import("../../gateway/src/web");
const call = (name: string, args: any = {}) => inOrg(() => callTool(actor, name, args));
const browser = (path: string, method = "GET", body?: any) => handleWeb(new Request(`http://engram.local${path}`, {
  method, headers: { "X-Engram-Console": "1", "X-Engram-Workspace": "7", cookie: "engram_session=ens_fixture", "Content-Type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
}));

beforeEach(() => { active = true; engineAvailable = true; calls.length = 0; accessOrgs.length = 0; reranked.length = 0; org.policies.acceptShares = true; });

describe("approved team pages in every memory read surface", () => {
  test("MCP list, search, recall and direct reads expose approved snapshots, never physical shadows", async () => {
    expect(payload(await call("list_pages", { sort: "slug", limit: 10 })).map((page: any) => page.slug)).toEqual([localPage.slug, sharedSlug]);
    expect(payload(await call("search", { query: "October" })).find((page: any) => page.slug === sharedSlug).chunk_text).toBe(approvedText);
    const recalled = payload(await call("recall", { query: "October", full: true }));
    expect(recalled.results.find((page: any) => page.slug === sharedSlug).snippet).toBe(approvedText);
    expect(recalled.full).toEqual({ slug: sharedSlug, body: approvedText });
    expect(reranked.flat().some(page => page.slug === sharedSlug)).toBe(false);
    calls.length = 0;
    expect(payload(await call("get_page", { slug: sharedSlug })).compiled_truth).toBe(approvedText);
    expect(calls).toEqual([]);
    expect(accessOrgs.every(id => id === 7)).toBe(true);
  });
  test("revocation immediately removes all virtual reads and has no physical fallback", async () => {
    expect(payload(await call("get_page", { slug: sharedSlug })).compiled_truth).toBe(approvedText);
    active = false;
    calls.length = 0;
    expect((await call("get_page", { slug: sharedSlug })).isError).toBe(true);
    expect(calls).toEqual([]);
    for (const name of ["list_pages", "search", "recall"]) {
      expect(JSON.stringify(await call(name, { query: "October", full: true }))).not.toContain(sharedSlug);
    }
    expect((await browser(`/api/page?slug=${sharedSlug}`)).status).toBe(404);
  });
  test("target acceptance policy and context identity are enforced before snapshot access", async () => {
    org.policies.acceptShares = false;
    expect((await call("get_page", { slug: sharedSlug })).isError).toBe(true);
    expect(accessOrgs).toEqual([]);
    const stranger = normalizeToken({ name: "Other workspace", orgId: 8 });
    await expect(inOrg(() => callTool(stranger, "get_page", { slug: sharedSlug }))).rejects.toThrow("matching workspace");
  });
  test("browser pagination and export traversal include approved snapshots exactly once", async () => {
    const collected: any[] = [];
    for (let offset = 0; offset < 5; offset++) {
      const response = await browser(`/api/pages?limit=1&sort=slug&offset=${offset}`);
      expect(response.status).toBe(200);
      const data = await response.json(); collected.push(...data.pages);
      if (!data.more) break;
    }
    expect(collected.map(page => page.slug)).toEqual([localPage.slug, sharedSlug]);
    const exported: any[] = [];
    for (const page of collected) exported.push(await (await browser(`/api/page?slug=${page.slug}`)).json());
    expect(exported.find(row => row.page.slug === sharedSlug).page.body).toBe(approvedText);
    const searched = await (await browser("/api/search?q=October")).json();
    expect(searched.results.find((page: any) => page.slug === sharedSlug).snippet).toBe(approvedText);
    expect(JSON.stringify(exported)).not.toContain("UNAPPROVED_PHYSICAL_BODY");
  });
  test("direct virtual reads work without starting the memory engine, then stop on revocation", async () => {
    engineAvailable = false;
    const response = await browser(`/api/page?slug=${sharedSlug}`);
    expect(response.status).toBe(200);
    expect((await response.json()).page.body).toBe(approvedText);
    expect(calls).toEqual([]);
    active = false;
    expect((await browser(`/api/page?slug=${sharedSlug}`)).status).toBe(404);
  });
  test("MCP and browser cannot edit, delete, restore, retag or shadow snapshots", async () => {
    for (const name of ["put_page", "add_tag", "add_timeline_entry", "add_link", "remember"]) {
      const args = name === "remember" ? { topic: sharedSlug, text: "overwrite" } : { slug: sharedSlug, expected_hash: null, content: "overwrite" };
      expect((await call(name, args)).isError).toBe(true);
    }
    expect((await browser(`/api/page?slug=${sharedSlug}`, "DELETE")).status).toBe(403);
    expect((await browser("/api/page/restore", "POST", { slug: sharedSlug })).status).toBe(403);
    expect((await browser("/api/capture", "POST", { slug: sharedSlug, text: "overwrite" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
