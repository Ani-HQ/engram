import { reflexClient } from "./client";
import { rerankHits } from "./tasks/rerank";

export async function rerankRecallHits<T extends { snippet?: string; chunk_text?: string }>(
  query: string,
  hits: T[],
  keep: number,
): Promise<T[]> {
  if (hits.length <= keep) return hits;
  try {
    const snippets = hits.map(hit => (
      typeof hit.snippet === "string" ? hit.snippet
        : typeof hit.chunk_text === "string" ? hit.chunk_text
          : ""
    ));
    const ranked = await rerankHits(reflexClient(), query, snippets);
    if (!ranked) return hits.slice(0, keep);
    const used = new Set<number>();
    const out: T[] = [];
    for (const row of ranked) {
      if (used.has(row.index) || !hits[row.index]) continue;
      used.add(row.index);
      out.push(hits[row.index]);
      if (out.length >= keep) return out;
    }
    for (const [index, hit] of hits.entries()) {
      if (used.has(index)) continue;
      out.push(hit);
      if (out.length >= keep) break;
    }
    return out;
  } catch (e) {
    console.warn("[reflex] recall rerank skipped:", String(e).slice(0, 160));
    return hits.slice(0, keep);
  }
}
