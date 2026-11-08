import type postgres from "postgres";
import { sql } from "./db";
import { config } from "./config";
import type { Org } from "./orgs";
import { normalizeToken, parsePolicies, type TokenRecord } from "./policies";
import { contextMaxBytes, MIN_CONTEXT_BYTES } from "./mcp-context";

// Linked workspaces: a person lets one of their personal agent connections read
// a team they belong to. The link row is the authority. The `workspace` tool
// argument only picks one of this connection's existing links; it never grants
// anything. Every use re-checks the exact team membership and the team policy.

export const LINKED_READ_TOOLS = new Set(["recall", "search", "list_pages", "get_page", "find_tasks", "resume_task", "list_actions"]);
export const FAN_OUT_TOOLS = new Set(["recall", "search"]);
// Teammate requests can also be made from a linked team; the person's team
// membership is resolved from the credential, never from arguments.
export const LINKED_REQUEST_TOOLS = new Set(["ask_teammate", "get_request"]);
export const WORKSPACE_PROPERTY = {
  type: "string",
  maxLength: 100,
  description: "Optional. A linked team's slug to read it instead of this connection's own workspace, or \"all\" (recall and search only) to include every linked team. Call list_workspaces to see the choices.",
};
const LINK_LIMIT = 50;

export class LinkedWorkspaceError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_request") { super(message); }
}

export interface LinkActor { kind: "token" | "oauth"; name: string }
export interface LinkedTarget { linkId: number; orgId: number; name: string; slug: string; memberId: number }

/** Only agent credentials can be linked. Console sessions never use /mcp links. */
export function linkActor(token: TokenRecord): LinkActor | null {
  return token.kind === "token" || token.kind === "oauth" ? { kind: token.kind, name: token.name } : null;
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Active, still-valid links for this connection. A link counts only while:
 * the home workspace is personal and the granting person still owns it; the
 * exact recorded team membership still exists for that person; and the team
 * still allows linked reads. Removing and rejoining a team never revives a link.
 */
export async function activeLinks(home: { id: number; kind: string }, actor: LinkActor, db: postgres.Sql = sql): Promise<LinkedTarget[]> {
  if (home.kind !== "personal") return [];
  const rows = await db`
    SELECT l.id AS link_id, o.id AS org_id, o.name, o.slug, m.id AS member_id
    FROM connection_workspace_links l
    JOIN orgs o ON o.id = l.target_org_id AND o.kind = 'team'
    JOIN org_members m ON m.id = l.target_membership_id AND m.org_id = l.target_org_id
      AND m.email = l.granted_by_email AND m.role IN ('owner', 'member')
    JOIN orgs h ON h.id = l.home_org_id AND h.kind = 'personal'
    JOIN org_members hm ON hm.org_id = l.home_org_id AND hm.email = l.granted_by_email AND hm.role = 'owner'
    WHERE l.home_org_id = ${home.id} AND l.actor_kind = ${actor.kind} AND l.actor_name = ${actor.name}
      AND l.revoked_at IS NULL
      AND coalesce((o.policies->>'linkedReads')::boolean, true) = true
    ORDER BY o.name, o.id
    LIMIT ${LINK_LIMIT}`;
  return rows.map(row => ({ linkId: Number(row.link_id), orgId: Number(row.org_id), name: String(row.name), slug: String(row.slug), memberId: Number(row.member_id) }));
}

/** The read-only identity used inside a linked team. It can never write. */
export function linkedToken(actor: TokenRecord, target: { orgId: number }): TokenRecord {
  return normalizeToken({
    name: `linked:${actor.name}`.slice(0, 600),
    orgId: target.orgId,
    role: "agent",
    canWrite: false,
    kind: actor.kind,
    email: actor.email,
    scopes: actor.scopes,
  });
}

export type WorkspacePlan =
  | { kind: "home"; args: Record<string, unknown> }
  | { kind: "error"; result: ReturnType<typeof toolError> }
  | { kind: "linked"; includeHome: boolean; targets: LinkedTarget[]; args: Record<string, unknown> };

/** Decide where a tools/call runs. Pure apart from the link lookup. */
export async function planWorkspaceCall(
  home: { id: number; slug: string; kind: string },
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
  lookup: (home: { id: number; kind: string }, actor: LinkActor) => Promise<LinkedTarget[]> = activeLinks,
): Promise<WorkspacePlan> {
  if (!args || typeof args !== "object" || !Object.prototype.hasOwnProperty.call(args, "workspace")) return { kind: "home", args };
  const { workspace, ...rest } = args;
  if (workspace === undefined || workspace === null || workspace === "") return { kind: "home", args: rest };
  if (typeof workspace !== "string" || workspace.length > 100) return { kind: "error", result: toolError("workspace must be a workspace slug, or \"all\" for recall and search.") };
  const wanted = workspace.trim().toLowerCase();
  if (wanted === home.slug) return { kind: "home", args: rest };
  if (!LINKED_READ_TOOLS.has(name) && !LINKED_REQUEST_TOOLS.has(name)) {
    return { kind: "error", result: toolError(`${name} only works in this connection's own workspace. To save to a team, connect an agent directly to it, or share reviewed excerpts from Sharing.`) };
  }
  const actor = linkActor(token);
  const links = actor ? await lookup(home, actor) : [];
  if (wanted === "all") {
    if (!FAN_OUT_TOOLS.has(name)) return { kind: "error", result: toolError("workspace \"all\" works with recall and search. Pick one workspace for other tools.") };
    return { kind: "linked", includeHome: true, targets: links, args: rest };
  }
  const target = links.find(link => link.slug === wanted);
  // One answer for unknown, unlinked, stale or disabled, so probing reveals nothing.
  if (!target) return { kind: "error", result: toolError(`This connection isn't linked to a workspace called "${wanted.slice(0, 100)}". Call list_workspaces to see linked teams and how to link one.`) };
  return { kind: "linked", includeHome: false, targets: [target], args: rest };
}

export interface LinkedRunDeps {
  getOrg: (id: number) => Promise<Org | null>;
  /** Runs one call inside a workspace with the given actor. */
  run: (org: Org, actor: TokenRecord, args: Record<string, unknown>, maxBytes: number | undefined) => Promise<any>;
  runHome: (args: Record<string, unknown>, maxBytes: number | undefined) => Promise<any>;
}

function label(text: string) { return { type: "text", text }; }
function contentOf(result: any): any[] { return Array.isArray(result?.content) ? result.content : []; }

/** Execute a linked plan and label every result with where it came from. */
export async function runLinkedPlan(
  plan: Extract<WorkspacePlan, { kind: "linked" }>,
  token: TokenRecord,
  home: { name: string; slug: string },
  requestedMaxBytes: unknown,
  deps: LinkedRunDeps,
): Promise<any> {
  const parts = (plan.includeHome ? 1 : 0) + plan.targets.length;
  const share = parts > 1 ? Math.max(MIN_CONTEXT_BYTES, Math.floor(contextMaxBytes(requestedMaxBytes) / parts)) : (typeof requestedMaxBytes === "number" ? requestedMaxBytes : undefined);
  const content: any[] = [];
  let anyOk = false;
  if (plan.includeHome) {
    const result = await deps.runHome(plan.args, share);
    content.push(label(`From ${home.name} (${home.slug}), this connection's own workspace:`), ...contentOf(result));
    anyOk ||= !result?.isError;
  }
  for (const target of plan.targets) {
    const org = await deps.getOrg(target.orgId);
    if (!org || org.kind !== "team") { content.push(label(`${target.name} (${target.slug}) is not available right now.`)); continue; }
    try {
      const result = await deps.run(org, linkedToken(token, target), plan.args, share);
      content.push(label(`From ${org.name} (${org.slug}), a linked team, read-only:`), ...contentOf(result));
      anyOk ||= !result?.isError;
    } catch {
      content.push(label(`${org.name} (${org.slug}) could not be read right now. Try again shortly.`));
    }
  }
  if (plan.includeHome && !plan.targets.length) content.push(label("No teams are linked to this connection yet. Call list_workspaces to see how to link one."));
  return { content, ...(anyOk ? {} : { isError: true }) };
}

/** list_workspaces: what this connection can read, and what it could link. */
export async function workspaceChoices(home: { id: number; name: string; slug: string; kind: string }, token: TokenRecord, db: postgres.Sql = sql, publicUrl = config.publicUrl) {
  const actor = linkActor(token);
  const linked = actor ? await activeLinks(home, actor, db) : [];
  let available: { name: string; slug: string; linkUrl: string; note?: string }[] = [];
  if (home.kind === "personal" && actor) {
    const rows = await db`
      SELECT o.id, o.name, o.slug, o.policies FROM orgs o
      JOIN org_members m ON m.org_id = o.id AND m.role IN ('owner', 'member')
      JOIN org_members hm ON hm.email = m.email AND hm.org_id = ${home.id} AND hm.role = 'owner'
      WHERE o.kind = 'team' ORDER BY o.name, o.id LIMIT ${LINK_LIMIT}`;
    const base = publicUrl || "";
    available = rows.filter(row => !linked.some(link => link.orgId === Number(row.id))).map(row => {
      const allowed = parsePolicies(row.policies).linkedReads;
      return {
        name: String(row.name), slug: String(row.slug),
        linkUrl: `${base}/app#connections`,
        ...(allowed ? {} : { note: "This team's owners have turned off linked reads." }),
      };
    });
  }
  return {
    workspace: { name: home.name, slug: home.slug, kind: home.kind },
    linked: linked.map(link => ({ name: link.name, slug: link.slug, access: "read-only" })),
    notLinked: available,
    howToLink: home.kind !== "personal"
      ? "Linking is available for connections to a personal workspace."
      : available.length
        ? "Ask the person to open Connections in Engram and turn on \"Also read from\" for the team. This connection can't link itself."
        : "There are no other teams to link.",
  };
}

// ---------------------------------------------------------------------------
// Console API: /api/linked-workspaces
// Personal workspace (owner): list connections × teams, link, unlink.
// Team workspace: owners and members see linked connections; owners revoke.

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

async function homeOwner(token: TokenRecord, org: Org, db: postgres.Sql) {
  if (token.kind !== "session" || token.role !== "owner" || !token.email || token.orgId !== org.id || org.kind !== "personal") throw new LinkedWorkspaceError("Open your personal workspace to manage linked teams.", 403, "forbidden");
  const rows = await db`SELECT id FROM org_members WHERE org_id = ${org.id} AND email = ${token.email} AND role = 'owner'`;
  if (rows.length !== 1) throw new LinkedWorkspaceError("This workspace membership is no longer available.", 403, "forbidden");
  return token.email;
}

export interface ConnectionSummary { agent: string; kind: "token" | "oauth"; displayName: string; status: string; archivedAt: string | null }

export async function listHomeLinks(token: TokenRecord, org: Org, connections: ConnectionSummary[], db: postgres.Sql = sql) {
  const email = await homeOwner(token, org, db);
  const teams = await db`
    SELECT o.id, o.name, o.slug, o.policies FROM orgs o JOIN org_members m ON m.org_id = o.id
    WHERE m.email = ${email} AND m.role IN ('owner', 'member') AND o.kind = 'team' ORDER BY o.name, o.id LIMIT ${LINK_LIMIT}`;
  const links = await db`
    SELECT l.id, l.actor_kind, l.actor_name, l.target_org_id, l.created_at FROM connection_workspace_links l
    JOIN org_members m ON m.id = l.target_membership_id AND m.org_id = l.target_org_id AND m.email = l.granted_by_email
    WHERE l.home_org_id = ${org.id} AND l.revoked_at IS NULL ORDER BY l.created_at`;
  return {
    teams: teams.map(row => ({ id: Number(row.id), name: String(row.name), slug: String(row.slug), linkedReads: parsePolicies(row.policies).linkedReads })),
    connections: connections.filter(c => c.status === "authorized" && !c.archivedAt).map(c => ({ agent: c.agent, kind: c.kind, displayName: c.displayName })),
    links: links.map(row => ({ id: Number(row.id), agent: String(row.actor_name), kind: String(row.actor_kind), teamId: Number(row.target_org_id), createdAt: new Date(row.created_at).toISOString() })),
  };
}

export async function createLink(token: TokenRecord, org: Org, input: unknown, connections: ConnectionSummary[], db: postgres.Sql = sql) {
  const email = await homeOwner(token, org, db);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LinkedWorkspaceError("Choose a connection and a team.");
  const { agent, teamId } = input as Record<string, unknown>;
  if (typeof agent !== "string" || !Number.isSafeInteger(teamId) || Number(teamId) < 1) throw new LinkedWorkspaceError("Choose a connection and a team.");
  const connection = connections.find(c => c.agent === agent && c.status === "authorized" && !c.archivedAt);
  if (!connection) throw new LinkedWorkspaceError("That connection isn't active in this workspace.", 404, "not_found");
  return db.begin(async transaction => {
    const tx = transaction as unknown as postgres.Sql;
    const team = await tx`
      SELECT o.id, o.name, o.slug, o.policies, m.id AS member_id FROM orgs o JOIN org_members m ON m.org_id = o.id
      WHERE o.id = ${Number(teamId)} AND o.kind = 'team' AND m.email = ${email} AND m.role IN ('owner', 'member') FOR SHARE OF m, o`;
    if (team.length !== 1) throw new LinkedWorkspaceError("You're not a member of that team.", 403, "forbidden");
    if (!parsePolicies(team[0].policies).linkedReads) throw new LinkedWorkspaceError("This team's owners have turned off linked reads.", 403, "linking_disabled");
    const existing = await tx`SELECT id FROM connection_workspace_links WHERE home_org_id = ${org.id} AND actor_kind = ${connection.kind} AND actor_name = ${connection.agent} AND target_org_id = ${Number(teamId)} AND revoked_at IS NULL FOR UPDATE`;
    if (existing.length) {
      // A membership from an earlier stay is not this membership. Replace it.
      await tx`UPDATE connection_workspace_links SET revoked_at = now(), revoked_by_email = ${email} WHERE id = ${existing[0].id} AND target_membership_id <> ${team[0].member_id}`;
      const still = await tx`SELECT id, created_at FROM connection_workspace_links WHERE id = ${existing[0].id} AND revoked_at IS NULL`;
      if (still.length) return { link: { id: Number(still[0].id), agent: connection.agent, kind: connection.kind, teamId: Number(teamId), createdAt: new Date(still[0].created_at).toISOString() } };
    }
    const [row] = await tx`
      INSERT INTO connection_workspace_links (home_org_id, actor_kind, actor_name, target_org_id, target_membership_id, granted_by_email)
      VALUES (${org.id}, ${connection.kind}, ${connection.agent}, ${Number(teamId)}, ${team[0].member_id}, ${email}) RETURNING id, created_at`;
    return { link: { id: Number(row.id), agent: connection.agent, kind: connection.kind, teamId: Number(teamId), createdAt: new Date(row.created_at).toISOString() } };
  });
}

export async function revokeHomeLink(token: TokenRecord, org: Org, id: number, db: postgres.Sql = sql) {
  const email = await homeOwner(token, org, db);
  const rows = await db`UPDATE connection_workspace_links SET revoked_at = now(), revoked_by_email = ${email}
    WHERE id = ${id} AND home_org_id = ${org.id} AND revoked_at IS NULL RETURNING id`;
  if (!rows.length) throw new LinkedWorkspaceError("Link not found.", 404, "not_found");
  return { ok: true };
}

/** Team side: who has linked a personal connection into this team. */
export async function listTeamLinks(token: TokenRecord, org: Org, db: postgres.Sql = sql) {
  if (token.kind !== "session" || !["owner", "member"].includes(token.role) || !token.email || token.orgId !== org.id || org.kind !== "team") throw new LinkedWorkspaceError("Sign in to this team to see linked connections.", 403, "forbidden");
  const rows = await db`
    SELECT l.id, l.actor_kind, l.actor_name, l.granted_by_email, l.created_at FROM connection_workspace_links l
    JOIN org_members m ON m.id = l.target_membership_id AND m.org_id = l.target_org_id AND m.email = l.granted_by_email AND m.role IN ('owner', 'member')
    WHERE l.target_org_id = ${org.id} AND l.revoked_at IS NULL ORDER BY l.created_at DESC LIMIT 200`;
  return {
    linkedReads: org.policies.linkedReads,
    canRevoke: token.role === "owner",
    links: rows.map(row => ({ id: Number(row.id), member: String(row.granted_by_email), agent: String(row.actor_name), kind: String(row.actor_kind), createdAt: new Date(row.created_at).toISOString() })),
  };
}

export async function revokeTeamLink(token: TokenRecord, org: Org, id: number, db: postgres.Sql = sql) {
  if (token.kind !== "session" || token.role !== "owner" || !token.email || token.orgId !== org.id || org.kind !== "team") throw new LinkedWorkspaceError("Only a team owner can revoke linked connections.", 403, "forbidden");
  const owners = await db`SELECT id FROM org_members WHERE org_id = ${org.id} AND email = ${token.email} AND role = 'owner'`;
  if (!owners.length) throw new LinkedWorkspaceError("Only a team owner can revoke linked connections.", 403, "forbidden");
  const rows = await db`UPDATE connection_workspace_links SET revoked_at = now(), revoked_by_email = ${token.email}
    WHERE id = ${id} AND target_org_id = ${org.id} AND revoked_at IS NULL RETURNING id`;
  if (!rows.length) throw new LinkedWorkspaceError("Link not found.", 404, "not_found");
  return { ok: true };
}

export async function handleLinkedWorkspacesApi(
  req: Request,
  token: TokenRecord,
  org: Org,
  connections: () => Promise<ConnectionSummary[]>,
  db: postgres.Sql = sql,
): Promise<Response> {
  try {
    if (req.headers.get("X-Engram-Console") !== "1") return json({ error: "forbidden", code: "forbidden" }, 403);
    const scope = req.headers.get("X-Engram-Workspace");
    if (!scope) return json({ error: "Select a workspace first.", code: "invalid_request" }, 400);
    if (scope !== String(org.id)) return json({ error: "The selected workspace changed. Start again.", code: "workspace_changed" }, 409);
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const linkId = id && /^[1-9]\d{0,15}$/.test(id) ? Number(id) : null;
    if (org.kind === "personal") {
      if (req.method === "GET") return json(await listHomeLinks(token, org, await connections(), db));
      if (req.method === "POST") {
        const raw = await req.text();
        if (raw.length > 2_000) return json({ error: "Request is too large.", code: "invalid_request" }, 413);
        let input: unknown; try { input = JSON.parse(raw); } catch { throw new LinkedWorkspaceError("Choose a connection and a team."); }
        return json(await createLink(token, org, input, await connections(), db));
      }
      if (req.method === "DELETE") { if (!linkId) throw new LinkedWorkspaceError("Choose a link."); return json(await revokeHomeLink(token, org, linkId, db)); }
    } else {
      if (req.method === "GET") return json(await listTeamLinks(token, org, db));
      if (req.method === "DELETE") { if (!linkId) throw new LinkedWorkspaceError("Choose a link."); return json(await revokeTeamLink(token, org, linkId, db)); }
    }
    return json({ error: "Method not allowed.", code: "invalid_request" }, 405);
  } catch (error) {
    if (error instanceof LinkedWorkspaceError) return json({ error: error.message, code: error.code }, error.status);
    console.error("[linked] request failed");
    return json({ error: "Linked workspaces are temporarily unavailable.", code: "unavailable" }, 503);
  }
}

