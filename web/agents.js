// Marks for the agents that write to this brain.
//
// These are deliberately original geometric glyphs, not reproductions of anyone's
// brand marks. Redrawing the Anthropic, OpenAI or xAI logos into this file would be
// using their trademarks, and a memory console has no licence to do that. Each mark
// is instead a distinct shape chosen to be told apart at 14 pixels, which is the
// only job it has here.

const SVG_NS = "http" + "://www.w3.org/2000/svg";

// Keyed by the token name an agent authenticates with, matched loosely so
// "mac-claude", "claude-code" and "fleet-claude" all land on the same mark.
const MARKS = [
  { test: /claude/i, name: "claude", draw: "burst" },
  { test: /codex|openai|gpt/i, name: "codex", draw: "ring" },
  { test: /openclaw|zara/i, name: "openclaw", draw: "claw" },
  { test: /hermes|baymax|carolyn|midi/i, name: "hermes", draw: "wing" },
  { test: /grok|dum-?e/i, name: "grok", draw: "slash" },
  { test: /cursor/i, name: "cursor", draw: "caret" },
];

export function agentKind(name) {
  const found = MARKS.find(mark => mark.test.test(String(name ?? "")));
  return found ? found.name : "unknown";
}

const SHAPES = {
  // Eight strokes from a centre: busy, radiant, reads as a spark.
  burst: () => Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2;
    return line(8 + Math.cos(angle) * 2.6, 8 + Math.sin(angle) * 2.6,
      8 + Math.cos(angle) * 6.4, 8 + Math.sin(angle) * 6.4);
  }).join(""),
  // A broken ring: closed enough to read as a circle, open enough not to be one.
  ring: () => `<path d="M13.4 8a5.4 5.4 0 1 1-2.6-4.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`,
  // Three tapering strokes, splayed.
  claw: () => [[-3.4, -1], [0, 0], [3.4, -1]].map(([dx, lift]) =>
    line(8 + dx, 3.4 + lift, 8 + dx * 1.5, 12.4)).join(""),
  // Two strokes leaving a point, like a mark of speed.
  wing: () => `${line(3, 11, 9.5, 4.5)}${line(7.5, 12.5, 13.2, 6.8)}`,
  // A single decisive diagonal with a counter-stroke.
  slash: () => `${line(4.4, 12.4, 11.6, 3.6)}${line(9.4, 12.4, 12.6, 8.4)}`,
  // A chevron.
  caret: () => `<path d="M5.4 4.6 10.8 8l-5.4 3.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  // Unknown agents get a plain filled dot rather than a guess at their identity.
  unknown: () => `<circle cx="8" cy="8" r="3.1" fill="currentColor"/>`,
};

function line(x1, y1, x2, y2) {
  return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export function agentMarkSvg(name, size = 16) {
  const kind = agentKind(name);
  const shape = SHAPES[MARKS.find(mark => mark.name === kind)?.draw ?? "unknown"] ?? SHAPES.unknown;
  return `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="${escapeAttr(String(name ?? "agent"))}"><g fill="none">${shape()}</g></svg>`;
}

export function agentMark(name, size = 16) {
  const wrap = document.createElement("span");
  wrap.className = `agent-mark agent-${agentKind(name)}`;
  wrap.title = String(name ?? "agent");
  wrap.innerHTML = agentMarkSvg(name, size);
  return wrap;
}

function escapeAttr(value) {
  return value.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
