import { describe, expect, test } from "bun:test";
import { agentOverview, connectionInventory } from "./connection-view.js";
import { taskReportingSetup } from "./task-reporting-view.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {}; value: string;
  constructor(tag: string, value = "") { this.tag = tag; this.value = value; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, value: Function) { this.events[key] = value; }
  append(...children: Element[]) { this.children.push(...children); }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
}
function render(work: () => Element) {
  const original = { Node: globalThis.Node, document: globalThis.document };
  try {
    Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (value: string) => new Element("#text", value) } });
    return work();
  } finally { Object.assign(globalThis, original); }
}
const nodes = (node: Element): Element[] => [node, ...node.children.flatMap(nodes)];
const current = { id: "token:1", agent: "laptop", name: "laptop", displayName: "Current laptop", kind: "token", status: "authorized", canWrite: true, memoryCalls: 2, taskReports: 3 };
const archived = { ...current, id: "oauth:2", name: "archived-client", agent: "archived-client", displayName: "Old agent", kind: "oauth", status: "revoked", archivedAt: "2026-10-25T12:00:00Z" };
const data = { connections: [current, archived], recentWindowSeconds: 900 };

describe("connection lifecycle presentation", () => {
  test("current and archived inventories remain separate and archived rows do not ask for reconnect", () => {
    const currentView = render(() => connectionInventory(data) as Element);
    expect(currentView.textContent).toContain("Current laptop"); expect(currentView.textContent).not.toContain("Old agent");
    let inspected: unknown;
    const archiveView = render(() => connectionInventory(data, { list: "archived", onInspect: (value: unknown) => { inspected = value; } }) as Element);
    expect(archiveView.textContent).toContain("Old agent"); expect(archiveView.textContent).toContain("Archived"); expect(archiveView.textContent).not.toContain("Reconnect needed");
    const details = nodes(archiveView).find(node => node.tag === "button" && node.textContent === "Details")!;
    details.events.click(); expect(inspected).toBe(archived);
    expect(nodes(archiveView).some(node => node.attrs["data-connection-id"] === "oauth:2")).toBe(true);
  });
  test("empty archived and current lists explain the selected scope without losing history", () => {
    expect(render(() => connectionInventory({ connections: [] }, { list: "archived" }) as Element).textContent).toContain("No archived connections");
    expect(render(() => connectionInventory({ connections: [archived] }) as Element).textContent).toContain("restore an archived connection");
  });
  test("archived agents stay out of overview and reporting attention while current evidence remains", () => {
    const overview = render(() => agentOverview(data) as Element);
    expect(overview.textContent).toContain("Current laptop"); expect(overview.textContent).not.toContain("Old agent"); expect(overview.textContent).not.toContain("connection needs a fresh");
    const reporting = render(() => taskReportingSetup(data) as Element);
    expect(reporting.textContent).toContain("Current laptop"); expect(reporting.textContent).not.toContain("Old agent");
    expect(reporting.textContent).toContain("1 connection has write access");
  });
  test("reporting routes ordinary setup through the managed flow and leaves the raw contract advanced", () => {
    let starts = 0;
    const view = render(() => taskReportingSetup(data, { onSetup: () => { starts++; } }) as Element);
    nodes(view).find(node => node.tag === "button" && node.textContent === "Set up or repair an agent")!.events.click();
    expect(starts).toBe(1);
    expect(view.textContent).toContain("Guided setup handles supported agent files automatically");
    expect(nodes(view).find(node => node.tag === "summary")?.textContent).toContain("Advanced: reporting contract");
    expect(view.textContent).not.toContain("Copy into your agent's instructions");
  });
});
