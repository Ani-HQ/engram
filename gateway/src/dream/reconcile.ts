import { sql } from "../db";
import { recordReflexDecision, type MemoryEntry } from "../memory-entries";
import { reflexClient } from "../reflex/client";
import { classifyMemory } from "../reflex/tasks/classify";
import { judgePair } from "../reflex/tasks/pairwise";
import { enqueueReviewItem } from "../review/store";
import { deriveClusters } from "./cluster";
import { nightKey, releaseDreamLock, tryDreamLock } from "./lock";
import { backfillChangedPages, neighborSlugs } from "./scan";

export interface DreamResult {
  ok: boolean;
  nightKey: string;
  locked: boolean;
  stats: Record<string, number>;
  error?: string;
}

export async function runDreamCycle(now = new Date()): Promise<DreamResult> {
  const key = nightKey(now);
  const locked = await tryDreamLock();
  if (!locked) return { ok: false, nightKey: key, locked: false, stats: {}, error: "lock held" };

  const stats = { pages: 0, entries: 0, decisions: 0, reviews: 0, clusters: 0 };
  let runId: number | null = null;
  try {
    const existing = await sql`SELECT * FROM dream_runs WHERE night_key = ${key}`;
    let cursor = existing[0]?.cursor ?? { offset: 0 };
    if (existing[0]?.status === "ok") {
      return { ok: true, nightKey: key, locked: true, stats: existing[0].stats ?? stats };
    }
    if (existing[0]) {
      runId = Number(existing[0].id);
      await sql`UPDATE dream_runs SET status = 'running', error = NULL WHERE id = ${runId}`;
    } else {
      const inserted = await sql`
        INSERT INTO dream_runs (night_key, status, cursor, stats)
        VALUES (${key}, 'running', ${sql.json(cursor)}, ${sql.json(stats)})
        RETURNING id`;
      runId = Number(inserted[0].id);
    }

    const scanned = await backfillChangedPages(cursor, 20);
    stats.pages = scanned.nextOffset;
    stats.entries = scanned.entries.length;
    cursor = { offset: scanned.nextOffset, done: scanned.done };

    for (const entry of scanned.entries) {
      await judgeEntry(entry, runId, stats);
    }

    for (const cluster of deriveClusters(scanned.entries)) {
      const queued = await enqueueReviewItem({
        fingerprint: `cluster:${key}:${cluster.slug}`,
        kind: "cluster",
        payload: cluster,
        runId,
      });
      if (queued) stats.clusters += 1;
    }

    const status = scanned.done ? "ok" : "running";
    await sql`
      UPDATE dream_runs
      SET status = ${status},
          cursor = ${sql.json(cursor)},
          stats = ${sql.json(stats)},
          finished_at = ${scanned.done ? sql`now()` : null}
      WHERE id = ${runId}`;
    return { ok: true, nightKey: key, locked: true, stats };
  } catch (e) {
    const error = String(e).slice(0, 300);
    if (runId) {
      await sql`
        UPDATE dream_runs
        SET status = 'failed', error = ${error}, finished_at = now()
        WHERE id = ${runId}`.catch(() => {});
    }
    return { ok: false, nightKey: key, locked: true, stats, error };
  } finally {
    await releaseDreamLock();
  }
}

async function judgeEntry(entry: MemoryEntry, runId: number | null, stats: Record<string, number>) {
  const classification = await classifyMemory(reflexClient(), entry.rawText);
  if (classification) {
    await recordReflexDecision({
      entryId: entry.id,
      sheet: "dream-classify",
      payload: classification as unknown as Record<string, unknown>,
      modelRef: classification.model,
    });
    stats.decisions += 1;
    if (classification.longevity === "ephemeral") {
      const queued = await enqueueReviewItem({
        fingerprint: `stale:${entry.id}`,
        entryId: entry.id,
        kind: "stale",
        payload: { slug: entry.slug, text: entry.rawText },
        runId,
      });
      if (queued) stats.reviews += 1;
    }
  }

  for (const neighbor of await neighborSlugs(entry.rawText, entry.slug)) {
    const judged = await judgePair(reflexClient(), entry.rawText, neighbor.text);
    if (!judged.relation) continue;
    await recordReflexDecision({
      entryId: entry.id,
      sheet: "dream-pairwise",
      payload: { otherSlug: neighbor.slug, relation: judged.relation },
      modelRef: judged.model,
      confidence: judged.confidence,
    });
    stats.decisions += 1;
    if (judged.relation === "unrelated") continue;
    const queued = await enqueueReviewItem({
      fingerprint: `dream-pair:${entry.id}:${neighbor.slug}:${judged.relation}`,
      entryId: entry.id,
      kind: judged.relation,
      confidence: judged.confidence,
      payload: { otherSlug: neighbor.slug, otherText: neighbor.text, relation: judged.relation },
      runId,
    });
    if (queued) stats.reviews += 1;
  }
}
