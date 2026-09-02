import { describe, expect, test } from "bun:test";
import { sealSvg } from "./seal.js";

describe("hanko seal generation", () => {
  test("is deterministic for the same input", () => {
    expect(sealSvg("shared", 64)).toBe(sealSvg("shared", 64));
  });

  test("varies visibly across inputs", () => {
    expect(sealSvg("shared", 64)).not.toBe(sealSvg("private", 64));
  });

  test("emits single-root svg markup", () => {
    const svg = sealSvg("engram", 64).trim();
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.match(/<svg\b/g)?.length).toBe(1);
    expect(svg.match(/<\/svg>/g)?.length).toBe(1);
    expect(svg).toContain("<filter");
    expect(svg).toContain("<rect");
  });
});
