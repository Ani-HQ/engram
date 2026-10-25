// Approved snapshots are a separate read model. Never resolve their slugs through
// the source brain: the source may change, and recipients have no source access.
export interface ApprovedContextItem {
  id: string;
  shareId: string;
  title: string;
  text: string;
}

export interface SharedContextPage {
  slug: string;
  title: string;
  type: "shared-context";
  compiled_truth: string;
}

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const SHARED_SLUG = new RegExp(`^shared-context/${UUID}/${UUID}$`);
export const SHARED_CONTEXT_PREFIX = "shared-context/";

export function isSharedContextSlug(value: unknown): value is string {
  return typeof value === "string" && (value === "shared-context" || value.startsWith(SHARED_CONTEXT_PREFIX));
}

export function contextSnapshotPages(items: readonly ApprovedContextItem[]): SharedContextPage[] {
  return items.flatMap(item => {
    const slug = `${SHARED_CONTEXT_PREFIX}${item.shareId}/${item.id}`;
    if (!SHARED_SLUG.test(slug) || typeof item.title !== "string" || typeof item.text !== "string") return [];
    // Explicit projection: do not spread source rows or carry source metadata.
    return [{ slug, title: item.title, type: "shared-context" as const, compiled_truth: item.text }];
  });
}

export function sharedPageSummary(page: SharedContextPage) {
  return { slug: page.slug, title: page.title, type: page.type };
}

export function readRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const key of ["pages", "results", "items", "matches", "data"]) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

export function contextReadLimit(value: unknown, fallback = 25, max = 25): number {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? Math.min(max, Math.trunc(limit)) || 1 : fallback;
}

export function contextReadOffset(value: unknown): number {
  const offset = Number(value);
  return Number.isFinite(offset) && offset > 0 ? Math.min(1_000_000, Math.trunc(offset)) : 0;
}

function snippet(text: string, query: string, max = 280): string {
  if (text.length <= max) return text;
  const first = query.toLocaleLowerCase().split(/\s+/).find(Boolean) ?? "";
  const index = text.toLocaleLowerCase().indexOf(first);
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, start + max - (start ? 1 : 0));
  const after = end < text.length;
  return `${start ? "…" : ""}${text.slice(start, end - (after ? 1 : 0))}${after ? "…" : ""}`;
}

export function searchContextSnapshots(pages: readonly SharedContextPage[], query: string) {
  const terms = [...new Set(query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean))];
  if (!terms.length) return [];
  return pages.flatMap(page => {
    const title = page.title.toLocaleLowerCase(), body = page.compiled_truth.toLocaleLowerCase();
    if (!terms.every(term => title.includes(term) || body.includes(term))) return [];
    return [{ slug: page.slug, title: page.title, chunk_text: snippet(page.compiled_truth, query),
      score: terms.reduce((score, term) => score + (title.includes(term) ? 2 : 1), 0) }];
  }).sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

export function sortContextPages<T extends { slug?: unknown; updated_at?: unknown; created_at?: unknown }>(pages: T[], sort: unknown): T[] {
  return [...pages].sort((a, b) => {
    if (sort === "slug") return String(a.slug ?? "").localeCompare(String(b.slug ?? ""));
    const key = sort === "created_desc" ? "created_at" : "updated_at";
    const time = (page: T) => Date.parse(String(page[key] ?? "")) || 0;
    const delta = time(a) - time(b);
    return (sort === "updated_asc" ? delta : -delta) || String(a.slug ?? "").localeCompare(String(b.slug ?? ""));
  });
}

// `pages` is already authorization-filtered for this single request. This pure
// reader has no database, workspace credential, brain client or fallback path.
export function callSharedContextTool(pages: readonly SharedContextPage[], name: string, args: Record<string, unknown> = {}): any {
  const success = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const error = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  if (name === "whoami") return success({ access: "approved-context", readOnly: true });
  if (name === "get_page") {
    const page = pages.find(page => page.slug === args.slug);
    return page ? success(page) : error("Page not found in approved context.");
  }
  if (name === "list_pages") {
    const offset = contextReadOffset(args.offset), limit = contextReadLimit(args.limit);
    const rows = args.tag ? [] : sortContextPages(pages.map(sharedPageSummary), args.sort);
    return success(rows.slice(offset, offset + limit));
  }
  if (name === "search" || name === "recall") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > 2000) return error("A query between 1 and 2000 characters is required.");
    const hits = searchContextSnapshots(pages, query);
    if (name === "search") return success(hits.slice(0, contextReadLimit(args.limit)));
    const results = hits.slice(0, 5).map(hit => ({ slug: hit.slug, title: hit.title, snippet: hit.chunk_text }));
    const best = pages.find(page => page.slug === hits[0]?.slug);
    const full = args.full === true && best ? { slug: best.slug, body: best.compiled_truth.slice(0, 4000) } : null;
    return success({ results, full });
  }
  return error("This connection only reads approved shared context.");
}

export async function approvedTeamContextPages(): Promise<SharedContextPage[]> {
  const { requireContext } = await import("./context");
  const { org } = requireContext();
  if (org.kind !== "team" || !org.policies.acceptShares) return [];
  const { listApprovedTeamItems } = await import("./context-sharing-access");
  return contextSnapshotPages(await listApprovedTeamItems(org.id));
}
