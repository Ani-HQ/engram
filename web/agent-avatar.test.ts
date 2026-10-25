import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentAvatar, agentAvatarSeed } from "./agent-avatar.js";
import { beamData } from "./vendor/boring-avatars/beam.js";

class SvgElement {
  attributes: Record<string, string> = {};
  children: SvgElement[] = [];
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  append(...children: SvgElement[]) { this.children.push(...children); }
  set innerHTML(_value: string) { throw new Error("Avatar markup must not be parsed"); }
}
function withSvgDocument(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElementNS: (_ns: string, tag: string) => new SvgElement(tag) } });
  try { run(); } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete (globalThis as any).document;
  }
}
const nodes = (node: SvgElement): SvgElement[] => [node, ...node.children.flatMap(nodes)];

describe("local agent avatar fallback", () => {
  test("stable private names vary the artwork while public aliases share one face", () => {
    const atlas = agentAvatarSeed("Atlas");
    expect(atlas).toBe(agentAvatarSeed(" Atlas "));
    expect(atlas).not.toBe(agentAvatarSeed("Milo"));
    expect(beamData(atlas)).not.toEqual(beamData(agentAvatarSeed("Milo")));
    for (const alias of ["Atlas", "Milo", "private@example.test", '<svg onload="alert(1)">', null]) {
      expect(agentAvatarSeed(alias, { publicSafe: true })).toBe(agentAvatarSeed("public", { publicSafe: true }));
    }
  });

  test("renders useful decorative SVG without exposing input or seed metadata", () => withSvgDocument(() => {
    const privateName = "private-alias-very-sensitive-2391";
    const seed = agentAvatarSeed(privateName);
    const first = agentAvatar(seed) as unknown as SvgElement;
    const second = agentAvatar(seed) as unknown as SvgElement;
    expect(first).toEqual(second);
    expect(first.attributes["aria-hidden"]).toBe("true");
    expect(first.attributes.viewBox).toBe("0 0 36 36");
    expect(first.children).toHaveLength(3);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(privateName);
    expect(serialized).not.toContain(String(seed));
    expect(nodes(first).some(node => node.attributes.id || node.attributes.href || node.attributes["data-seed"])).toBe(false);
  }));

  test("public SVG output is independent of all private aliases", () => withSvgDocument(() => {
    const first = agentAvatar(agentAvatarSeed("private-team-project", { publicSafe: true }));
    const second = agentAvatar(agentAvatarSeed("private-other-machine", { publicSafe: true }));
    expect(first).toEqual(second);
  }));

  test("untrusted names and optional labels never create executable or external SVG", () => withSvgDocument(() => {
    const malicious = '\"><image href="https://example.test/leak" onload="alert(1)" />';
    const face = agentAvatar(agentAvatarSeed(malicious), { label: malicious }) as unknown as SvgElement;
    expect(face.attributes["aria-label"]).toBe(malicious);
    expect(face.attributes.role).toBe("img");
    for (const node of nodes(face)) {
      expect(["svg", "rect", "g", "path"]).toContain(node.tagName);
      for (const [key, value] of Object.entries(node.attributes)) {
        expect(key).not.toMatch(/^(?:on[a-z]+|href|xlink:href|src|style|id)$/i);
        if (key !== "aria-label") expect(value).not.toMatch(/javascript:|https?:|url\(/i);
      }
    }
  }));

  test("invalid seeds and sizes remain finite local geometry", () => withSvgDocument(() => {
    for (const seed of [0, 1, 4294967295, -1, NaN, Infinity, "<script>", null]) {
      const face = agentAvatar(seed, { size: Infinity }) as unknown as SvgElement;
      expect(face.attributes.width).toBe("24");
      expect(JSON.stringify(face)).not.toMatch(/NaN|Infinity|script/);
    }
  }));

  test("the adaptation retains pinned upstream source and the MIT notice", () => {
    const root = new URL("./vendor/boring-avatars/", import.meta.url);
    const source = JSON.parse(readFileSync(new URL("source.json", root), "utf8"));
    expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(source.repository).toBe("https://github.com/boringdesigners/boring-avatars");
    for (const asset of source.assets) expect(createHash("sha256").update(readFileSync(new URL(asset.file, root))).digest("hex")).toBe(asset.sha256);
    expect(readFileSync(new URL("LICENSE", root), "utf8")).toContain("Copyright (c) 2021 boringdesigners");
    expect(readFileSync(new URL("beam.js", root), "utf8")).not.toMatch(/\bfetch\s*\(|innerHTML|eval\s*\(/);
  });
});
