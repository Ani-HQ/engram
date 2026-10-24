import { beforeEach, describe, expect, mock, test } from "bun:test";
import { runWithContext } from "../../gateway/src/context";
import { DEFAULT_POLICIES, normalizeToken, type TokenRecord } from "../../gateway/src/policies";
import type postgres from "postgres";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const brainCalls: any[] = [];
const items = new Map<number, any>();
let engineError = false;

const brain = {
  async callTool(request: any) {
    brainCalls.push(request);
    if (engineError) return { isError: true, content: [{ type: "text", text: "Rejected change" }] };
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  },
};

const realBrain = await import("../../gateway/src/brain");
mock.module("../../gateway/src/brain", () => ({
  ...realBrain,
  brainClient: () => brain,
}));

const realAudit = await import("../../gateway/src/audit");
mock.module("../../gateway/src/audit", () => ({
  ...realAudit,
  audit: async () => {},
}));

const realEntries = await import("../../gateway/src/memory-entries");
mock.module("../../gateway/src/memory-entries", () => ({
  ...realEntries,
  getMemoryEntry: async (id: string) => ({
    id,
    fingerprint: "fp",
    slug: "projects/engram",
    archiveSlug: null,
    recordedAt: null,
    tokenName: "agent",
    rawText: "A decision",
    topicHint: "engram",
    status: "active",
  }),
  setEntryStatus: async () => {},
}));

const realStore = await import("../../gateway/src/review/store");
mock.module("../../gateway/src/review/store", () => ({
  ...realStore,
  getReviewItem: async (id: number) => items.get(id) ?? null,
  setReviewState: async (id: number, state: string, resolvedBy: string) => {
    const current = items.get(id);
    if (!current || current.state !== "pending") return null;
    const next = { ...current, state, resolvedBy };
    items.set(id, next);
    return next;
  },
}));

const realCoordination = await import("../../gateway/src/write-coordination");
let tail: Promise<void> = Promise.resolve();
mock.module("../../gateway/src/write-coordination", () => ({
  ...realCoordination,
  async withMemoryWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const prior = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await prior; try { return await work(); } finally { release(); }
  },
}));

const { resolveReview, clusterReviewTarget, safeReviewSlug } = await import("../../gateway/src/review/apply");
const member = normalizeToken({ name: "ani", orgId: 7, role: "member", canWrite: true });
const org = { id: 7, name: "Fixture", slug: "fixture", kind: "team" as const, brainDb: "brain_org_7", dataDb: "brain_org_7", homeDir: "org-7", policies: DEFAULT_POLICIES };
function scoped<T>(work: () => Promise<T>, actor: TokenRecord = member) {
  return runWithContext({ org, token: actor, dataSql: {} as postgres.Sql }, work);
}

describe("review apply", () => {
  beforeEach(() => {
    brainCalls.length = 0;
    engineError = false;
    items.clear();
    items.set(1, {
      id: 1,
      fingerprint: "pair:1:projects/engram:duplicate",
      entryId: "entry-1",
      kind: "duplicate",
      state: "pending",
      confidence: 0.8,
      payload: { otherSlug: "projects/engram-archive", otherText: "older note" },
      runId: null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
    });
  });

  test("reject does not touch the brain", async () => {
    const result = await scoped(() => resolveReview(member, 1, "reject"));
    expect(result.item?.state).toBe("rejected");
    expect(brainCalls).toEqual([]);
  });

  test("approve of a duplicate records a link, not a source rewrite", async () => {
    const result = await scoped(() => resolveReview(member, 1, "approve"));
    expect(result.item?.state).toBe("applied");
    expect(brainCalls.some(call => call.name === "put_page" && call.arguments?.slug?.startsWith("projects/"))).toBe(false);
    expect(brainCalls.some(call => call.name === "add_link")).toBe(true);
  });

  test("requires authenticated context, matching actor and the context's actual role", async () => {
    await expect(resolveReview(member, 1, "approve")).rejects.toThrow();
    await expect(scoped(() => resolveReview({ ...member, orgId: 8 }, 1, "approve"))).rejects.toThrow("context must match");
    const agent = { ...member, role: "agent" as const };
    const forged = await scoped(() => resolveReview({ ...agent, role: "owner" }, 1, "approve"), agent);
    expect(forged.error).toBe("forbidden"); expect(brainCalls).toHaveLength(0);
  });

  test("serializes competing approval and rejection so only one resolution changes memory", async () => {
    const results = await Promise.all([scoped(() => resolveReview(member, 1, "approve")), scoped(() => resolveReview(member, 1, "reject"))]);
    expect(results.filter(result => !result.error)).toHaveLength(1);
    expect(results.filter(result => result.error === "already resolved")).toHaveLength(1);
    expect(brainCalls.filter(call => call.name === "add_link")).toHaveLength(1);
    expect(items.get(1).state).toBe("applied");
  });

  test("accepts derived cluster slug and confines safe cluster writes", async () => {
    expect(clusterReviewTarget({ slug: "meta/clusters/release" })).toBe("meta/clusters/release");
    expect(clusterReviewTarget({ topic: "release" })).toBe("meta/clusters/release");
    for (const slug of ["meta/other", "../escape", "meta/clusters/../escape", "meta/clusters/", "meta/clusters/a\n# injection"]) expect(() => clusterReviewTarget({ slug })).toThrow();
    expect(safeReviewSlug("projects/engram")).toBe(true); expect(safeReviewSlug("projects/../escape")).toBe(false);
    items.set(1, { ...items.get(1), kind: "cluster", entryId: null, payload: { slug: "meta/clusters/release", members: ["projects/engram", "projects/release"] } });
    expect((await scoped(() => resolveReview(member, 1, "approve"))).item?.state).toBe("applied");
    expect(brainCalls.some(call => call.name === "put_page" && call.arguments.slug === "meta/clusters/release")).toBe(true);
  });

  test("rejects injected cluster members and preserves pending state on engine error", async () => {
    items.set(1, { ...items.get(1), kind: "cluster", payload: { slug: "meta/clusters/release", members: ["projects/a]]\nInjected"] } });
    expect((await scoped(() => resolveReview(member, 1, "approve"))).error).toBeTruthy();
    expect(items.get(1).state).toBe("pending"); expect(brainCalls).toHaveLength(0);
    items.set(1, { ...items.get(1), kind: "duplicate", payload: { otherSlug: "projects/other" } }); engineError = true;
    expect((await scoped(() => resolveReview(member, 1, "approve"))).error).toBeTruthy();
    expect(items.get(1).state).toBe("pending");
  });
});
