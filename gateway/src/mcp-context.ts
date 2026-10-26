import { createHash } from "node:crypto";
import type { McpMemoryContext } from "./mcp-request-context";

/** These are wire-byte ceilings, including JSON escaping and MCP metadata. They
 * are not model token measurements. Internal callers may use a smaller cap. */
export const DEFAULT_CONTEXT_BYTES = 4_096;
export const MAX_CONTEXT_BYTES = 16_384;
export const MIN_CONTEXT_BYTES = 1_024;
export const MAX_REMEMBER_BYTES = 8_192;
export const MAX_TOPIC_BYTES = 512;
export interface McpCallContext extends McpMemoryContext { /** Server-derived credential digest, never parsed from client metadata. */ credentialKey?: string }
export const PAGE_READ_PROPERTIES = {
  offset: { type: "integer", minimum: 0, description: "Body offset in UTF-16 code units; use next_offset from the previous response." },
  length: { type: "integer", minimum: 1, maximum: 16_384, description: "Requested body length. The total response byte budget may return less." },
  cursor: { type: "string", description: "Opaque next_cursor from a prior read. Rejects a changed body rather than mixing versions." },
  detail: { type: "boolean", description: "Explicit detail request. Still limited by the request's context byte budget." },
} as const;

export function contextMaxBytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_CONTEXT_BYTES, Math.max(MIN_CONTEXT_BYTES, Math.floor(value))) : DEFAULT_CONTEXT_BYTES;
}
export function mcpResultBytes(result: unknown): number { return Buffer.byteLength(JSON.stringify(result), "utf8"); }
export function contextReadArguments(args: Record<string, unknown>): Record<string, unknown> {
  const { offset: _offset, length: _length, cursor: _cursor, detail: _detail, ...upstream } = args;
  return upstream;
}
export function contextError(message: string) { return { content: [{ type: "text", text: message }], isError: true }; }
export interface RecallPassageCitation { offset: number; length: number; total: number; source_hash: string }
/** Only the exact bounded extractive span is described. Never spread arbitrary
 * candidate metadata or keep a citation after shortening its excerpt. */
export function projectRecallPassage(value: unknown, excerpt: unknown): RecallPassageCitation | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof excerpt !== "string") return null;
  const row = value as Record<string, unknown>;
  const { offset, length, total, source_hash } = row;
  if (![offset, length, total].every(number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= 2_147_483_647) ||
      Number(length) > 180 || length !== excerpt.length || Number(offset) + Number(length) > Number(total) ||
      typeof source_hash !== "string" || !/^[a-f0-9]{64}$/.test(source_hash)) return null;
  return { offset: Number(offset), length: Number(length), total: Number(total), source_hash };
}
function jsonResult(payload: unknown, original: any = {}) {
  return { ...(original?.isError ? { isError: true } : {}), ...(original?._meta ? { _meta: original._meta } : {}), content: [{ type: "text", text: JSON.stringify(payload) }] };
}
function parseResult(result: any): any | undefined {
  const texts = result?.content?.filter((item: any) => item?.type === "text" && typeof item.text === "string");
  if (texts?.length !== 1 || result.content.length !== 1) return undefined;
  try { return JSON.parse(texts[0].text); } catch { return undefined; }
}
function byteText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (Buffer.byteLength(value) <= max) return value;
  let text = "", used = 0;
  for (const part of value) { const bytes = Buffer.byteLength(part); if (used + bytes + 3 > max) break; text += part; used += bytes; }
  return text + "…";
}
function byteEnds(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value;
  const marker = "\n[… older entries omitted; read the page for detail …]\n";
  const budget = max - Buffer.byteLength(marker);
  if (budget < 80) return byteText(value, max) ?? "";
  const headBudget = Math.floor(budget * 0.3), tailBudget = budget - headBudget;
  const head = byteText(value, headBudget) ?? "";
  let tail = "", used = 0;
  for (const part of Array.from(value).reverse()) { const bytes = Buffer.byteLength(part); if (used + bytes > tailBudget) break; tail = part + tail; used += bytes; }
  return head + marker + tail;
}
function int(value: unknown, fallback: number, max = 1_000_000_000): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(max, value) : fallback;
}
function safeEnd(body: string, offset: number, length: number): number {
  let end = Math.min(body.length, offset + length);
  if (end < body.length && end > offset && /[\uD800-\uDBFF]/.test(body[end - 1]) && /[\uDC00-\uDFFF]/.test(body[end])) end -= 1;
  return end;
}
function oversized(result: any, maxBytes: number, message = "Response exceeded the context budget. Refine the query or request a smaller page."): any {
  // Usage metadata is trusted numeric diagnostics, but no caller may inflate it
  // past the hard response cap. Prefer retaining it; discard it only if needed.
  const base = { ...contextError(message), ...(result?._meta ? { _meta: result._meta } : {}) };
  if (mcpResultBytes(base) <= maxBytes) return base;
  const fallback = contextError("Response exceeded context budget.");
  return mcpResultBytes(fallback) <= maxBytes ? fallback : { content: [] as any[], isError: true };
}
function fits(result: any, maxBytes: number): boolean { return mcpResultBytes(result) <= maxBytes; }

function pageResult(args: Record<string, unknown>, page: any, original: any, maxBytes: number) {
  if (!page || typeof page !== "object" || typeof page.compiled_truth !== "string") return null;
  if (args.offset !== undefined && (typeof args.offset !== "number" || !Number.isSafeInteger(args.offset) || args.offset < 0)) return contextError("offset must be a non-negative integer.");
  const body: string = page.compiled_truth;
  const prior = page._page && typeof page.body_hash === "string" && /^[a-f0-9]{64}$/.test(page.body_hash) && Number.isSafeInteger(page._page.offset) && Number.isSafeInteger(page._page.total) ? page._page : null;
  const bodyHash = prior ? page.body_hash : createHash("sha256").update(body).digest("hex");
  let offset = prior ? 0 : int(args.offset, 0);
  if (!prior && args.cursor !== undefined) {
    const match = typeof args.cursor === "string" ? /^v1\.([a-f0-9]{64})\.(\d{1,10})$/.exec(args.cursor) : null;
    if (!match || match[1] !== bodyHash) return { ...contextError("Page cursor is invalid or the body changed. Read from offset 0 for the current version."), ...(original?._meta ? { _meta: original._meta } : {}) };
    offset = Number(match[2]);
  }
  if (offset > body.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(body[offset] ?? "") && /[\uD800-\uDBFF]/.test(body[offset - 1]))) return contextError("Body offset must be within the page and on a complete Unicode character boundary.");
  const requested = int(args.length, body.length, MAX_CONTEXT_BYTES);
  if (args.length !== undefined && (!requested || requested !== args.length)) return contextError("length must be an integer between 1 and 16384.");
  const explicit = prior || args.offset !== undefined || args.length !== undefined || args.cursor !== undefined;
  if (!explicit && fits(original, maxBytes)) return original;
  // Preserve the full-page CAS hash verbatim. body_hash independently identifies
  // the entire compiled body; neither is a hash of the returned fragment.
  if (typeof page.slug === "string" && Buffer.byteLength(page.slug) > 1_024) return oversized(original, maxBytes, "Page identifier exceeds the context budget. Use a shorter page slug.");
  const metadata: Record<string, unknown> = {};
  for (const key of ["slug", "content_hash", "type", "created_at", "updated_at"]) {
    if (typeof page[key] === "string" && Buffer.byteLength(page[key]) <= 1_024) metadata[key] = page[key];
  }
  if (typeof page.title === "string") metadata.title = byteText(page.title, 240);
  metadata.body_hash = bodyHash;
  const build = (length: number) => {
    const end = safeEnd(body, offset, length), wireOffset = prior ? prior.offset : offset;
    const total = prior ? prior.total : body.length, wireEnd = wireOffset + end - offset;
    const partial = wireOffset > 0 || wireEnd < total;
    return jsonResult({ ...metadata, compiled_truth: body.slice(offset, end), _page: {
      offset: wireOffset, length: end - offset, total, unit: "utf16_code_units", partial,
      next_offset: wireEnd < total ? wireEnd : null,
      next_cursor: wireEnd < total ? `v1.${bodyHash}.${wireEnd}` : null,
      ...(partial ? { warning: "Partial body. content_hash and body_hash identify the full version; never replace a page with this fragment." } : {}),
    } }, original);
  };
  let lo = 0, hi = Math.min(requested, body.length - offset);
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(build(mid), maxBytes)) lo = mid; else hi = mid - 1; }
  const result = build(lo);
  if (!fits(result, maxBytes) || (body.length > offset && !safeEnd(body, offset, lo))) return oversized(original, maxBytes);
  if (body.length > offset && safeEnd(body, offset, lo) === offset) return oversized(original, maxBytes);
  return result;
}

/** Summaries omit large detail, resource bodies, facets and hidden diagnostics.
 * The authenticated REST/web action APIs continue returning complete records. */
export function actionSummary(action: any) {
  const row: Record<string, unknown> = {};
  for (const [key, max] of Object.entries({ id: 80, agent: 160, tool: 160, summary: 360, taskTitle: 200, status: 24, evidence: 24, occurredAt: 40, runId: 200 })) {
    const value = byteText(action?.[key], max); if (value !== undefined && value !== "") row[key] = value;
  }
  return row;
}
function actionResults(args: Record<string, unknown>, payload: any, original: any, maxBytes: number) {
  if (!Array.isArray(payload?.actions)) return null;
  const offset = int(args.offset, 0), details = args.detail === true;
  const invalid = (message: string) => {
    const error = { ...contextError(message), ...(original?._meta ? { _meta: original._meta } : {}) };
    return fits(error, maxBytes) ? error : oversized(original, maxBytes);
  };
  if (payload.actions.some((action: any) => !action || typeof action !== "object" || Array.isArray(action))) return invalid("Invalid action result. Try the action query again.");
  if (details) {
    if (args.detail_offset !== undefined && (typeof args.detail_offset !== "number" || !Number.isSafeInteger(args.detail_offset) || args.detail_offset < 0)) return invalid("detail_offset must be a non-negative integer.");
    if (args.detail_length !== undefined && (typeof args.detail_length !== "number" || !Number.isSafeInteger(args.detail_length) || args.detail_length < 1 || args.detail_length > MAX_CONTEXT_BYTES)) return invalid("detail_length must be an integer between 1 and 16384.");
    for (const action of payload.actions) {
      const detail = typeof action.detail === "string" ? action.detail : "";
      const prior = action._detail && Number.isSafeInteger(action._detail.offset) && Number.isSafeInteger(action._detail.total);
      const start = prior ? 0 : Math.min(int(args.detail_offset, 0), detail.length);
      if (start > 0 && /[\uDC00-\uDFFF]/.test(detail[start] ?? "") && /[\uD800-\uDBFF]/.test(detail[start - 1])) return invalid("detail_offset must be on a complete Unicode character boundary. Use _detail.next_offset from the previous response.");
    }
  }
  const rows = payload.actions.map((action: any) => {
    const row = actionSummary(action);
    if (details) {
      const detail = typeof action.detail === "string" ? action.detail : "";
      const prior = action._detail && Number.isSafeInteger(action._detail.offset) && Number.isSafeInteger(action._detail.total) ? action._detail : null;
      const start = prior ? 0 : Math.min(int(args.detail_offset, 0), detail.length);
      const length = int(args.detail_length, MAX_CONTEXT_BYTES, MAX_CONTEXT_BYTES);
      const end = safeEnd(detail, start, length);
      row.detail = detail.slice(start, end);
      const wireStart = prior ? prior.offset : start, total = prior ? prior.total : detail.length;
      row._detail = { offset: wireStart, length: end - start, total, next_offset: wireStart + end - start < total ? wireStart + end - start : null, unit: "utf16_code_units", partial: wireStart > 0 || wireStart + end - start < total };
      for (const key of ["outcome", "currentStep", "approach", "resource"]) if (typeof action[key] === "string") row[key] = byteText(action[key], 400);
    }
    return row;
  });
  const build = (items: any[]) => jsonResult({ actions: items, more: Boolean(payload.more) || items.length < rows.length,
    next_offset: Boolean(payload.more) || items.length < rows.length ? offset + items.length : null,
    _context: { summaries: !details, ...(items.length < rows.length ? { truncated: true } : {}) } }, original);
  const kept: any[] = [];
  for (const row of rows) {
    if (details && typeof row.detail === "string") {
      const originalDetail = row.detail;
      const meta = row._detail as any;
      let lo = 0, hi = originalDetail.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); const end = safeEnd(originalDetail, 0, mid); row.detail = originalDetail.slice(0, end); row._detail = { ...meta, length: end, next_offset: meta.offset + end < meta.total ? meta.offset + end : null, partial: meta.offset > 0 || meta.offset + end < meta.total }; if (fits(build([...kept, row]), maxBytes)) lo = mid; else hi = mid - 1; }
      const end = safeEnd(originalDetail, 0, lo); row.detail = originalDetail.slice(0, end); row._detail = { ...meta, length: end, next_offset: meta.offset + end < meta.total ? meta.offset + end : null, partial: meta.offset > 0 || meta.offset + end < meta.total };
      if (originalDetail.length && !end && !kept.length) return oversized(original, maxBytes, "Action metadata exceeds context budget. Request summaries or a larger explicit detail budget.");
    }
    if (!fits(build([...kept, row]), maxBytes)) break;
    kept.push(row);
  }
  return kept.length || !rows.length ? build(kept) : oversized(original, maxBytes);
}

function smallRow(row: any): any | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (typeof row.slug === "string" && Buffer.byteLength(row.slug) > 1_024) return null;
  const out: Record<string, unknown> = {};
  const excerpt = typeof row.chunk_text === "string" ? row.chunk_text : row.snippet;
  const passage = projectRecallPassage(row.recall_passage, excerpt);
  for (const [key, max] of Object.entries({ slug: 1_024, id: 80, title: 240, type: 80, snippet: 400, chunk_text: 400, origin: 120, agent: 160, updated_at: 40, created_at: 40 })) {
    const value = passage && (key === "snippet" || key === "chunk_text") && row[key] === excerpt ? excerpt : byteText(row[key], max);
    if (value !== undefined) out[key] = value;
  }
  if (passage) out.recall_passage = passage;
  if (typeof row.score === "number" && Number.isFinite(row.score)) out.score = row.score;
  return out;
}

/** A pure final wire boundary. It never truncates serialized JSON, never mutates
 * its input, and keeps caller/upstream metadata inside the measured ceiling. */
export function boundMcpResult(name: string, args: Record<string, unknown> = {}, result: any, requestedMax = DEFAULT_CONTEXT_BYTES): any {
  const maxBytes = Math.max(128, Math.min(MAX_CONTEXT_BYTES, Math.floor(requestedMax) || DEFAULT_CONTEXT_BYTES));
  const payload = parseResult(result);
  if (!result?.isError && name === "get_page") { const page = pageResult(args, payload, result, maxBytes); if (page) return fits(page, maxBytes) ? page : oversized(result, maxBytes); }
  if (!result?.isError && name === "record_action" && payload?.action) {
    const receipt = jsonResult({ ok: true, id: payload.action.id, status: payload.action.status, evidence: payload.action.evidence }, result);
    return fits(receipt, maxBytes) ? receipt : oversized(result, maxBytes);
  }
  if (!result?.isError && name === "list_actions") { const listing = actionResults(args, payload, result, maxBytes); if (listing) return listing; }
  if (!result?.isError && ["put_page", "add_tag", "add_link", "add_timeline_entry"].includes(name)) {
    const receipt = jsonResult({ ok: true, ...(typeof payload?.slug === "string" && Buffer.byteLength(payload.slug) <= 1_024 ? { slug: payload.slug } : {}), ...(typeof payload?.content_hash === "string" && /^[a-f0-9]{64}$/.test(payload.content_hash) ? { content_hash: payload.content_hash } : {}) }, result);
    return fits(receipt, maxBytes) ? receipt : oversized(result, maxBytes);
  }
  if (fits(result, maxBytes)) return result;
  if (name === "recall" && payload && Array.isArray(payload.results)) {
    const rows = payload.results.map(smallRow).filter(Boolean), kept: any[] = [];
    const build = (rows: any[], full: any) => jsonResult({ results: rows, full, _context: { truncated: true, warning: "Results shortened to the context budget. Read individual pages for detail." } }, result);
    for (const row of rows) { if (!fits(build([...kept, row], null), maxBytes)) break; kept.push(row); }
    let full = null;
    if (payload.full && typeof payload.full.body === "string" && typeof payload.full.slug === "string" && Buffer.byteLength(payload.full.slug) <= 1_024) {
      let lo = 0, hi = payload.full.body.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(build(kept, { slug: payload.full.slug, body: byteEnds(payload.full.body, mid), partial: true }), maxBytes)) lo = mid; else hi = mid - 1; }
      if (lo > 64) full = { slug: payload.full.slug, body: byteEnds(payload.full.body, lo), partial: true };
    }
    const out = build(kept, full); return fits(out, maxBytes) ? out : oversized(result, maxBytes);
  }
  const rows = Array.isArray(payload) ? payload : ["pages", "results", "items", "matches", "data"].map(key => payload?.[key]).find(Array.isArray);
  if (rows) {
    const kept: any[] = [], offset = int(args.offset, 0);
    const build = (rows: any[]) => jsonResult({ results: rows, next_offset: offset + rows.length, _context: { truncated: true, warning: "Result summaries shortened to the context budget. Refine the query for omitted records." } }, result);
    for (const row of rows) { const summary = smallRow(row); if (!summary) break; if (!fits(build([...kept, summary]), maxBytes)) break; kept.push(summary); }
    return kept.length ? build(kept) : oversized(result, maxBytes);
  }
  return oversized(result, maxBytes);
}
