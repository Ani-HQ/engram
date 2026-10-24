import { failureCode } from "../diagnostics";
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
    const signal = AbortSignal.timeout(400);
    // The caller's latency is bounded even if a preflight database read stalls.
    // The client retains its in-flight slot until that work actually settles,
    // and checks the aborted signal before any eventual provider transmission.
    const ranked = await Promise.race([
      rerankHits(reflexClient(), query, snippets.slice(0, 24), { signal, maxAttempts: 1 }),
      new Promise<null>(resolve => signal.addEventListener("abort", () => resolve(null), { once: true })),
    ]);
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
    console.warn("[reflex] recall rerank skipped:", failureCode(e));
    return hits.slice(0, keep);
  }
}
