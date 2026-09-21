import { brainClient } from "../brain";
import { config } from "../config";
import {
  recordReflexDecision,
  type MemoryEntry,
} from "../memory-entries";
import { enqueueReviewItem } from "../review/store";
import { reflexClient } from "./client";
import { classifyMemory } from "./tasks/classify";
import { judgePair, type MemoryRelation } from "./tasks/pairwise";
import { routeTopic, type TopicCandidate } from "./tasks/topic-route";

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

export async function suggestTopic(text: string): Promise<string | null> {
  try {
    const hits = parseToolJson(await brainClient().callTool({
      name: "search",
      arguments: { query: text.slice(0, 160), limit: 12 },
    }));
    const candidates: TopicCandidate[] = [];
    const seen = new Set<string>();
    for (const hit of Array.isArray(hits) ? hits : []) {
      const slug = typeof hit?.slug === "string" ? hit.slug.replace(/-archive$/, "") : "";
      if (!slug || seen.has(slug) || slug.startsWith("notes/") || slug.startsWith("meta/")) continue;
      seen.add(slug);
      candidates.push({
        slug,
        title: typeof hit?.title === "string" && hit.title.trim() ? hit.title : slug,
      });
      if (candidates.length >= 8) break;
    }
    const routed = await routeTopic(reflexClient(), text, candidates);
    return routed.topic;
  } catch (e) {
    console.warn("[reflex] topic route skipped:", String(e).slice(0, 160));
    return null;
  }
}

export async function afterRemember(input: {
  entry: MemoryEntry | null;
  text: string;
  slug: string;
  topic?: string;
}): Promise<void> {
  if (!input.entry) return;
  try {
    const classification = await classifyMemory(reflexClient(), input.text);
    if (classification) {
      await recordReflexDecision({
        entryId: input.entry.id,
        sheet: "classify",
        payload: classification as unknown as Record<string, unknown>,
        modelRef: classification.model,
        confidence: classification.importance,
      });
    }

    const neighbors = await neighborHits(input.text, input.slug);
    for (const neighbor of neighbors) {
      const judged = await judgePair(reflexClient(), input.text, neighbor.text);
      if (!judged.relation) {
        await enqueueReviewItem({
          entryId: input.entry.id,
          kind: "uncertain_relation",
          fingerprint: `pair:${input.entry.id}:${neighbor.slug}:${hashish(neighbor.text)}`,
          confidence: judged.confidence,
          payload: { otherSlug: neighbor.slug, otherText: neighbor.text, relation: null },
        });
        continue;
      }
      await recordReflexDecision({
        entryId: input.entry.id,
        sheet: "pairwise",
        payload: { otherSlug: neighbor.slug, otherText: neighbor.text, relation: judged.relation },
        modelRef: judged.model,
        confidence: judged.confidence,
      });
      if (needsReview(judged.relation, judged.confidence)) {
        await enqueueReviewItem({
          entryId: input.entry.id,
          kind: judged.relation,
          fingerprint: `pair:${input.entry.id}:${neighbor.slug}:${judged.relation}`,
          confidence: judged.confidence,
          payload: { otherSlug: neighbor.slug, otherText: neighbor.text, relation: judged.relation },
        });
      }
    }
  } catch (e) {
    console.warn("[reflex] afterRemember skipped:", String(e).slice(0, 160));
  }
}

function needsReview(relation: MemoryRelation, confidence: number | null): boolean {
  if (relation === "unrelated") return false;
  if (relation === "duplicate" || relation === "contradict" || relation === "supersede") return true;
  return (confidence ?? 0) < config.reflex.minConfidence + 0.15;
}

async function neighborHits(text: string, slug: string): Promise<Array<{ slug: string; text: string }>> {
  try {
    const hits = parseToolJson(await brainClient().callTool({
      name: "search",
      arguments: { query: text.slice(0, 160), limit: 8 },
    }));
    const out: Array<{ slug: string; text: string }> = [];
    const seen = new Set<string>();
    for (const hit of Array.isArray(hits) ? hits : []) {
      const other = typeof hit?.slug === "string" ? hit.slug : "";
      const snippet = typeof hit?.chunk_text === "string" ? hit.chunk_text : "";
      if (!other || other === slug || seen.has(other) || !snippet) continue;
      seen.add(other);
      out.push({ slug: other, text: snippet });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

function hashish(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}
