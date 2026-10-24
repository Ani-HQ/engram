import { describe, expect, test } from "bun:test";
import { citedSources, confidenceLabel, methodLabel, reviewAllowed, reviewPlan, validReviewSlug } from "./insight-model.js";

describe("insight presentation boundaries", () => {
  test("separates rule checks, model judgments, extractive briefs, and text matches", () => {
    expect(methodLabel("rule")).toBe("Rule check");
    expect(methodLabel("model")).toBe("Model judgment");
    expect(methodLabel("extractive")).toBe("Extractive brief");
    expect(methodLabel("lexical")).toBe("Text match");
    expect(methodLabel("invented")).toBe("Method unavailable");
    expect(confidenceLabel(0.8)).toBe("80% model confidence");
    for (const invalid of [null, "0.8", NaN, Infinity, -1, 2]) expect(confidenceLabel(invalid)).toBeNull();
  });

  test("shows evidence previews only for explicit source citations", () => {
    const source = { id: "cited", summary: "A cited action", evidence: "reported" };
    expect(citedSources({ sourceActions: [source, { id: "unrelated", summary: "Unrelated private context" }] }, ["cited"])).toEqual([source]);
    expect(citedSources({ sourceActions: [source] }, ["missing"])).toEqual([]);
    expect(citedSources(null, ["cited"])).toEqual([]);
  });
});

describe("memory review change previews", () => {
  const entry = { slug: "context/source", id: "entry-1", rawText: "Original source" };

  test("enforces review role policy and requires complete relationship evidence", () => {
    expect(reviewAllowed({ role: "owner" })).toBe(true);
    expect(reviewAllowed({ role: "member", org: { policies: { reviewApprovers: "members" } } })).toBe(true);
    expect(reviewAllowed({ role: "member", org: { policies: { reviewApprovers: "owners" } } })).toBe(false);
    expect(reviewAllowed({ role: "agent" })).toBe(false);
    const item = { kind: "contradict", payload: { otherSlug: "context/other" } };
    const preview = reviewPlan(item, entry);
    expect(preview.supported).toBe(true);
    expect(preview.change).toContain("context/source");
    expect(preview.change).toContain("context/other");
    expect(preview.change).toContain("contradict");
    expect(reviewPlan(item, null).supported).toBe(false);
    expect(reviewPlan({ ...item, payload: {} }, entry).supported).toBe(false);
  });

  test("describes replacement and unsupported operations without promising undo", () => {
    const cluster = reviewPlan({ kind: "cluster", payload: { clusterSlug: "my-context", members: ["context/source"] } }, null);
    expect(cluster.target).toBe("meta/clusters/my-context");
    expect(cluster.change).toContain("Create or replace");
    expect(cluster.note).toContain("may be replaced");
    expect(reviewPlan({ kind: "cluster", payload: {} }, null).supported).toBe(false);
    expect(reviewPlan({ kind: "cluster", payload: { slug: "meta/clusters/real-generated", members: ["context/source"] } }, null).supported).toBe(true);
    for (const slug of ["meta/review-decisions", "meta/clusters/../private", "meta/clusters/a//b", "meta/clusters/bad\nname"]) expect(reviewPlan({ kind: "cluster", payload: { slug, members: ["context/source"] } }, null).supported).toBe(false);
    for (const slug of ["../private", "a/../private", "a//b", "a\\b", "a]]\n[[private", "a b"]) expect(validReviewSlug(slug)).toBe(false);
    expect(reviewPlan({ kind: "arbitrary_delete", payload: {} }, entry).supported).toBe(false);
    expect(reviewPlan({ kind: "stale", payload: {} }, entry).change).toContain("stale tag");
    expect(reviewPlan({ kind: "supersede", entryId: "entry-1", payload: {} }, entry).change).toContain("superseded");
    expect(reviewPlan({ kind: "topic_route", payload: {} }, entry).note).toContain("does not move or rewrite");
  });
});
