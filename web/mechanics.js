import { sealSvg } from "./seal.js";

const SVG_NS = "http" + "://www.w3.org/2000/svg";

export function renderKintsugi(page, links, openItem) {
  const wrap = h("section", { class: "kintsugi", "aria-label": "Linked memory seams" }, h("p", { class: "kintsugi-source" }, page.title || page.slug));
  if (!links.length) return wrap;
  const svg = s("svg", { viewBox: "0 0 640 180", preserveAspectRatio: "none", "aria-hidden": "true" });
  const targets = h("div", { class: "kintsugi-targets" });
  links.slice(0, 4).forEach((link, index) => {
    const y = 30 + index * 38;
    const jitter = seeded(`${page.slug}:${link.slug}`);
    const c1 = 180 + jitter() * 34;
    const c2 = 360 + jitter() * 44;
    svg.append(s("path", { d: `M 90 28 C ${c1} ${16 + jitter() * 28}, ${c2} ${y + jitter() * 24}, 512 ${y}`, fill: "none", stroke: "var(--kin)", "stroke-width": "1.5", "stroke-linecap": "round" }));
    for (let fleck = 0; fleck < 3; fleck += 1) {
      svg.append(s("circle", { cx: 235 + fleck * 92 + jitter() * 18, cy: y - 8 + jitter() * 20, r: 1 + jitter() * 1.1, fill: "var(--kin)", opacity: "0.8" }));
    }
    targets.append(h("button", { type: "button", class: "seam-link", style: { top: `${y - 12}px` }, onclick: () => openItem(link) }, link.slug));
  });
  wrap.append(svg, targets);
  return wrap;
}

export function renderTimeline(entries) {
  // No entries means no scroll to unroll — an empty 絵巻 heading is just a dangling label.
  if (!entries.length) return "";
  const strip = h("section", { class: "emaki", "aria-label": "Timeline" }, h("h3", {}, "絵巻"));
  const inner = h("div", { class: "emaki-inner" }, ...entries.map(entry => h("div", { class: "emaki-node" },
    h("span", { class: "node-dot" }),
    h("time", { datetime: entry.at }, compactDate(entry.at)),
    h("p", {}, entry.text),
  )));
  const scroller = h("div", { class: "emaki-strip", tabindex: "0" }, inner);
  attachDragScroll(scroller);
  strip.append(scroller);
  return strip;
}

export function seigaiha() {
  const svg = s("svg", { class: "seigaiha", viewBox: "0 0 120 60", "aria-hidden": "true" });
  [22, 36, 50].forEach(r => svg.append(s("path", { d: `M ${60 - r} 54 A ${r} ${r} 0 0 1 ${60 + r} 54`, fill: "none", stroke: "currentColor", "stroke-width": "1" })));
  return svg;
}

export function sealImg(text, size, alt) {
  const img = h("img", { class: "seal", width: size, height: size, alt });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sealSvg(text, size))}`;
  return img;
}

export function relativeDate(value, now = new Date()) {
  const days = Math.max(0, (now - new Date(value)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function inkGlyph(step) {
  if (step > 0.66) return "███";
  if (step > 0.33) return "▓▓░";
  return "░░░";
}

function compactDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

function attachDragScroll(node) {
  let drag = null;
  node.addEventListener("pointerdown", event => {
    drag = { x: event.clientX, left: node.scrollLeft };
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener("pointermove", event => {
    if (drag) node.scrollLeft = drag.left - (event.clientX - drag.x);
  });
  node.addEventListener("pointerup", () => drag = null);
  node.addEventListener("pointercancel", () => drag = null);
}

function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === false || value === undefined || value === null) return;
    if (key === "class") node.className = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  });
  children.flat().forEach(child => {
    if (child !== "" && child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function s(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}
