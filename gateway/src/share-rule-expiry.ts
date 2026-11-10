import type postgres from "postgres";
import { config } from "./config";
import { sql } from "./db";
import { sendMail, type MailDelivery } from "./mail";
import { parseShareMatch, type ShareMatch } from "./sharing";

export const SHARE_RULE_TTL_DAYS = 90;
export const RENEWAL_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

// Plain words for what a rule shares, for the reminder email and the app.
export function describeShareMatch(match: ShareMatch): string {
  const parts: string[] = [];
  if (match.trailIds.length) parts.push(match.trailIds.length === 1 ? "one session" : `${match.trailIds.length} sessions`);
  if (match.topics.length) parts.push(`topics: ${match.topics.join(", ")}`);
  if (match.repos.length) parts.push(`repos: ${match.repos.join(", ")}`);
  if (match.harnesses.length) parts.push(`agents: ${match.harnesses.join(", ")}`);
  if (!parts.length) parts.push("everything new");
  return parts.join("; ");
}

export interface ExpiringRule { id: number; ownerEmail: string; teamName: string; match: ShareMatch; expiresAt: Date }

export interface ReminderDeps {
  db?: postgres.Sql;
  now?: () => Date;
  send?: (mail: { to: string; subject: string; text: string; idempotencyKey: string }) => Promise<MailDelivery>;
  publicUrl?: string;
  dryRun?: boolean;
}

// One email per owner, once per expiry, about a week before. A rule is only
// marked reminded after the email is accepted, so a failed send retries on the
// next run. Rules whose owner no longer owns the personal workspace are skipped:
// they already stop sharing on their own.
export async function remindExpiringShareRules(deps: ReminderDeps = {}): Promise<{ owners: number; rules: number; sent: number; failed: number }> {
  const db = deps.db ?? sql, now = deps.now ?? (() => new Date());
  const send = deps.send ?? (mail => sendMail(mail));
  const at = now();
  const rows = await db`
    SELECT r.id, r.owner_email, r.match, r.expires_at, t.name AS team_name
    FROM share_rules r
    JOIN orgs t ON t.id = r.target_org AND t.kind = 'team'
    JOIN orgs s ON s.id = r.source_org AND s.kind = 'personal'
    JOIN org_members m ON m.org_id = r.source_org AND lower(m.email) = lower(r.owner_email) AND m.role = 'owner'
    WHERE r.revoked_at IS NULL AND r.renewal_notified_at IS NULL
      AND r.expires_at > ${at} AND r.expires_at <= ${new Date(at.getTime() + RENEWAL_NOTICE_MS)}
    ORDER BY r.owner_email, r.expires_at, r.id
    LIMIT 200`;
  const byOwner = new Map<string, ExpiringRule[]>();
  for (const row of rows) {
    const rule = { id: Number(row.id), ownerEmail: String(row.owner_email), teamName: String(row.team_name), match: parseShareMatch(row.match, { allowStoredAll: true }), expiresAt: new Date(row.expires_at) };
    const key = rule.ownerEmail.toLowerCase();
    byOwner.set(key, [...(byOwner.get(key) ?? []), rule]);
  }
  let sent = 0, failed = 0;
  for (const rules of byOwner.values()) {
    if (deps.dryRun) continue;
    const mail = renewalEmail(rules, deps.publicUrl ?? config.publicUrl ?? "");
    const delivery = await send(mail);
    if (delivery !== "sent") { failed += delivery === "failed" ? 1 : 0; continue; }
    sent++;
    await db`UPDATE share_rules SET renewal_notified_at = ${at} WHERE id IN ${db(rules.map(rule => rule.id))} AND renewal_notified_at IS NULL`;
  }
  return { owners: byOwner.size, rules: rows.length, sent, failed };
}

export function renewalEmail(rules: ExpiringRule[], publicUrl: string) {
  const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const lines = rules.map(rule => `- To ${rule.teamName} (${describeShareMatch(rule.match)}): stops on ${day(rule.expiresAt)}`);
  const one = rules.length === 1;
  return {
    to: rules[0]!.ownerEmail,
    subject: one ? `Your automatic sharing to ${rules[0]!.teamName} stops in a week` : `${rules.length} automatic sharing rules stop in a week`,
    text: [
      one ? "This automatic sharing rule from your personal memory stops soon:" : "These automatic sharing rules from your personal memory stop soon:",
      "",
      ...lines,
      "",
      "After that, nothing new is shared. What was already shared stays until you remove it.",
      `To keep sharing for another ${SHARE_RULE_TTL_DAYS} days, renew it here: ${publicUrl.replace(/\/$/, "")}/app#approvals`,
      "",
      "If you do nothing, sharing simply stops.",
    ].join("\n"),
    idempotencyKey: `share-rule-renewal-${rules.map(rule => `${rule.id}.${Math.floor(rule.expiresAt.getTime() / 1000)}`).join("-")}`.slice(0, 256),
  };
}
