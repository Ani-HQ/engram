// Local synthetic lifecycle. No provider, account, mail or production credential.
import { callSharedContextTool, contextSnapshotPages } from "../gateway/src/shared-context-read";

type Recipient = { kind: "team"; orgId: number; name: string } | { kind: "agent"; name: string };
type Candidate = { id: string; title: string; text: string; reason: string; sourceKind: string };
const corpus = [
  { text: "Use stable request IDs for background jobs. A retry must not create a second job.", tags: "project architecture decisions retry background jobs", sourceKind: "memory" },
  { text: "Require an explicit approval before a production deployment. Keep a rollback ready.", tags: "project deployment release decisions approval", sourceKind: "memory" },
  { text: "The project design review happens weekly. Personal contact details: [redacted].", tags: "project design planning review contact", sourceKind: "trail" },
  { text: "Personal health appointment and private contact information.", tags: "personal private health contact email", sourceKind: "memory", excluded: true },
];
const previews = new Map<string, { workspaceId: number; instruction: string; recipient: Recipient; candidates: Candidate[]; expiresAt: string; used: boolean }>();
const shares = new Map<string, any>(), credentials = new Map<string, string>(), grantTokens = new Map<string, string>();
// Existing synthetic grants let the local screen demonstrate review, token
// replacement and revocation after reload. No credential is seeded or exposed.
shares.set("f9b450e5-8b66-4e01-8eca-4c8254d766b1", {
  id: "f9b450e5-8b66-4e01-8eca-4c8254d766b1", sourceOrgId: 2,
  instruction: "Share retry conventions. Exclude personal notes.", recipient: { kind: "agent", name: "Example research assistant" },
  itemCount: 1, items: [{ id: "ddca9f4f-f7ac-47c0-95e4-0c69d62c4d6b", title: "Memory excerpt", text: "Retries use a stable request ID to avoid creating a second job." }],
  createdAt: new Date(Date.now() - 86_400_000).toISOString(), revokedAt: null,
});
shares.set("28dc8327-da36-49f0-a941-914e7f3fc4ae", {
  id: "28dc8327-da36-49f0-a941-914e7f3fc4ae", sourceOrgId: 2,
  instruction: "Share deployment approvals only.", recipient: { kind: "team", orgId: 1, name: "Fixture Org" },
  itemCount: 1, items: [{ id: "ffbc36b6-60c7-45f0-b12d-e4c672b02785", title: "Memory excerpt", text: "Require explicit approval before production deployment." }],
  createdAt: new Date(Date.now() - 172_800_000).toISOString(), revokedAt: new Date(Date.now() - 86_400_000).toISOString(),
});
shares.set("1f4385ee-ff57-47b2-8ea0-9ac9239c6d62", {
  id: "1f4385ee-ff57-47b2-8ea0-9ac9239c6d62", sourceOrgId: 2,
  instruction: "Share the agreed retry convention.", recipient: { kind: "team", orgId: 1, name: "Fixture Org" },
  itemCount: 1, items: [{ id: "6c3f58f1-a3e4-4496-989b-86654095f14d", title: "Memory excerpt", text: "Use stable request IDs for background jobs. A retry must not create a second job." }],
  createdAt: new Date(Date.now() - 43_200_000).toISOString(), revokedAt: null,
});
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const error = (message: string, status = 400, code = "invalid_request") => json({ error: message, code }, status);
const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
const keys = (value: any, permitted: string[]) => object(value) && Object.keys(value).every(key => permitted.includes(key));
async function body(req: Request) { try { return await req.json(); } catch { return null; } }
function eligibleRecipient(value: any, session: any): Recipient | null {
  if (value?.kind === "team" && keys(value, ["kind", "orgId"]) && Number.isInteger(value.orgId)) {
    const target = session.orgs.find((org: any) => org.id === value.orgId && org.kind === "team");
    return target ? { kind: "team", orgId: target.id, name: target.name } : null;
  }
  if (value?.kind === "agent" && keys(value, ["kind", "name"]) && typeof value.name === "string" && value.name.trim() && value.name.trim().length <= 80) return { kind: "agent", name: value.name.trim() };
  return null;
}
function issueCredential(share: any, origin: string) {
  const old = grantTokens.get(share.id); if (old) credentials.delete(old);
  const token = "egs_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  credentials.set(token, share.id); grantTokens.set(share.id, token);
  return { token, mcpUrl: origin + "/mcp/shared" };
}
const words = (text: string) => text.toLowerCase().match(/[a-z]{4,}/g)?.map(word => word.replace(/s$/, "")).filter(word => !["share", "include", "exclude", "project", "memory", "memorie", "everything", "anything", "only", "with", "from", "that", "about", "this", "text", "please", "note"].includes(word)) || [];
function candidatePreview(instruction: string): { candidates: Candidate[]; excludedCount: number } {
  const [positive, negative = ""] = instruction.split(/\b(?:exclude|except|without|leave out|do not share)\b/i, 2);
  const include = words(positive), exclude = words(negative);
  const selected = corpus.filter(item => !item.excluded && (!include.length || include.some(word => (item.tags + " " + item.text).toLowerCase().includes(word))) && !exclude.some(word => item.tags.includes(word)));
  return { candidates: selected.slice(0, 12).map(item => ({ id: crypto.randomUUID(), title: item.sourceKind === "trail" ? "Conversation excerpt" : "Memory excerpt", text: item.text, reason: "Synthetic text match. Check that this excerpt fits the instruction and contains no private details.", sourceKind: item.sourceKind })), excludedCount: corpus.length - selected.length };
}

export function demoSharedPages(orgId: number) {
  const active = [...shares.values()].filter(share => !share.revokedAt && share.recipient.kind === "team" && share.recipient.orgId === orgId);
  return active.flatMap(share => contextSnapshotPages(share.items.map((item: any) => ({ id: item.id, shareId: share.id, title: item.title, text: item.text }))).map(page => ({
    ...page, body: page.compiled_truth, scope: "shared-context", created_at: share.createdAt, updated_at: share.createdAt, tags: [], entryCount: 1,
  })));
}

export async function devSharing(req: Request, session: any): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/sharing")) return null;
  const pin = req.headers.get("x-engram-workspace");
  if (!pin) return error("Select a workspace and try again.", 400);
  if (pin !== String(session.org.id)) return error("The selected workspace changed.", 409, "preview_changed");
  const teamRead = req.method === "GET" && url.pathname === "/api/sharing" && session.org.kind === "team" && ["owner", "member"].includes(session.role);
  if (req.headers.get("x-engram-console") !== "1" || (session.role !== "owner" && !teamRead)) return error("Only the signed-in owner can manage sharing.", 403, "forbidden");
  if (req.method === "GET" && url.pathname === "/api/sharing") {
    if (teamRead) {
      const rawLimit = url.searchParams.get("limit") ?? "25", rawOffset = url.searchParams.get("offset") ?? "0";
      if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) return error("Choose a valid page of received shares.");
      const limit = Number(rawLimit), offset = Number(rawOffset);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset > 1_000_000) return error("Choose a valid page of received shares.");
      const received = [...shares.values()].filter(share => !share.revokedAt && share.recipient.kind === "team" && share.recipient.orgId === session.org.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
        .flatMap(share => share.items.map(({ id, title, text }: any) => ({ id, shareId: share.id, title, text })));
      return json({ sourceKind: "team", received: received.slice(offset, offset + limit), more: received.length > offset + limit });
    }
    return json({ targets: session.orgs.filter((org: any) => org.kind === "team").map(({ id, name }: any) => ({ id, name })), shares: [...shares.values()].filter(share => share.sourceOrgId === session.org.id).map(({ sourceOrgId, ...share }) => share), sourceKind: session.org.kind, modelAvailable: false });
  }
  if (session.org.kind !== "personal") return error("Choose a personal workspace to prepare a shared snapshot.", 403, "forbidden");
  if (req.method === "POST" && url.pathname === "/api/sharing/preview") {
    const input = await body(req), recipient = eligibleRecipient(input?.recipient, session);
    if (!keys(input, ["instruction", "recipient"]) || typeof input.instruction !== "string" || input.instruction.trim().length < 5 || input.instruction.trim().length > 1000 || !recipient) return error("Use an instruction and an eligible recipient.");
    const result = candidatePreview(input.instruction.trim()), previewId = crypto.randomUUID(), expiresAt = new Date(Date.now() + 900_000).toISOString();
    previews.set(previewId, { workspaceId: session.org.id, instruction: input.instruction.trim(), recipient, candidates: structuredClone(result.candidates), expiresAt, used: false });
    return json({ previewId, expiresAt, method: "text", scannedCount: corpus.length, consideredCount: corpus.filter(item => !item.excluded).length, maxChunksPerSource: 3, candidateLimit: 12, truncated: false, ...result });
  }
  if (req.method === "POST" && url.pathname === "/api/sharing/commit") {
    const input = await body(req), preview = previews.get(input?.previewId);
    if (!keys(input, ["previewId", "selections", "acknowledged"]) || input.acknowledged !== true || !Array.isArray(input.selections) || input.selections.length < 1 || input.selections.length > 12) return error("Review the selected text and acknowledge its recipient.");
    if (!preview || preview.workspaceId !== session.org.id || preview.used) return error("This preview is no longer available. Preview again.", 409, "preview_changed");
    if (Date.parse(preview.expiresAt) <= Date.now()) return error("This preview expired. Preview again.", 410, "preview_expired");
    if (preview.recipient.kind === "team" && !session.orgs.some((org: any) => org.id === preview.recipient.orgId && org.kind === "team")) return error("The recipient is no longer available.", 409, "unavailable");
    const selected = new Set<string>(), items: any[] = [];
    for (const selection of input.selections) {
      const candidate = preview.candidates.find(item => item.id === selection?.id), text = typeof selection?.text === "string" ? selection.text.trim() : "";
      if (!keys(selection, ["id", "text"]) || !candidate || selected.has(candidate.id) || !text || text.length > 1200 || !candidate.text.includes(text)) return error("Keep only a continuous excerpt of the proposed text.");
      selected.add(candidate.id); items.push({ id: candidate.id, title: candidate.title, text });
    }
    const share = { id: crypto.randomUUID(), sourceOrgId: session.org.id, instruction: preview.instruction, recipient: preview.recipient, itemCount: items.length, items, createdAt: new Date().toISOString(), revokedAt: null };
    shares.set(share.id, structuredClone(share)); preview.used = true;
    const { sourceOrgId, ...visible } = share;
    return json({ share: visible, ...(share.recipient.kind === "agent" ? { credential: issueCredential(share, url.origin) } : {}) });
  }
  const match = /^\/api\/sharing\/([a-f0-9-]+)(\/agent-token)?$/.exec(url.pathname);
  if (match) {
    const share = shares.get(match[1]);
    if (!share || share.sourceOrgId !== session.org.id) return error("Share not found.", 404, "not_found");
    if (req.method === "DELETE" && !match[2]) {
      share.revokedAt ||= new Date().toISOString();
      const token = grantTokens.get(share.id); if (token) credentials.delete(token);
      const { sourceOrgId, ...visible } = share; return json({ share: visible });
    }
    if (req.method === "POST" && match[2]) {
      const input = await body(req);
      if (!keys(input, []) || share.revokedAt || share.recipient.kind !== "agent") return error("Only an active agent share can replace its token.", 409, "unavailable");
      return json({ credential: issueCredential(share, url.origin) });
    }
  }
  return error("Sharing route not found.", 404, "not_found");
}

export async function devSharedMcp(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/mcp/shared") return null;
  const bearer = /^Bearer (egs_[A-Za-z0-9_-]{32})$/.exec(req.headers.get("authorization") || "");
  const share = bearer ? shares.get(credentials.get(bearer[1]) || "") : null;
  if (!share || share.revokedAt || share.recipient.kind !== "agent") return error("Unauthorized approved-context credential.", 401, "forbidden");
  if (req.method !== "POST") return error("Use a JSON-RPC POST request.", 405);
  const input = await body(req);
  if (!object(input) || input.jsonrpc !== "2.0") return error("Invalid JSON-RPC request.");
  if (input.method === "notifications/initialized") return new Response(null, { status: 204, headers });
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id: input.id ?? null, result });
  if (input.method === "initialize") return reply({ protocolVersion: input.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Engram synthetic approved context", version: "1" } });
  if (input.method === "tools/list") return reply({ tools: ["recall", "search", "list_pages", "get_page", "whoami"].map(name => ({
    name, description: "Read approved synthetic snapshot text only.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, slug: { type: "string" }, limit: { type: "number" }, offset: { type: "number" }, full: { type: "boolean" } } },
  })) });
  if (input.method === "tools/call") return reply(callSharedContextTool(contextSnapshotPages(share.items.map((item: any) => ({ ...item, shareId: share.id }))), input.params?.name, input.params?.arguments || {}));
  return json({ jsonrpc: "2.0", id: input.id ?? null, error: { code: -32601, message: "Only approved-context read tools are available." } });
}
