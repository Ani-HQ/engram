import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

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
    expect(normalizePageResult(LIVE_GET_PAGE, "notes/engram-online", "shared")).toEqual({
      page: {
        slug: "notes/engram-online",
        title: "engram online",
        type: "note",
        scope: "shared",
        updated_at: "2026-08-15T17:29:30.421Z",
        body: LIVE_GET_PAGE.compiled_truth,
      },
      links: [],
      timeline: [],
    });
  });

  test("uses chunk_text and effective_date for search results", () => {
    expect(normalizeSearchResults(LIVE_SEARCH, "shared")).toEqual([{
      slug: "notes/engram-online",
      title: "engram online",
      scope: "shared",
      updated_at: "2026-08-15",
      snippet: "# engram online\nengram brain deployed...",
    }]);
  });

  test("normalizes list_pages bare arrays", () => {
    expect(normalizePageSummaries(LIVE_LIST_PAGES, "shared")).toEqual([{
      slug: "notes/engram-online",
      title: "engram online",
      type: "note",
      source_id: "default",
      scope: "shared",
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
    expect(normalizePageResult({ ...LIVE_GET_PAGE, compiled_truth: body }, "notes/engram-online", "shared")?.links)
      .toEqual([
        { slug: "notes/foo", title: "foo", relation: "body" },
        { slug: "notes/bar", title: "bar", relation: "body" },
      ]);
  });

  test("created_desc falls back to updated_at when created_at is missing", () => {
    expect(sortPageSummaries([
      { slug: "notes/old", title: "old", type: "note", source_id: "default", scope: "shared", updated_at: "2026-08-14T00:00:00.000Z" },
      { slug: "notes/new", title: "new", type: "note", source_id: "default", scope: "shared", updated_at: "2026-08-16T00:00:00.000Z" },
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
      scope: null,
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
      scope: "shared",
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
