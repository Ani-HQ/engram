import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const web = new URL("../web/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, web));
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

describe("client-facing brand assets", () => {
  test("the scalable source is a self-contained monochrome mark", () => {
    const svg = read("brand/engram-mark.svg").toString();
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('rx="15"');
    expect(svg).toContain('fill="#171717"');
    expect(svg).toContain('stroke="#fff"');
    expect(svg).not.toMatch(/<(?:script|foreignObject|image|text|style)\b|\son\w+=|(?:href|src)=|url\(/i);
    expect(read("favicon.svg").toString()).toBe(svg);
  });

  test("MCP and browser PNGs are valid exports of the actual SVG", () => {
    const source = read("brand/engram-mark.svg").toString();
    for (const [path, size] of [["brand/engram-mark.png", 512], ["brand/engram-192.png", 192], ["apple-touch-icon.png", 180]] as const) {
      const bytes = read(path);
      expect([...bytes.subarray(0, 8)]).toEqual(pngSignature);
      expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
      expect(bytes.readUInt32BE(16)).toBe(size);
      expect(bytes.readUInt32BE(20)).toBe(size);
      const rendered = Buffer.from(new Resvg(source, { font: { loadSystemFonts: false }, fitTo: { mode: "width", value: size } }).render().asPng());
      expect(bytes.equals(rendered)).toBe(true);
    }
  });

  test("the traditional favicon contains complete small PNG images", () => {
    const bytes = read("favicon.ico");
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBe(3);
    for (let i = 0; i < 3; i++) {
      const entry = 6 + i * 16;
      const size = bytes[entry];
      const length = bytes.readUInt32LE(entry + 8);
      const offset = bytes.readUInt32LE(entry + 12);
      expect([16, 32, 48]).toContain(size);
      expect(bytes[entry + 1]).toBe(size);
      expect(offset).toBeGreaterThanOrEqual(54);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      const image = bytes.subarray(offset, offset + length);
      expect([...image.subarray(0, 8)]).toEqual(pngSignature);
      expect(image.readUInt32BE(16)).toBe(size);
      expect(image.readUInt32BE(20)).toBe(size);
    }
  });

  test("public pages and the app manifest reference only local branded icons", () => {
    for (const page of ["index.html", "pricing.html", "privacy.html", "self-host.html"]) {
      const html = read(page).toString();
      expect(html).toContain('href="/favicon.ico"');
      expect(html).toContain('href="/favicon.svg"');
      expect(html).toContain('href="/apple-touch-icon.png"');
      expect(html).toContain('href="/site.webmanifest"');
    }
    const manifest = JSON.parse(read("site.webmanifest").toString());
    expect(manifest.name).toBe("Engram");
    expect(manifest.icons).toHaveLength(2);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith("/brand/")).toBe(true);
      expect(icon.type).toBe("image/png");
      expect([...read(icon.src.slice(1)).subarray(0, 8)]).toEqual(pngSignature);
    }
  });
});
