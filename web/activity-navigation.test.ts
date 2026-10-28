import { describe, expect, test } from "bun:test";
import { activityDestination, activityHref, activitySections } from "./activity-navigation.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; text: string;
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener() {}
  append(...children: Element[]) { this.children.push(...children); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
}
function render(props = {}) {
  const original = { Node: globalThis.Node, document: globalThis.document };
  try {
    Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } });
    return activitySections(props) as Element;
  } finally { Object.assign(globalThis, original); }
}
const paramsFor = (hash: string) => new URLSearchParams(hash.split("?")[1] || "");

describe("Activity history and checks navigation", () => {
  test("old Attention routes and Checks links select the same Activity section", () => {
    const old = new URLSearchParams("q=release+handoff&activityId=activity%3A42");
    expect(activityDestination("attention", old)).toEqual({ view: "activity", activityTab: "checks" });
    expect(activityDestination("activity", new URLSearchParams("tab=checks"))).toEqual({ view: "activity", activityTab: "checks" });
    expect(activityDestination("activity", new URLSearchParams("tab=handoffs"))).toEqual({ view: "activity", activityTab: "handoffs" });
    expect(activityHref({ tab: "handoffs" })).toBe("#activity?tab=handoffs");
    expect(activityDestination("memory", new URLSearchParams("tab=handoffs"))).toEqual({ view: "memory", activityTab: "history" });
    // Query and activity scope survive canonicalizing the legacy destination.
    const href = activityHref({ tab: "checks", query: old.get("q")!, activityId: old.get("activityId")! });
    expect(paramsFor(href).get("q")).toBe("release handoff");
    expect(paramsFor(href).get("activityId")).toBe("activity:42");
  });

  test("ordinary Activity routes default to history without changing other app destinations", () => {
    expect(activityDestination("activity")).toEqual({ view: "activity", activityTab: "history" });
    expect(activityDestination("activity", new URLSearchParams("tab=unknown"))).toEqual({ view: "activity", activityTab: "history" });
    expect(activityDestination("memory", new URLSearchParams("tab=review"))).toEqual({ view: "memory", activityTab: "history" });
    expect(activityDestination("connect", new URLSearchParams("tab=checks"))).toEqual({ view: "connect", activityTab: "history" });
  });

  test("history links retain their own filters and exclude check query and scope", () => {
    const href = activityHref({ kind: "tasks", filters: { q: "build", agent: "codex", tool: "files.write", status: "failed", resource: "src/app.js", runId: "run-1", arbitrary: "discard" }, query: "handoff", activityId: "private-scope" });
    const params = paramsFor(href);
    expect(Object.fromEntries(params)).toEqual({ kind: "tasks", q: "build", agent: "codex", tool: "files.write", status: "failed", resource: "src/app.js", runId: "run-1" });
    expect(params.has("tab")).toBe(false); expect(params.has("activityId")).toBe(false);
    expect(activityHref()).toBe("#activity");
    expect(activityHref({ kind: "memory" })).toBe("#activity?kind=memory");
  });

  test("Checks uses its own intent and scope while excluding history filters", () => {
    const href = activityHref({ tab: "checks", kind: "tasks", filters: { q: "history phrase", agent: "codex", status: "failed" }, query: "context handoff", activityId: "activity-7" });
    expect(Object.fromEntries(paramsFor(href))).toEqual({ tab: "checks", q: "context handoff", activityId: "activity-7" });
    expect(activityHref({ tab: "checks" })).toBe("#activity?tab=checks");
  });

  test("intent and activity identifiers round-trip without becoming additional route parameters", () => {
    const query = "release & rollback? #context / déjà vu";
    const activityId = "activity:7&tab=history#private";
    const href = activityHref({ tab: "checks", query, activityId });
    const params = paramsFor(href);
    expect(params.get("q")).toBe(query); expect(params.get("activityId")).toBe(activityId);
    expect([...params.keys()]).toEqual(["tab", "q", "activityId"]);
    expect(href.split("#")).toHaveLength(2);
    expect(paramsFor(activityHref({ filters: { q: query } })).get("q")).toBe(query);
  });

  test("section links use native navigation semantics and preserve both destinations", () => {
    const historyHref = activityHref({ kind: "tasks", filters: { agent: "codex" } });
    const checksHref = activityHref({ tab: "checks", query: "release", activityId: "activity-7" });
    const view = render({ tab: "checks", historyHref, checksHref });
    expect(view.tag).toBe("nav"); expect(view.attrs.class).toBe("ds-tabs activity-section-tabs"); expect(view.attrs["aria-label"]).toBe("Activity views");
    expect(view.children.map(child => ({ tag: child.tag, label: child.textContent, href: child.attrs.href, current: child.attrs["aria-current"], key: child.attrs["data-activity-section"] }))).toEqual([
      { tag: "a", label: "History", href: historyHref, current: undefined, key: "history" },
      { tag: "a", label: "Handoffs", href: "#activity?tab=handoffs", current: undefined, key: "handoffs" },
      { tag: "a", label: "Checks", href: checksHref, current: "page", key: "checks" },
    ]);
    expect(view.children.every(child => child.attrs.class === "ds-tab" && !child.attrs.role && !child.attrs["aria-selected"])).toBe(true);
    expect(render().children[0].attrs["aria-current"]).toBe("page");
  });
});
