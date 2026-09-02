export const LIGHT_PALETTE = {
  gofun: "#F7F4EC",
  sumi: "#1C1A17",
};

export const DARK_PALETTE = {
  gofun: "#14130F",
  sumi: "#EDE7DA",
};

export const INK_MIX_FLOOR = 0.62;
const ONE_DAY = 86_400_000;
const FADE_DAYS = 365;

export function inkStepFor(updatedAt, now = new Date()) {
  const then = new Date(updatedAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(then) || !Number.isFinite(current)) return 0;
  const ageDays = Math.max(0, (current - then) / ONE_DAY);
  if (ageDays <= 1) return 1;
  const curved = 1 - Math.log1p(ageDays - 1) / Math.log1p(FADE_DAYS - 1);
  return clamp(curved, 0, 1);
}

export function inkColor(step) {
  const amount = INK_MIX_FLOOR + (1 - INK_MIX_FLOOR) * clamp(step, 0, 1);
  return `color-mix(in oklab, var(--sumi) ${Math.round(amount * 1000) / 10}%, var(--gofun))`;
}

export function contrastRatio(colorA, colorB) {
  const bg = parseHex(colorB);
  const fg = resolveColor(colorA, colorB);
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function resolveColor(color, against) {
  if (typeof color === "string" && color.startsWith("color-mix(")) {
    const mix = color.match(/var\(--sumi\)\s+([\d.]+)%/);
    const pct = mix ? Number(mix[1]) / 100 : INK_MIX_FLOOR;
    const bg = normalizeHex(against);
    const palette = bg === normalizeHex(DARK_PALETTE.gofun) ? DARK_PALETTE : LIGHT_PALETTE;
    return mixRgb(parseHex(palette.sumi), parseHex(palette.gofun), clamp(pct, 0, 1));
  }
  return parseHex(color);
}

function parseHex(hex) {
  const normalized = normalizeHex(hex);
  const value = Number.parseInt(normalized.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function normalizeHex(hex) {
  if (typeof hex !== "string") throw new Error("expected hex color");
  const value = hex.trim();
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`invalid hex color: ${hex}`);
  return value.toUpperCase();
}

function mixRgb(a, b, amount) {
  return {
    r: Math.round(a.r * amount + b.r * (1 - amount)),
    g: Math.round(a.g * amount + b.g * (1 - amount)),
    b: Math.round(a.b * amount + b.b * (1 - amount)),
  };
}

function luminance({ r, g, b }) {
  const [rr, gg, bb] = [r, g, b].map(channel => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
