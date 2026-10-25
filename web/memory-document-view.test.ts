import { describe, expect, test } from "bun:test";
import { memoryDocumentView } from "./memory-document-view.js";

class Element {
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {}; children: Element[] = []; value = "";
  constructor(public tag: string, text = "") { this.value = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener() {}
  set className(value: string) { this.attrs.class = value; }
  get nodeName() { return this.tag.toUpperCase(); }
  get childNodes() { return this.children; }
  append(...items: Element[]) { this.children.push(...items); }
  prepend(...items: Element[]) { this.children.unshift(...items); }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.value = value; }
}
const nodes = (node: Element): Element[] => [node, ...node.children.flatMap(nodes)];
function render(page: Record<string, unknown>) {
  const original = { Node: globalThis.Node, document: globalThis.document };
  try {
    Object.assign(globalThis, { Node: Element, document: {
      createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag),
      createTextNode: (text: string) => new Element("#text", text), createDocumentFragment: () => new Element("#fragment"),
    } });
    return memoryDocumentView({ page }) as unknown as Element;
  } finally { Object.assign(globalThis, original); }
}

describe("memory document ownership labels", () => {
  test("approved snapshots identify their read-only owner-managed access without altering source or adding actions", () => {
    const body = "Exact approved context.\nKeep this source intact.";
    const view = render({ type: "shared-context", title: "Memory excerpt", slug: "shared-context/grant/item", body });
    const badge = nodes(view).find(node => node.attrs.class === "ds-badge")!;
    expect(badge.textContent).toBe("Read-only snapshot");
    expect(badge.dataset.tone).toBe("info");
    expect(view.textContent).toContain("Approved snapshot. Changes and access are managed by the sharing owner.");
    expect(nodes(view).find(node => node.tag === "code")?.textContent).toBe(body);
    expect(nodes(view).filter(node => node.tag === "button").map(node => node.textContent)).toEqual(["Read", "Source"]);
  });
  test("ordinary saved memory is not described as an approved or owner-managed snapshot", () => {
    const view = render({ type: "note", title: "Personal note", slug: "notes/personal", body: "Personal context." });
    expect(view.textContent).not.toContain("Read-only snapshot");
    expect(view.textContent).not.toContain("managed by the sharing owner");
  });
});
