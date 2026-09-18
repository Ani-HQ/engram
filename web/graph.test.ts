import { describe, expect, test } from "bun:test";
import { clusterPalette, fitToView, solveLayout } from "./graph.js";

function makeNodes(count: number, clusters = 3) {
  return Array.from({ length: count }, (_, i) => ({
    slug: `notes/page-${i}`,
    title: `Page ${i}`,
    cluster: `cluster-${i % clusters}`,
    contributors: [],
  }));
}

function ring(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    source: `notes/page-${i}`,
    target: `notes/page-${(i + 1) % count}`,
  }));
}

describe("graph layout", () => {
  // Every coordinate went NaN on the first real dataset: an uncapped 1/r² repulsion
  // plus velocity carried between passes was enough for one close pair to throw the
  // whole graph to infinity. Canvas draws nothing for NaN, silently, so the only
  // symptom was a blank rectangle.
  test("every coordinate is finite and on the board", () => {
    const width = 1200;
    const height = 500;
    const { nodes } = solveLayout(makeNodes(96), ring(96), width, height);

    expect(nodes.length).toBe(96);
    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.r)).toBe(true);
    }

    // The layout is free to settle outside the frame; the view is what brings it in.
    // Clamping instead piled every outlying node along the edges.
    const view = fitToView(nodes, width, height);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(view.scale).toBeGreaterThan(0);
    expect(view.scale).toBeLessThanOrEqual(1);
    for (const node of nodes) {
      const screenX = node.x * view.scale + view.x;
      const screenY = node.y * view.scale + view.y;
      expect(screenX).toBeGreaterThanOrEqual(0);
      expect(screenX).toBeLessThanOrEqual(width);
      expect(screenY).toBeGreaterThanOrEqual(0);
      expect(screenY).toBeLessThanOrEqual(height);
    }
  });

  test("survives the degenerate inputs that caused it", () => {
    // All nodes in one cluster, so the seeding has to separate them itself.
    const stacked = solveLayout(makeNodes(40, 1), [], 800, 600);
    for (const node of stacked.nodes) expect(Number.isFinite(node.x)).toBe(true);

    // A single node, an empty graph, and edges pointing at pages that are not here.
    expect(solveLayout(makeNodes(1), [], 800, 600).nodes[0].x).toBeFinite();
    expect(solveLayout([], [], 800, 600).nodes).toEqual([]);
    const dangling = solveLayout(makeNodes(4), [
      { source: "notes/page-0", target: "notes/missing" },
      { source: "notes/page-0", target: "notes/page-0" },
    ], 800, 600);
    // A self-link and a link to a page outside the window are both dropped rather
    // than drawn as an edge to nowhere.
    expect(dangling.links.length).toBe(0);
  });

  test("is deterministic, so the same brain always draws the same way", () => {
    const a = solveLayout(makeNodes(30), ring(30), 900, 500);
    const b = solveLayout(makeNodes(30), ring(30), 900, 500);
    expect(a.nodes.map(n => [Math.round(n.x), Math.round(n.y)]))
      .toEqual(b.nodes.map(n => [Math.round(n.x), Math.round(n.y)]));
  });

  test("node size follows how connected a page is", () => {
    const nodes = makeNodes(6, 1);
    // page-0 is linked to everything; the rest have one link each.
    const edges = [1, 2, 3, 4, 5].map(i => ({ source: "notes/page-0", target: `notes/page-${i}` }));
    const solved = solveLayout(nodes, edges, 800, 600);
    const hub = solved.nodes.find(n => n.slug === "notes/page-0")!;
    const leaf = solved.nodes.find(n => n.slug === "notes/page-3")!;
    expect(hub.degree).toBe(5);
    expect(hub.r).toBeGreaterThan(leaf.r);
  });

  test("gives each cluster its own colour and keeps the accent for the first", () => {
    const palette = clusterPalette(["notes", "projects", "companies"], "#1B1BFF");
    expect(palette.get("notes")).toBe("#1B1BFF");
    expect(new Set([...palette.values()]).size).toBe(3);
  });
});
