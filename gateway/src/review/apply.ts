import { audit } from "../audit";
import type { TokenRecord } from "../auth";
import { brainClient } from "../brain";
import { requireContext } from "../context";
import { canApproveReview, hasOauthScope } from "../policies";
import { getMemoryEntry, setEntryStatus } from "../memory-entries";
import { withMemoryWriteLock } from "../write-coordination";
import { getReviewItem, setReviewState, type ReviewItem } from "./store";

const SAFE_KINDS = new Set([
  "duplicate",
  "contradict",
  "refine",
  "supersede",
  "topic_route",
  "stale",
  "cluster",
  "uncertain_relation",
]);

function parseToolJson(result: any): any {
  if (result?.isError) return null;
  const text = (result?.content ?? []).find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function resolveReview(
  token: TokenRecord,
  id: number,
  action: "approve" | "reject" | "defer",
): Promise<{ item: ReviewItem | null; error?: string }> {
  const ctx = requireContext();
  if (token.orgId !== ctx.org.id || token.name !== ctx.token.name) throw new Error("Review actor and workspace context must match");
  // Permission comes from the authenticated context, never a caller's role copy.
  if (!canApproveReview(ctx.token, ctx.org.policies) || !hasOauthScope(ctx.token, "memory:write")) return { item: null, error: "forbidden" };
  if (!Number.isSafeInteger(id) || id < 1 || !["approve", "reject", "defer"].includes(action)) return { item: null, error: "bad request" };
  // A workspace-wide transaction lock serializes competing resolutions across
  // gateway instances and spans the review log's entire read/modify/write. Engine
  // mutations acquire this same lock reentrantly.
  return withMemoryWriteLock(() => resolveReviewLocked(ctx.token, id, action));
}

async function resolveReviewLocked(token: TokenRecord, id: number, action: "approve" | "reject" | "defer"): Promise<{ item: ReviewItem | null; error?: string }> {
  const current = await getReviewItem(id);
  if (!current) return { item: null, error: "not found" };
  if (current.state !== "pending") return { item: current, error: "already resolved" };
  if (action === "reject") {
    const item = await setReviewState(id, "rejected", token.name);
    await audit(token.name, "review_reject", JSON.stringify({ id }), item ? "ok" : "error", slugFrom(current));
    return item ? { item } : { item: current, error: "Review decision could not be saved" };
  }
  if (action === "defer") {
    const item = await setReviewState(id, "deferred", token.name);
    await audit(token.name, "review_defer", JSON.stringify({ id }), item ? "ok" : "error", slugFrom(current));
    return item ? { item } : { item: current, error: "Review decision could not be saved" };
  }

  if (!SAFE_KINDS.has(current.kind)) {
    return { item: current, error: "unsafe kind" };
  }

  try {
    await applySafeAction(token, current);
  } catch {
    await audit(token.name, "review_approve", JSON.stringify({ id }), "error", slugFrom(current));
    return { item: current, error: "The proposed memory change could not be applied" };
  }

  const item = await setReviewState(id, "applied", token.name);
  await audit(token.name, "review_approve", JSON.stringify({ id, kind: current.kind }), item ? "ok" : "error", slugFrom(current));
  return item ? { item } : { item: current, error: "The memory change was applied, but its review state could not be saved. Inspect memory before retrying." };
}

export function safeReviewSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240 && /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(value)
    && value.split("/").every(part => part && part !== "." && part !== "..");
}

export function clusterReviewTarget(payload: Record<string, unknown>): string {
  const topic = textField(payload, "topic") ?? textField(payload, "clusterSlug") ?? textField(payload, "slug");
  const slug = topic?.startsWith("meta/") ? topic : `meta/clusters/${topic ?? ""}`;
  if (!safeReviewSlug(slug) || !slug.startsWith("meta/clusters/") || slug === "meta/clusters") throw new Error("Invalid cluster target");
  return slug;
}

async function changeMemory(name: string, args: Record<string, unknown>) {
  const result = await brainClient().callTool({ name, arguments: args });
  if (result?.isError) throw new Error("Memory engine rejected the change");
  return result;
}

async function applySafeAction(token: TokenRecord, item: ReviewItem): Promise<void> {
  const entry = item.entryId ? await getMemoryEntry(item.entryId) : null;
  const otherSlug = textField(item.payload, "otherSlug");
  if (entry && !safeReviewSlug(entry.slug)) throw new Error("Invalid source page");
  if (otherSlug && !safeReviewSlug(otherSlug)) throw new Error("Invalid related page");
  if (["duplicate", "refine", "contradict"].includes(item.kind) && (!entry || !otherSlug)) throw new Error("Relationship evidence is incomplete");
  if (["supersede", "stale"].includes(item.kind) && !entry) throw new Error("Source entry is unavailable");

  if ((item.kind === "duplicate" || item.kind === "refine" || item.kind === "contradict") && entry && otherSlug) {
    await changeMemory("add_link", { from: entry.slug, to: otherSlug, relation: item.kind })
      .catch(() => changeMemory("add_link", { source: entry.slug, target: otherSlug, relation: item.kind }));
  }

  if (item.kind === "supersede" && entry) {
    await setEntryStatus(entry.id, "superseded");
    if (otherSlug) {
      await changeMemory("add_tag", { slug: entry.slug, tag: "superseded" });
    }
  }

  if (item.kind === "stale" && entry) {
    await changeMemory("add_tag", { slug: entry.slug, tag: "stale" });
  }

  if (item.kind === "cluster") {
    const slug = clusterReviewTarget(item.payload);
    const title = textField(item.payload, "title") ?? slug;
    const members = Array.isArray(item.payload.members) ? item.payload.members : [];
    if (!members.length || members.length > 200 || members.some(member => !safeReviewSlug(member))) throw new Error("Invalid cluster members");
    const body = [
      `---`,
      `title: ${JSON.stringify(title)}`,
      `---`,
      ``,
      `# ${title}`,
      ``,
      ...members.map((member: unknown) => `- [[${String(member)}]]`),
    ].join("\n");
    await changeMemory("put_page", { slug, content: body });
  }

  const note = [
    `Reviewed ${item.kind} #${item.id}`,
    entry ? `entry ${entry.id} on ${entry.slug}` : null,
    otherSlug ? `related ${otherSlug}` : null,
  ].filter(Boolean).join("; ");
  await brainClient().callTool({
    name: "put_page",
    arguments: {
      slug: `meta/review-decisions`,
      content: await appendMetaLog("Review decisions", note),
    },
  }).catch(() => {});
  void token;
}

async function appendMetaLog(title: string, line: string): Promise<string> {
  try {
    const page = parseToolJson(await brainClient().callTool({
      name: "get_page",
      arguments: { slug: "meta/review-decisions" },
    }));
    const prior = typeof page?.compiled_truth === "string" ? page.compiled_truth.trimEnd() : "";
    const stamp = `- ${new Date().toISOString()} — ${line}`;
    if (prior) return `${prior}\n\n${stamp}\n`;
  } catch {
    // first write
  }
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n- ${new Date().toISOString()} — ${line}\n`;
}

function textField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function slugFrom(item: ReviewItem): string | null {
  const payloadSlug = textField(item.payload, "otherSlug") ?? textField(item.payload, "slug");
  return payloadSlug;
}
