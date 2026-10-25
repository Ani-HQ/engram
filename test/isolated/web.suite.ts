import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const brainCalls: any[] = [];
const auditCalls: any[] = [];
let brainResult: any = { status: "soft_deleted", slug: "notes/delete-me" };
let brainError: unknown = null;
let ensureBrainError: unknown = null;
let ensureBrainCalls = 0;

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
const realAuth = await import("../../gateway/src/auth");
const realBrain = await import("../../gateway/src/brain");
const realOrgs = await import("../../gateway/src/orgs");
const realConnections = await import("../../gateway/src/connections");

const consoleToken = {
  name: "console",
  orgId: 1,
  role: "owner" as const,
  canWrite: true,
  kind: "token" as const,
  email: null,
  scopes: [] as string[],
};

mock.module("../../gateway/src/auth", () => ({
  ...realAuth,
  authenticate: async (authHeader: string | null) => (
    authHeader === "Bearer valid-token" ? consoleToken : null
  ),
  authenticateSecret: async (raw: string) => (raw === "valid-token" ? consoleToken : null),
  authenticateRequest: async (req: Request) => (
    req.headers.get("authorization") === "Bearer valid-token" ? consoleToken : null
  ),
}));

mock.module("../../gateway/src/brain", () => ({
  ...realBrain,
  brainClient: () => brain,
  ensureBrain: async () => { ensureBrainCalls++; if (ensureBrainError) throw ensureBrainError; return brain; },
}));

mock.module("../../gateway/src/orgs", () => ({
  ...realOrgs,
  resolveOrg: async () => realOrgs.ANI_HQ_ORG,
  withOrg: async (_org: unknown, _token: unknown, fn: () => Promise<Response>) => fn(),
  orgHasAgentToken: async () => true,
  orgHasRecordedPage: async () => false,
}));

mock.module("../../gateway/src/connections", () => ({
  ...realConnections,
  agentOnboardingChecks: async () => ({ agentConnected: true, memorySaved: false, memoryRecalled: false, taskReported: false }),
}));

// Spread for the same reason as the others, and override the two provenance
// readers explicitly: the real ones query Postgres, which no unit test wants.
let provenanceRows = new Map<string, any>();

const realAudit = await import("../../gateway/src/audit");

mock.module("../../gateway/src/audit", () => ({
  ...realAudit,
  audit: async (...args: any[]) => {
    auditCalls.push(args);
  },
  provenance: async () => ({ origin: null, contributors: [] }),
  provenanceFor: async (slugs: string[]) =>
    new Map(slugs.filter(slug => provenanceRows.has(slug)).map(slug => [slug, provenanceRows.get(slug)])),
}));

const realReview = await import("../../gateway/src/review/store");
mock.module("../../gateway/src/review/store", () => ({
  ...realReview,
  listReviewItems: async () => [],
  getReviewItem: async () => null,
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
} = await import("../../gateway/src/web");

beforeEach(() => {
  brainCalls.length = 0;
  auditCalls.length = 0;
  brainResult = { status: "soft_deleted", slug: "notes/delete-me" };
  brainError = null;
  ensureBrainError = null;
  ensureBrainCalls = 0;
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
  test("onboarding progress remains available when the memory engine cannot start", async () => {
    ensureBrainError = new Error("Fixture engine unavailable; receipt metadata remains accessible");
    const response = await handleWeb(new Request("http://engram.local/api/onboarding", {
      headers: { cookie: "engram_session=valid-token", "X-Engram-Console": "1", "X-Engram-Workspace": "1" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ step: "remember", provisioning: false, hasToken: true, hasPage: false,
      checks: { agentConnected: true, memorySaved: false, memoryRecalled: false, taskReported: false } });
    expect(ensureBrainCalls).toBe(0);
    expect(brainCalls).toEqual([]);
  });

  test("protects showcase settings with a cookie and CSRF header or an authenticated bearer", async () => {
    expect((await handleWeb(new Request("http://engram.local/api/showcase"))).status).toBe(403);
    expect((await handleWeb(new Request("http://engram.local/api/showcase", { headers: { "X-Engram-Console": "1" } }))).status).toBe(401);
    expect((await handleWeb(new Request("http://engram.local/api/showcase", { headers: { authorization: "Bearer invalid-token" } }))).status).toBe(401);
    for (const headers of [
      { authorization: "Bearer valid-token" },
      { cookie: "engram_session=valid-token", "X-Engram-Console": "1" },
    ]) {
      const invalid = await handleWeb(new Request("http://engram.local/api/showcase", { method: "PUT", headers, body: JSON.stringify({ slug: "invalid/slug", displayName: "Name", bio: "", published: true }) }));
      expect(invalid.status).toBe(400);
    }
    expect(brainCalls).toHaveLength(0);
  });

  test("protects action history with bearer authentication or the console session and header", async () => {
    const unauthorized = await handleWeb(new Request("http://engram.local/api/actions", {
      headers: { authorization: "Bearer invalid-token" },
    }));
    expect(unauthorized.status).toBe(401);
    const noHeader = await handleWeb(new Request("http://engram.local/api/actions", {
      headers: { cookie: "engram_session=valid-token" },
    }));
    expect(noHeader.status).toBe(403);
    const noCookie = await handleWeb(new Request("http://engram.local/api/actions", {
      headers: { "X-Engram-Console": "1" },
    }));
    expect(noCookie.status).toBe(401);
  });

  test("validates action queries identically through bearer and browser access", async () => {
    for (const headers of [
      { authorization: "Bearer valid-token" },
      { cookie: "engram_session=valid-token", "X-Engram-Console": "1" },
    ]) {
      const response = await handleWeb(new Request("http://engram.local/api/actions?status=unknown", { headers }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "status must be completed, failed, or running" });
    }
  });

  test("rejects spoofed action identity and malformed reports before persistence", async () => {
    for (const body of [{ tool: "shell", summary: "Ran", agent: "someone-else" }, { tool: "shell", summary: "Ran", evidence: "observed" }, []]) {
      const response = await handleWeb(new Request("http://engram.local/api/actions", {
        method: "POST", headers: { authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
    }
    expect(brainCalls).toHaveLength(0);
  });

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

  test("a long export stops if its browser session switches to a different workspace", async () => {
    const response = await handleWeb(new Request("http://engram.local/api/pages", { headers: { "X-Engram-Console": "1", "X-Engram-Workspace": "2", Cookie: "engram_session=valid-token" } }));
    expect(response.status).toBe(409);
    expect(brainCalls).toHaveLength(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
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
    expect(auditCalls)
      .toEqual([["console", "delete_page", "{\"slug\":\"notes/missing\"}", "not_found", "notes/missing"]]);
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
      expect(auditCalls)
        .toEqual([["console", "delete_page", `{\"slug\":\"notes/${status}\"}`, "ok", `notes/${status}`]]);
    }
  });

  test("returns JSON 404 for unknown API routes", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/nope", {
      headers: { "X-Engram-Console": "1" },
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("lists the review queue for a console session", async () => {
    const res = await handleWeb(new Request("http://engram.local/api/review", {
      headers: {
        "X-Engram-Console": "1",
        Cookie: "engram_session=valid-token",
      },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
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
  test("browser capture explicitly requests create-only and cannot silently replace a page", async () => {
    const { runWithContext } = await import("../../gateway/src/context");
    const { normalizeToken } = await import("../../gateway/src/policies");
    const dataQueries: string[] = [];
    const dataSql = (async (parts: TemplateStringsArray) => { dataQueries.push(parts.join("?")); return []; }) as any;
    const actor = normalizeToken(consoleToken);
    const request = () => new Request("http://engram.local/api/capture", { method: "POST", headers: { "X-Engram-Console": "1", Cookie: "engram_session=valid-token" }, body: JSON.stringify({ slug: "notes/atomic-capture", title: "Atomic capture", text: "A new memory." }) });
    const scoped = (work: () => Promise<Response>) => runWithContext({ org: realOrgs.ANI_HQ_ORG, token: actor, dataSql }, work);
    const response = await scoped(() => handleWeb(request()));
    expect(response.status).toBe(200);
    expect(brainCalls).toHaveLength(1);
    expect(brainCalls[0]).toMatchObject({ name: "put_page", arguments: { slug: "notes/atomic-capture", expected_hash: null } });
    expect(dataQueries).toHaveLength(1);
    brainError = new Error("ENGRAM_CAS_CONFLICT");
    expect((await scoped(() => handleWeb(request()))).status).toBe(400);
    expect(brainCalls[1].arguments.expected_hash).toBeNull();
    expect(dataQueries).toHaveLength(1);
  });

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

describe("anonymous branding asset delivery", () => {
  const assets = [
    ["/brand/engram-mark.svg", "image/svg+xml; charset=utf-8"],
    ["/brand/engram-mark.png", "image/png"],
    ["/brand/engram-192.png", "image/png"],
    ["/favicon.svg", "image/svg+xml; charset=utf-8"],
    ["/favicon.ico", "image/x-icon"],
    ["/apple-touch-icon.png", "image/png"],
    ["/site.webmanifest", "application/manifest+json"],
  ];

  test("serves public GET and empty HEAD without cookies or authentication", async () => {
    for (const [path, type] of assets) {
      for (const method of ["GET", "HEAD"]) {
        const response = await handleWeb(new Request(`http://engram.local${path}`, { method }));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(type);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("www-authenticate")).toBeNull();
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        const bytes = (await response.arrayBuffer()).byteLength;
        if (method === "HEAD") expect(bytes).toBe(0);
        else expect(bytes).toBeGreaterThan(0);
      }
    }
    expect(brainCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("limits cross-origin delivery to branding, including after path decoding", async () => {
    for (const path of ["/style.css", "/oauth.css", "/brand%2f..%2fstyle.css"]) {
      const response = await handleWeb(new Request(`http://engram.local${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const privateResponse = await handleWeb(new Request("http://engram.local/api/me"));
    expect(privateResponse.status).not.toBe(200);
    expect(privateResponse.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("serves separate public and private shells without soft 404s", async () => {
    for (const [path, expected] of [["/", "/marketing.css"], ["/app", "/app.js"]]) {
      const page = await handleWeb(new Request(`http://engram.local${path}`));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(expected);
      const head = await handleWeb(new Request(`http://engram.local${path}`, { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    const missingPage = await handleWeb(new Request("http://engram.local/a-missing-public-page"));
    expect(missingPage.status).toBe(404);
    expect(missingPage.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(missingPage.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await missingPage.text()).toContain('name="robots" content="noindex');
    const missingAsset = await handleWeb(new Request("http://engram.local/missing-runtime.js"));
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.text()).toBe("Not Found");
    const sitemap = await handleWeb(new Request("http://engram.local/sitemap.xml"));
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  });

  test("returns 404 for missing branding and consent assets while retaining SPA routes", async () => {
    const webDir = await mkdtemp(join(tmpdir(), "engram-branding-static-"));
    const previous = process.env.ENGRAM_WEB_DIR;
    try {
      await writeFile(join(webDir, "index.html"), "<!doctype html><title>SPA fixture</title>");
      process.env.ENGRAM_WEB_DIR = webDir;
      for (const path of ["/brand", "/brand/missing.svg", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/site.webmanifest", "/oauth.css"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await handleWeb(new Request(`http://engram.local${path}`, { method }));
          expect(response.status).toBe(404);
          expect(await response.text()).toBe(method === "HEAD" ? "" : "Not Found");
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          expect(response.headers.get("set-cookie")).toBeNull();
        }
      }
      const page = await handleWeb(new Request("http://engram.local/workspace/client-route"));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("SPA fixture");
      const head = await handleWeb(new Request("http://engram.local/workspace/client-route", { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await head.text()).toBe("");
    } finally {
      if (previous === undefined) delete process.env.ENGRAM_WEB_DIR;
      else process.env.ENGRAM_WEB_DIR = previous;
      await rm(webDir, { recursive: true, force: true });
    }
  });
});

describe("provenance on the list", () => {
  // The list is the hot path, so provenance for a whole window is one grouped query
  // rather than one per row. The rows carry it so a stub can say where it came from
  // and who has taught it, without the reader opening every page to find out.
  test("each row carries its origin and contributors, and the list says if there is more", async () => {
    brainResult = [
      { slug: "notes/a", title: "A", type: "note", updated_at: "2026-09-18T00:00:00Z" },
      { slug: "notes/b", title: "B", type: "note", updated_at: "2026-09-17T00:00:00Z" },
      { slug: "notes/c", title: "C", type: "note", updated_at: "2026-09-16T00:00:00Z" },
    ];
    provenanceRows = new Map([
      ["notes/a", {
        origin: { by: "codex", at: "2026-09-01T00:00:00.000Z" },
        contributors: [
          { name: "codex", first: "2026-09-01T00:00:00.000Z", last: "2026-09-02T00:00:00.000Z", writes: 3 },
          { name: "mac-claude", first: "2026-09-05T00:00:00.000Z", last: "2026-09-18T00:00:00.000Z", writes: 9 },
        ],
      }],
    ]);

    const res = await handleWeb(new Request("http://engram.local/api/pages?limit=2", {
      headers: { "X-Engram-Console": "1", Cookie: "engram_session=valid-token" },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pages[0].provenance.origin).toEqual({ by: "codex", at: "2026-09-01T00:00:00.000Z" });
    expect(body.pages[0].provenance.contributors.map((c: any) => c.name)).toEqual(["codex", "mac-claude"]);
    // A page with nothing recoverable says so rather than inventing an author.
    expect(body.pages[1].provenance).toEqual({ origin: null, contributors: [] });
    // The extra row establishes that another window exists.
    expect(body.more).toBe(true);
  });

  test("a short window reports that there is nothing more to load", async () => {
    brainResult = [{ slug: "notes/only", title: "Only", type: "note", updated_at: "2026-09-18T00:00:00Z" }];
    provenanceRows = new Map();

    const res = await handleWeb(new Request("http://engram.local/api/pages?limit=25", {
      headers: { "X-Engram-Console": "1", Cookie: "engram_session=valid-token" },
    }));

    expect((await res.json()).more).toBe(false);
  });

  test("browser exports can paginate beyond the MCP context cap and stop on a real storage failure", async () => {
    brainResult = Array.from({ length: 60 }, (_, index) => ({ slug: `notes/page-${index}`, title: `Page ${index}`, updated_at: new Date(Date.UTC(2026, 0, 60 - index)).toISOString() }));
    const response = await handleWeb(new Request("http://engram.local/api/pages?limit=25&offset=25", { headers: { "X-Engram-Console": "1", Cookie: "engram_session=valid-token" } }));
    const result = await response.json();
    expect(brainCalls[0].arguments.limit).toBe(51);
    expect(result.pages[0].slug).toBe("notes/page-25");
    expect(result.pages).toHaveLength(25);
    expect(result.more).toBe(true);
    brainError = new Error("offline");
    const failed = await handleWeb(new Request("http://engram.local/api/pages", { headers: { "X-Engram-Console": "1", Cookie: "engram_session=valid-token" } }));
    expect(failed.status).toBe(503);
  });
});
