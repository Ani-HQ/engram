import { ensureBrain } from "./brain";
import { currentContext, currentOrg } from "./context";
import { dataSql, sql } from "./db";
import { listActiveEntries, type MemoryEntry } from "./memory-entries";
import {
  getOrg,
  memberInOrg,
  withOrg,
  type Org,
} from "./orgs";
import {
  capShareLevel,
  parseShareLevel,
  type ShareLevel,
  type TokenRecord,
} from "./policies";
import {
  deleteDigestPage,
  getTrail,
  listTrails,
  publicTrail,
  writeDigestPage,
  type Trail,
} from "./trails";

export interface ShareMatch {
  repos: string[];
  topics: string[];
  harnesses: string[];
  since: string | null;
  until: string | null;
  trailIds: string[];
}

export interface ShareRule {
  id: number;
  ownerEmail: string;
  sourceOrg: number;
  targetOrg: number;
  match: ShareMatch;
  level: ShareLevel;
  createdAt: string;
  pausedAt: string | null;
  revokedAt: string | null;
}

export interface ShareableItem {
  kind: "trail" | "entry";
  id: string;
  repo: string | null;
  topic: string | null;
  harness: string | null;
  at: string | null;
}

export function parseShareMatch(value: unknown): ShareMatch {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    repos: stringList(raw.repos),
    topics: stringList(raw.topics),
    harnesses: stringList(raw.harnesses),
    since: optionalText(raw.since),
    until: optionalText(raw.until),
    trailIds: stringList(raw.trailIds ?? raw.trail_ids),
  };
}

export function ruleMatches(match: ShareMatch, item: ShareableItem): boolean {
  if (match.trailIds.length && (item.kind !== "trail" || !match.trailIds.includes(item.id))) {
    return false;
  }
  if (match.repos.length && !includesNormalized(match.repos, item.repo)) return false;
  if (match.harnesses.length && !includesNormalized(match.harnesses, item.harness)) return false;
  if (match.topics.length && !topicMatches(match.topics, item.topic)) return false;
  if (match.since && (!item.at || item.at < match.since)) return false;
  if (match.until && (!item.at || item.at > match.until)) return false;
  return true;
}

export function itemFromTrail(trail: Trail): ShareableItem {
  return {
    kind: "trail",
    id: trail.id,
    repo: trail.repo,
    topic: trail.repo,
    harness: trail.harness,
    at: trail.endedAt ?? trail.startedAt,
  };
}

export function itemFromEntry(entry: MemoryEntry & { repo?: string | null; harness?: string | null }): ShareableItem {
  return {
    kind: "entry",
    id: entry.id,
    repo: entry.repo ?? null,
    topic: entry.topicHint ?? entry.slug,
    harness: entry.harness ?? null,
    at: entry.recordedAt,
  };
}

export async function listShareRules(sourceOrg: number, ownerEmail?: string | null): Promise<ShareRule[]> {
  const rows = ownerEmail
    ? await sql`
        SELECT * FROM share_rules
        WHERE source_org = ${sourceOrg} AND owner_email = ${ownerEmail} AND revoked_at IS NULL
        ORDER BY created_at DESC`
    : await sql`
        SELECT * FROM share_rules
        WHERE source_org = ${sourceOrg} AND revoked_at IS NULL
        ORDER BY created_at DESC`;
  return rows.map(rowToRule);
}

export async function getShareRule(id: number): Promise<ShareRule | null> {
  const rows = await sql`SELECT * FROM share_rules WHERE id = ${id}`;
  return rows[0] ? rowToRule(rows[0]) : null;
}

export async function createShareRule(input: {
  ownerEmail: string;
  sourceOrg: Org;
  targetOrgId: number;
  match: ShareMatch;
  level: ShareLevel;
}): Promise<ShareRule> {
  await assertCanShare(input.ownerEmail, input.sourceOrg, input.targetOrgId);
  const rows = await sql`
    INSERT INTO share_rules (owner_email, source_org, target_org, match, level)
    VALUES (
      ${input.ownerEmail},
      ${input.sourceOrg.id},
      ${input.targetOrgId},
      ${sql.json(input.match)},
      ${input.level}
    )
    RETURNING *`;
  const rule = rowToRule(rows[0]);
  await backfillRule(rule).catch(e => {
    console.error("[sharing] backfill failed:", String(e).slice(0, 160));
  });
  return rule;
}

export async function updateShareRule(
  rule: ShareRule,
  patch: { match?: ShareMatch; level?: ShareLevel; paused?: boolean },
): Promise<ShareRule> {
  const nextMatch = patch.match ?? rule.match;
  const nextLevel = patch.level ?? rule.level;
  const pausedAt = patch.paused === undefined
    ? rule.pausedAt
    : patch.paused ? new Date().toISOString() : null;
  const rows = await sql`
    UPDATE share_rules
    SET match = ${sql.json(nextMatch)},
        level = ${nextLevel},
        paused_at = ${pausedAt}
    WHERE id = ${rule.id}
    RETURNING *`;
  const updated = rowToRule(rows[0]);
  if (patch.match || patch.level) {
    await unshareRule(updated.id, { keepIfStillMatches: updated }).catch(() => {});
    if (!updated.pausedAt && !updated.revokedAt) {
      await backfillRule(updated).catch(() => {});
    }
  }
  return updated;
}

export async function revokeShareRule(id: number): Promise<void> {
  await sql`UPDATE share_rules SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
  await unshareRule(id);
}

export async function previewShare(input: {
  sourceOrg: Org;
  match: ShareMatch;
}): Promise<{ trails: number; entries: number }> {
  const { trails, entries } = await collectMatches(input.sourceOrg, input.match);
  return { trails: trails.length, entries: entries.length };
}

export async function shareAfterWrite(input: { kind: "trail"; trail: Trail } | { kind: "entry"; entry: MemoryEntry }): Promise<void> {
  const org = currentOrg();
  if (!org || org.kind !== "personal") return;
  const item = input.kind === "trail" ? itemFromTrail(input.trail) : itemFromEntry(input.entry);
  const rules = (await listShareRules(org.id)).filter(rule => !rule.pausedAt && ruleMatches(rule.match, item));
  for (const rule of rules) {
    const target = await getOrg(rule.targetOrg);
    if (!target || target.kind !== "team" || !target.policies.acceptShares) continue;
    await mirror(input, rule, target).catch(e => {
      console.error("[sharing] mirror failed:", String(e).slice(0, 160));
    });
  }
}

export async function shareOne(input: {
  ownerEmail: string;
  sourceOrg: Org;
  targetOrgId: number;
  trailId: string;
  level: ShareLevel;
}): Promise<ShareRule> {
  return createShareRule({
    ...input,
    match: { ...parseShareMatch({}), trailIds: [input.trailId] },
  });
}

export async function unshareTrail(input: {
  ownerEmail: string;
  sourceOrg: number;
  trailId: string;
  targetOrgId?: number;
}): Promise<number> {
  const rules = await listShareRules(input.sourceOrg, input.ownerEmail);
  let count = 0;
  for (const rule of rules) {
    if (input.targetOrgId && rule.targetOrg !== input.targetOrgId) continue;
    if (!rule.match.trailIds.includes(input.trailId) && !ruleMatches(rule.match, {
      kind: "trail",
      id: input.trailId,
      repo: null,
      topic: null,
      harness: null,
      at: new Date().toISOString(),
    })) {
      // A standing repo rule still covers this trail; drop only an explicit one-off,
      // or pause this trail by adding a revoked copy? Keep standing rules.
      if (rule.match.trailIds.length === 0) continue;
    }
    if (rule.match.trailIds.length === 1 && rule.match.trailIds[0] === input.trailId) {
      await revokeShareRule(rule.id);
      count += 1;
      continue;
    }
    if (rule.match.trailIds.includes(input.trailId)) {
      const next = { ...rule.match, trailIds: rule.match.trailIds.filter(id => id !== input.trailId) };
      await updateShareRule(rule, { match: next });
      count += 1;
    }
  }
  const copies = await sql`
    SELECT c.* FROM shared_copies c
    JOIN share_rules r ON r.id = c.rule_id
    WHERE r.source_org = ${input.sourceOrg}
      AND r.owner_email = ${input.ownerEmail}
      AND c.source_kind = 'trail'
      AND c.source_id = ${input.trailId}
      AND c.revoked_at IS NULL
      ${input.targetOrgId ? sql`AND c.target_org = ${input.targetOrgId}` : sql``}`;
  for (const copy of copies) {
    await revokeCopy(copy);
    count += 1;
  }
  return count;
}

export async function assertCanShare(email: string, source: Org, targetOrgId: number): Promise<Org> {
  if (source.kind !== "personal") throw new Error("share from a personal brain");
  if (!email) throw new Error("email required");
  const member = await memberInOrg(source.id, email);
  if (!member) throw new Error("not a member of the source brain");
  const target = await getOrg(targetOrgId);
  if (!target || target.kind !== "team") throw new Error("share to a team");
  if (!target.policies.acceptShares) throw new Error("that team is not accepting shares");
  if (!await memberInOrg(target.id, email)) throw new Error("not a member of that team");
  return target;
}

async function backfillRule(rule: ShareRule): Promise<void> {
  const source = await getOrg(rule.sourceOrg);
  const target = await getOrg(rule.targetOrg);
  if (!source || !target || rule.pausedAt || rule.revokedAt) return;
  const { trails, entries } = await collectMatches(source, rule.match);
  for (const trail of trails) {
    await mirror({ kind: "trail", trail }, rule, target);
  }
  for (const entry of entries) {
    await mirror({ kind: "entry", entry }, rule, target);
  }
}

async function collectMatches(source: Org, match: ShareMatch): Promise<{ trails: Trail[]; entries: MemoryEntry[] }> {
  const ctx = currentContext();
  const token = ctx?.token ?? { name: "share", orgId: source.id, role: "owner" as const, canWrite: true, kind: "session" as const, email: null, scopes: [] };
  return withOrg(source, token, async () => {
    const trails = (await listAllTrails()).filter(trail => ruleMatches(match, itemFromTrail(trail)));
    const entries = (await listAllActiveEntries()).filter(entry => ruleMatches(match, itemFromEntry(entry)));
    return { trails, entries };
  });
}

async function listAllTrails(): Promise<Trail[]> {
  const pageSize = 100;
  const all: Trail[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await listTrails({ limit: pageSize, offset });
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

async function listAllActiveEntries(): Promise<MemoryEntry[]> {
  const pageSize = 200;
  const all: MemoryEntry[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await listActiveEntries(pageSize, afterId);
    all.push(...page);
    if (page.length < pageSize) return all;
    afterId = page[page.length - 1]!.id;
  }
}

async function mirror(
  input: { kind: "trail"; trail: Trail } | { kind: "entry"; entry: MemoryEntry },
  rule: ShareRule,
  target: Org,
): Promise<void> {
  const ctx = currentContext();
  const token = ctx?.token;
  if (!token) return;
  const effective = capShareLevel(rule.level, target.policies.maxShareLevel);
  await ensureBrain(target);
  await withOrg(target, token, async () => {
    if (input.kind === "trail") {
      const copied = await writeSharedTrail(input.trail, effective);
      await recordCopy(rule.id, "trail", input.trail.id, target.id, copied.digestSlug, copied.id);
      return;
    }
    const slug = await writeSharedEntry(input.entry, token);
    await recordCopy(rule.id, "entry", input.entry.id, target.id, slug, null);
  });
}

async function writeSharedTrail(source: Trail, level: ShareLevel): Promise<Trail> {
  const includeTranscript = level === "digest_transcript" || level === "transcript";
  const includeDigest = level === "digest" || level === "digest_transcript";
  const digest = includeDigest ? source.digest : (source.digest ? `Transcript from ${source.harness}${source.repo ? ` on ${source.repo}` : ""}.` : null);
  const rows = await dataSql()`
    INSERT INTO trails (
      id, harness, session_id, repo, cwd, branch, author_email,
      started_at, ended_at, transcript, digest, digest_slug
    ) VALUES (
      ${source.id}, ${source.harness}, ${source.sessionId}, ${source.repo},
      ${source.cwd}, ${source.branch}, ${source.authorEmail},
      ${source.startedAt}, ${source.endedAt},
      ${includeTranscript ? source.transcript : null},
      ${digest}, ${source.digestSlug}
    )
    ON CONFLICT (harness, session_id) DO UPDATE SET
      repo = EXCLUDED.repo,
      author_email = EXCLUDED.author_email,
      ended_at = EXCLUDED.ended_at,
      transcript = EXCLUDED.transcript,
      digest = EXCLUDED.digest,
      digest_slug = COALESCE(trails.digest_slug, EXCLUDED.digest_slug),
      updated_at = now()
    RETURNING *`;
  const copied = {
    id: String(rows[0].id),
    harness: String(rows[0].harness),
    sessionId: String(rows[0].session_id),
    repo: rows[0].repo ? String(rows[0].repo) : null,
    cwd: rows[0].cwd ? String(rows[0].cwd) : null,
    branch: rows[0].branch ? String(rows[0].branch) : null,
    authorEmail: rows[0].author_email ? String(rows[0].author_email) : null,
    startedAt: rows[0].started_at ? new Date(rows[0].started_at).toISOString() : null,
    endedAt: rows[0].ended_at ? new Date(rows[0].ended_at).toISOString() : null,
    transcript: rows[0].transcript != null ? String(rows[0].transcript) : null,
    digest: rows[0].digest != null ? String(rows[0].digest) : null,
    digestSlug: rows[0].digest_slug ? String(rows[0].digest_slug) : null,
  };
  if (includeDigest) await writeDigestPage(copied);
  return copied;
}

async function writeSharedEntry(entry: MemoryEntry, token: TokenRecord): Promise<string> {
  const { callTool } = await import("./proxy");
  const text = `${entry.rawText} — shared from ${token.email || token.name}`;
  const result = await callTool(token, "remember", {
    text,
    topic: `shared/${entry.id}`,
  });
  const parsed = parseToolJson(result);
  return typeof parsed?.slug === "string" ? parsed.slug : `shared/${entry.id}`;
}

async function recordCopy(
  ruleId: number,
  sourceKind: "trail" | "entry",
  sourceId: string,
  targetOrg: number,
  targetSlug: string | null,
  targetTrailId: string | null,
): Promise<void> {
  await sql`
    INSERT INTO shared_copies (rule_id, source_kind, source_id, target_org, target_slug, target_trail_id, synced_at, revoked_at)
    VALUES (${ruleId}, ${sourceKind}, ${sourceId}, ${targetOrg}, ${targetSlug}, ${targetTrailId}, now(), NULL)
    ON CONFLICT (rule_id, source_kind, source_id) DO UPDATE SET
      target_slug = EXCLUDED.target_slug,
      target_trail_id = EXCLUDED.target_trail_id,
      synced_at = now(),
      revoked_at = NULL`;
}

async function unshareRule(ruleId: number, opts?: { keepIfStillMatches?: ShareRule }): Promise<void> {
  const copies = await sql`
    SELECT * FROM shared_copies WHERE rule_id = ${ruleId} AND revoked_at IS NULL`;
  for (const copy of copies) {
    if (opts?.keepIfStillMatches && copy.source_kind === "trail") {
      const source = await getOrg(opts.keepIfStillMatches.sourceOrg);
      if (source) {
        const trail = await withOrg(source, currentContext()!.token, () => getTrail(String(copy.source_id)));
        if (trail && ruleMatches(opts.keepIfStillMatches.match, itemFromTrail(trail))) continue;
      }
    }
    await revokeCopy(copy);
  }
}

async function revokeCopy(copy: any): Promise<void> {
  await sql`UPDATE shared_copies SET revoked_at = now() WHERE id = ${copy.id}`;
  const others = await sql`
    SELECT 1 FROM shared_copies
    WHERE target_org = ${copy.target_org}
      AND source_kind = ${copy.source_kind}
      AND source_id = ${copy.source_id}
      AND revoked_at IS NULL
      AND id != ${copy.id}
    LIMIT 1`;
  if (others.length) return;
  const target = await getOrg(Number(copy.target_org));
  const token = currentContext()?.token;
  if (!target || !token) return;
  await withOrg(target, token, async () => {
    if (copy.target_slug) await deleteDigestPage(String(copy.target_slug));
    if (copy.source_kind === "trail") {
      await dataSql()`DELETE FROM trails WHERE id = ${String(copy.source_id)}`.catch(() => {});
    }
  });
}

function parseToolJson(result: any): any {
  const text = result?.content?.find((block: any) => block?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rowToRule(row: any): ShareRule {
  return {
    id: Number(row.id),
    ownerEmail: String(row.owner_email),
    sourceOrg: Number(row.source_org),
    targetOrg: Number(row.target_org),
    match: parseShareMatch(row.match),
    level: parseShareLevel(row.level),
    createdAt: new Date(row.created_at).toISOString(),
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => typeof item === "string" ? item.trim() : "").filter(Boolean))];
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function includesNormalized(list: string[], value: string | null): boolean {
  if (!value) return false;
  const needle = value.toLowerCase();
  return list.some(item => needle === item.toLowerCase() || needle.endsWith(`/${item.toLowerCase()}`) || item.toLowerCase().endsWith(`/${needle}`));
}

function topicMatches(topics: string[], value: string | null): boolean {
  if (!value) return false;
  const needle = value.toLowerCase();
  return topics.some(topic => {
    const want = topic.toLowerCase();
    return needle === want || needle.endsWith(`/${want}`) || needle.includes(want);
  });
}

export function publicRule(rule: ShareRule) {
  return {
    id: rule.id,
    targetOrg: rule.targetOrg,
    match: rule.match,
    level: rule.level,
    createdAt: rule.createdAt,
    pausedAt: rule.pausedAt,
  };
}

export { publicTrail };
