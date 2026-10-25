import { readFileSync } from "node:fs";

// Server-rendered emails and SVG exports need literal values from the same
// source as the browser. Resolve simple semantic aliases without evaluating CSS.
const designSource = readFileSync(new URL("../../web/design-system.css", import.meta.url), "utf8");

export function designToken(name: string, ancestors: string[] = []): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid design token name.");
  if (ancestors.includes(name)) throw new Error("Circular design token.");
  const value = designSource.match(new RegExp(`--ds-${name}:\\s*([^;]+);`, "i"))?.[1]?.trim();
  if (!value) throw new Error(`Missing design token: ${name}`);
  const alias = value.match(/^var\(--ds-([a-z0-9-]+)\)$/);
  return alias ? designToken(alias[1], [...ancestors, name]) : value;
}

export function designColor(name: string): string {
  const value = designToken(name);
  if (!/^#[a-f0-9]{6}$/i.test(value)) throw new Error(`Invalid design color token: ${name}`);
  return value;
}

export function designPixels(name: string): number {
  const value = designToken(name), parsed = value.match(/^([0-9.]+)(px|rem)$/);
  if (!parsed) throw new Error(`Invalid design size token: ${name}`);
  return Number(parsed[1]) * (parsed[2] === "rem" ? 16 : 1);
}
