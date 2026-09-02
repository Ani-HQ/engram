import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { audit } from "./audit";
import { authenticate, type TokenRecord } from "./auth";
import { brainClient } from "./brain";
import { callTool } from "./proxy";

export const SESSION_COOKIE_NAME = "engram_session";
export const SESSION_COOKIE_MAX_AGE = 1_209_600;

const PAGE_SORTS = new Set(["updated_desc", "updated_asc", "created_desc", "slug"]);
const HARD_EXCLUDED_SLUG_PREFIXES = ["test/", "attachments/", ".raw/"];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

export class ToolTextError extends Error {
  text: string;

  constructor(text: string) {
    super(text);
    this.text = text;
  }
}

export interface PagesQuery {
  limit: number;
  offset: number;
  sort: string;
  tag: string | null;
}

export interface SearchQuery {
  q: string;
  limit: number;
}

export function serializeSessionCookie(token: string, maxAge = SESSION_COOKIE_MAX_AGE): string {
  const parts = [`${SESSION_COOKIE_NAME}=${token}`, "HttpOnly"];
  if (process.env.ENGRAM_INSECURE_COOKIE !== "1") parts.push("Secure");
  parts.push("SameSite=Strict", "Path=/", `Max-Age=${maxAge}`);
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return serializeSessionCookie("", 0);
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE_NAME) return trimmed.slice(eq + 1);
  }
  return null;
}

export function hasConsoleHeader(headers: { get(name: string): string | null }): boolean {
  return headers.get("x-engram-console") === "1";
}

export function needsConsoleHeader(_method: string, pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function parseToolText(result: any): any {
  const raw = firstTextBlock(result) ?? "";
  if (result?.isError) throw new ToolTextError(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

export function coerceBoundedInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function coerceOffset(value: string | null): number {
  if (!value?.trim()) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function coercePagesQuery(params: URLSearchParams): PagesQuery | null {
  const sort = textParam(params, "sort") ?? "updated_desc";
  if (!PAGE_SORTS.has(sort)) return null;
  return {
    limit: coerceBoundedInt(params.get("limit"), 50, 1, 100),
    offset: coerceOffset(params.get("offset")),
    sort,
    tag: textParam(params, "tag"),
  };
}

export function coerceSearchQuery(params: URLSearchParams): SearchQuery | null {
  const q = textParam(params, "q");
  if (!q) return null;
  return {
    q,
    limit: coerceBoundedInt(params.get("limit"), 20, 1, 50),
  };
}

export function generateCaptureSlug(title: string | null, text: string, date: Date | string = new Date()): string {
  const day = typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
  const textStem = kebab(text.trim().split(/\s+/).slice(0, 6).join(" "));
  const stem = (title?.trim() ? kebab(title) : "") || textStem || "capture";
  const prefix = `notes/${day}-`;
  return prefix + trimSlugStem(stem, 60 - prefix.length);
}

export function captureMarkdown(title: string, text: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${text}`;
}

export function defaultWebDir(): string {
  return resolve(resolve(import.meta.dir, "../.."), process.env.ENGRAM_WEB_DIR ?? "web");
}

export function resolveStaticPath(pathname: string, webDir = defaultWebDir()): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\0")) return null;

  const root = resolve(webDir);
  const relativePath = decoded === "/" ? "index.html" : decoded.slice(1);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

export function contentTypeFor(pathname: string): string {
  return CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

export function forbiddenResponse(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

export async function handleWeb(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return handleApi(req, url);
  }
  // Static files and the SPA shell answer GET/HEAD only. Without this, any method
  // on any unknown path returned the console HTML with a 200 — so a client still
  // POSTing to the deleted /t/<token>/mcp route got HTML and a success code
  // instead of a clear failure.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return serveStatic(url.pathname);
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  // The custom header is the CSRF boundary; browsers cannot send it cross-origin
  // without a preflight, and this gateway never emits CORS headers.
  if (needsConsoleHeader(req.method, url.pathname) && !hasConsoleHeader(req.headers)) {
    return forbiddenResponse();
  }

  if (req.method === "POST" && url.pathname === "/api/session") return postSession(req);
  if (req.method === "DELETE" && url.pathname === "/api/session") return deleteSession();

  let route: ((req: Request, url: URL, token: TokenRecord) => Response | Promise<Response>) | null = null;
  if (req.method === "GET" && url.pathname === "/api/me") route = getMe;
  else if (req.method === "GET" && url.pathname === "/api/pages") route = getPages;
  else if (req.method === "GET" && url.pathname === "/api/search") route = getSearch;
  else if (req.method === "GET" && url.pathname === "/api/page") route = getPage;
  else if (req.method === "DELETE" && url.pathname === "/api/page") route = deletePage;
  else if (req.method === "POST" && url.pathname === "/api/page/restore") route = postRestorePage;
  else if (req.method === "POST" && url.pathname === "/api/capture") route = postCapture;
  if (!route) return Response.json({ error: "not found" }, { status: 404 });

  const token = await authenticateCookie(req);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  return route(req, url, token);
}

async function postSession(req: Request): Promise<Response> {
  const body = await jsonObject(req);
  const rawToken = typeof body?.token === "string" && body.token.trim() ? body.token : null;
  if (!rawToken) return Response.json({ error: "bad request" }, { status: 400 });

  const token = await authenticate(`Bearer ${rawToken}`);
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(publicToken(token), {
    headers: { "Set-Cookie": serializeSessionCookie(rawToken) },
  });
}

function deleteSession(): Response {
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

function getMe(_req: Request, _url: URL, token: TokenRecord): Response {
  return Response.json(publicToken(token));
}

async function getPages(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const query = coercePagesQuery(url.searchParams);
  if (!query) return Response.json({ error: "bad request" }, { status: 400 });

  const args: Record<string, unknown> = {
    limit: query.limit + query.offset,
    offset: 0,
    sort: query.sort,
  };
  if (query.tag) args.tag = query.tag;

  const data = await readTool(token, "list_pages", args);
  const pages = normalizePageSummaries(data);
  return Response.json({
    pages: sortPageSummaries(pages, query.sort).slice(query.offset, query.offset + query.limit),
    scopes: ["shared"],
  });
}

async function getSearch(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const query = coerceSearchQuery(url.searchParams);
  if (!query) return Response.json({ error: "bad request" }, { status: 400 });

  const data = await readTool(token, "search", {
    query: query.q,
    limit: query.limit,
  });
  const results = normalizeSearchResults(data);
  return Response.json({ results: results.slice(0, query.limit) });
}

async function getPage(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const slug = textParam(url.searchParams, "slug");
  if (!slug) return Response.json({ error: "bad request" }, { status: 400 });

  const data = await readTool(token, "get_page", { slug });
  const normalized = normalizePageResult(data, slug);
  if (normalized) return Response.json(normalized);
  return Response.json({ error: "not found" }, { status: 404 });
}

async function deletePage(_req: Request, url: URL, token: TokenRecord): Promise<Response> {
  const slug = textParam(url.searchParams, "slug");
  if (!slug) {
    await auditConsole(token, "delete_page", {}, "bad_request");
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const args = { slug };
  try {
    const data = await brainTool("delete_page", args);
    const status = textField(data, "status");
    if (status === "soft_deleted" || status === "already_soft_deleted") {
      await auditConsole(token, "delete_page", args, "ok");
      return Response.json({
        ok: true,
        slug: textField(data, "slug") ?? slug,
        recoverable: true,
      });
    }

    await auditConsole(token, "delete_page", args, "error");
    return Response.json({ error: "bad request" }, { status: 400 });
  } catch (e) {
    const notFound = isPageNotFoundError(e);
    await auditConsole(token, "delete_page", args, notFound ? "not_found" : "error");
    if (notFound) return Response.json({ error: "not found" }, { status: 404 });
    console.error("[web] delete_page failed:", String(e).slice(0, 200));
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

async function postRestorePage(req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  const body = await jsonObject(req);
  const slug = optionalText(body?.slug);
  if (!slug) {
    await auditConsole(token, "restore_page", {}, "bad_request");
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const args = { slug };
  try {
    await brainTool("restore_page", args);
    await auditConsole(token, "restore_page", args, "ok");
    return Response.json({ ok: true, slug });
  } catch (e) {
    const notFound = isPageNotFoundError(e);
    await auditConsole(token, "restore_page", args, notFound ? "not_found" : "error");
    if (notFound) return Response.json({ error: "not found" }, { status: 404 });
    console.error("[web] restore_page failed:", String(e).slice(0, 200));
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

async function postCapture(req: Request, _url: URL, token: TokenRecord): Promise<Response> {
  const body = await jsonObject(req);
  const text = typeof body?.text === "string" ? body.text : null;
  if (!text?.trim()) return Response.json({ error: "bad request" }, { status: 400 });

  const title = captureTitle(optionalText(body?.title), text);
  const requestedSlug = optionalText(body?.slug);
  const slug = requestedSlug ?? await availableCaptureSlug(
    token,
    generateCaptureSlug(title, text),
  );
  const reason = rejectedSlugReason(slug);
  if (reason) return Response.json({ error: "bad request", message: reason }, { status: 400 });

  const args: Record<string, unknown> = { slug, content: captureMarkdown(title, text) };

  try {
    parseToolText(await callTool(token, "put_page", args));
    return Response.json({ ok: true, slug });
  } catch (e) {
    if (String(e).toLowerCase().includes("denied")) return forbiddenResponse();
    console.error("[web] capture failed:", String(e).slice(0, 200));
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const webDir = defaultWebDir();
  const staticPath = resolveStaticPath(pathname, webDir);
  if (!staticPath) return new Response("Not Found", { status: 404 });
  if (await isFile(staticPath)) return fileResponse(staticPath);

  // Unknown client-side routes fall back to the SPA shell without exposing cwd.
  const indexPath = resolveStaticPath("/", webDir);
  if (indexPath && await isFile(indexPath)) return fileResponse(indexPath);
  return new Response("Not Found", { status: 404 });
}

function fileResponse(pathname: string): Response {
  return new Response(Bun.file(pathname), {
    headers: { "Content-Type": contentTypeFor(pathname) },
  });
}

async function authenticateCookie(req: Request): Promise<TokenRecord | null> {
  const rawToken = parseSessionCookie(req.headers.get("cookie"));
  return rawToken ? authenticate(`Bearer ${rawToken}`) : null;
}

function publicToken(token: TokenRecord) {
  return { name: token.name };
}

async function jsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function isFile(pathname: string): Promise<boolean> {
  try {
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

async function readTool(
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  try {
    return parseToolText(await callTool(token, name, args));
  } catch (e) {
    console.error(`[web] ${name} failed:`, String(e).slice(0, 200));
    return null;
  }
}

async function brainTool(name: string, args: Record<string, unknown>): Promise<any> {
  return parseToolText(await brainClient().callTool({ name, arguments: args }));
}

async function auditConsole(
  token: TokenRecord,
  tool: string,
  args: Record<string, unknown>,
  outcome: string,
): Promise<void> {
  await audit(token.name, tool, summarizeArgs(args), outcome);
}

function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {}).slice(0, 200);
}

export function normalizePageSummaries(data: any) {
  return arrayFrom(data, ["pages", "results", "items", "data"]).map(row => ({
    slug: textField(row, "slug") ?? "",
    title: textField(row, "title") ?? textField(row, "slug") ?? "",
    type: textField(row, "type") ?? "note",
    source_id: textField(row, "source_id") ?? textField(row, "sourceId") ?? "default",
    updated_at: timestampField(row, "updated_at") ?? timestampField(row, "updatedAt") ?? "",
    created_at: timestampField(row, "created_at") ?? timestampField(row, "createdAt") ?? "",
  })).filter(page => page.slug);
}

export function normalizeSearchResults(data: any) {
  return arrayFrom(data, ["results", "pages", "items", "matches", "data"]).map(row => ({
    slug: textField(row, "slug") ?? "",
    title: textField(row, "title") ?? textField(row, "slug") ?? "",
    updated_at:
      timestampField(row, "updated_at") ??
      timestampField(row, "updatedAt") ??
      timestampField(row, "effective_date") ??
      timestampField(row, "effectiveDate") ??
      "",
    snippet: textField(row, "chunk_text") ?? textField(row, "snippet") ?? textField(row, "excerpt") ?? "",
  })).filter(result => result.slug);
}

export function normalizePageResult(data: any, slug: string) {
  if (typeof data?.error === "string" && data.error.toLowerCase().includes("not found")) return null;

  const source = data?.page && typeof data.page === "object" ? data.page : data;
  const body =
    textField(source, "body") ??
    textField(source, "content") ??
    textField(source, "compiled_truth") ??
    textField(data, "text") ??
    "";
  if (!body && !textField(source, "slug")) return null;

  return {
    page: {
      slug: textField(source, "slug") ?? slug,
      title: textField(source, "title") ?? slug,
      type: textField(source, "type") ?? "note",
      updated_at: timestampField(source, "updated_at") ?? timestampField(source, "updatedAt") ?? "",
      body,
    },
    links: deriveBodyLinks(body),
    timeline: normalizeTimeline(data?.timeline ?? source?.timeline),
  };
}

export function rejectedSlugReason(slug: string | null): string | null {
  if (!slug) return null;
  const prefix = HARD_EXCLUDED_SLUG_PREFIXES.find(p => slug.startsWith(p));
  return prefix ? `slug prefix '${prefix}' is hard-excluded from search` : null;
}

export function sortPageSummaries(pages: any[], sort: string): any[] {
  return [...pages].sort((a, b) => {
    if (sort === "slug") return a.slug.localeCompare(b.slug);
    const key = sort === "created_desc" ? "created_at" : "updated_at";
    const aDate = sort === "created_desc" ? a[key] || a.updated_at : a[key];
    const bDate = sort === "created_desc" ? b[key] || b.updated_at : b[key];
    const diff = timeValue(aDate) - timeValue(bDate);
    return sort === "updated_asc" ? diff : -diff;
  }).map(({ created_at: _createdAt, ...page }) => page);
}

export function deriveBodyLinks(body: string) {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const add = (target: string) => {
    const slug = cleanInternalTarget(target);
    if (!slug || seen.has(slug) || slugs.length >= 12) return;
    seen.add(slug);
    slugs.push(slug);
  };

  for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    add(match[1].split("|")[0]);
  }
  for (const match of body.matchAll(/\[[^\]]*]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    add(match[1]);
  }

  return slugs.map(slug => ({
    slug,
    title: titleFromSlug(slug),
    relation: "body",
  }));
}

export function normalizeTimeline(value: any) {
  if (typeof value === "string") {
    return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(parseTimelineLine);
  }
  return Array.isArray(value) ? value.map(item => ({
    at: timestampField(item, "at") ?? timestampField(item, "created_at") ?? "",
    text: textField(item, "text") ?? textField(item, "body") ?? "",
  })).filter(item => item.text) : [];
}

function textParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstTextBlock(result: any): string | null {
  if (Array.isArray(result?.content)) {
    const block = result.content.find((c: any) => c?.type === "text" && typeof c.text === "string");
    return block?.text ?? null;
  }
  return typeof result?.content === "string" ? result.content : null;
}

function isPageNotFoundError(error: unknown): boolean {
  const text = error instanceof ToolTextError ? error.text : String(error);
  return text.toLowerCase().includes("page_not_found");
}

function arrayFrom(data: any, keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function textField(value: any, key: string): string | null {
  const text = value?.[key];
  return typeof text === "string" ? text : null;
}

function timestampField(value: any, key: string): string | null {
  const text = textField(value, key);
  return text ? text : null;
}

function captureTitle(title: string | null, text: string): string {
  return title ?? text.trim().split(/\s+/).slice(0, 6).join(" ");
}

async function availableCaptureSlug(token: TokenRecord, baseSlug: string): Promise<string> {
  if (!await pageExists(token, baseSlug)) return baseSlug;

  for (let i = 0; i < 8; i += 1) {
    const candidate = suffixedSlug(baseSlug, randomSuffix());
    if (!await pageExists(token, candidate)) return candidate;
  }
  return suffixedSlug(baseSlug, randomSuffix());
}

async function pageExists(token: TokenRecord, slug: string): Promise<boolean> {
  try {
    const data = parseToolText(await callTool(token, "get_page", { slug }));
    return normalizePageResult(data, slug) !== null;
  } catch {
    return false;
  }
}

function kebab(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function trimSlugStem(stem: string, maxLength: number): string {
  return stem.slice(0, maxLength).replace(/-+$/g, "") || "capture";
}

function suffixedSlug(baseSlug: string, suffix: string): string {
  return `${trimSlugStem(baseSlug, 60 - suffix.length - 1)}-${suffix}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6) || "x";
}

function cleanInternalTarget(target: string): string | null {
  const withoutAlias = target.trim().replace(/^<|>$/g, "").split("#")[0].split("?")[0];
  if (!withoutAlias || withoutAlias.startsWith("#") || withoutAlias.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutAlias)) return null;
  return withoutAlias.includes("/") ? withoutAlias.replace(/^\/+/, "") : null;
}

function titleFromSlug(slug: string): string {
  const last = slug.split("/").filter(Boolean).pop() ?? slug;
  return last.replace(/[-_]+/g, " ");
}

function parseTimelineLine(line: string) {
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?)(?:\s*(?:-|\u2014|:)\s*|\s+)?(.*)$/,
  );
  return match ? { at: match[1], text: match[2] } : { at: "", text: line };
}

function timeValue(value: unknown): number {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isNaN(parsed) ? 0 : parsed;
}
