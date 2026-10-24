import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyWorkspaceName, captureSetupFocus, createWorkspaceNameEditor, restoreSetupFocus, workspaceNameForm } from "./workspace-name.js";
import { onboardingGuide } from "./onboarding-view.js";
import { onboardingProgress } from "./onboarding-model.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {}; dataset: Record<string, string> = {};
  value = ""; text = ""; disabled = false; selectionStart: number | null = null; selectionEnd: number | null = null; selectionDirection = "none";
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "disabled") this.disabled = true; if (key === "data-setup-focus") this.dataset.setupFocus = value; }
  addEventListener(key: string, action: Function) { this.events[key] = action; }
  append(...items: Element[]) { this.children.push(...items); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.text = value; }
  contains(node: Element) { return all(this).includes(node); }
  querySelectorAll(selector: string) { return all(this).filter(node => selector === "[data-setup-focus]" && node.dataset.setupFocus); }
  focus() { (globalThis.document as any).activeElement = this; }
  setSelectionRange(start: number, end: number, direction: string) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  async fire(type: string) { await this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const find = (node: Element, predicate: (item: Element) => boolean) => all(node).find(predicate)!;
const fresh = { hasToken: false, hasPage: false, provisioning: false, checks: { agentConnected: false, memorySaved: false, memoryRecalled: false, taskReported: false } };
const owner = { role: "owner", email: "owner@example.com", org: { id: 7, name: "Original" } };
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { activeElement: null, createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));

describe("optional onboarding workspace name", () => {
  test("saves a trimmed name, blocks duplicate requests, and never alters agent evidence", async () => {
    let finish: (value: any) => void = () => {}; const calls: string[] = [], updates: any[] = [];
    const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => "session-1", save: (name: string) => { calls.push(name); return new Promise(resolve => { finish = resolve; }); }, saved: (org: any) => updates.push(org) });
    editor.setDraft("  Research notes  "); const pending = editor.submit();
    expect(editor.state.busy).toBe(true); expect(editor.state.feedback).toBe("Saving workspace name…");
    const view = workspaceNameForm({ session: owner, editor }) as Element;
    expect(find(view, node => node.tag === "button").disabled).toBe(true); expect(find(view, node => node.tag === "input").attrs.readonly).toBe("");
    await editor.submit(); expect(calls).toEqual(["Research notes"]);
    finish({ org: { id: 7, name: "Research notes" } }); await pending;
    expect(editor.state).toMatchObject({ name: "Research notes", draft: "Research notes", busy: false, error: "", feedback: "Workspace name saved." }); expect(updates).toEqual([{ id: 7, name: "Research notes" }]);
    expect(onboardingProgress(fresh).completed).toBe(0);
  });

  test("retains the draft on failures and rejects blank, long, control-character, and mismatched responses", async () => {
    let calls = 0, fail = true;
    const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => "session", save: async () => { calls++; if (fail) throw new Error("Service unavailable"); return { org: { id: 8, name: "Wrong workspace" } }; } });
    editor.setDraft("Unsaved decision"); await editor.submit(); expect(editor.state.draft).toBe("Unsaved decision"); expect(editor.state.error).toBe("Service unavailable"); expect(editor.state.busy).toBe(false);
    const view = workspaceNameForm({ session: owner, editor }) as Element; expect(find(view, node => node.attrs.id === "setup-name-feedback").attrs.role).toBe("alert");
    for (const name of ["   ", "x".repeat(101), "name\nwith control", "name\u007f"]) { editor.setDraft(name); await editor.submit(); expect(editor.state.error).toContain("between 1 and 100"); }
    expect(calls).toBe(1);
    fail = false; editor.setDraft("Keep my draft"); await editor.submit(); expect(editor.state.name).toBe("Original"); expect(editor.state.draft).toBe("Keep my draft"); expect(editor.state.error).toContain("could not be confirmed");
  });

  test("ignores late success and failure after switching away and returning or changing identity", async () => {
    for (const outcome of ["success", "failure"]) {
      let finish: (value: any) => void = () => {}, reject: (error: Error) => void = () => {}, identity = "owner-1", updates = 0;
      const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => identity, save: () => new Promise((resolve, fail) => { finish = resolve; reject = fail; }), saved() { updates++; } });
      editor.setDraft("Draft before switch"); const pending = editor.submit(); editor.invalidate();
      if (outcome === "success") finish({ org: { id: 7, name: "Late old save" } }); else reject(new Error("Late old error"));
      await pending; expect(updates).toBe(0); expect(editor.state.name).toBe("Original"); expect(editor.state.error).toBe(""); expect(editor.state.draft).toBe("Draft before switch");
      const another = editor.submit(); identity = "owner-2"; finish({ org: { id: 7, name: "Other identity" } }); await another; expect(updates).toBe(0); expect(editor.state.name).toBe("Original");
    }
  });

  test("draft and text selection survive a progress rerender, without stealing focus outside the guide", async () => {
    const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => "session", save: async () => ({}) });
    const view = workspaceNameForm({ session: owner, editor }) as Element, field = find(view, node => node.tag === "input");
    expect(field.value).toBe("Original"); field.value = "My unsaved workspace"; await field.fire("input"); field.focus(); field.setSelectionRange(3, 10, "forward");
    const snapshot = captureSetupFocus(view as any);
    editor.syncName("Original"); const next = workspaceNameForm({ session: owner, editor }) as Element; restoreSetupFocus(next as any, snapshot);
    const nextField = find(next, node => node.tag === "input"); expect(nextField.value).toBe("My unsaved workspace"); expect(document.activeElement as any).toBe(nextField); expect([nextField.selectionStart, nextField.selectionEnd, nextField.selectionDirection]).toEqual([3, 10, "forward"]);
    const outside = new Element("button"); outside.focus(); expect(captureSetupFocus(next as any)).toBeNull(); restoreSetupFocus(next as any, null); expect(document.activeElement as any).toBe(outside);
  });

  test("shows owners the optional form before exactly three agent steps and hides it from members", () => {
    const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => "session", save: async () => ({}) });
    const props = { data: fresh, mcp: "https://example.test/mcp", session: owner, nameEditor: editor, copyControl: () => new Element("button") };
    const guide = onboardingGuide(props) as Element;
    expect(guide.textContent.indexOf("Name your workspace (optional)")).toBeLessThan(guide.textContent.indexOf("Connect an agent"));
    expect(all(guide).filter(node => node.tag === "li")).toHaveLength(3); expect(guide.textContent).toContain("You can change this later here.");
    expect(workspaceNameForm({ session: { ...owner, role: "member" }, editor })).toBeNull();
    expect(workspaceNameForm({ session: { ...owner, email: null }, editor })).toBeNull();
    expect((onboardingGuide({ ...props, session: { ...owner, role: "member" } }) as Element).textContent).not.toContain("Name your workspace");
  });

  test("applying a confirmed name updates only matching display names", () => {
    const policies = { agentsMayWrite: false }, session = { org: { id: 7, name: "Old", slug: "stable", policies, provisioningStatus: "ready" }, orgs: [{ id: 7, name: "Old", role: "owner" }, { id: 8, name: "Other", role: "member" }] };
    expect(applyWorkspaceName(session, { id: 7, name: "New", slug: "stale", policies: {}, provisioningStatus: "pending" })).toBe(true);
    expect(session.org).toEqual({ id: 7, name: "New", slug: "stable", policies, provisioningStatus: "ready" }); expect(session.orgs).toEqual([{ id: 7, name: "New", role: "owner" }, { id: 8, name: "Other", role: "member" }]);
    expect(applyWorkspaceName(session, { id: 8, name: "Wrong workspace" })).toBe(false); expect(session.org.name).toBe("New");
  });
});
