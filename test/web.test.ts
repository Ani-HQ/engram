import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const brainCalls: any[] = [];
const auditCalls: any[] = [];
let brainResult: any = { status: "soft_deleted", slug: "notes/delete-me" };
let brainError: unknown = null;

const brain = {
  async callTool(request: any) {
    brainCalls.push(request);
    if (brainError) throw brainError;
    return {
      content: [{
        type: "text",
        text: JSON.stringify(brainResult),
      }],
    };
  },
};

// mock.module is process-global and outlives this file, so a mock that lists only
// the exports this suite needs silently deletes the rest for every file that runs
// after it. That cost a Cloud Build failure: web.test.ts happened to be evaluated
// first, auth.test.ts imported this stub instead of the real module, and sha256 came
// back undefined. Spread the real module so a mock can only ever override, never drop.
const realAuth = await import("../gateway/src/auth");
const realBrain = await import("../gateway/src/brain");

mock.module("../gateway/src/auth", () => ({
  ...realAuth,
  authenticate: async (authHeader: string | null) => (
    authHeader === "Bearer valid-token" ? { name: "console" } : null
  ),
}));

mock.module("../gateway/src/brain", () => ({
  ...realBrain,
  brainClient: () => brain,
}));

mock.module("../gateway/src/audit", () => ({
  audit: async (...args: any[]) => {
    auditCalls.push(args);
  },
}));

const {
  captureMarkdown,
  clearSessionCookie,
  coercePagesQuery,
  coerceSearchQuery,
  deriveBodyLinks,
  generateCaptureSlug,
  hasConsoleHeader,
  handleWeb,
  needsConsoleHeader,
  normalizePageResult,
  normalizePageSummaries,
  normalizeSearchResults,
  normalizeTimeline,
  parseSessionCookie,
  parseToolText,
  rejectedSlugReason,
  resolveStaticPath,
  serializeSessionCookie,
  sortPageSummaries,
} = await import("../gateway/src/web");

beforeEach(() => {
  brainCalls.length = 0;
  auditCalls.length = 0;
  brainResult = { status: "soft_deleted", slug: "notes/delete-me" };
  brainError = null;
});

const LIVE_GET_PAGE = {
  id: 1,
  slug: "notes/engram-online",
  type: "note",
  title: "engram online",
  compiled_truth: "# engram online\nengram brain deployed to Cloud Run on 2026-08-15. Marker: nebula-condor.",
  timeline: "",
  frontmatter: {},
  content_hash: "d004...",
  created_at: "2026-08-15T17:29:30.421Z",
  updated_at: "2026-08-15T17:29:30.421Z",
  deleted_at: null,
  effective_date: "2026-08-15T17:29:30.425Z",
  source_kind: "mcp:put_page",
  source_id: "default",
  tags: [],
};

const LIVE_SEARCH = [{
  slug: "notes/engram-online",
  page_id: 1,
  title: "engram online",
  type: "note",
  chunk_text: "# engram online\nengram brain deployed...",
  chunk_source: "compiled_truth",
  chunk_id: 1,
  chunk_index: 0,
  score: 1,
  stale: false,
  source_id: "default",
  effective_date: "2026-08-15",
  evidence: "high_vector_match",
}];

const LIVE_LIST_PAGES = [{
  slug: "notes/engram-online",
  source_id: "default",
  type: "note",
  title: "engram online",
  updated_at: "2026-08-15T17:29:30.421Z",
}];

describe("console session cookies", () => {
  test("serializes and parses the secure cookie", () => {
    const old = process.env.ENGRAM_INSECURE_COOKIE;
    delete process.env.ENGRAM_INSECURE_COOKIE;
    try {
      const cookie = serializeSessionCookie("raw-token");
      expect(cookie).toBe(
        "engram_session=raw-token; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1209600",
      );
      expect(parseSessionCookie(`other=x; ${cookie}`)).toBe("raw-token");
      expect(clearSessionCookie()).toContain("Max-Age=0");
    } finally {
      if (old === undefined) delete process.env.ENGRAM_INSECURE_COOKIE;
      else process.env.ENGRAM_INSECURE_COOKIE = old;
    }
  });

  test("omits Secure only for local insecure-cookie mode", () => {
    const old = process.env.ENGRAM_INSECURE_COOKIE;
    process.env.ENGRAM_INSECURE_COOKIE = "1";
    try {
      expect(serializeSessionCookie("local-token")).toBe(
        "engram_session=local-token; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600",
      );
      expect(parseSessionCookie("engram_session=local-token")).toBe("local-token");
    } finally {
      if (old === undefined) delete process.env.ENGRAM_INSECURE_COOKIE;
      else process.env.ENGRAM_INSECURE_COOKIE = old;
    }
  });
});

describe("console CSRF header", () => {
  test("rejects missing and wrong console headers", () => {
    expect(needsConsoleHeader("GET", "/api/me")).toBe(true);
    expect(needsConsoleHeader("POST", "/api/session")).toBe(true);
    expect(hasConsoleHeader(new Headers())).toBe(false);
    expect(hasConsoleHeader(new Headers({ "X-Engram-Console": "0" }))).toBe(false);
    expect(hasConsoleHeader(new Headers({ "X-Engram-Console": "1" }))).toBe(true);
  });
});

describe("console API edge responses", () => {
  test("rejects protected API routes without the console header", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/me"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("rejects session creation without the console header", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/session", {
      method: "POST",
      body: JSON.stringify({ token: "attacker-token" }),
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("returns 401 on protected API routes without a cookie", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/me", {
      headers: { "X-Engram-Console": "1" },
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("rejects delete without the console header", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/page?slug=notes/delete-me", {
      method: "DELETE",
      headers: { Cookie: "engram_session=valid-token" },
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(brainCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  test("rejects delete without a cookie", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/page?slug=notes/delete-me", {
      method: "DELETE",
      headers: { "X-Engram-Console": "1" },
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(brainCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  test("maps page_not_found from delete to 404", async () => {
    brainError = new Error("page_not_found");
    const res = await handleWeb(new Request("http://engram.local/api/page?slug=notes/missing", {
      method: "DELETE",
      headers: {
        "X-Engram-Console": "1",
        Cookie: "engram_session=valid-token",
      },
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(brainCalls).toEqual([{ name: "delete_page", arguments: { slug: "notes/missing" } }]);
    expect(auditCalls).toEqual([["console", "delete_page", "{\"slug\":\"notes/missing\"}", "not_found"]]);
  });

  test("maps soft delete statuses to the recoverable ok shape", async () => {
    for (const status of ["soft_deleted", "already_soft_deleted"]) {
      brainCalls.length = 0;
      auditCalls.length = 0;
      brainResult = { status, slug: `notes/${status}` };

      const res = await handleWeb(new Request(`http://engram.local/api/page?slug=notes/${status}`, {
        method: "DELETE",
        headers: {
          "X-Engram-Console": "1",
          Cookie: "engram_session=valid-token",
        },
      }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, slug: `notes/${status}`, recoverable: true });
      expect(brainCalls).toEqual([{ name: "delete_page", arguments: { slug: `notes/${status}` } }]);
      expect(auditCalls).toEqual([["console", "delete_page", `{\"slug\":\"notes/${status}\"}`, "ok"]]);
    }
  });

  test("returns JSON 404 for unknown API routes", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/nope", {
      headers: { "X-Engram-Console": "1" },
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("clears the session cookie without a response body", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/session", {
      method: "DELETE",
      headers: { "X-Engram-Console": "1" },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await res.text()).toBe("");
  });
});

describe("live gbrain payload normalizers", () => {
  test("reads page body from compiled_truth and empty timeline as []", () => {
    expect(normalizePageResult(LIVE_GET_PAGE, "notes/engram-online")).toEqual({
      page: {
        slug: "notes/engram-online",
        title: "engram online",
        type: "note",
        updated_at: "2026-08-15T17:29:30.421Z",
        body: LIVE_GET_PAGE.compiled_truth,
      },
      links: [],
      timeline: [],
    });
  });

  test("uses chunk_text and effective_date for search results", () => {
    expect(normalizeSearchResults(LIVE_SEARCH)).toEqual([{
      slug: "notes/engram-online",
      title: "engram online",
      updated_at: "2026-08-15",
      snippet: "# engram online\nengram brain deployed...",
    }]);
  });

  test("normalizes list_pages bare arrays", () => {
    expect(normalizePageSummaries(LIVE_LIST_PAGES)).toEqual([{
      slug: "notes/engram-online",
      title: "engram online",
      type: "note",
      source_id: "default",
      updated_at: "2026-08-15T17:29:30.421Z",
      created_at: "",
    }]);
  });

  test("parses timeline strings into dated entries", () => {
    expect(normalizeTimeline("2026-08-15 - shipped v0\n2026-08-16 - added console")).toEqual([
      { at: "2026-08-15", text: "shipped v0" },
      { at: "2026-08-16", text: "added console" },
    ]);
    expect(normalizeTimeline("")).toEqual([]);
  });

  test("derives internal body links and ignores external targets", () => {
    const body = [
      "[[notes/foo]]",
      "[text](notes/bar)",
      "[ext](https://example.com)",
      "[[notes/foo]]",
    ].join("\n");
    expect(deriveBodyLinks(body)).toEqual([
      { slug: "notes/foo", title: "foo", relation: "body" },
      { slug: "notes/bar", title: "bar", relation: "body" },
    ]);
    expect(normalizePageResult({ ...LIVE_GET_PAGE, compiled_truth: body }, "notes/engram-online")?.links)
      .toEqual([
        { slug: "notes/foo", title: "foo", relation: "body" },
        { slug: "notes/bar", title: "bar", relation: "body" },
      ]);
  });

  test("created_desc falls back to updated_at when created_at is missing", () => {
    expect(sortPageSummaries([
      { slug: "notes/old", title: "old", type: "note", source_id: "default", updated_at: "2026-08-14T00:00:00.000Z" },
      { slug: "notes/new", title: "new", type: "note", source_id: "default", updated_at: "2026-08-16T00:00:00.000Z" },
    ], "created_desc").map(page => page.slug)).toEqual(["notes/new", "notes/old"]);
  });
});

describe("capture slug and markdown helpers", () => {
  test("generates date-prefixed note slugs from titles", () => {
    expect(generateCaptureSlug("Engram console shipped", "ignored", "2026-08-17")).toBe(
      "notes/2026-08-17-engram-console-shipped",
    );
  });

  test("handles punctuation, unicode, and overlong titles", () => {
    expect(generateCaptureSlug("Cafe deja vu!!! ship-now", "", "2026-08-17")).toBe(
      "notes/2026-08-17-cafe-deja-vu-ship-now",
    );
    expect(generateCaptureSlug("Café déjà vu!!! 🚀 ship now", "", "2026-08-17")).toBe(
      "notes/2026-08-17-cafe-deja-vu-ship-now",
    );
    const long = generateCaptureSlug(
      "This title is intentionally very long and should be trimmed before it becomes a slug",
      "",
      "2026-08-17",
    );
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).not.toEndWith("-");
    expect(generateCaptureSlug("!!!", "Fallback text wins when title has no letters", "2026-08-17")).toBe(
      "notes/2026-08-17-fallback-text-wins-when-title-has",
    );
  });

  test("falls back to the first six words of text and avoids excluded prefixes", () => {
    const slug = generateCaptureSlug(null, "Captured text becomes a readable note slug with extras", "2026-08-17");
    expect(slug).toBe("notes/2026-08-17-captured-text-becomes-a-readable-note");
    expect(rejectedSlugReason(slug)).toBeNull();
    expect(slug.startsWith("test/")).toBe(false);
    expect(slug.startsWith("attachments/")).toBe(false);
    expect(slug.startsWith(".raw/")).toBe(false);
  });

  test("quotes YAML frontmatter title safely", () => {
    expect(captureMarkdown("Engram: \"console\"", "Body")).toBe(
      "---\ntitle: \"Engram: \\\"console\\\"\"\n---\n\nBody",
    );
  });
});

describe("tool text parsing", () => {
  test("parses JSON text blocks", () => {
    expect(parseToolText({ content: [{ type: "text", text: "{\"ok\":true}" }] })).toEqual({ ok: true });
  });

  test("passes prose through as text", () => {
    expect(parseToolText({ content: [{ type: "text", text: "stored in notes/x" }] })).toEqual({
      text: "stored in notes/x",
    });
  });

  test("throws tool errors with the original text", () => {
    expect(() => parseToolText({
      content: [{ type: "text", text: "Write denied." }],
      isError: true,
    })).toThrow("Write denied.");
  });
});

describe("console query coercion", () => {
  test("coerces page defaults, clamps limits, and rejects bad sort", () => {
    expect(coercePagesQuery(new URLSearchParams(""))).toEqual({
      limit: 50,
      offset: 0,
      sort: "updated_desc",
      tag: null,
    });
    expect(coercePagesQuery(new URLSearchParams("limit=999&offset=-2&sort=slug"))).toMatchObject({
      limit: 100,
      offset: 0,
      sort: "slug",
    });
    expect(coercePagesQuery(new URLSearchParams("sort=random"))).toBeNull();
  });

  test("coerces search query and rejects blank q", () => {
    expect(coerceSearchQuery(new URLSearchParams("q=hello&limit=999&scope=shared"))).toEqual({
      q: "hello",
      limit: 50,
    });
    expect(coerceSearchQuery(new URLSearchParams("q=+"))).toBeNull();
  });
});

describe("static path resolution", () => {
  const root = "/tmp/engram-web-root";

  test("keeps ordinary paths inside the web root", () => {
    expect(resolveStaticPath("/", root)).toBe("/tmp/engram-web-root/index.html");
    expect(resolveStaticPath("/assets/app.js", root)).toBe("/tmp/engram-web-root/assets/app.js");
  });

  test("refuses traversal and absolute-path attempts", () => {
    expect(resolveStaticPath("../secret", root)).toBeNull();
    expect(resolveStaticPath("/../secret", root)).toBeNull();
    expect(resolveStaticPath("/%2e%2e%2fsecret", root)).toBeNull();
    expect(resolveStaticPath("//etc/passwd", root)).toBeNull();
    expect(resolveStaticPath("/%2Fetc/passwd", root)).toBeNull();
  });
});
