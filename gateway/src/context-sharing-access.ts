import type postgres from "postgres";
import { sql } from "./db";
import { sha256 } from "./hash";

export const SHARED_CONTEXT_TOKEN = /^egs_[A-Za-z0-9_-]{32}$/;
export interface ApprovedContextItem { id: string; title: string; text: string; shareId: string }

/** Deliberately returns approved snapshots only, never source identifiers or text. */
export async function listApprovedTeamItems(targetOrgId: number, db: postgres.Sql = sql): Promise<ApprovedContextItem[]> {
  if (!Number.isSafeInteger(targetOrgId) || targetOrgId < 1) return [];
  const rows = await db`
    SELECT i.id, i.title, i.text, i.share_id FROM context_share_items i
    JOIN context_shares s ON s.id = i.share_id AND s.revoked_at IS NULL
    JOIN orgs source ON source.id = s.source_org AND source.kind = 'personal'
    JOIN org_members owner ON owner.id = s.owner_member_id AND owner.org_id = source.id AND owner.role = 'owner'
    JOIN orgs target ON target.id = s.target_org AND target.kind = 'team'
    JOIN org_members member ON member.id = s.target_member_id AND member.org_id = target.id AND member.email = owner.email
    WHERE s.recipient_kind = 'team' AND s.target_org = ${targetOrgId}
      AND coalesce((target.policies->>'acceptShares')::boolean, true) = true
    ORDER BY s.created_at DESC, i.ordinal`;
  return rows.map(row => ({ id: String(row.id), title: String(row.title), text: String(row.text), shareId: String(row.share_id) }));
}

/** These capabilities never enter general workspace authentication. */
export async function authenticateContextShareToken(raw: string, db: postgres.Sql = sql): Promise<{ shareId: string; items: Omit<ApprovedContextItem,"shareId">[] } | null> {
  if (!SHARED_CONTEXT_TOKEN.test(raw)) return null;
  // One statement binds the current authorization decision to the returned text.
  const rows = await db`
    SELECT s.id AS share_id, i.id, i.title, i.text FROM context_shares s
    JOIN orgs source ON source.id = s.source_org AND source.kind = 'personal'
    JOIN org_members owner ON owner.id = s.owner_member_id AND owner.org_id = source.id AND owner.role = 'owner'
    JOIN context_share_items i ON i.share_id = s.id
    WHERE s.recipient_kind = 'agent' AND s.token_hash = ${sha256(raw)} AND s.revoked_at IS NULL
    ORDER BY i.ordinal LIMIT 12`;
  if (!rows.length) return null;
  return { shareId: String(rows[0].share_id), items: rows.map(row => ({ id: String(row.id), title: String(row.title), text: String(row.text) })) };
}
