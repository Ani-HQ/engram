export type ActorRole = "owner" | "member" | "agent";
export type CredentialKind = "token" | "session" | "oauth";
export type ReviewApprovers = "owners" | "members";
export type OrgKind = "team" | "personal";
export type ShareLevel = "digest" | "digest_transcript" | "transcript";

export interface TokenRecord {
  name: string;
  orgId: number;
  role: ActorRole;
  canWrite: boolean;
  kind: CredentialKind;
  email: string | null;
  scopes: string[];
}

export interface OrgPolicies {
  agentsMayWrite: boolean;
  membersOnlyDelete: boolean;
  jevMayPropose: boolean;
  reviewApprovers: ReviewApprovers;
  acceptShares: boolean;
  maxShareLevel: ShareLevel;
}

export const SHARE_LEVELS: ShareLevel[] = ["digest", "digest_transcript", "transcript"];

export const DEFAULT_POLICIES: OrgPolicies = {
  agentsMayWrite: true,
  membersOnlyDelete: true,
  jevMayPropose: true,
  reviewApprovers: "members",
  acceptShares: true,
  maxShareLevel: "digest",
};

const SHARE_RANK: Record<ShareLevel, number> = {
  digest: 0,
  digest_transcript: 1,
  transcript: 2,
};

export function parseShareLevel(value: unknown, fallback: ShareLevel = "digest"): ShareLevel {
  return typeof value === "string" && SHARE_LEVELS.includes(value as ShareLevel)
    ? value as ShareLevel
    : fallback;
}

export function capShareLevel(requested: ShareLevel, max: ShareLevel): ShareLevel {
  return SHARE_RANK[requested] <= SHARE_RANK[max] ? requested : max;
}

const WRITE_TOOLS = new Set([
  "put_page",
  "add_tag",
  "add_link",
  "add_timeline_entry",
  "remember",
]);

const DELETE_TOOLS = new Set(["delete_page", "restore_page"]);

export function parsePolicies(value: unknown): OrgPolicies {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    agentsMayWrite: raw.agentsMayWrite !== false,
    membersOnlyDelete: raw.membersOnlyDelete !== false,
    jevMayPropose: raw.jevMayPropose !== false,
    reviewApprovers: raw.reviewApprovers === "owners" ? "owners" : "members",
    acceptShares: raw.acceptShares !== false,
    maxShareLevel: parseShareLevel(raw.maxShareLevel, "digest"),
  };
}

export function normalizeToken(token: { name: string } & Partial<TokenRecord>): TokenRecord {
  const role: ActorRole = token.role === "owner" || token.role === "member" || token.role === "agent"
    ? token.role
    : "agent";
  return {
    name: token.name,
    orgId: Number.isFinite(token.orgId) ? Number(token.orgId) : 1,
    role,
    canWrite: token.canWrite !== false,
    kind: token.kind === "session" || token.kind === "oauth" ? token.kind : "token",
    email: token.email ?? null,
    scopes: token.scopes ?? [],
  };
}

export function isHuman(token: TokenRecord): boolean {
  return token.role === "owner" || token.role === "member";
}

export function canManageOrg(token: TokenRecord): boolean {
  return token.role === "owner";
}

export function canWrite(token: TokenRecord, policies: OrgPolicies): boolean {
  if (isHuman(token)) return true;
  return token.canWrite && policies.agentsMayWrite;
}

export function canDelete(token: TokenRecord, policies: OrgPolicies): boolean {
  if (isHuman(token)) return true;
  if (policies.membersOnlyDelete) return false;
  return canWrite(token, policies);
}

export function canApproveReview(token: TokenRecord, policies: OrgPolicies): boolean {
  if (token.role === "owner") return true;
  if (token.role === "member") return policies.reviewApprovers === "members";
  return false;
}

export function canUseTool(token: TokenRecord, name: string, policies: OrgPolicies): boolean {
  if (DELETE_TOOLS.has(name)) return canDelete(token, policies);
  if (WRITE_TOOLS.has(name)) return canWrite(token, policies);
  return true;
}

export function hasOauthScope(token: TokenRecord, needed: "memory:read" | "memory:write"): boolean {
  if (token.kind !== "oauth") return true;
  if (token.scopes.includes(needed)) return true;
  if (needed === "memory:read" && token.scopes.includes("memory:write")) return true;
  const custom = token.scopes.filter(scope => scope.startsWith("memory:"));
  // Chat connectors grant openid/email, not always memory:*.
  // Membership is the gate until a token actually carries memory scopes.
  return custom.length === 0;
}
