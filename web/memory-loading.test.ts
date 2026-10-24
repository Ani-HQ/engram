import { describe, expect, test } from "bun:test";
import { memoryLoading, setMemoryLoadingDelayed } from "./memory-loading.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; value: string;
  constructor(tag: string, value = "") { this.tag = tag; this.value = value; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  append(...children: Element[]) { this.children.push(...children); }
  get hidden() { return Object.hasOwn(this.attrs, "hidden"); }
  set hidden(value: boolean) { if (value) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
  querySelector(selector: string): Element | null { return nodes(this).find(node => selector.startsWith(".") && node.attrs.class?.split(" ").includes(selector.slice(1))) || null; }
}
function nodes(node: Element): Element[] { return [node, ...node.children.flatMap(nodes)]; }
function render(work: () => Element) {
  const original = { Node: globalThis.Node, document: globalThis.document };
  try {
    Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } });
    return work();
  } finally { Object.assign(globalThis, original); }
}

describe("memory reading feedback", () => {
  test("presents one truthful status and a decorative page scaffold without staged progress", () => {
    const view = render(() => memoryLoading("release/launch-plan")) as Element;
    expect(view.attrs.role).toBe("status");
    expect(view.attrs["aria-live"]).toBe("polite");
    expect(nodes(view).filter(node => node.attrs.id === "detail-title").map(node => node.textContent)).toEqual(["Reading your memory…"]);
    expect(view.textContent).toContain("Retrieving the content and links saved in this memory.");
    expect(view.querySelector(".memory-loading-sheet")?.attrs["aria-hidden"]).toBe("true");
    expect(nodes(view).some(node => node.attrs.role === "progressbar" || Object.hasOwn(node.attrs, "aria-valuenow"))).toBe(false);
    expect(view.textContent).not.toMatch(/\d+%|complete|verified|loaded successfully/i);
  });

  test("displays a bounded slug as text and omits unknown target values", () => {
    const label = '<img src=x onerror="alert(1)">';
    const view = render(() => memoryLoading(label)) as Element;
    expect(view.querySelector(".memory-loading-target")?.textContent).toBe(label);
    expect(nodes(view).some(node => node.tag === "img" || node.tag === "a")).toBe(false);
    const long = render(() => memoryLoading("🔒".repeat(200))) as Element;
    expect(Array.from(long.querySelector(".memory-loading-target")!.textContent)).toHaveLength(120);
    expect(long.querySelector(".memory-loading-target")?.textContent.endsWith("…")).toBe(true);
    const control = render(() => memoryLoading("\u202esecret\u0000")) as Element;
    expect(control.querySelector(".memory-loading-target")?.textContent).toBe("secret");
    for (const value of [null, undefined, 23, { slug: "private" }, ""]) {
      expect((render(() => memoryLoading(value)) as Element).querySelector(".memory-loading-target")).toBeNull();
    }
  });

  test("long-wait feedback is controlled by the drawer without rewriting status or creating timers", () => {
    const view = render(() => memoryLoading("launch-plan")) as Element;
    const note = view.querySelector(".memory-loading-delayed")!;
    const text = view.textContent;
    expect(note.hidden).toBe(true);
    expect(setMemoryLoadingDelayed(view)).toBe(true);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Still loading this memory. You can close this panel and try again.");
    expect(setMemoryLoadingDelayed(view)).toBe(true);
    expect(view.textContent).toBe(text);
    expect(setMemoryLoadingDelayed(view, false)).toBe(true);
    expect(note.hidden).toBe(true);
    expect(setMemoryLoadingDelayed(null)).toBe(false);
  });
});
