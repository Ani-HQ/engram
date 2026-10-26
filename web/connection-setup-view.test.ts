import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connectionAgents, connectionSetupView } from "./connection-setup-view.js";
import { agentSources } from "./tooling.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {};
  value = ""; text = ""; reportValidity?: () => boolean;
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, action: Function) { this.events[key] = action; }
  append(...children: Element[]) { this.children.push(...children); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  fire(type: string) { return this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this }); }
}
const nodes = (node: Element): Element[] => [node, ...node.children.flatMap(nodes)];
const find = (node: Element, predicate: (item: Element) => boolean) => nodes(node).find(predicate)!;
const focus = (node: Element, key: string) => find(node, item => item.attrs["data-connection-focus"] === key);
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));
const endpoint = "https://engram.example/custom/mcp";
const render = (options: Record<string, unknown> = {}) => connectionSetupView({ endpoint, ...options }) as Element;

describe("connection-only agent composer", () => {
  test("starts with an empty agent choice and no installation, key, or memory task", () => {
    let selected = "";
    const view = render({ onChoose: (value: string) => { selected = value; } });
    expect(find(view, node => node.attrs.id === "detail-title").textContent).toBe("Connect an agent");
    expect(focus(view, "agent").value).toBe("");
    expect(nodes(view).some(node => node.tag === "form" || node.tag === "code")).toBe(false);
    focus(view, "agent").value = "chatgpt"; focus(view, "agent").fire("change");
    expect(selected).toBe("chatgpt");
    for (const text of ["Save your first memory", "Copy recall prompt", "Private skills", "Set up or repair memory workflow"]) expect(view.textContent).not.toContain(text);
  });

  test("OAuth clients show endpoint and sign-in steps without creating an access key", () => {
    for (const agentId of ["claude", "chatgpt", "grok"]) {
      let refreshes = 0;
      const copied: unknown[] = [];
      const view = render({ agentId, onDone: () => { refreshes++; }, copyControl: (label: string, value: string, attrs: unknown) => { copied.push({ label, value, attrs }); return new Element("button", label); } });
      expect(view.textContent).toContain("sign in to your Engram workspace");
      expect(view.textContent).toContain("OAuth to be enabled");
      expect(nodes(view).some(node => node.tag === "form")).toBe(false);
      expect(view.textContent).not.toContain("Create access key");
      expect(copied).toEqual([{ label: "Copy endpoint", value: endpoint, attrs: { class: "primary", "data-connection-focus": "endpoint" } }]);
      focus(view, "refresh").fire("click"); expect(refreshes).toBe(1);
    }
  });

  test("key clients derive the source from the chosen agent and expose only connection fields", () => {
    for (const agentId of ["codex", "grok-bot", "vscode", "other"]) {
      const view = render({ agentId });
      expect(nodes(view).filter(node => node.tag === "form")).toHaveLength(1);
      expect(focus(view, "name").attrs).toMatchObject({ name: "agent-name", required: "", maxlength: "100", autocomplete: "off" });
      expect(focus(view, "permission").value).toBe("write");
      expect(focus(view, "submit").textContent).toBe("Create access key");
      expect(nodes(view).filter(node => node.tag === "select")).toHaveLength(2);
      for (const text of ["Private skills", "Copy skill setup prompt", "npx", "Copy save prompt", "Copy connection check"]) expect(view.textContent).not.toContain(text);
    }
  });

  test("preserves the full existing source catalog when connecting or replacing a key", () => {
    for (const [id] of agentSources) expect(connectionAgents.some(agent => agent.id === id)).toBe(true);
    expect(new Set(connectionAgents.map(agent => agent.id)).size).toBe(connectionAgents.length);
    expect(connectionAgents.at(-1)?.id).toBe("other");
    const submitted: unknown[] = [];
    const view = render({ agentId: "cline", draft: { name: "Cline laptop" }, onSubmit: (value: unknown) => submitted.push(value) });
    expect(focus(view, "agent").value).toBe("cline");
    expect(view.textContent).toContain("Create an access key for Cline");
    find(view, node => node.tag === "form").fire("submit");
    expect(submitted).toEqual([{ name: "Cline laptop", harness: "cline", canWrite: true }]);
    const invalid = render({ agentId: "cline", endpoint: "https://user:secret@example.com/mcp" });
    expect(nodes(invalid).some(node => node.tag === "form" || node.tag === "code")).toBe(false);
  });

  test("replacing an existing access key keeps OAuth-listed source metadata on the key flow", () => {
    const submitted: unknown[] = [];
    const view = render({ agentId: "chatgpt", keyOnly: true, draft: { name: "Existing ChatGPT key-new", canWrite: false }, onSubmit: (value: unknown) => submitted.push(value) });
    expect(focus(view, "agent").value).toBe("chatgpt");
    expect(focus(view, "permission").value).toBe("read");
    expect(view.textContent).toContain("Create an access key for ChatGPT");
    expect(view.textContent).not.toContain("OAuth to be enabled");
    find(view, node => node.tag === "form").fire("submit");
    expect(submitted).toEqual([{ name: "Existing ChatGPT key-new", harness: "chatgpt", canWrite: false }]);
    expect(nodes(render({ agentId: "chatgpt" })).some(node => node.tag === "form")).toBe(false);
  });

  test("retains drafts and submits only when native validation succeeds", () => {
    const drafts: unknown[] = [], submitted: unknown[] = [];
    const view = render({ agentId: "vscode", draft: { name: "Work machine", canWrite: false }, onDraft: (value: unknown) => drafts.push(value), onSubmit: (value: unknown) => submitted.push(value) });
    const name = focus(view, "name"), permission = focus(view, "permission"), form = find(view, node => node.tag === "form");
    expect(name.value).toBe("Work machine"); expect(permission.value).toBe("read");
    name.value = "Home machine"; name.fire("input");
    permission.value = "write"; permission.fire("change");
    expect(drafts).toEqual([{ name: "Home machine", harness: "vscode", canWrite: false }, { name: "Home machine", harness: "vscode", canWrite: true }]);
    form.reportValidity = () => false; form.fire("submit"); expect(submitted).toHaveLength(0);
    form.reportValidity = () => true; form.fire("submit"); expect(submitted).toEqual([{ name: "Home machine", harness: "vscode", canWrite: true }]);
  });

  test("pending issuance disables choices and blocks repeated submission or draft changes", () => {
    let calls = 0;
    const count = () => { calls++; };
    const view = render({ agentId: "codex", busy: true, onChoose: count, onDraft: count, onSubmit: count });
    expect(view.attrs["aria-busy"]).toBe("true");
    expect(focus(view, "agent").attrs.disabled).toBe("");
    expect(focus(view, "name").attrs.readonly).toBe("");
    expect(focus(view, "permission").attrs.disabled).toBe("");
    expect(focus(view, "submit").attrs.disabled).toBe("");
    expect(find(view, node => node.attrs.role === "status").textContent).toContain("Creating access key");
    focus(view, "agent").fire("change"); focus(view, "name").fire("input"); focus(view, "permission").fire("change");
    find(view, node => node.tag === "form").fire("submit"); expect(calls).toBe(0);
  });

  test("errors remain visible and keep the chosen source, draft and permission", () => {
    const view = render({ agentId: "cursor", draft: { name: "My project", canWrite: false }, error: "The key could not be created. Try again." });
    expect(find(view, node => node.attrs.role === "alert").textContent).toContain("could not be created");
    expect(focus(view, "agent").value).toBe("cursor"); expect(focus(view, "name").value).toBe("My project"); expect(focus(view, "permission").value).toBe("read");
    expect(focus(view, "name").attrs["aria-describedby"]).toContain("connection-create-feedback");
    expect(focus(view, "submit").attrs.disabled).toBeUndefined();
  });

  test("invalid endpoints and unrecognized clients never expose a credential form or copied endpoint", () => {
    for (const options of [{ endpoint: "javascript:alert(1)" }, { endpoint: "https://user:secret@example.com/mcp" }, { endpoint: "http://remote.example/mcp" }, { endpoint: `${endpoint}?token=secret` }, { agentId: "unknown-product" }]) {
      let copied = false;
      const view = render({ agentId: "codex", ...options, copyControl: () => { copied = true; return new Element("button"); } });
      expect(view.textContent).toContain("Connection instructions are unavailable");
      expect(nodes(view).some(node => node.tag === "form" || node.tag === "code")).toBe(false); expect(copied).toBe(false);
    }
  });
});
