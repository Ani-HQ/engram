import { afterEach, expect, test } from "bun:test";

class Element {
  attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {};
  dataset: Record<string, string> = {}; private _disabled = false; text = "";
  get disabled() { return this._disabled; }
  set disabled(value: boolean) { this._disabled = value; if (value && (document as any).activeElement === this) (document as any).activeElement = document.body; }
  constructor(public tag: string, text = "") { this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(key: string, callback: Function) { this.events[key] = callback; }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: (Element | string)[]) { this.text = ""; this.children = items.map(item => item instanceof Element ? item : new Element("#text", String(item))); }
  get textContent(): string { return this.text + this.children.map(item => item.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  querySelector() { return descendants(this).find(item => ["a", "button"].includes(item.tag)) || null; }
  focus() { (document as any).activeElement = this; }
}
const descendants = (element: Element): Element[] => element.children.flatMap(item => [item, ...descendants(item)]);
const original = { Node: globalThis.Node, document: globalThis.document, fetch: globalThis.fetch };
afterEach(() => Object.assign(globalThis, original));

test("public plan retry announces progress, prevents duplicates, and retains keyboard focus through recovery", async () => {
  const target = new Element("div");
  let calls = 0;
  const pending: Array<(response: Response) => void> = [];
  Object.assign(globalThis, {
    Node: Element,
    document: {
      body: new Element("body"),
      activeElement: null,
      createElement: (tag: string) => new Element(tag),
      createElementNS: (_: string, tag: string) => new Element(tag),
      createTextNode: (text: string) => new Element("#text", text),
      querySelector: (selector: string) => selector === "#pricing-plans" ? target : null,
      querySelectorAll: () => [],
    },
    fetch: () => { calls++; return calls <= 2 ? Promise.resolve(new Response(null, { status: 503 })) : new Promise<Response>(resolve => pending.push(resolve)); },
  });
  await import("./public.js?public-plan-retry");
  await Bun.sleep(0);
  const notice = target.children[0], retry = descendants(target).find(item => item.tag === "button")!;
  expect(notice.attrs.role).toBe("alert"); expect(target.textContent).toContain("Plans could not be loaded");
  retry.focus();
  const first = retry.events.click();
  await retry.events.click();
  expect(calls).toBe(4); expect(retry.disabled).toBe(true); expect(target.attrs["aria-busy"]).toBe("true");
  expect(notice.attrs.role).toBe("status"); expect(target.textContent).toContain("Loading the current plans");
  expect(document.activeElement).toBe(document.body);
  pending[0](Response.json({ mode: "hosted", currency: "usd", plans: [{ id: "cloud", name: "Cloud", description: "Hosted", monthlyPrice: 19, features: [] }] }));
  pending[1](Response.json({ mode: "invite-only", complimentary: true, verificationRequired: true, inviteCodeRequired: true }));
  await first;
  expect(target.textContent).toContain("60 days free"); expect(target.textContent).not.toContain("Plans could not be loaded");
  expect(target.attrs["aria-busy"]).toBeUndefined(); expect((document.activeElement as any).tag).toBe("a");
});
