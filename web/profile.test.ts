import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { profileCard, updateProfileCard, updateProfileTimes } from "./profile.js";

const dataKey = (key: string) => key.slice(5).replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
class Element {
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {};
  parentElement: Element | null = null; hidden = false; open = false; tabIndex = -1; text = ""; title = "";
  constructor(public tag: string, text = "") { this.text = text; }
  set className(value: string) { this.attrs.class = value; }
  get className() { return this.attrs.class || ""; }
  get classList() { return { contains: (name: string) => this.className.split(" ").includes(name) }; }
  get childNodes() { return [...this.children]; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key.startsWith("data-")) this.dataset[dataKey(key)] = value; if (key === "tabindex") this.tabIndex = Number(value); }
  getAttribute(key: string) { return key.startsWith("data-") ? this.dataset[dataKey(key)] ?? null : this.attrs[key] ?? null; }
  addEventListener(key: string, callback: Function) { this.events[key] = callback; }
  append(...items: Element[]) { items.forEach(item => { item.remove(); item.parentElement = this; this.children.push(item); }); }
  insertBefore(item: Element, before: Element | null) { item.remove(); item.parentElement = this; const index = before ? this.children.indexOf(before) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, item); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
  replaceChildren(...items: Element[]) { this.children.forEach(item => item.parentElement = null); this.children = []; this.text = ""; this.append(...items); }
  replaceWith(item: Element) { const parent = this.parentElement; if (parent) { parent.insertBefore(item, this); this.remove(); } }
  get textContent(): string { return this.text + this.children.map(item => item.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  querySelectorAll(selector: string): Element[] { return all(this).slice(1).filter(item => selector.split(",").some(part => matches(item, part.trim()))); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): Element | null { return matches(this, selector) ? this : this.parentElement?.closest(selector) || null; }
  focus() { (document as any).activeElement = this; this.events.focus?.({ currentTarget: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
function matches(node: Element, selector: string): boolean {
  const parts = selector.split(" ");
  if (parts.length > 1) return matches(node, parts.at(-1)!) && !!node.parentElement?.closest(parts.slice(0, -1).join(" "));
  if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
  const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attribute) return node.getAttribute(attribute[1]) !== null && (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2]);
  return node.tag === selector;
}
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { activeElement: null, createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));
const daily = [{ date: "2026-10-23", count: 1 }, { date: "2026-10-24", count: 2 }, { date: "2026-10-25", count: 3 }];
const event = { id: "a".repeat(32), agent: { product: "codex", label: "Codex" }, agentAlias: "private laptop alias", service: "github", action: "GitHub activity", status: "running", evidence: "reported", updatedAt: "2026-10-25T10:00:00Z", taskTitle: "private task title", resource: "https://private.example/doc" };
const sample = { profile: { displayName: "Ada", bio: "Building useful things.", slug: "ada" }, stats: { totalActions: 6, activeAgents: 1, activeDays: 3 }, daily, tools: [{ category: "code", count: 6 }], live: { workingAgents: 1, recentlyActiveAgents: 1, completedAgents: 1, staleActions: 0 }, activity: { enabled: true, events: [event] } };

describe("public activity profile", () => {
  test("renders canonical product/service identities and only safe projected fields", () => {
    const card = profileCard(sample) as unknown as Element;
    expect(card.textContent).toContain("Codex"); expect(card.textContent).toContain("GitHub activity");
    expect(card.textContent).toContain("Agent reported"); expect(card.textContent).toContain("In progress");
    for (const privateText of ["private laptop alias", "private task title", "private.example"]) {
      expect(card.textContent).not.toContain(privateText);
      expect(JSON.stringify(all(card).map(node => ({ attrs: node.attrs, dataset: node.dataset })))).not.toContain(privateText);
    }
    expect(all(card).some(node => node.attrs["data-brand"] === "codex")).toBe(true);
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(1);
  });

  test("off and empty states never display event rows, and disabling removes existing content", () => {
    const card = profileCard({ ...sample, activity: { enabled: false, events: [event] } }) as unknown as Element;
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(0); expect(card.textContent).toContain("Activity streaming is off");
    updateProfileCard(card, sample); expect(card.querySelectorAll("[data-public-event]")).toHaveLength(1);
    updateProfileCard(card, { ...sample, activity: { enabled: false, events: [event] } });
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(0);
    updateProfileCard(card, { ...sample, activity: { enabled: true, events: [] } });
    expect(card.textContent).toContain("A quiet moment.");
  });

  test("stream changes reuse keyed rows and preserve disclosure, chart selection and keyboard focus", () => {
    const card = profileCard(sample) as unknown as Element;
    const row = card.querySelector("[data-public-event]"), grid = card.querySelector(".contribution-grid")!;
    const history = card.querySelector(".profile-history")!; history.open = true;
    grid.children[1].focus();
    const changed = { ...sample, activity: { enabled: true, events: [{ ...event, id: "b".repeat(32), status: "running" }, { ...event, status: "completed" }] } };
    updateProfileCard(card, changed);
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(2);
    expect(card.querySelector('[data-public-events="recent"]')!.children[0]).toBe(row);
    expect(card.querySelector(".contribution-grid")).toBe(grid); expect(document.activeElement).toBe(grid.children[1] as any);
    expect(grid.dataset.selectedDate).toBe("2026-10-24"); expect(history.open).toBe(true);
    updateProfileCard(card, changed);
    expect(card.querySelector('[data-public-events="recent"]')!.children[0]).toBe(row);
  });

  test("chart date-range rollover retains the explored date without stealing focus", () => {
    const card = profileCard(sample) as unknown as Element;
    card.querySelector(".contribution-grid")!.children[1].focus();
    const outside = new Element("button"); outside.focus();
    updateProfileCard(card, { ...sample, daily: [{ date: "2026-10-22", count: 0 }, ...daily] });
    const grid = card.querySelector(".contribution-grid")!;
    expect(grid.dataset.selectedDate).toBe("2026-10-24"); expect(grid.children[2].tabIndex).toBe(0);
    expect(document.activeElement).toBe(outside as any); expect(card.querySelector(".contribution-caption")!.textContent).toContain("2 actions");
  });

  test("timestamps age quietly and stale reports have an explicit state", () => {
    const card = profileCard({ ...sample, activity: { enabled: true, events: [{ ...event, status: "stale", evidence: "observed" }] } }) as unknown as Element;
    updateProfileTimes(card, Date.parse(event.updatedAt) + 120_000);
    expect(card.textContent).toContain("Update overdue"); expect(card.textContent).toContain("Observed by Engram");
    expect(card.querySelector("[data-public-time]")!.textContent).toBe("2 minutes ago");
  });
});
