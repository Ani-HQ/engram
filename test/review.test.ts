import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const brainCalls: any[] = [];
const items = new Map<number, any>();

const brain = {
  async callTool(request: any) {
    brainCalls.push(request);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  },
};

const realBrain = await import("../gateway/src/brain");
mock.module("../gateway/src/brain", () => ({
  ...realBrain,
  brainClient: () => brain,
}));

const realAudit = await import("../gateway/src/audit");
mock.module("../gateway/src/audit", () => ({
  ...realAudit,
  audit: async () => {},
}));

const realEntries = await import("../gateway/src/memory-entries");
mock.module("../gateway/src/memory-entries", () => ({
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

const realStore = await import("../gateway/src/review/store");
mock.module("../gateway/src/review/store", () => ({
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

const { resolveReview } = await import("../gateway/src/review/apply");

describe("review apply", () => {
  beforeEach(() => {
    brainCalls.length = 0;
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
    const result = await resolveReview({ name: "ani" }, 1, "reject");
    expect(result.item?.state).toBe("rejected");
    expect(brainCalls).toEqual([]);
  });

  test("approve of a duplicate records a link, not a source rewrite", async () => {
    const result = await resolveReview({ name: "ani" }, 1, "approve");
    expect(result.item?.state).toBe("applied");
    expect(brainCalls.some(call => call.name === "put_page" && call.arguments?.slug?.startsWith("projects/"))).toBe(false);
    expect(brainCalls.some(call => call.name === "add_link")).toBe(true);
  });
});
