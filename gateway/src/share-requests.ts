import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "./db";
import { config } from "./config";
import { sendMail } from "./mail";
import { memberInOrg, normalizeEmail, personalOrgForEmail, publicUrlFrom, type Org } from "./orgs";
import { parsePolicies, type TokenRecord } from "./policies";
import { redactSecrets } from "./redact";
import { commitContextShare, ContextSharingError, previewContextShare, type ContextSharingDeps } from "./context-sharing";

// Ask a teammate: an agent in a team asks one teammate for something from that
// teammate's personal memory. Nothing leaves until the owner reviews exact
// excerpts and approves them, through the same preview and commit steps as
// Sharing. A 90-day approval only re-serves excerpts the owner already
// approved under that topic; anything new comes back to the owner as a request.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const REQUEST_TTL_MS = 24 * 60 * 60_000;
export const GRANT_TTL_MS = 90 * 24 * 60 * 60_000;
const OPEN_PER_OWNER = 5, DAILY_PER_REQUESTER = 20, NOTIFY_GAP_MS = 10 * 60_000;
const NOT_AVAILABLE = "That teammate can't be asked from here. Check the email is a current member of this team.";

export class ShareRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_request") { super(message); }
}
function toolError(message: string) { return { content: [{ type: "text", text: message }], isError: true }; }
function toolJson(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }

const STOP = new Set("what when where which about from have that this with your they them their there would could should please need know does did decide decided tell share any some into for and the".split(" "));
export function topicWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !STOP.has(word)))].slice(0, 30);
}
/** A question is covered by a topic when it shares at least half the topic's words (min one). */
export function coveredByTopic(question: string, topic: string): boolean {
  const wanted = topicWords(topic);
  if (!wanted.length) return false;
  const asked = new Set(topicWords(question));
  const hits = wanted.filter(word => asked.has(word)).length;
  return hits >= Math.max(1, Math.ceil(wanted.length / 2));
}

/** A short topic from a question: its first few specific words. */
export function suggestTopic(question: string): string {
  const words = topicWords(question).slice(0, 4).join(" ");
  return words.length >= 3 ? words : question.slice(0, 200);
}

/** The team membership behind an agent call, from the credential, never from arguments. */
export async function requesterMember(actor: TokenRecord, teamOrgId: number, db: postgres.Sql = sql) {
  if (actor.kind === "session") return null;
  let email = actor.email;
  if (!email && actor.kind === "token") {
    const base = actor.name.startsWith("linked:") ? actor.name.slice(7) : actor.name;
    const rows = await db`SELECT issued_by_email FROM tokens WHERE name = ${base} AND revoked_at IS NULL AND issuer_kind = 'member'`;
    email = rows[0]?.issued_by_email ? String(rows[0].issued_by_email) : null;
  }
  if (!email) return null;
  const member = await memberInOrg(teamOrgId, email, db);
  return member && (member.role === "owner" || member.role === "member") ? member : null;
}

export interface AskDeps { db?: postgres.Sql; now?: () => Date; notify?: (input: { to: string; requester: string; team: string; question: string; requestId: string }) => Promise<void> }

async function defaultNotify(input: { to: string; requester: string; team: string; question: string; requestId: string }) {
  const url = `${config.publicUrl || ""}/app#approvals`;
  await sendMail({
    to: input.to,
    subject: `${input.requester} asked for something from your memory`,
    text: [
      `${input.requester}'s agent in ${input.team} asked:`,
      "",
      `"${input.question}"`,
      "",
      "Nothing is shared until you review the exact excerpts and approve them.",
      `Review it here: ${url}`,
      "",
      "The request lapses after 24 hours if you don't answer.",
    ].join("\n"),
    idempotencyKey: `share-request-${input.requestId}`,
  });
}

function itemView(row: any) {
  return { slug: `shared-context/${row.share_id}/${row.id}`, title: String(row.title), text: String(row.text) };
}

export async function askTeammate(actor: TokenRecord, team: { id: number; name: string; kind: string; policies: unknown }, args: Record<string, unknown>, deps: AskDeps = {}) {
  const db = deps.db ?? sql, now = deps.now ?? (() => new Date());
  try {
    if (team.kind !== "team") return toolError("ask_teammate works in a team workspace. Use workspace: \"<team slug>\" if this connection is linked to one.");
    if (!parsePolicies(team.policies).shareRequests) return toolError("This team's owners have turned off teammate requests.");
    const keys = Object.keys(args ?? {}).filter(key => key !== "workspace");
    if (keys.some(key => key !== "teammate" && key !== "question")) return toolError("ask_teammate takes teammate and question.");
    const teammate = typeof args.teammate === "string" ? normalizeEmail(args.teammate) : null;
    const question = typeof args.question === "string" ? redactSecrets(args.question.trim()) : "";
    if (!teammate) return toolError("teammate must be the teammate's email address.");
    if (question.length < 5 || question.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(question)) return toolError("question must be 5 to 500 characters of plain text.");
    const requester = await requesterMember(actor, team.id, db);
    if (!requester) return toolError("This connection isn't tied to a current member of this team, so it can't ask teammates.");
    if (requester.email === teammate) return toolError("That's you. Use recall on your own workspace instead.");
    const ownerTeamMember = await memberInOrg(team.id, teammate, db);
    const ownerOrg = ownerTeamMember ? await personalOrgForEmail(teammate, db) : null;
    const ownerMember = ownerOrg ? await memberInOrg(ownerOrg.id, teammate, db) : null;
    if (!ownerTeamMember || !["owner", "member"].includes(ownerTeamMember.role) || !ownerOrg || !ownerMember || ownerMember.role !== "owner") return toolError(NOT_AVAILABLE);

    // A current 90-day approval answers from material already approved under it.
    const grants = await db`
      SELECT id, topic FROM context_share_grants
      WHERE team_org = ${team.id} AND requester_member_id = ${requester.id} AND owner_member_id = ${ownerMember.id}
        AND revoked_at IS NULL AND expires_at > ${now()} ORDER BY created_at DESC LIMIT 20`;
    const grant = grants.find(row => coveredByTopic(question, String(row.topic)));
    if (grant) {
      const words = topicWords(question);
      const items = await db`
        SELECT i.id, i.share_id, i.title, i.text FROM context_share_items i JOIN context_shares s ON s.id = i.share_id
        WHERE s.grant_id = ${grant.id} AND s.revoked_at IS NULL AND s.target_org = ${team.id} ORDER BY s.created_at DESC, i.ordinal LIMIT 50`;
      const matching = items.filter(row => words.some(word => String(row.text).toLowerCase().includes(word))).slice(0, 8);
      if (matching.length) {
        const id = randomUUID();
        await db`INSERT INTO context_share_requests (id, team_org, requester_member_id, requester_actor, owner_org, owner_member_id, question, status, grant_id, expires_at, decided_at)
          VALUES (${id}, ${team.id}, ${requester.id}, ${actor.name.slice(0, 600)}, ${ownerOrg.id}, ${ownerMember.id}, ${question}, 'answered', ${grant.id}, ${now()}, ${now()})`;
        return toolJson({ requestId: id, status: "answered", from: teammate, note: `Answered from excerpts ${teammate} already approved for you on "${grant.topic}". For anything new, ask again with a different question.`, excerpts: matching.map(itemView) });
      }
    }

    const open = await db`SELECT
        count(*) FILTER (WHERE owner_member_id = ${ownerMember.id} AND status = 'pending' AND expires_at > ${now()})::integer AS open_to_owner,
        count(*) FILTER (WHERE created_at > ${new Date(now().getTime() - 24 * 60 * 60_000)})::integer AS today
      FROM context_share_requests WHERE team_org = ${team.id} AND requester_member_id = ${requester.id}`;
    if (Number(open[0]?.open_to_owner) >= OPEN_PER_OWNER) return toolError(`You already have ${OPEN_PER_OWNER} open requests with ${teammate}. Wait for an answer first.`);
    if (Number(open[0]?.today) >= DAILY_PER_REQUESTER) return toolError("You've reached today's limit for teammate requests. Try again tomorrow.");

    const id = randomUUID(), expiresAt = new Date(now().getTime() + REQUEST_TTL_MS);
    await db`INSERT INTO context_share_requests (id, team_org, requester_member_id, requester_actor, owner_org, owner_member_id, question, expires_at)
      VALUES (${id}, ${team.id}, ${requester.id}, ${actor.name.slice(0, 600)}, ${ownerOrg.id}, ${ownerMember.id}, ${question}, ${expiresAt})`;
    // One email per quiet period; everything waiting is on the Approvals page.
    const recent = await db`SELECT 1 FROM context_share_requests WHERE owner_member_id = ${ownerMember.id} AND notified_at > ${new Date(now().getTime() - NOTIFY_GAP_MS)} LIMIT 1`;
    if (!recent.length) {
      await db`UPDATE context_share_requests SET notified_at = ${now()} WHERE id = ${id}`;
      (deps.notify ?? defaultNotify)({ to: teammate, requester: requester.email, team: team.name, question, requestId: id }).catch(() => {});
    }
    return toolJson({ requestId: id, status: "pending", from: teammate, expiresAt: expiresAt.toISOString(), note: `Waiting for ${teammate} to review and approve. Check back with get_request. Requests lapse after 24 hours.` });
  } catch {
    return toolError("The request could not be sent right now. Try again shortly.");
  }
}

export async function getShareRequest(actor: TokenRecord, team: { id: number; kind: string }, args: Record<string, unknown>, deps: { db?: postgres.Sql; now?: () => Date } = {}) {
  const db = deps.db ?? sql, now = deps.now ?? (() => new Date());
  try {
    const id = typeof args.requestId === "string" ? args.requestId.trim().toLowerCase() : "";
    if (!UUID.test(id)) return toolError("requestId must be the ID ask_teammate returned.");
    if (team.kind !== "team") return toolError("get_request works in the team the request was made from.");
    const requester = await requesterMember(actor, team.id, db);
    if (!requester) return toolError("Request not found.");
    const rows = await db`SELECT r.*, m.email AS owner_email FROM context_share_requests r JOIN org_members m ON m.id = r.owner_member_id
      WHERE r.id = ${id} AND r.team_org = ${team.id} AND r.requester_member_id = ${requester.id}`;
    const row = rows[0];
    if (!row) return toolError("Request not found.");
    const from = String(row.owner_email);
    let status = String(row.status);
    if (status === "pending" && new Date(row.expires_at).getTime() <= now().getTime()) status = "expired";
    if (status === "pending") return toolJson({ requestId: id, status, from, note: `Still waiting for ${from}.` });
    if (status === "expired") return toolJson({ requestId: id, status, from, note: "No answer within 24 hours. You can ask again." });
    // Declined and "nothing to share" read the same on purpose.
    if (status === "declined") return toolJson({ requestId: id, status: "closed", from, note: `${from} didn't share anything for this request.` });
    const items = row.share_id ? await db`
      SELECT i.id, i.share_id, i.title, i.text FROM context_share_items i JOIN context_shares s ON s.id = i.share_id
      WHERE s.id = ${row.share_id} AND s.revoked_at IS NULL AND s.target_org = ${team.id} ORDER BY i.ordinal` : [];
    if (!items.length && !row.grant_id) return toolJson({ requestId: id, status: "closed", from, note: `${from} didn't share anything for this request.` });
    return toolJson({ requestId: id, status: "answered", from, excerpts: items.map(itemView) });
  } catch {
    return toolError("The request could not be checked right now. Try again shortly.");
  }
}

// ---------------------------------------------------------------------------
// Owner side: /api/approvals in the owner's personal workspace.

async function approver(token: TokenRecord, org: Org, db: postgres.Sql) {
  if (token.kind !== "session" || token.role !== "owner" || !token.email || token.orgId !== org.id || org.kind !== "personal") throw new ShareRequestError("Open your personal workspace to review requests.", 403, "forbidden");
  const rows = await db`SELECT id FROM org_members WHERE org_id = ${org.id} AND email = ${token.email} AND role = 'owner'`;
  if (rows.length !== 1) throw new ShareRequestError("This workspace membership is no longer available.", 403, "forbidden");
  return { email: token.email, memberId: Number(rows[0].id) };
}

function requestView(row: any) {
  return {
    id: String(row.id), question: String(row.question), status: String(row.status),
    team: { id: Number(row.team_org), name: String(row.team_name) },
    requester: String(row.requester_email), agent: String(row.requester_actor),
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    automatic: row.status === "answered" && !row.share_id && !!row.grant_id,
  };
}

export async function listApprovals(token: TokenRecord, org: Org, db: postgres.Sql = sql, now = new Date()) {
  const me = await approver(token, org, db);
  await db`UPDATE context_share_requests SET status = 'expired' WHERE owner_org = ${org.id} AND owner_member_id = ${me.memberId} AND status = 'pending' AND expires_at <= ${now}`;
  const rows = await db`
    SELECT r.*, o.name AS team_name, m.email AS requester_email FROM context_share_requests r
    JOIN orgs o ON o.id = r.team_org JOIN org_members m ON m.id = r.requester_member_id
    WHERE r.owner_org = ${org.id} AND r.owner_member_id = ${me.memberId}
    ORDER BY r.created_at DESC LIMIT 100`;
  const grants = await db`
    SELECT g.*, o.name AS team_name, m.email AS requester_email,
      (SELECT count(*) FROM context_shares s WHERE s.grant_id = g.id AND s.revoked_at IS NULL)::integer AS shares
    FROM context_share_grants g JOIN orgs o ON o.id = g.team_org JOIN org_members m ON m.id = g.requester_member_id
    WHERE g.source_org = ${org.id} AND g.owner_member_id = ${me.memberId} AND g.revoked_at IS NULL AND g.expires_at > ${now}
    ORDER BY g.expires_at`;
  const views = rows.map(requestView);
  return {
    pending: views.filter(view => view.status === "pending"),
    history: views.filter(view => view.status !== "pending").slice(0, 50),
    grants: grants.map(row => ({ id: String(row.id), topic: String(row.topic), team: { id: Number(row.team_org), name: String(row.team_name) }, requester: String(row.requester_email), shares: Number(row.shares), createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() })),
  };
}

async function pendingRequest(org: Org, memberId: number, id: string, db: postgres.Sql, now: Date) {
  if (!UUID.test(id)) throw new ShareRequestError("Request not found.", 404, "not_found");
  const rows = await db`SELECT r.*, m.email AS requester_email, m.role AS requester_role FROM context_share_requests r
    LEFT JOIN org_members m ON m.id = r.requester_member_id AND m.org_id = r.team_org
    WHERE r.id = ${id} AND r.owner_org = ${org.id} AND r.owner_member_id = ${memberId}`;
  const row = rows[0];
  if (!row) throw new ShareRequestError("Request not found.", 404, "not_found");
  if (row.status !== "pending") throw new ShareRequestError("This request has already been answered.", 409, "already_decided");
  if (new Date(row.expires_at).getTime() <= now.getTime()) throw new ShareRequestError("This request lapsed after 24 hours.", 410, "expired");
  if (!row.requester_email || !["owner", "member"].includes(row.requester_role)) throw new ShareRequestError("The person who asked is no longer in that team.", 409, "requester_gone");
  return row;
}

export interface ApprovalDeps { db?: postgres.Sql; now?: () => Date; sharing?: ContextSharingDeps; preview?: typeof previewContextShare; commit?: typeof commitContextShare }

export async function previewRequest(token: TokenRecord, org: Org, id: string, deps: ApprovalDeps = {}) {
  const db = deps.db ?? sql, now = (deps.now ?? (() => new Date()))();
  const me = await approver(token, org, db);
  const row = await pendingRequest(org, me.memberId, id, db, now);
  const preview = await (deps.preview ?? previewContextShare)(token, org, { instruction: String(row.question), recipient: { kind: "team", orgId: Number(row.team_org) } }, deps.sharing);
  return { request: { id: String(row.id), question: String(row.question), requester: String(row.requester_email) }, suggestedTopic: suggestTopic(String(row.question)), preview };
}

export async function approveRequest(token: TokenRecord, org: Org, id: string, input: unknown, publicUrl: string, deps: ApprovalDeps = {}) {
  const db = deps.db ?? sql, now = (deps.now ?? (() => new Date()))();
  const me = await approver(token, org, db);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ShareRequestError("Review and approve exact excerpts.");
  const { mode, topic, ...commit } = input as Record<string, unknown>;
  if (mode !== "once" && mode !== "standing") throw new ShareRequestError("Choose just this once or 90 days.");
  const row = await pendingRequest(org, me.memberId, id, db, now);
  let cleanTopic: string | null = null;
  if (mode === "standing") {
    cleanTopic = typeof topic === "string" && topic.trim() ? redactSecrets(topic.trim()) : String(row.question);
    if (cleanTopic.length < 3 || cleanTopic.length > 200 || /[\u0000-\u001f\u007f]/.test(cleanTopic)) throw new ShareRequestError("The topic must be 3 to 200 characters.");
    if (!topicWords(cleanTopic).length) throw new ShareRequestError("Give the topic at least one specific word.");
  }
  const result = await (deps.commit ?? commitContextShare)(token, org, commit, publicUrl, deps.sharing);
  const shareId = result.share.id;
  if (result.share.recipient.kind !== "team" || result.share.recipient.orgId !== Number(row.team_org)) throw new ShareRequestError("Those excerpts went to a different recipient.", 409, "preview_changed");
  return db.begin(async transaction => {
    const tx = transaction as unknown as postgres.Sql;
    let grantId: string | null = null;
    if (mode === "standing") {
      grantId = randomUUID();
      await tx`INSERT INTO context_share_grants (id, source_org, owner_member_id, team_org, requester_member_id, topic, expires_at)
        VALUES (${grantId}, ${org.id}, ${me.memberId}, ${row.team_org}, ${row.requester_member_id}, ${cleanTopic}, ${new Date(now.getTime() + GRANT_TTL_MS)})`;
      await tx`UPDATE context_shares SET grant_id = ${grantId} WHERE id = ${shareId} AND source_org = ${org.id}`;
    }
    const updated = await tx`UPDATE context_share_requests SET status = 'answered', share_id = ${shareId}, grant_id = ${grantId}, decided_at = ${now}
      WHERE id = ${id} AND status = 'pending' RETURNING id`;
    if (!updated.length) throw new ShareRequestError("This request has already been answered.", 409, "already_decided");
    return { ok: true, share: result.share, grantId, expiresAt: grantId ? new Date(now.getTime() + GRANT_TTL_MS).toISOString() : null };
  });
}

export async function declineRequest(token: TokenRecord, org: Org, id: string, deps: ApprovalDeps = {}) {
  const db = deps.db ?? sql, now = (deps.now ?? (() => new Date()))();
  const me = await approver(token, org, db);
  if (!UUID.test(id)) throw new ShareRequestError("Request not found.", 404, "not_found");
  const rows = await db`UPDATE context_share_requests SET status = 'declined', decided_at = ${now}
    WHERE id = ${id} AND owner_org = ${org.id} AND owner_member_id = ${me.memberId} AND status = 'pending' RETURNING id`;
  if (!rows.length) throw new ShareRequestError("This request is no longer waiting.", 409, "already_decided");
  return { ok: true };
}

export async function revokeGrant(token: TokenRecord, org: Org, id: string, deps: ApprovalDeps = {}) {
  const db = deps.db ?? sql;
  const me = await approver(token, org, db);
  if (!UUID.test(id)) throw new ShareRequestError("Approval not found.", 404, "not_found");
  const rows = await db`UPDATE context_share_grants SET revoked_at = now() WHERE id = ${id} AND source_org = ${org.id} AND owner_member_id = ${me.memberId} AND revoked_at IS NULL RETURNING id`;
  if (!rows.length) throw new ShareRequestError("Approval not found.", 404, "not_found");
  return { ok: true, note: "No more automatic answers. Excerpts already shared stay in the team until you revoke them in Sharing." };
}

export async function handleApprovalsApi(req: Request, token: TokenRecord, org: Org, deps: ApprovalDeps = {}): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  try {
    if (req.headers.get("X-Engram-Console") !== "1") return json({ error: "forbidden", code: "forbidden" }, 403);
    const scope = req.headers.get("X-Engram-Workspace");
    if (!scope) return json({ error: "Select a workspace first.", code: "invalid_request" }, 400);
    if (scope !== String(org.id)) return json({ error: "The selected workspace changed. Start again.", code: "workspace_changed" }, 409);
    const path = new URL(req.url).pathname;
    if (path === "/api/approvals" && req.method === "GET") return json(await listApprovals(token, org, deps.db));
    const grant = path.match(/^\/api\/approvals\/grants\/([^/]+)$/);
    if (grant && req.method === "DELETE") return json(await revokeGrant(token, org, grant[1], deps));
    const action = path.match(/^\/api\/approvals\/([^/]+)\/(preview|approve|decline)$/);
    if (!action || req.method !== "POST") return json({ error: "Method not allowed.", code: "invalid_request" }, 405);
    if (action[2] === "preview") return json(await previewRequest(token, org, action[1], deps));
    if (action[2] === "decline") return json(await declineRequest(token, org, action[1], deps));
    const raw = await req.text();
    if (raw.length > 20_000) return json({ error: "Request is too large.", code: "invalid_request" }, 413);
    let input: unknown; try { input = JSON.parse(raw); } catch { throw new ShareRequestError("Review and approve exact excerpts."); }
    return json(await approveRequest(token, org, action[1], input, publicUrlFrom(req), deps));
  } catch (error) {
    if (error instanceof ShareRequestError || error instanceof ContextSharingError) return json({ error: error.message, code: error.code }, error.status);
    if (error && typeof error === "object" && "status" in error && error.status === 402) return json({ error: "Active workspace access is required to share.", code: "subscription_required" }, 402);
    console.error("[approvals] request failed");
    return json({ error: "Approvals are temporarily unavailable.", code: "unavailable" }, 503);
  }
}
