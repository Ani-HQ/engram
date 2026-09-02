const SHU = "#C7402E";
const SVG_NS = "http" + "://www.w3.org/2000/svg";

export function sealSvg(text = "engram", size = 64) {
  const seed = hash(String(text));
  const rand = mulberry32(seed);
  const grid = seed & 1 ? 3 : 2;
  const filterId = `seal-${seed.toString(16)}`;
  const cell = 44 / grid;
  const parts = [];

  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      const left = 10 + x * cell + 2;
      const top = 10 + y * cell + 2;
      const w = cell - 4;
      const h = cell - 4;
      parts.push(glyph(left, top, w, h, Math.floor(rand() * 7)));
    }
  }

  return `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="hanko seal"><defs><filter id="${filterId}" x="-12%" y="-12%" width="124%" height="124%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${seed % 997}" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.1"/></filter></defs><g filter="url(#${filterId})" fill="none" stroke="${SHU}" stroke-linecap="square" stroke-linejoin="round"><rect x="5" y="5" width="54" height="54" rx="7" stroke-width="3"/><rect x="9" y="9" width="46" height="46" rx="4" stroke-width="1.35"/></g><g filter="url(#${filterId})" fill="${SHU}">${parts.join("")}</g></svg>`;
}

function glyph(x, y, w, h, mode) {
  const a = round(x);
  const b = round(y);
  const midX = round(x + w * 0.44);
  const midY = round(y + h * 0.45);
  const stroke = Math.max(2.1, w * 0.17);
  const wide = round(w);
  const high = round(h);
  const s = round(stroke);
  const inset = round(stroke * 0.8);
  const short = round(w * 0.52);
  const pieces = [
    `<rect x="${a}" y="${b}" width="${s}" height="${high}"/>`,
    `<rect x="${a}" y="${b}" width="${wide}" height="${s}"/>`,
    `<rect x="${round(x + w - s)}" y="${b}" width="${s}" height="${round(h * 0.72)}"/>`,
    `<rect x="${a}" y="${round(y + h - s)}" width="${wide}" height="${s}"/>`,
    `<rect x="${midX}" y="${b}" width="${s}" height="${high}"/>`,
    `<rect x="${a}" y="${midY}" width="${short}" height="${s}"/>`,
    `<rect x="${round(x + inset)}" y="${round(y + inset)}" width="${round(w - inset * 2)}" height="${s}"/>`,
  ];
  const variants = [
    [0, 1, 5],
    [1, 2, 3],
    [0, 3, 4],
    [2, 5, 6],
    [0, 2, 3, 6],
    [1, 4, 5],
    [0, 1, 2, 3],
  ];
  return variants[mode].map(index => pieces[index]).join("");
}

function hash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function next() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}
