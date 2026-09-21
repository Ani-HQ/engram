import { sql } from "../db";

export const REVIEW_STATES = ["pending", "approved", "rejected", "deferred", "applied"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface ReviewItem {
  id: number;
  fingerprint: string;
  entryId: string | null;
  kind: string;
  state: ReviewState;
  confidence: number | null;
  payload: Record<string, unknown>;
  runId: number | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export async function enqueueReviewItem(input: {
  fingerprint: string;
  entryId?: string | null;
  kind: string;
  confidence?: number | null;
  payload: Record<string, unknown>;
  runId?: number | null;
}): Promise<ReviewItem | null> {
  try {
    const rows = await sql`
      INSERT INTO review_items (fingerprint, entry_id, kind, state, confidence, payload, run_id)
      VALUES (
        ${input.fingerprint},
        ${input.entryId ?? null},
        ${input.kind},
        'pending',
        ${input.confidence ?? null},
        ${sql.json(input.payload)},
        ${input.runId ?? null}
      )
      ON CONFLICT (fingerprint) DO NOTHING
      RETURNING *`;
    return rows[0] ? rowToItem(rows[0]) : null;
  } catch (e) {
    console.error("[review] enqueue failed:", String(e).slice(0, 200));
    return null;
  }
}

export async function listReviewItems(input: {
  state?: string;
  kind?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ReviewItem[]> {
  const state = input.state ?? "pending";
  const limit = Math.min(100, Math.max(1, input.limit ?? 40));
  const offset = Math.max(0, input.offset ?? 0);
  try {
    const rows = input.kind
      ? await sql`
          SELECT * FROM review_items
          WHERE state = ${state} AND kind = ${input.kind}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}`
      : await sql`
          SELECT * FROM review_items
          WHERE state = ${state}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}`;
    return rows.map(rowToItem);
  } catch (e) {
    console.error("[review] list failed:", String(e).slice(0, 200));
    return [];
  }
}

export async function getReviewItem(id: number): Promise<ReviewItem | null> {
  try {
    const rows = await sql`SELECT * FROM review_items WHERE id = ${id}`;
    return rows[0] ? rowToItem(rows[0]) : null;
  } catch (e) {
    console.error("[review] get failed:", String(e).slice(0, 200));
    return null;
  }
}

export async function setReviewState(
  id: number,
  state: ReviewState,
  resolvedBy: string,
): Promise<ReviewItem | null> {
  try {
    const rows = await sql`
      UPDATE review_items
      SET state = ${state},
          resolved_at = now(),
          resolved_by = ${resolvedBy}
      WHERE id = ${id} AND state = 'pending'
      RETURNING *`;
    return rows[0] ? rowToItem(rows[0]) : null;
  } catch (e) {
    console.error("[review] update failed:", String(e).slice(0, 200));
    return null;
  }
}

function rowToItem(row: any): ReviewItem {
  return {
    id: Number(row.id),
    fingerprint: String(row.fingerprint),
    entryId: row.entry_id ? String(row.entry_id) : null,
    kind: String(row.kind),
    state: REVIEW_STATES.includes(row.state) ? row.state : "pending",
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    runId: row.run_id === null || row.run_id === undefined ? null : Number(row.run_id),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
