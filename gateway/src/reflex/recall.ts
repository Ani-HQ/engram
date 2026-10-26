import { createHash } from "node:crypto";
import { config } from "../config";
import { currentContext } from "../context";
import { failureCode } from "../diagnostics";
import { jevAllowed } from "../privacy";
import { reflexClient } from "./client";
import { prepareRecallCandidates, type RecallCandidate } from "./passages";
import { rerankPassages, type PassageRank } from "./tasks/rerank";
import type { ReflexClient } from "./types";

export const RECALL_PLAN_TTL_MS = 30_000;
export const RECALL_PLAN_CAPACITY = 128;
export const RECALL_PLAN_INFLIGHT = 16;
type Plan = { count: number; rows: PassageRank[] };
type Hit = { snippet?: string; chunk_text?: string; slug?: unknown };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Cache numeric selection plans only. Each caller supplies fresh authorized
 * sources; neither cached query text nor another actor's passages are returned. */
export function createRecallReranker(options: { client?: () => ReflexClient; now?: () => number } = {}) {
  const cache = new Map<string, { at: number; plan: Plan }>();
  const pending = new Map<string, Promise<Plan | null>>();
  const clients = new WeakMap<ReflexClient, number>();
  let clientId = 0;
  const now = options.now ?? Date.now;
  function scope(client: ReflexClient): unknown | null {
    const ctx = currentContext();
    // processingOrg supplies this request's effective hosted-access policy. The
    // client independently enforces consent, supported model and circuit state.
    if (!ctx || ctx.org.id !== ctx.token.orgId || !jevAllowed(ctx.org) || !client.available()) return null;
    if (!clients.has(client)) clients.set(client, ++clientId);
    return [ctx.org.id, ctx.org.kind, ctx.token.kind, ctx.token.name, ctx.token.email, ctx.token.role,
      ctx.token.canWrite, [...ctx.token.scopes].sort(), ctx.org.policies, config.reflex.model,
      config.reflex.endpoint, config.reflex.minConfidence, clients.get(client)];
  }
  function keyFor(identity: unknown, query: string, candidates: RecallCandidate[], hits: Hit[]) {
    return hash([identity, hash(query), candidates.map(candidate => [candidate.originalIndex, candidate.sourceHash,
      typeof hits[candidate.originalIndex]?.slug === "string" ? hash(hits[candidate.originalIndex].slug) : null])]);
  }
  return async function rerank<T extends Hit>(query: string, hits: T[], keep: number): Promise<T[]> {
    const count = Math.max(0, Math.min(5, Math.trunc(keep) || 0));
    const fallback = () => hits.slice(0, count);
    if (!count || !hits.length) return fallback();
    const client = (options.client ?? reflexClient)(), identity = scope(client);
    if (!identity) return fallback();
    const candidates = prepareRecallCandidates(query, hits), key = keyFor(identity, query, candidates, hits);
    if (!candidates.length) return fallback();
    let plan: Plan | null = null;
    const cached = cache.get(key), elapsed = cached ? now() - cached.at : -1;
    if (cached && elapsed >= 0 && elapsed < RECALL_PLAN_TTL_MS) {
      cache.delete(key); cache.set(key, cached); plan = cached.plan;
    } else {
      if (cached) cache.delete(key);
      let work = pending.get(key);
      if (!work) {
        if (pending.size >= RECALL_PLAN_INFLIGHT) return fallback();
        const signal = AbortSignal.timeout(400);
        work = (async () => {
          try {
            const ranked = await Promise.race([
              rerankPassages(client, query, candidates, signal),
              new Promise<null>(resolve => signal.addEventListener("abort", () => resolve(null), { once: true })),
            ]);
            if (!ranked || signal.aborted) return null;
            // Do not install late, revoked, or differently scoped plans.
            const current = scope(client);
            if (!current || keyFor(current, query, candidates, hits) !== key) return null;
            const valid = { count: ranked.candidates.length, rows: ranked.plan.map(row => ({ index: row.index, score: row.score, passage: row.passage })) };
            cache.set(key, { at: now(), plan: valid });
            while (cache.size > RECALL_PLAN_CAPACITY) cache.delete(cache.keys().next().value!);
            return valid;
          } catch (error) {
            console.warn("[reflex] recall rerank skipped:", failureCode(error));
            return null;
          } finally { pending.delete(key); }
        })();
        pending.set(key, work);
      }
      plan = await work;
    }
    const current = scope(client);
    if (!plan || !current || keyFor(current, query, candidates, hits) !== key) return fallback();
    const used = new Set<number>(), out: T[] = [];
    for (const row of plan.rows) {
      if (row.index < 0 || row.index >= plan.count) continue;
      const candidate = candidates[row.index], passage = candidate?.passages[row.passage];
      if (!candidate || !passage || used.has(candidate.originalIndex)) continue;
      const hit = hits[candidate.originalIndex];
      if (!hit) continue;
      used.add(candidate.originalIndex);
      out.push({ ...hit,
        ...(typeof hit.chunk_text === "string" ? { chunk_text: passage.text } : {}),
        ...(typeof hit.snippet === "string" ? { snippet: passage.text } : {}),
        recall_passage: { offset: passage.offset, length: passage.length, total: candidate.sourceLength, source_hash: candidate.sourceHash },
      });
      if (out.length >= count) return out;
    }
    // Local candidate order supplies the remaining authorized sources. Duplicate
    // text consumes one slot, while no-provider fallback preserves old behavior.
    for (const candidate of candidates) {
      if (used.has(candidate.originalIndex)) continue;
      out.push(hits[candidate.originalIndex]);
      if (out.length >= count) break;
    }
    return out;
  };
}

export const rerankRecallHits = createRecallReranker();
