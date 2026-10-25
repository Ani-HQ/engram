import { afterEach, beforeEach, expect, test } from "bun:test";
import { billingPanel, workspacePanel } from "./account.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {}; dataset: Record<string, string> = {};
  value = ""; checked = false; disabled = false; text = "";
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "disabled") this.disabled = true; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(key: string, handler: Function) { this.events[key] = handler; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: (Element | string)[]) { this.text = ""; this.children = nodes.map(node => node instanceof Element ? node : new Element("#text", String(node))); }
  get childNodes() { return this.children; }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  focus() { (document as any).activeElement = this; }
  async fire(type: string) { await this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const control = (node: Element, text: string) => all(node).find(item => item.tag === "button" && item.textContent === text)!;
const session = { role: "owner", org: { id: 7, slug: "sample-workspace", name: "Sample workspace", kind: "team", policies: { externalAiProcessing: false, agentsMayWrite: true } } };
const original = { Node: globalThis.Node, document: globalThis.document, window: globalThis.window, location: globalThis.location };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) }, location: { search: "" }, window: { location: { assign() {} } } }));
afterEach(() => Object.assign(globalThis, original));

test("a pending workspace export cannot duplicate or download after leaving its workspace", async () => {
  let current = true, finish!: (data: any) => void, pages = 0, actions = 0;
  const view = workspacePanel({ session, members: [], invites: [], api: { pages: () => { pages++; return new Promise(resolve => { finish = resolve; }); }, actions: async () => { actions++; return { actions: [], more: false }; } }, saved() {}, fail() {}, notify() {}, isCurrent: () => current }) as Element;
  const button = control(view, "Export memory & activity");
  const pending = button.fire("click"); await button.fire("click");
  expect(pages).toBe(1); expect(button.disabled).toBe(true); expect(button.attrs["aria-busy"]).toBe("true"); expect(all(button).some(node => node.attrs.class === "ds-spinner")).toBe(true);
  current = false; finish({ pages: [], more: false }); await pending;
  expect(actions).toBe(0); expect(view.textContent).not.toContain("Export downloaded");
});

test("privacy saves ignore completions after the panel's session becomes stale", async () => {
  let current = true, finish!: (data: any) => void, saves = 0, notices = 0;
  const view = workspacePanel({ session, members: [], invites: [], api: { savePolicies: () => new Promise(resolve => { finish = resolve; }) }, saved: () => saves++, fail() {}, notify: () => notices++, isCurrent: () => current }) as Element;
  const form = all(view).find(node => node.tag === "form")!;
  const pending = form.fire("submit"); current = false; finish({ policies: { agentsMayWrite: false } }); await pending;
  expect(saves).toBe(0); expect(notices).toBe(0);
});

test("billing cannot redirect an obsolete workspace after an asynchronous portal request", async () => {
  let current = true, finish!: (data: any) => void, calls = 0, redirects = 0;
  (window as any).location.assign = () => redirects++;
  const view = billingPanel({ billing: { mode: "hosted", planId: "cloud", status: "active", canWrite: true, checkoutAvailable: false, portalAvailable: true }, catalog: { mode: "hosted", plans: [] }, jev: null, api: { billingPortal: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }, notify() {}, fail() {}, refresh() {}, isCurrent: () => current }) as Element;
  const button = control(view, "Manage subscription"), pending = button.fire("click"); await button.fire("click");
  expect(calls).toBe(1); expect(button.attrs["aria-busy"]).toBe("true");
  current = false; finish({ url: "https://billing.example/session" }); await pending;
  expect(redirects).toBe(0);
});

test("privacy saves request focus restoration only while the submitted action still owns focus", async () => {
  const metadata: any[] = [];
  const view = workspacePanel({ session, members: [], invites: [], api: { savePolicies: async () => ({ policies: session.org.policies }) }, saved: (_: any, focus: any) => metadata.push(focus), fail() {}, notify() {} }) as Element;
  const form = all(view).find(node => node.tag === "form")!, save = control(view, "Save privacy settings");
  expect(save.attrs["data-account-focus"]).toBe("privacy-save");
  save.focus(); await form.fire("submit");
  new Element("input").focus(); await form.fire("submit");
  expect(metadata).toEqual([{ restoreFocus: true, focusKey: "privacy-save" }, { restoreFocus: false, focusKey: "privacy-save" }]);
});
