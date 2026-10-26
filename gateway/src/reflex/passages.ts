import { createHash } from "node:crypto";

export const RECALL_CANDIDATE_CAP = 20;
export const RERANK_CANDIDATE_CAP = 16;
export const RECALL_SCAN_CHARS = 65_536;
export const RECALL_PASSAGE_CHARS = 180;
export interface RecallPassage { offset: number; length: number; text: string }
export interface RecallCandidate { originalIndex: number; sourceHash: string; sourceLength: number; passages: RecallPassage[] }

export function sourceText(hit: { snippet?: string; chunk_text?: string }): string {
  return typeof hit.chunk_text === "string" ? hit.chunk_text : typeof hit.snippet === "string" ? hit.snippet : "";
}
export function sourceHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function boundary(text: string, offset: number, direction: -1 | 1): number {
  if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])) return offset + direction;
  return offset;
}

/** Only existing source spans can be selected. Query-centred windows allow a
 * later decision to compete with boilerplate without sending an entire page. */
export function recallPassages(query: string, text: string): RecallPassage[] {
  if (!text) return [{ offset: 0, length: 0, text: "" }];
  const terms = [...new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,50}/gu) ?? []).slice(0, 12))];
  const scans = text.length <= RECALL_SCAN_CHARS ? [{ offset: 0, text }] : [
    { offset: 0, text: text.slice(0, RECALL_SCAN_CHARS / 2) },
    { offset: text.length - RECALL_SCAN_CHARS / 2, text: text.slice(-RECALL_SCAN_CHARS / 2) },
  ];
  const starts = new Set([0, Math.max(0, text.length - RECALL_PASSAGE_CHARS)]);
  for (const scan of scans) {
    const lower = scan.text.toLocaleLowerCase();
    for (const term of terms) {
      let offset = lower.indexOf(term), count = 0;
      while (offset >= 0 && count++ < 8) {
        starts.add(Math.max(0, Math.min(text.length - RECALL_PASSAGE_CHARS, scan.offset + offset - 45)));
        offset = lower.indexOf(term, offset + term.length);
      }
    }
  }
  const windows = [...starts].map(raw => {
    const offset = boundary(text, raw, -1), end = boundary(text, Math.min(text.length, offset + RECALL_PASSAGE_CHARS), -1);
    const value = text.slice(offset, end), lower = value.toLocaleLowerCase();
    return { offset, length: end - offset, text: value, score: terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score || b.offset - a.offset);
  const selected: RecallPassage[] = [];
  const add = ({ score: _score, ...window }: typeof windows[number]) => {
    // Almost-identical overlapping windows waste provider input and citations.
    if (selected.some(prior => prior.text === window.text || Math.abs(prior.offset - window.offset) < RECALL_PASSAGE_CHARS * 0.6)) return;
    selected.push(window);
  };
  // Keep distinct source context as well as the strongest match. Repeated boilerplate
  // must not occupy all three choices merely because it repeats query words.
  if (windows[0]) add(windows[0]);
  const head = windows.find(window => window.offset === 0);
  if (head) add(head);
  const tail = windows.reduce((last, window) => window.offset > last.offset ? window : last, windows[0]);
  if (tail && selected.length < 3) add(tail);
  for (const window of windows) {
    if (selected.length === 3) break;
    add(window);
  }
  return selected.sort((a, b) => a.offset - b.offset);
}

export function prepareRecallCandidates(query: string, hits: Array<{ snippet?: string; chunk_text?: string }>): RecallCandidate[] {
  const seen = new Set<string>(), candidates: RecallCandidate[] = [];
  for (const [originalIndex, hit] of hits.slice(0, RECALL_CANDIDATE_CAP).entries()) {
    const text = sourceText(hit), hash = sourceHash(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    candidates.push({ originalIndex, sourceHash: hash, sourceLength: text.length, passages: recallPassages(query, text) });
  }
  return candidates;
}
