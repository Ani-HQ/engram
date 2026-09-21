import { brainClient } from "../brain";
import { backfillPageEntries, type MemoryEntry } from "../memory-entries";

function parseToolJson(result: any): any {
  if (result?.isError) return null;
  const text = (result?.content ?? []).find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listBrainPages(limit = 25, offset = 0): Promise<Array<{ slug: string; title: string }>> {
  const data = parseToolJson(await brainClient().callTool({
    name: "list_pages",
    arguments: { limit, offset, sort: "updated_desc" },
  }));
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.pages) ? data.pages
      : [];
  return rows
    .map((row: any) => ({
      slug: typeof row?.slug === "string" ? row.slug : "",
      title: typeof row?.title === "string" ? row.title : "",
    }))
    .filter((row: { slug: string }) => row.slug);
}

export async function readPageBody(slug: string): Promise<string> {
  try {
    const page = parseToolJson(await brainClient().callTool({
      name: "get_page",
      arguments: { slug },
    }));
    return typeof page?.compiled_truth === "string" ? page.compiled_truth : "";
  } catch {
    return "";
  }
}

export async function backfillChangedPages(cursor: { offset?: number } | null, budget = 20): Promise<{
  entries: MemoryEntry[];
  nextOffset: number;
  done: boolean;
}> {
  const offset = cursor?.offset ?? 0;
  const pages = await listBrainPages(budget, offset);
  const entries: MemoryEntry[] = [];
  for (const page of pages) {
    const body = await readPageBody(page.slug);
    if (!body) continue;
    entries.push(...await backfillPageEntries({ slug: page.slug, body }));
  }
  return {
    entries,
    nextOffset: offset + pages.length,
    done: pages.length < budget,
  };
}

export async function neighborSlugs(text: string, slug: string, limit = 6): Promise<Array<{ slug: string; text: string }>> {
  const hits = parseToolJson(await brainClient().callTool({
    name: "search",
    arguments: { query: text.slice(0, 160), limit: limit + 2 },
  }));
  const out: Array<{ slug: string; text: string }> = [];
  const seen = new Set<string>([slug]);
  for (const hit of Array.isArray(hits) ? hits : []) {
    const other = typeof hit?.slug === "string" ? hit.slug : "";
    const snippet = typeof hit?.chunk_text === "string" ? hit.chunk_text : "";
    if (!other || seen.has(other) || !snippet) continue;
    seen.add(other);
    out.push({ slug: other, text: snippet });
    if (out.length >= limit) break;
  }
  return out;
}
