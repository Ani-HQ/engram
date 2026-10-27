import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connectionAgents, connectionSetupView } from "./connection-setup-view.js";
import { agentSources } from "./tooling.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {};
  value = ""; text = ""; open = false; isConnected = true; parentNode?: Element; reportValidity?: () => boolean;
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "open") this.open = true; }
  addEventListener(key: string, action: Function) { this.events[key] = action; }
  append(...children: Element[]) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  fire(type: string) { return this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this }); }
}
const nodes = (node: Element): Element[] => [node, ...node.children.flatMap(nodes)];
const find = (node: Element, predicate: (item: Element) => boolean) => nodes(node).find(predicate)!;
const focus = (node: Element, key: string) => find(node, item => item.attrs["data-connection-focus"] === key);
const disclosure = (node: Element, key: "key" | "help") => focus(node, `${key}-toggle`).parentNode!;
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));
const endpoint = "https://engram.example/custom/mcp";
const render = (options: Record<string, unknown> = {}) => connectionSetupView({ endpoint, ...options }) as Element;

describe("generic connection composer", () => {
  test("starts with the shared endpoint and refresh, with optional sections closed", () => {
    let refreshes = 0;
    const copied: unknown[] = [];
    const view = render({ onDone: () => { refreshes++; }, copyControl: (label: string, value: string, attrs: unknown) => { copied.push({ label, value, attrs }); return new Element("button", label); } });
    expect(find(view, node => node.attrs.id === "detail-title").textContent).toBe("Connect an agent");
    expect(find(view, node => node.tag === "code").textContent).toBe(endpoint);
    expect(copied).toEqual([{ label: "Copy endpoint", value: endpoint, attrs: { class: "primary", "data-connection-focus": "endpoint" } }]);
    expect(view.children[1].attrs.class).toContain("connection-setup-endpoint");
    expect(disclosure(view, "key").open).toBe(false); expect(disclosure(view, "help").open).toBe(false);
    expect(focus(view, "help").attrs.required).toBeUndefined(); expect(focus(view, "help").value).toBe("");
    expect(view.textContent).toContain("Sign in to Engram when prompted");
    expect(view.textContent).toContain("refresh Connections to see its client name when available");
    focus(view, "refresh").fire("click"); expect(refreshes).toBe(1);
  });

  test("creates a key without choosing an agent and submits no display-source metadata", () => {
    const submitted: unknown[] = [];
    const view = render({ keyExpanded: true, draft: { name: "Work laptop", canWrite: false, harness: "codex", sourceLabel: "Manual source" }, onSubmit: (value: unknown) => submitted.push(value) });
    expect(disclosure(view, "key").open).toBe(true);
    expect(focus(view, "name").attrs).toMatchObject({ name: "agent-name", required: "", maxlength: "100", autocomplete: "off" });
    expect(focus(view, "permission").value).toBe("read");
    find(view, node => node.tag === "form").fire("submit");
    expect(submitted).toEqual([{ name: "Work laptop", canWrite: false }]);
  });

  test("selecting optional help has no effect on key drafts or credential payloads", () => {
    const chosen: string[] = [], drafts: unknown[] = [], submitted: unknown[] = [];
    const view = render({ helpExpanded: true, draft: { name: "Personal computer", canWrite: false }, onHelpChoose: (value: string) => chosen.push(value), onDraft: (value: unknown) => drafts.push(value), onSubmit: (value: unknown) => submitted.push(value) });
    focus(view, "help").value = "codex"; focus(view, "help").fire("change");
    expect(chosen).toEqual(["codex"]); expect(drafts).toEqual([]);
    find(view, node => node.tag === "form").fire("submit");
    expect(submitted).toEqual([{ name: "Personal computer", canWrite: false }]);
  });

  test("OAuth setup help remains optional while access-key creation stays available", () => {
    for (const helpAgentId of ["claude", "chatgpt", "grok"]) {
      const view = render({ helpAgentId, helpExpanded: true });
      expect(view.textContent).toContain("add Engram as a custom MCP connector with the endpoint above");
      expect(view.textContent).toContain("sign in to your Engram workspace");
      expect(view.textContent).toContain("this Engram installation support OAuth");
      expect(nodes(view).filter(node => node.tag === "form")).toHaveLength(1);
      expect(nodes(view).some(node => node.tag === "pre")).toBe(false);
      expect(disclosure(view, "key").open).toBe(false);
      expect(focus(view, "help").value).toBe(helpAgentId);
    }
  });

  test("key-client help uses configuration examples with placeholders, never draft credentials", () => {
    for (const helpAgentId of ["codex", "vscode", "cline", "grok-bot", "other"]) {
      const view = render({ helpAgentId, helpExpanded: true, draft: { name: "Office", token: "eng_NEVER_RENDER_THIS" } });
      const example = find(view, node => node.tag === "pre");
      expect(example.textContent).toContain(endpoint); expect(example.textContent).toContain("<access-token>");
      expect(view.textContent).not.toContain("eng_NEVER_RENDER_THIS");
      expect(example.attrs.tabindex).toBe("0"); expect(example.attrs["aria-label"]).toContain("MCP configuration example");
      if (helpAgentId === "codex") expect(example.textContent).toContain("[mcp_servers.engram]");
      if (helpAgentId === "vscode") expect(example.textContent).toContain('"servers"');
    }
  });

  test("preserves the full source catalog only as optional setup help", () => {
    for (const [id] of agentSources) expect(connectionAgents.some(agent => agent.id === id)).toBe(true);
    expect(new Set(connectionAgents.map(agent => agent.id)).size).toBe(connectionAgents.length);
    expect(connectionAgents.at(-1)?.id).toBe("other");
    const view = render({ helpAgentId: "hermes" });
    expect(focus(view, "help").value).toBe("hermes");
    expect(nodes(view).filter(node => node.tag === "select")).toHaveLength(2);
    expect(nodes(view).filter(node => node.tag === "select" && node.attrs.required !== undefined)).toHaveLength(0);
    expect(disclosure(view, "help").open).toBe(false);
  });

  test("disclosure callbacks preserve independently controlled open states", () => {
    const keyStates: boolean[] = [], helpStates: boolean[] = [];
    const view = render({ keyExpanded: true, helpExpanded: false, onKeyToggle: (value: boolean) => keyStates.push(value), onHelpToggle: (value: boolean) => helpStates.push(value) });
    const key = disclosure(view, "key"), help = disclosure(view, "help");
    expect(key.open).toBe(true); expect(help.open).toBe(false);
    key.open = false; key.fire("toggle"); help.open = true; help.fire("toggle");
    expect(keyStates).toEqual([false]); expect(helpStates).toEqual([true]);
    const rerendered = render({ keyExpanded: keyStates.at(-1), helpExpanded: helpStates.at(-1) });
    expect(disclosure(rerendered, "key").open).toBe(false); expect(disclosure(rerendered, "help").open).toBe(true);
  });

  test("retains drafts and submits only when native validation succeeds", () => {
    const drafts: unknown[] = [], submitted: unknown[] = [];
    const view = render({ draft: { name: "Work machine", canWrite: false }, onDraft: (value: unknown) => drafts.push(value), onSubmit: (value: unknown) => submitted.push(value) });
    const name = focus(view, "name"), permission = focus(view, "permission"), form = find(view, node => node.tag === "form");
    expect(name.value).toBe("Work machine"); expect(permission.value).toBe("read");
    name.value = "Home machine"; name.fire("input"); permission.value = "write"; permission.fire("change");
    expect(drafts).toEqual([{ name: "Home machine", canWrite: false }, { name: "Home machine", canWrite: true }]);
    form.reportValidity = () => false; form.fire("submit"); expect(submitted).toHaveLength(0);
    form.reportValidity = () => true; form.fire("submit"); expect(submitted).toEqual([{ name: "Home machine", canWrite: true }]);
  });

  test("queued disclosure events from a replaced dialog cannot overwrite current open state", () => {
    const events: boolean[] = [];
    const view = render({ keyExpanded: true, helpExpanded: true, onKeyToggle: (value: boolean) => events.push(value), onHelpToggle: (value: boolean) => events.push(value) });
    for (const key of ["key", "help"] as const) {
      const section = disclosure(view, key);
      section.isConnected = false; section.open = false; section.fire("toggle");
    }
    expect(events).toEqual([]);
  });

  test("pending issuance opens the key section and blocks duplicate submission or editor changes", () => {
    let calls = 0;
    const count = () => { calls++; };
    const view = render({ busy: true, onHelpChoose: count, onDraft: count, onSubmit: count, onDone: count });
    expect(view.attrs["aria-busy"]).toBe("true"); expect(disclosure(view, "key").open).toBe(true);
    expect(focus(view, "help").attrs.disabled).toBe(""); expect(focus(view, "name").attrs.readonly).toBe("");
    expect(focus(view, "permission").attrs.disabled).toBe(""); expect(focus(view, "submit").attrs.disabled).toBe(""); expect(focus(view, "refresh").attrs.disabled).toBe("");
    expect(find(view, node => node.attrs.role === "status").textContent).toContain("Creating access key");
    focus(view, "help").fire("change"); focus(view, "name").fire("input"); focus(view, "permission").fire("change"); focus(view, "refresh").fire("click");
    find(view, node => node.tag === "form").fire("submit"); expect(calls).toBe(0);
  });

  test("issuance errors open the key section, link feedback, and keep entered values", () => {
    const view = render({ helpAgentId: "cursor", draft: { name: "My project", canWrite: false }, error: "The key could not be created. Try again." });
    expect(disclosure(view, "key").open).toBe(true);
    expect(find(view, node => node.attrs.role === "alert").textContent).toContain("could not be created");
    expect(focus(view, "help").value).toBe("cursor"); expect(focus(view, "name").value).toBe("My project"); expect(focus(view, "permission").value).toBe("read");
    expect(focus(view, "name").attrs["aria-describedby"]).toContain("connection-create-feedback"); expect(focus(view, "submit").attrs.disabled).toBeUndefined();
  });

  test("invalid endpoints cannot be copied or used for key issuance", () => {
    for (const endpoint of ["javascript:alert(1)", "https://user:secret@example.com/mcp", "http://remote.example/mcp", "https://engram.example/mcp?token=secret"]) {
      let copied = false;
      const view = render({ endpoint, copyControl: () => { copied = true; return new Element("button"); } });
      expect(view.textContent).toContain("Connection instructions are unavailable");
      expect(nodes(view).some(node => node.tag === "form" || node.tag === "code")).toBe(false); expect(copied).toBe(false);
    }
    const local = render({ endpoint: "http://localhost:8107/mcp/" });
    expect(find(local, node => node.tag === "code").textContent).toBe("http://localhost:8107/mcp");
  });

  test("missing or unrecognized help does not block the generic flow or expose workflow setup", () => {
    for (const helpAgentId of ["", "unknown-product"]) {
      const view = render({ helpAgentId });
      expect(focus(view, "help").value).toBe("");
      expect(nodes(view).some(node => node.tag === "form")).toBe(true);
      expect(find(view, node => node.tag === "code").textContent).toBe(endpoint);
      for (const text of ["Private skills", "Copy skill setup prompt", "npx", "Copy save prompt", "Set up or repair memory workflow", "Copy connection check"]) expect(view.textContent).not.toContain(text);
    }
  });
});
