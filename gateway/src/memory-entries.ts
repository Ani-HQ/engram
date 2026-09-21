import { createHash } from "node:crypto";
import { sql } from "./db";
import { splitTopicEntries } from "./topic-page";

export const ENTRY_STATUSES = ["active", "superseded", "retracted", "merged"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export interface MemoryEntry {
  id: string;
  fingerprint: string;
  slug: string;
  archiveSlug: string | null;
  recordedAt: string | null;
  tokenName: string | null;
  rawText: string;
  topicHint: string | null;
  status: EntryStatus;
}

export interface ParsedEntry {
  recordedAt: string | null;
  text: string;
  raw: string;
}

const BULLET = /^- (\d{4}-\d{2}-\d{2}T[^\s]+)\s+[—-]\s*(.*)$/;

export function idFromFingerprint(fingerprint: string): string {
  const hex = createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function canonicalTopicSlug(slug: string): string {
  return slug.replace(/-archive$/, "");
}

export function entryFingerprint(slug: string, recordedAt: string | null, text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update(`${canonicalTopicSlug(slug)}\n${recordedAt ?? ""}\n${normalized}`)
    .digest("hex");
}

export function parseRememberBullet(raw: string): ParsedEntry {
  const lines = raw.split("\n");
  const first = lines[0] ?? "";
  const match = first.match(BULLET);
  if (!match) {
    return { recordedAt: null, text: raw.replace(/\s+/g, " ").trim(), raw };
  }
  const rest = lines.slice(1).join("\n").trim();
  const text = [match[2], rest].filter(Boolean).join("\n").trim();
  return { recordedAt: match[1], text, raw };
}

export function parsePageEntries(slug: string, body: string): ParsedEntry[] {
  const { entries } = splitTopicEntries(body);
  if (entries.length) {
    return entries
      .map(lines => parseRememberBullet(lines.join("\n").trimEnd()))
      .filter(entry => entry.text);
  }
  const text = body.replace(/^---\n[\s\S]*?\n---\n+/, "").replace(/^# .+\n+/, "").trim();
  if (!text) return [];
  return [{ recordedAt: null, text, raw: text }];
}

export async function upsertMemoryEntry(input: {
  slug: string;
  rawText: string;
  recordedAt?: string | null;
  tokenName?: string | null;
  topicHint?: string | null;
  archiveSlug?: string | null;
}): Promise<MemoryEntry | null> {
  const parsed = parseRememberBullet(input.rawText);
  const recordedAt = input.recordedAt ?? parsed.recordedAt;
  const fingerprint = entryFingerprint(input.slug, recordedAt, parsed.text);
  const id = idFromFingerprint(fingerprint);
  const archiveSlug = input.archiveSlug ?? (input.slug.endsWith("-archive") ? input.slug : null);
  const liveSlug = canonicalTopicSlug(input.slug);
  try {
    const rows = await sql`
      INSERT INTO memory_entries (
        id, fingerprint, slug, archive_slug, recorded_at, token_name, raw_text, topic_hint, status
      ) VALUES (
        ${id}, ${fingerprint}, ${liveSlug}, ${archiveSlug},
        ${recordedAt}, ${input.tokenName ?? null}, ${parsed.text}, ${input.topicHint ?? null}, 'active'
      )
      ON CONFLICT (fingerprint) DO UPDATE SET
        slug = EXCLUDED.slug,
        archive_slug = COALESCE(EXCLUDED.archive_slug, memory_entries.archive_slug),
        token_name = COALESCE(EXCLUDED.token_name, memory_entries.token_name),
        topic_hint = COALESCE(EXCLUDED.topic_hint, memory_entries.topic_hint),
        updated_at = now()
      RETURNING *`;
    return rows[0] ? rowToEntry(rows[0]) : null;
  } catch (e) {
    console.error("[memory-entries] upsert failed:", String(e).slice(0, 200));
    return null;
  }
}

export async function markRolledEntries(liveSlug: string, archiveSlug: string, movedRaw: string[]): Promise<void> {
  for (const raw of movedRaw) {
    const parsed = parseRememberBullet(raw);
    const fingerprint = entryFingerprint(liveSlug, parsed.recordedAt, parsed.text);
    try {
      await sql`
        UPDATE memory_entries
        SET archive_slug = ${archiveSlug}, updated_at = now()
        WHERE fingerprint = ${fingerprint}`;
    } catch (e) {
      console.error("[memory-entries] rollover update failed:", String(e).slice(0, 200));
    }
  }
}

export async function backfillPageEntries(input: {
  slug: string;
  body: string;
  tokenName?: string | null;
}): Promise<MemoryEntry[]> {
  const parsed = parsePageEntries(input.slug, input.body);
  const out: MemoryEntry[] = [];
  for (const entry of parsed) {
    const saved = await upsertMemoryEntry({
      slug: input.slug,
      rawText: entry.raw,
      recordedAt: entry.recordedAt,
      tokenName: input.tokenName,
    });
    if (saved) out.push(saved);
  }
  return out;
}

export async function getMemoryEntry(id: string): Promise<MemoryEntry | null> {
  try {
    const rows = await sql`SELECT * FROM memory_entries WHERE id = ${id}`;
    return rows[0] ? rowToEntry(rows[0]) : null;
  } catch (e) {
    console.error("[memory-entries] get failed:", String(e).slice(0, 200));
    return null;
  }
}

export async function listActiveEntries(limit = 200, afterId?: string): Promise<MemoryEntry[]> {
  try {
    const rows = afterId
      ? await sql`
          SELECT * FROM memory_entries
          WHERE status = 'active' AND id > ${afterId}
          ORDER BY id
          LIMIT ${limit}`
      : await sql`
          SELECT * FROM memory_entries
          WHERE status = 'active'
          ORDER BY id
          LIMIT ${limit}`;
    return rows.map(rowToEntry);
  } catch (e) {
    console.error("[memory-entries] list failed:", String(e).slice(0, 200));
    return [];
  }
}

export async function setEntryStatus(id: string, status: EntryStatus): Promise<void> {
  try {
    await sql`UPDATE memory_entries SET status = ${status}, updated_at = now() WHERE id = ${id}`;
  } catch (e) {
    console.error("[memory-entries] status update failed:", String(e).slice(0, 200));
  }
}

export async function recordReflexDecision(input: {
  entryId: string | null;
  sheet: string;
  payload: Record<string, unknown>;
  modelRef?: string | null;
  confidence?: number | null;
}): Promise<void> {
  try {
    await sql`
      INSERT INTO reflex_decisions (entry_id, sheet, payload, model_ref, confidence)
      VALUES (
        ${input.entryId},
        ${input.sheet},
        ${sql.json(input.payload)},
        ${input.modelRef ?? null},
        ${input.confidence ?? null}
      )`;
  } catch (e) {
    console.error("[memory-entries] decision write failed:", String(e).slice(0, 200));
  }
}

function rowToEntry(row: any): MemoryEntry {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    slug: String(row.slug),
    archiveSlug: row.archive_slug ? String(row.archive_slug) : null,
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
    tokenName: row.token_name ? String(row.token_name) : null,
    rawText: String(row.raw_text ?? ""),
    topicHint: row.topic_hint ? String(row.topic_hint) : null,
    status: (ENTRY_STATUSES.includes(row.status) ? row.status : "active") as EntryStatus,
  };
}
