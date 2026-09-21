// Dev-only fixture server. Production never runs this file; the engram gateway
// serves web/ as static console assets and owns the real API implementation.
import { extname, normalize } from "node:path";

const PORT = 8099;
const root = new URL("./", import.meta.url);
const sessionFixture = await readFixture("session.json");
const pagesFixture = await readFixture("pages.json");
const emptyFixture = await readFixture("pages-empty.json");
const detailFixture = await readFixture("page-detail.json");
const searchFixture = await readFixture("search.json");

// The fixture file holds enough rows to judge the design, but not enough to reach a
// second window, so lazy loading could never be exercised against it. Pad it here
// rather than committing eighty near-identical rows to the fixture.
let pages = padCollection(clone(pagesFixture.pages), 96);

function padCollection(rows: any[], target: number): any[] {
  const agents = ["mac-claude", "codex", "baymax", "carolyn", "midi", "grok-bot"];
  const out = rows.slice();
  for (let i = rows.length; i < target; i += 1) {
    const seed = rows[i % rows.length];
    const who = agents[i % agents.length];
    const day = String((i % 27) + 1).padStart(2, "0");
    out.push({
      ...clone(seed),
      slug: `${seed.slug}-${i}`,
      title: `${seed.title} ${i}`,
      updated_at: `2026-0${(i % 9) + 1}-${day}T09:00:00.000Z`,
      provenance: {
        origin: { by: who, at: `2026-0${(i % 9) + 1}-${day}T09:00:00.000Z` },
        contributors: [{ name: who, first: `2026-01-${day}T09:00:00.000Z`, last: `2026-09-${day}T09:00:00.000Z`, writes: (i % 11) + 1 }],
      },
    });
  }
  return out;
}
const details = new Map([[detailFixture.page.slug, detailFixture]]);
const forgotten = new Map<string, { row: any; detail: any; index: number }>();

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: devFetch });
  console.log(`engram console dev server: http://localhost:${PORT}/`);
}

export async function devFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return handleApi(req, url);
  return serveStatic(url);
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/session" && req.method === "POST") {
    await req.json().catch(() => ({}));
    return json(sessionFixture, {
      "Set-Cookie": "engram_dev=1; Path=/; HttpOnly; SameSite=Lax",
    });
  }
  if (url.pathname === "/api/session" && req.method === "DELETE") {
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": "engram_dev=; Path=/; Max-Age=0; SameSite=Lax" },
    });
  }
  if (url.pathname === "/api/me" && req.method === "GET") {
    return hasDevSession(req) ? json(sessionFixture) : json({ error: "unauthorized" }, {}, 401);
  }
  if (url.pathname === "/api/pages" && req.method === "GET") return json(listPages(url));
  if (url.pathname === "/api/search" && req.method === "GET") return json(searchPages(url));
  if (url.pathname === "/api/graph" && req.method === "GET") return json(buildGraph());
  if (url.pathname === "/api/activity" && req.method === "GET") return json(fakeActivity());
  if (url.pathname === "/api/page" && req.method === "GET") {
    const detail = pageDetail(url);
    return detail ? json(detail) : json({ error: "not found" }, {}, 404);
  }
  if (url.pathname === "/api/page" && req.method === "DELETE") return forgetPage(req, url);
  if (url.pathname === "/api/page/restore" && req.method === "POST") return restorePage(req);
  if (url.pathname === "/api/capture" && req.method === "POST") return capture(req);
  if (url.pathname === "/api/review" && req.method === "GET") return json({ items: reviewFixture() });
  if (url.pathname === "/api/review/item" && req.method === "GET") {
    const item = reviewFixture().find((row: any) => String(row.id) === url.searchParams.get("id"));
    return item ? json({ item }) : json({ error: "not found" }, {}, 404);
  }
  if (url.pathname.startsWith("/api/review/") && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    return json({ ok: true, item: { id: Number(body.id) || 1, state: url.pathname.split("/").pop() } });
  }
  return new Response("Not Found", { status: 404 });
}

function reviewFixture() {
  return [
    {
      id: 1,
      kind: "duplicate",
      state: "pending",
      confidence: 0.81,
      payload: {
        otherSlug: "projects/engram",
        otherText: "Deploy is gated on the test suite.",
      },
    },
    {
      id: 2,
      kind: "cluster",
      state: "pending",
      confidence: 0.74,
      payload: { title: "engram", clusterSlug: "projects-engram", members: ["projects/engram"] },
    },
  ];
}

function listPages(url: URL) {
  const fixture = url.searchParams.get("fixture") === "empty" ? emptyFixture.pages : pages;
  const scope = url.searchParams.get("scope");
  const sort = url.searchParams.get("sort") ?? "updated_desc";
  const limit = Number(url.searchParams.get("limit") ?? 48);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const all = fixture
    .filter((page: any) => !scope || page.scope === scope)
    .sort((a: any, b: any) => comparePages(a, b, sort));
  const rows = all.slice(offset, offset + limit);
  return {
    pages: rows,
    // Same contract the gateway answers with: a full window means ask again.
    more: rows.length === limit && offset + limit < all.length,
    scopes: [...new Set(fixture.map((page: any) => page.scope))],
  };
}

// Fixture graph: cluster by slug prefix and link each page to a couple of others in
// the same cluster, which is enough shape to judge the layout and the interaction.
// Rotates through a few pages so the shimmer and the agent marks can actually be
// looked at without waiting for a real agent to touch something.
function fakeActivity() {
  const agents = ["mac-claude", "codex", "zara-openclaw", "hermes-baymax", "grok-bot"];
  const tools = ["recall", "remember", "get_page", "put_page"];
  const tick = Math.floor(Date.now() / 8000);
  // Pick from the most recently updated pages, which are the ones actually on screen.
  // Choosing at random from the whole set meant the shimmer was usually happening to
  // a row forty places below the fold.
  const visible = [...pages].sort((a: any, b: any) => comparePages(a, b, "updated_desc")).slice(0, 12);
  const active = [0, 1, 2].map(i => {
    const page = visible[(tick + i * 4) % visible.length];
    return {
      slug: page.slug,
      by: agents[(tick + i) % agents.length],
      tool: tools[(tick + i) % tools.length],
      at: new Date().toISOString(),
    };
  });
  return { active };
}

function buildGraph() {
  const nodes = pages.slice(0, 150).map((page: any) => ({
    slug: page.slug,
    title: page.title,
    type: page.type ?? "note",
    updated_at: page.updated_at,
    cluster: page.slug.includes("/") ? page.slug.slice(0, page.slug.indexOf("/")) : page.slug.split("-")[0],
    origin: page.provenance?.origin ?? null,
    contributors: (page.provenance?.contributors ?? []).map((c: any) => c.name),
  }));
  const byCluster = new Map<string, any[]>();
  for (const node of nodes) {
    if (!byCluster.has(node.cluster)) byCluster.set(node.cluster, []);
    byCluster.get(node.cluster)!.push(node);
  }
  const edges: { source: string; target: string }[] = [];
  for (const group of byCluster.values()) {
    for (let i = 1; i < group.length; i += 1) {
      edges.push({ source: group[i].slug, target: group[i - 1].slug });
      if (i % 3 === 0) edges.push({ source: group[i].slug, target: group[0].slug });
    }
  }
  const clusters = [...byCluster.values()];
  for (let i = 1; i < clusters.length; i += 1) {
    edges.push({ source: clusters[i][0].slug, target: clusters[i - 1][0].slug });
  }
  return { nodes, edges, truncated: pages.length > 150 };
}

function searchPages(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const scope = url.searchParams.get("scope");
  const limit = Number(url.searchParams.get("limit") ?? 48);
  if (!q) return { results: [] };
  const fixtureHits = searchFixture.results.filter((row: any) => !forgotten.has(row.slug) && matches(row, q, scope));
  const pageHits = pages
    .filter((row: any) => matches(row, q, scope))
    .map((row: any) => ({
      slug: row.slug,
      title: row.title,
      scope: row.scope,
      updated_at: row.updated_at,
      snippet: `Fixture page matching ${q}: ${row.title}.`,
    }));
  const seen = new Set();
  return {
    results: [...fixtureHits, ...pageHits].filter((row: any) => {
      if (seen.has(row.slug)) return false;
      seen.add(row.slug);
      return true;
    }).slice(0, limit),
  };
}

function pageDetail(url: URL) {
  const slug = url.searchParams.get("slug") ?? "ink-density-recency";
  if (details.has(slug)) return clone(details.get(slug));
  const row = pages.find((page: any) => page.slug === slug);
  if (!row) return null;
  return {
    page: {
      slug: row.slug,
      title: row.title,
      type: row.type,
      scope: row.scope,
      updated_at: row.updated_at,
      body: `## ${row.title}\n\nThis fixture page gives the reader pane enough text to breathe. It belongs to \`${row.scope}\` and keeps the same contract as the gateway.`,
    },
    links: clone(detailFixture.links).slice(0, 2),
    timeline: clone(detailFixture.timeline).slice(0, 3),
  };
}

function forgetPage(req: Request, url: URL) {
  if (!hasDevSession(req)) return json({ error: "forbidden" }, {}, 403);
  const slug = url.searchParams.get("slug")?.trim();
  if (!slug) return json({ error: "bad request" }, {}, 400);

  const index = pages.findIndex((page: any) => page.slug === slug);
  if (index >= 0) {
    const [row] = pages.splice(index, 1);
    const detail = details.get(slug) ?? null;
    details.delete(slug);
    forgotten.set(slug, { row, detail, index });
    return json({ ok: true, slug, recoverable: true });
  }
  if (forgotten.has(slug)) return json({ ok: true, slug, recoverable: true });
  return json({ error: "not found" }, {}, 404);
}

async function restorePage(req: Request) {
  if (!hasDevSession(req)) return json({ error: "forbidden" }, {}, 403);
  const body = await req.json().catch(() => ({}));
  const slug = String(body.slug ?? "").trim();
  if (!slug) return json({ error: "bad request" }, {}, 400);

  const record = forgotten.get(slug);
  if (!record) return json({ error: "not found" }, {}, 404);
  if (!pages.some((page: any) => page.slug === slug)) {
    pages.splice(Math.max(0, Math.min(record.index, pages.length)), 0, record.row);
  }
  if (record.detail) details.set(slug, record.detail);
  forgotten.delete(slug);
  return json({ ok: true, slug });
}

async function capture(req: Request) {
  if (!hasDevSession(req)) return json({ error: "forbidden" }, {}, 403);
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim();
  if (!text) return json({ error: "empty" }, {}, 400);
  const title = String(body.title || text.split("\n")[0]).replace(/^#+\s*/, "").slice(0, 80) || "Untitled memory";
  const slug = uniqueSlug(body.slug || slugify(title));
  const scope = body.scope || "shared";
  const updated_at = new Date().toISOString();
  const row = { slug, title, type: "capture", source_id: "dev", scope, updated_at };
  pages = [row, ...pages];
  details.set(slug, { page: { ...row, body: text }, links: [], timeline: [{ at: updated_at, text: "Captured from the dev console." }] });
  return json({ ok: true, slug });
}

async function serveStatic(url: URL): Promise<Response> {
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const fileUrl = new URL(`.${safe}`, root);
  if (!fileUrl.pathname.startsWith(root.pathname)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(fileUrl);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });
  return new Response(file, { headers: { "Content-Type": contentType(fileUrl.pathname) } });
}

function comparePages(a: any, b: any, sort: string) {
  if (sort === "updated_asc") return Date.parse(a.updated_at) - Date.parse(b.updated_at);
  if (sort === "created_desc") return a.slug < b.slug ? 1 : -1;
  if (sort === "slug") return a.slug.localeCompare(b.slug);
  return Date.parse(b.updated_at) - Date.parse(a.updated_at);
}

function matches(row: any, q: string, scope: string | null) {
  if (scope && row.scope !== scope) return false;
  return `${row.slug} ${row.title} ${row.snippet ?? ""}`.toLowerCase().includes(q);
}

function hasDevSession(req: Request) {
  return req.headers.get("cookie")?.includes("engram_dev=1") || req.headers.get("x-engram-console") === "1";
}

function uniqueSlug(base: string) {
  let slug = base || "memory";
  let suffix = 2;
  while (pages.some((page: any) => page.slug === slug)) slug = `${base}-${suffix++}`;
  return slug;
}

function slugify(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
}

function contentType(pathname: string) {
  const ext = extname(pathname);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[ext] ?? "application/octet-stream";
}

function json(data: unknown, headers: Record<string, string> = {}, status = 200) {
  return Response.json(data, { status, headers });
}

async function readFixture(name: string) {
  return Bun.file(new URL(`./fixtures/${name}`, root)).json();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
