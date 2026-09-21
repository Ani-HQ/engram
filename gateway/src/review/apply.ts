import { audit } from "../audit";
import type { TokenRecord } from "../auth";
import { brainClient } from "../brain";
import { getMemoryEntry, setEntryStatus } from "../memory-entries";
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
  const current = await getReviewItem(id);
  if (!current) return { item: null, error: "not found" };
  if (current.state !== "pending") return { item: current, error: "already resolved" };

  if (action === "reject") {
    const item = await setReviewState(id, "rejected", token.name);
    await audit(token.name, "review_reject", JSON.stringify({ id }), item ? "ok" : "error", slugFrom(current));
    return { item };
  }
  if (action === "defer") {
    const item = await setReviewState(id, "deferred", token.name);
    await audit(token.name, "review_defer", JSON.stringify({ id }), item ? "ok" : "error", slugFrom(current));
    return { item };
  }

  if (!SAFE_KINDS.has(current.kind)) {
    return { item: current, error: "unsafe kind" };
  }

  try {
    await applySafeAction(token, current);
  } catch (e) {
    await audit(token.name, "review_approve", JSON.stringify({ id }), "error", slugFrom(current));
    return { item: current, error: String(e).slice(0, 160) };
  }

  const item = await setReviewState(id, "applied", token.name);
  await audit(token.name, "review_approve", JSON.stringify({ id, kind: current.kind }), "ok", slugFrom(current));
  return { item };
}

async function applySafeAction(token: TokenRecord, item: ReviewItem): Promise<void> {
  const entry = item.entryId ? await getMemoryEntry(item.entryId) : null;
  const otherSlug = textField(item.payload, "otherSlug");
  const topic = textField(item.payload, "topic") ?? textField(item.payload, "clusterSlug");

  if ((item.kind === "duplicate" || item.kind === "refine" || item.kind === "contradict") && entry && otherSlug) {
    await brainClient().callTool({
      name: "add_link",
      arguments: { from: entry.slug, to: otherSlug, relation: item.kind },
    }).catch(() => brainClient().callTool({
      name: "add_link",
      arguments: { source: entry.slug, target: otherSlug },
    }));
  }

  if (item.kind === "supersede" && entry) {
    await setEntryStatus(entry.id, "superseded");
    if (otherSlug) {
      await brainClient().callTool({
        name: "add_tag",
        arguments: { slug: entry.slug, tag: "superseded" },
      }).catch(() => {});
    }
  }

  if (item.kind === "stale" && entry) {
    await brainClient().callTool({
      name: "add_tag",
      arguments: { slug: entry.slug, tag: "stale" },
    }).catch(() => {});
  }

  if (item.kind === "cluster" && topic) {
    const slug = topic.startsWith("meta/") ? topic : `meta/clusters/${topic}`;
    const title = textField(item.payload, "title") ?? slug;
    const members = Array.isArray(item.payload.members) ? item.payload.members : [];
    const body = [
      `---`,
      `title: ${JSON.stringify(title)}`,
      `---`,
      ``,
      `# ${title}`,
      ``,
      ...members.map((member: unknown) => `- [[${String(member)}]]`),
    ].join("\n");
    await brainClient().callTool({
      name: "put_page",
      arguments: { slug, content: body },
    });
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
