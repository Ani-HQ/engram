// A force-directed layout, hand-rolled. No library, because a strict CSP forbids
// fetching one and vendoring a copy would be more code than this file.
//
// The layout is solved synchronously and drawn once, rather than animated toward a
// solution. Three reasons: an animation loop depends on requestAnimationFrame, which
// a browser throttles in a tab it treats as hidden; a settling graph is a poor way to
// read structure, because the thing you are looking for keeps moving; and redrawing
// only on pan, zoom and hover costs nothing while nobody is touching it.

const REPULSION = 5200;
const MAX_REPULSION = 600;
const SPRING = 0.0016;
const SPRING_LENGTH = 92;
const CLUSTER_PULL = 0.0042;
const CENTRE_PULL = 0.0009;
const ITERATIONS = 420;
const MAX_STEP = 34;
const MIN_RADIUS = 4.5;
const MAX_RADIUS = 15;
const LABEL_COUNT = 10;

export function solveLayout(nodes, edges, width, height) {
  const byId = new Map(nodes.map(node => [node.slug, node]));
  const clusters = [...new Set(nodes.map(node => node.cluster))];
  const centres = new Map();

  // Seed each cluster on its own ring. Random starts settle into a different shape
  // every visit, which makes the graph unrecognisable between sessions; seeding from
  // the cluster index and the node's position within it means the same brain always
  // draws the same way.
  clusters.forEach((cluster, index) => {
    const angle = (index / Math.max(1, clusters.length)) * Math.PI * 2;
    const spread = Math.min(width, height) * 0.3;
    centres.set(cluster, {
      x: width / 2 + Math.cos(angle) * spread,
      y: height / 2 + Math.sin(angle) * spread,
    });
  });

  const counts = new Map();
  for (const node of nodes) {
    const seen = counts.get(node.cluster) ?? 0;
    counts.set(node.cluster, seen + 1);
    const centre = centres.get(node.cluster);
    const angle = seen * 2.399963;
    // Phyllotaxis rather than a plain circle: it spaces same-cluster nodes without
    // any two landing on top of each other, which is what made the forces explode.
    const radius = 7 * Math.sqrt(seen + 1);
    node.x = centre.x + Math.cos(angle) * radius;
    node.y = centre.y + Math.sin(angle) * radius;
    node.degree = 0;
  }

  const links = edges
    .map(edge => ({ a: byId.get(edge.source), b: byId.get(edge.target) }))
    .filter(link => link.a && link.b && link.a !== link.b);
  for (const link of links) {
    link.a.degree += 1;
    link.b.degree += 1;
  }

  for (let step = 0; step < ITERATIONS; step += 1) {
    // Displacement is recomputed from scratch each pass and the move is capped by a
    // cooling temperature. Carrying velocity between passes let an unbounded
    // repulsion term accumulate until every coordinate became NaN.
    const temperature = MAX_STEP * (1 - step / ITERATIONS);
    for (const node of nodes) {
      node.dx = 0;
      node.dy = 0;
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) {
          // Coincident nodes have no direction to separate along. Break the tie by
          // index so the same input always produces the same layout.
          dx = ((i % 7) - 3) || 1;
          dy = ((j % 5) - 2) || 1;
          distSq = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(distSq);
        // Capped: 1/r² is unbounded as r approaches zero, and one close pair was
        // enough to throw every other node to infinity.
        const force = Math.min(REPULSION / distSq, MAX_REPULSION);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.dx += fx;
        a.dy += fy;
        b.dx -= fx;
        b.dy -= fy;
      }
    }

    for (const { a, b } of links) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - SPRING_LENGTH) * SPRING;
      a.dx += dx * force;
      a.dy += dy * force;
      b.dx -= dx * force;
      b.dy -= dy * force;
    }

    for (const node of nodes) {
      const centre = centres.get(node.cluster);
      node.dx += (centre.x - node.x) * CLUSTER_PULL;
      node.dy += (centre.y - node.y) * CLUSTER_PULL;
      node.dx += (width / 2 - node.x) * CENTRE_PULL;
      node.dy += (height / 2 - node.y) * CENTRE_PULL;

      const magnitude = Math.hypot(node.dx, node.dy);
      if (magnitude > 0.0001 && Number.isFinite(magnitude)) {
        const limited = Math.min(magnitude, temperature);
        node.x += (node.dx / magnitude) * limited;
        node.y += (node.dy / magnitude) * limited;
      }
      // A coordinate that has gone non-finite is unrecoverable and would silently
      // draw nothing, so put it back on the board rather than carry it forward.
      if (!Number.isFinite(node.x)) node.x = width / 2;
      if (!Number.isFinite(node.y)) node.y = height / 2;
    }
  }

  // Deliberately not clamped into the frame. Clamping piles everything that wanted
  // to be outside along the edges, which reads as a border of nodes rather than as
  // structure. The view is fitted to the result instead.
  const maxDegree = nodes.reduce((max, node) => Math.max(max, node.degree), 0);
  for (const node of nodes) {
    // Area, not radius, tracks degree: doubling the radius would quadruple the ink
    // and overstate the difference between a hub and an ordinary page.
    const share = maxDegree ? node.degree / maxDegree : 0;
    node.r = MIN_RADIUS + Math.sqrt(share) * (MAX_RADIUS - MIN_RADIUS);
  }

  return { nodes, links };
}

// Frame the solved graph: whatever space it settled into, show all of it.
export function fitToView(nodes, width, height, padding = 46) {
  if (!nodes.length) return { scale: 1, x: 0, y: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.r);
    maxX = Math.max(maxX, node.x + node.r);
    minY = Math.min(minY, node.y - node.r);
    maxY = Math.max(maxY, node.y + node.r);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // Never magnify past 1: a graph of three nodes blown up to fill the frame looks
  // broken rather than generous.
  const scale = Math.min(1, (width - padding * 2) / spanX, (height - padding * 2) / spanY);
  return {
    scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: height / 2 - ((minY + maxY) / 2) * scale,
  };
}

export function clusterPalette(clusters, accent) {
  // One hue family, stepped. Distinct clusters must be told apart, but a graph of a
  // memory bank is not a chart and does not need six competing colours.
  const steps = [0, 38, 76, 114, 152, 190];
  return new Map(clusters.map((cluster, index) => [
    cluster,
    index === 0 ? accent : `hsl(${(214 + steps[index % steps.length]) % 360} 62% 46%)`,
  ]));
}

export function renderGraph(canvas, data, options = {}) {
  const ctx = canvas.getContext("2d");
  const onSelect = options.onSelect || (() => {});
  const readStyle = () => getComputedStyle(canvas);
  let view = { x: 0, y: 0, scale: 1 };
  let hovered = null;
  let dragging = null;
  let solved = null;
  let neighbours = new Map();
  let labelled = new Set();

  function size() {
    const rect = canvas.getBoundingClientRect();
    // Back the canvas at device resolution, or hairlines and 11px labels blur.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { w: rect.width, h: rect.height };
  }

  function build() {
    const { w, h } = size();
    solved = solveLayout(data.nodes.map(node => ({ ...node })), data.edges, w, h);
    view = fitToView(solved.nodes, w, h);
    // The hubs get a permanent label; everything else is labelled on hover. Labelling
    // by size alone put ninety overlapping words on the screen at once.
    const ranked = [...solved.nodes].sort((a, b) => b.degree - a.degree);
    labelled = new Set(ranked.slice(0, LABEL_COUNT).filter(node => node.degree > 0).map(node => node.slug));
    neighbours = new Map(solved.nodes.map(node => [node.slug, new Set()]));
    for (const { a, b } of solved.links) {
      neighbours.get(a.slug).add(b.slug);
      neighbours.get(b.slug).add(a.slug);
    }
    draw();
  }

  function toScreen(node) {
    return { x: node.x * view.scale + view.x, y: node.y * view.scale + view.y };
  }

  function draw() {
    if (!solved) return;
    const { w, h } = { w: canvas.clientWidth, h: canvas.clientHeight };
    const style = readStyle();
    const ink = style.getPropertyValue("--text").trim() || "#0A0A0A";
    const soft = style.getPropertyValue("--line-soft").trim() || "#D2D2CC";
    const paper = style.getPropertyValue("--surface").trim() || "#FFFFFF";
    const accent = style.getPropertyValue("--accent").trim() || "#1B1BFF";
    const clusters = [...new Set(solved.nodes.map(node => node.cluster))];
    const palette = clusterPalette(clusters, accent);

    ctx.save();
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, w, h);

    const focus = hovered ? neighbours.get(hovered.slug) : null;

    ctx.lineWidth = 1;
    for (const { a, b } of solved.links) {
      const near = !hovered || a.slug === hovered.slug || b.slug === hovered.slug;
      ctx.strokeStyle = near ? ink : soft;
      ctx.globalAlpha = hovered ? (near ? 0.55 : 0.12) : 0.32;
      const pa = toScreen(a);
      const pb = toScreen(b);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    for (const node of solved.nodes) {
      const p = toScreen(node);
      const r = node.r * view.scale;
      const isHovered = hovered && node.slug === hovered.slug;
      const isNeighbour = focus && focus.has(node.slug);
      const dim = hovered && !isHovered && !isNeighbour;

      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = palette.get(node.cluster) || accent;
      ctx.fill();
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.strokeStyle = ink;
      ctx.stroke();

      // Label the hubs and whatever the pointer is on. Labelling everything turns
      // the graph into a wall of text at any useful zoom.
      const showLabel = isHovered || isNeighbour || (!hovered && labelled.has(node.slug));
      if (showLabel && view.scale > 0.4) {
        ctx.globalAlpha = dim ? 0.2 : 1;
        ctx.fillStyle = ink;
        ctx.font = `${isHovered ? 12 : 11}px ${style.getPropertyValue("--mono").trim() || "monospace"}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title;
        ctx.fillText(label, p.x, p.y + r + 5);
      }
    }
    ctx.restore();
  }

  function nodeAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestDist = Infinity;
    for (const node of solved?.nodes || []) {
      const p = toScreen(node);
      const dist = Math.hypot(p.x - x, p.y - y);
      // A generous target: these circles are small, and a graph you have to aim at
      // is not a graph you explore.
      if (dist < Math.max(node.r * view.scale + 7, 12) && dist < bestDist) {
        best = node;
        bestDist = dist;
      }
    }
    return best;
  }

  function onMove(event) {
    if (dragging) {
      view.x = event.clientX - dragging.x;
      view.y = event.clientY - dragging.y;
      draw();
      return;
    }
    const found = nodeAt(event.clientX, event.clientY);
    if (found !== hovered) {
      hovered = found;
      canvas.style.cursor = found ? "pointer" : "grab";
      canvas.title = found ? `${found.title}\n${found.slug}\n${found.contributors.length ? found.contributors.join(", ") : "no contributors recorded"}` : "";
      draw();
    }
  }

  function onDown(event) {
    const found = nodeAt(event.clientX, event.clientY);
    if (found) {
      onSelect(found);
      return;
    }
    dragging = { x: event.clientX - view.x, y: event.clientY - view.y };
    canvas.style.cursor = "grabbing";
  }

  function onUp() {
    dragging = null;
    canvas.style.cursor = hovered ? "pointer" : "grab";
  }

  function onWheel(event) {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const next = Math.min(3, Math.max(0.3, view.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    // Zoom about the pointer, not the origin, so the thing under the cursor stays
    // under the cursor.
    view.x = px - ((px - view.x) / view.scale) * next;
    view.y = py - ((py - view.y) / view.scale) * next;
    view.scale = next;
    draw();
  }

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mousedown", onDown);
  window.addEventListener("mouseup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", build, { passive: true });
  canvas.style.cursor = "grab";
  build();

  return {
    redraw: draw,
    rebuild: build,
    destroy() {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", build);
    },
  };
}
