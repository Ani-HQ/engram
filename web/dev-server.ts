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

let pages = clone(pagesFixture.pages);
const details = new Map([[detailFixture.page.slug, detailFixture]]);

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: devFetch });
  console.log(`文庫 dev server: http://localhost:${PORT}/`);
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
  if (url.pathname === "/api/page" && req.method === "GET") return json(pageDetail(url));
  if (url.pathname === "/api/capture" && req.method === "POST") return capture(req);
  return new Response("Not Found", { status: 404 });
}

function listPages(url: URL) {
  const fixture = url.searchParams.get("fixture") === "empty" ? emptyFixture.pages : pages;
  const scope = url.searchParams.get("scope");
  const sort = url.searchParams.get("sort") ?? "updated_desc";
  const limit = Number(url.searchParams.get("limit") ?? 48);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const rows = fixture
    .filter((page: any) => !scope || page.scope === scope)
    .sort((a: any, b: any) => comparePages(a, b, sort))
    .slice(offset, offset + limit);
  return { pages: rows, scopes: [...new Set(fixture.map((page: any) => page.scope))] };
}

function searchPages(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const scope = url.searchParams.get("scope");
  const limit = Number(url.searchParams.get("limit") ?? 48);
  if (!q) return { results: [] };
  const fixtureHits = searchFixture.results.filter((row: any) => matches(row, q, scope));
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
  const row = pages.find((page: any) => page.slug === slug) ?? pages[0];
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
