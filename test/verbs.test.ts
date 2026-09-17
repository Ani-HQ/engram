import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const pages = new Map<string, string>();
const calls: any[] = [];
const auditCalls: any[] = [];
let searchHits: any[] = [];

// gbrain strips frontmatter out of compiled_truth, so the fake does too — remember
// appends to the body it is handed back, not to the raw file it wrote.
function compiledTruth(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

const brain = {
  async listTools() {
    return { tools: [] };
  },
  async callTool(request: any) {
    calls.push(request);
    const args = request.arguments ?? {};
    if (request.name === "get_page") {
      const stored = pages.get(args.slug);
      if (stored === undefined) {
        return { content: [{ type: "text", text: `page not found: ${args.slug}` }], isError: true };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: 1,
            slug: args.slug,
            type: "note",
            title: stored.match(/^title: "(.*)"$/m)?.[1] ?? "",
            compiled_truth: compiledTruth(stored),
            timeline: "",
            frontmatter: {},
            tags: [],
          }),
        }],
      };
    }
    if (request.name === "put_page") {
      pages.set(args.slug, args.content);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ slug: args.slug, status: "created_or_updated", chunks: 1 }),
        }],
      };
    }
    if (request.name === "search") {
      return {
        content: [{ type: "text", text: JSON.stringify(searchHits.slice(0, args.limit ?? 10)) }],
      };
    }
    return { content: [{ type: "text", text: "{}" }] };
  },
};

// Spread the real module: mock.module is process-global, so listing only the export
// this suite needs would delete the others for every file evaluated after it.
const realBrain = await import("../gateway/src/brain");

mock.module("../gateway/src/brain", () => ({
  ...realBrain,
  brainClient: () => brain,
}));

mock.module("../gateway/src/audit", () => ({
  audit: async (...args: any[]) => {
    auditCalls.push(args);
  },
}));

const { callTool, slugForRemember, shrinkToolDef, SERVER_INSTRUCTIONS } =
  await import("../gateway/src/proxy");

const token = { name: "agent" };

function hit(overrides: Record<string, unknown> = {}) {
  return {
    slug: "notes/x",
    page_id: 1,
    title: "X",
    type: "note",
    chunk_text: "word ".repeat(400),
    score: 1,
    source_id: "default",
    effective_date: "2026-08-15",
    ...overrides,
  };
}

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  pages.clear();
  calls.length = 0;
  auditCalls.length = 0;
  searchHits = [];
});

describe("remember", () => {
  test("creates the page when it does not exist yet", async () => {
    const result = await callTool(token, "remember", {
      text: "Chose Bun over Node for the gateway.",
      topic: "Engram Gateway",
    });

    expect(payload(result)).toEqual({
      ok: true,
      slug: "projects/engram-gateway",
      appended: false,
    });
    const written = pages.get("projects/engram-gateway")!;
    expect(written).toContain("title: \"Engram Gateway\"");
    expect(written).toContain("Chose Bun over Node for the gateway.");
    expect(written).toMatch(/- \d{4}-\d{2}-\d{2}T[\d:.]+Z — Chose Bun/);
    expect(auditCalls.map(call => [call[1], call[3]])).toEqual([["remember", "ok"]]);
  });

  test("appends to an existing topic instead of overwriting it", async () => {
    await callTool(token, "remember", { text: "first decision", topic: "gateway" });
    const result = await callTool(token, "remember", { text: "second decision", topic: "gateway" });

    expect(payload(result).appended).toBe(true);
    const written = pages.get("projects/gateway")!;
    expect(written).toContain("first decision");
    expect(written).toContain("second decision");
    // One header, two bullets: the log grows, the page is not recreated each time,
    // and the title survives the round trip through frontmatter-free compiled_truth.
    expect(written.match(/^---$/gm)?.length).toBe(2);
    expect(written.match(/^- \d{4}/gm)?.length).toBe(2);
    expect(written).toContain("title: \"gateway\"");
    expect(written.match(/^# gateway$/gm)?.length).toBe(1);
  });

  test("derives a dated notes slug when no topic is given", async () => {
    const result = await callTool(token, "remember", {
      text: "Rotated the deploy token after the leak scare today",
    });

    const day = new Date().toISOString().slice(0, 10);
    expect(payload(result).slug).toBe(`notes/${day}-rotated-the-deploy-token-after-the`);
  });

  test("re-homes slugs under prefixes gbrain hides from search", () => {
    expect(slugForRemember("x", "test/thing")).toBe("projects/test/thing");
    expect(slugForRemember("x", "attachments/thing")).toBe("projects/attachments/thing");
    expect(slugForRemember("x", ".raw/thing")).toBe("projects/.raw/thing");
    // A bare topic is namespaced already, so it is never excluded to begin with.
    expect(slugForRemember("x", "test")).toBe("projects/test");
    expect(slugForRemember("x", "Engram / Gateway Work")).toBe("engram/gateway-work");
    expect(slugForRemember("x", "///")).toBe("projects/untitled");
  });

  test("rejects empty text without writing", async () => {
    const result = await callTool(token, "remember", { text: "   " });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(auditCalls.map(call => [call[1], call[3]])).toEqual([["remember", "error"]]);
  });
});

describe("recall", () => {
  test("caps results at five and snippets at 280 chars", async () => {
    searchHits = Array.from({ length: 8 }, (_, i) => hit({ slug: `notes/${i}`, score: i }));

    const result = await callTool(token, "recall", { query: "deploy", limit: 500 });
    const { results, full } = payload(result);

    expect(calls[0]).toEqual({ name: "search", arguments: { query: "deploy", limit: 5 } });
    expect(results.length).toBe(5);
    for (const entry of results) {
      expect(entry.snippet.length).toBeLessThanOrEqual(280);
      expect(entry.snippet.endsWith("…")).toBe(true);
      expect(Object.keys(entry)).toEqual(["slug", "title", "snippet"]);
    }
    expect(full).toBeNull();
    expect(auditCalls.map(call => [call[1], call[3]])).toEqual([["recall", "ok"]]);
  });

  test("leaves short snippets alone", async () => {
    searchHits = [hit({ chunk_text: "# X\nshort body" })];

    const { results } = payload(await callTool(token, "recall", { query: "x" }));
    expect(results).toEqual([{ slug: "notes/x", title: "X", snippet: "# X\nshort body" }]);
  });

  test("full:true adds the best-scoring page body, truncated", async () => {
    searchHits = [
      hit({ slug: "notes/low", score: 0.2 }),
      hit({ slug: "notes/best", score: 9 }),
    ];
    pages.set("notes/best", `body ${"x".repeat(6000)}`);

    const { full } = payload(await callTool(token, "recall", { query: "x", full: true }));

    expect(full.slug).toBe("notes/best");
    expect(full.body.length).toBeLessThanOrEqual(4000);
    expect(full.body.endsWith("…")).toBe(true);
    expect(calls.map(call => call.name)).toEqual(["search", "get_page"]);
  });

  test("full:true on a miss returns null rather than erroring", async () => {
    searchHits = [hit({ slug: "notes/gone" })];

    const { results, full } = payload(await callTool(token, "recall", { query: "x", full: true }));
    expect(results.length).toBe(1);
    expect(full).toBeNull();
  });

  test("rejects an empty query without searching", async () => {
    const result = await callTool(token, "recall", {});

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(auditCalls.map(call => [call[1], call[3]])).toEqual([["recall", "error"]]);
  });
});

describe("forwarded search caps", () => {
  test("truncates chunk_text on the way back out", async () => {
    searchHits = [hit(), hit({ slug: "notes/y", chunk_text: "tiny" })];

    const result = await callTool(token, "search", { query: "x", limit: 500 });
    const hits = JSON.parse(result.content[0].text);

    expect(calls[0].arguments.limit).toBe(25);
    expect(hits[0].chunk_text.length).toBeLessThanOrEqual(280);
    expect(hits[0].chunk_text.endsWith("…")).toBe(true);
    expect(hits[1].chunk_text).toBe("tiny");
  });
});

describe("server instructions", () => {
  test("teach both verbs without spending a system prompt's worth of context", () => {
    expect(SERVER_INSTRUCTIONS.split(/\s+/).filter(Boolean).length).toBeLessThan(120);
    expect(SERVER_INSTRUCTIONS).toContain("recall");
    expect(SERVER_INSTRUCTIONS).toContain("remember");
  });
});

describe("tool description shrinking", () => {
  // Shaped like what gbrain actually ships: hundreds of words, and pointers to tools
  // engram does not serve. Every word of it lands in every agent's context.
  const gbrainSearch = {
    name: "search",
    description:
      "Search the knowledge base using hybrid BM25 + vector retrieval with automatic " +
      "query expansion. Returns ranked chunks with provenance. For recency-weighted " +
      "results call get_recent_salience first, then narrow with find_anomalies, and " +
      "for code questions prefer code_callers which walks the call graph. " +
      "Tip: issue several searches with different phrasings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "How many chunks to return. Defaults to 10." },
        mode: {
          type: "string",
          description:
            "Retrieval mode. Use 'hybrid' unless you have already run get_recent_salience.",
        },
      },
      required: ["query"],
    },
  };

  test("replaces the description and keeps the schema", () => {
    const shrunk = shrinkToolDef(gbrainSearch);

    expect(shrunk.description.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(shrunk.description).not.toContain("get_recent_salience");
    expect(shrunk.inputSchema.required).toEqual(["query"]);
    expect(Object.keys(shrunk.inputSchema.properties)).toEqual(["query", "limit", "mode"]);
  });

  test("keeps short parameter text, drops text naming tools engram does not serve", () => {
    const props = shrinkToolDef(gbrainSearch).inputSchema.properties;

    expect(props.query.description).toBe("Search query.");
    expect(props.mode.description).toBeUndefined();
    expect("description" in props.mode).toBe(false);
    // The cap is stated where a caller would otherwise guess at it.
    expect(props.limit.description).toBe("Max results (capped at 25).");
  });

  test("leaves a schema without properties alone", () => {
    expect(shrinkToolDef({ name: "whoami", inputSchema: { type: "object" } }).inputSchema)
      .toEqual({ type: "object" });
  });

  test("concurrent appends to one topic do not lose an entry", async () => {
    // The hazard is read-stale-then-write: both callers read the page, then both
    // write based on what they read, and the second write drops the first entry.
    // The fake must snapshot the page BEFORE its latency, or it accidentally lets
    // the later read observe the earlier write and the race never reproduces.
    const realCallTool = brain.callTool.bind(brain);
    brain.callTool = async (request: any) => {
      if (request.name === "get_page") {
        const snapshot = pages.get(request.arguments?.slug);
        await new Promise(r => setTimeout(r, 20));
        const restore = pages.get(request.arguments?.slug);
        if (snapshot === undefined) pages.delete(request.arguments?.slug);
        else pages.set(request.arguments?.slug, snapshot);
        const result = await realCallTool(request);
        if (restore === undefined) pages.delete(request.arguments?.slug);
        else pages.set(request.arguments?.slug, restore);
        return result;
      }
      return realCallTool(request);
    };
    try {
      await Promise.all([
        callTool({ name: "agent-a" } as any, "remember", { topic: "raceweave", text: "entry from agent A" }),
        callTool({ name: "agent-b" } as any, "remember", { topic: "raceweave", text: "entry from agent B" }),
      ]);
    } finally {
      brain.callTool = realCallTool;
    }

    const stored = pages.get("projects/raceweave") ?? "";
    expect(stored).toContain("entry from agent A");
    expect(stored).toContain("entry from agent B");
  });

});

describe("remember durability", () => {
  // The per-slug queue only covers this process. A write from the outgoing revision
  // during a deploy, from the console, or from a put_page run by hand lands
  // underneath an append, and the read-back is the only thing that notices.
  function clobberAfterPutPage(body: string, times: number) {
    const realCallTool = brain.callTool.bind(brain);
    let remaining = times;
    brain.callTool = async (request: any) => {
      const result = await realCallTool(request);
      if (request.name === "put_page" && remaining > 0) {
        remaining -= 1;
        pages.set(request.arguments.slug, body);
      }
      return result;
    };
    return () => {
      brain.callTool = realCallTool;
    };
  }

  const otherWriter =
    '---\ntitle: "gateway"\n---\n\n# gateway\n\n- 2026-01-01T00:00:00.000Z — written by another instance\n';

  test("re-appends when another writer clobbers the page after the write", async () => {
    const restore = clobberAfterPutPage(otherWriter, 1);
    try {
      const result = await callTool(token, "remember", { text: "mine", topic: "gateway" });
      expect(payload(result)).toEqual({ ok: true, slug: "projects/gateway", appended: true });
    } finally {
      restore();
    }

    const stored = pages.get("projects/gateway")!;
    // Both survive: the other writer's entry is the body this append restarted from.
    expect(stored).toContain("written by another instance");
    expect(stored).toContain("mine");
    expect(stored.match(/^- \d{4}/gm)?.length).toBe(2);
    expect(stored.match(/^---$/gm)?.length).toBe(2);
  });

  test("reports an error when the entry never survives", async () => {
    const restore = clobberAfterPutPage(otherWriter, 99);
    try {
      const result = await callTool(token, "remember", { text: "mine", topic: "gateway" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("did not survive");
    } finally {
      restore();
    }
    // A save that is gone is reported as a failure, not as ok.
    expect(auditCalls.map(call => [call[1], call[3]])).toEqual([["remember", "error"]]);
  });
});
