export function methodLabel(method) {
  return { rule: "Rule check", model: "Model judgment", extractive: "Extractive brief", lexical: "Text match" }[method] || "Method unavailable";
}

export function confidenceLabel(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? `${Math.round(value * 100)}% model confidence` : null;
}

export function citedSources(result, ids = []) {
  const wanted = new Set(ids);
  return (result?.sourceActions || []).filter(source => wanted.has(source.id));
}

export function reviewAllowed(session) {
  return session?.role === "owner" || (session?.role === "member" && session.org?.policies?.reviewApprovers !== "owners");
}

export function validReviewSlug(value) {
  return typeof value === "string" && value.length <= 240 && /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(value)
    && value.split("/").every(part => part && part !== "." && part !== "..");
}

// Describe the existing review/apply.ts operations. These are change previews,
// not interpretations of a model's reasoning or promises of an unavailable undo.
export function reviewPlan(item, entry) {
  const payload = item.payload || {};
  const otherSlug = typeof payload.otherSlug === "string" ? payload.otherSlug : null;
  if (["duplicate", "refine", "contradict"].includes(item.kind)) {
    return { supported: validReviewSlug(entry?.slug) && validReviewSlug(otherSlug), title: "Add a relationship", target: entry?.slug,
      change: `Link ${entry?.slug || "the source entry"} to ${otherSlug || "the related memory"} with the relation “${item.kind}”.`,
      note: "The source memory text stays intact. The review decision is recorded in meta/review-decisions." };
  }
  if (item.kind === "supersede") return { supported: validReviewSlug(entry?.slug), title: "Mark an entry superseded", target: entry?.slug,
    change: `Mark entry ${item.entryId || "unknown"} as superseded${otherSlug ? " and tag its page as superseded" : ""}.`, note: "The original text stays stored; its memory entry status changes." };
  if (item.kind === "stale") return { supported: validReviewSlug(entry?.slug), title: "Tag a memory as stale", target: entry?.slug,
    change: `Add the stale tag to ${entry?.slug || "the source page"}.`, note: "The memory text stays intact. This marks it for attention rather than deleting it." };
  if (item.kind === "cluster") {
    const topic = payload.topic || payload.clusterSlug || payload.slug;
    const target = typeof topic === "string" ? topic.startsWith("meta/") ? topic : `meta/clusters/${topic}` : null;
    const members = Array.isArray(payload.members) ? payload.members : [];
    return { supported: validReviewSlug(target) && target.startsWith("meta/clusters/") && members.length > 0 && members.length <= 200 && members.every(validReviewSlug), title: "Write a cluster page", target,
      change: `Create or replace ${target || "the proposed cluster page"} with links to the proposed members.`, note: "Existing content at that cluster page may be replaced. The member pages stay intact." };
  }
  if (["topic_route", "uncertain_relation"].includes(item.kind)) return { supported: true, title: "Record a review decision", target: "meta/review-decisions",
    change: `Record approval of this ${item.kind.replaceAll("_", " ")} proposal in the review log.`, note: "The current review action does not move or rewrite the source memory." };
  return { supported: false, title: "Proposal details", target: null, change: "This proposal type has no supported approval action.", note: "You can defer or reject it without changing memory." };
}
