import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyWorkspaceName, captureSetupFocus, createWorkspaceNameEditor, restoreSetupFocus, workspaceNameForm } from "./workspace-name.js";
import { onboardingGuide } from "./onboarding-view.js";
import { onboardingProgress } from "./onboarding-model.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {}; dataset: Record<string, string> = {};
  parentElement: Element | null = null;
  value = ""; text = ""; disabled = false; selectionStart: number | null = null; selectionEnd: number | null = null; selectionDirection = "none";
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  get tagName() { return this.tag.toUpperCase(); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "disabled") this.disabled = true; if (key === "data-setup-focus") this.dataset.setupFocus = value; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  toggleAttribute(key: string, force = !Object.hasOwn(this.attrs, key)) { if (force) this.setAttribute(key, ""); else this.removeAttribute(key); return force; }
  addEventListener(key: string, action: Function) { this.events[key] = action; }
  append(...items: Element[]) { items.forEach(item => { item.parentElement = this; }); this.children.push(...items); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.text = value; }
  get open() { return Object.hasOwn(this.attrs, "open"); }
  set open(value: boolean) { if (value) this.attrs.open = ""; else delete this.attrs.open; }
  contains(node: Element) { return all(this).includes(node); }
  querySelectorAll(selector: string) { return all(this).filter(node => selector === "[data-setup-focus]" && node.dataset.setupFocus); }
  querySelector(selector: string) { return all(this).find(node => node.tag === selector); }
  closest(selector: string): Element | null { return selector === "details:not([open])" && this.tag === "details" && !this.open ? this : this.parentElement?.closest(selector) || null; }
  focus() { (globalThis.document as any).activeElement = this; }
  setSelectionRange(start: number, end: number, direction: string) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  async fire(type: string) { await this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const find = (node: Element, predicate: (item: Element) => boolean) => all(node).find(predicate)!;
const disclosure = (node: Element, label: string) => find(node, item => item.tag === "details" && item.children.some(child => child.tag === "summary" && child.textContent === label));
const fresh = { hasToken: false, hasPage: false, provisioning: false, checks: { agentConnected: false, memorySaved: false, memoryRecalled: false, taskReported: false } };
const complete = { ...fresh, checks: { agentConnected: true, memorySaved: true, memoryRecalled: true, taskReported: true } };
const owner = { role: "owner", email: "owner@example.com", org: { id: 7, name: "Original" } };
const guideProps = { data: fresh, mcp: "https://example.test/mcp", session: owner, copyControl: (label: string, _value: string, attrs: Record<string, string> = {}) => {
  const control = new Element("button", label);
  for (const [key, value] of Object.entries(attrs)) control.setAttribute(key, value);
  return control;
} };
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

  test("keeps optional workspace naming after the agent task in a closed owner-only disclosure", () => {
    const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => "session", save: async () => ({}) });
    const props = { data: fresh, mcp: "https://example.test/mcp", session: owner, nameEditor: editor, copyControl: () => new Element("button") };
    const guide = onboardingGuide(props) as Element;
    const naming = disclosure(guide, "Workspace name (optional)");
    expect(naming).toBeDefined(); expect(naming.attrs).not.toHaveProperty("open");
    expect(all(guide).indexOf(naming)).toBeGreaterThan(all(guide).indexOf(find(guide, node => node.tag === "select")));
    expect(naming.textContent).toContain("You can also change this in Workspace settings.");
    expect(all(guide).filter(node => node.tag === "li")).toHaveLength(3);
    expect(workspaceNameForm({ session: { ...owner, role: "member" }, editor })).toBeNull();
    expect(workspaceNameForm({ session: { ...owner, email: null }, editor })).toBeNull();
    expect((onboardingGuide({ ...props, session: { ...owner, role: "member" } }) as Element).textContent).not.toContain("Name your workspace");
  });

  test("existing workspaces can repair an agent after receipts complete without claiming installation", async () => {
    let chosen = "", created = 0;
    const data = complete;
    const guide = onboardingGuide({ data, agentId: "codex", mcp: "https://custom.example/engram/mcp", session: owner,
      onChoose: (value: string) => { chosen = value; }, onCreateKey: () => { created++; },
      copyControl: (label: string) => new Element("button", label),
    }) as Element;
    const repair = disclosure(guide, "Add or repair an agent");
    expect(repair).toBeDefined(); expect(repair.attrs).not.toHaveProperty("open");
    expect(repair.textContent).toContain("setup codex --host 'https://custom.example/engram'");
    expect(find(guide, node => node.attrs.id === "setup-title").textContent).toBe("Your workspace has memory.");
    for (const label of ["Open Memory", "View Activity", "Review connections"]) {
      const action = find(guide, node => node.tag === "a" && node.textContent === label);
      expect(action).toBeDefined(); expect(repair.contains(action)).toBe(false);
      expect(all(guide).indexOf(action)).toBeLessThan(all(guide).indexOf(repair));
    }
    expect(guide.textContent).not.toContain("SKILL.md"); expect(guide.textContent).not.toContain("/absolute/project");
    const selector = find(guide, node => node.tag === "select"); selector.value = "cursor"; await selector.fire("change"); expect(chosen).toBe("cursor");
    await find(guide, node => node.tag === "button" && node.textContent === "Create an access key").fire("click"); expect(created).toBe(1);
    expect(onboardingProgress(data).completed).toBe(3);
  });

  test("applying a confirmed name updates only matching display names", () => {
    const policies = { agentsMayWrite: false }, session = { org: { id: 7, name: "Old", slug: "stable", policies, provisioningStatus: "ready" }, orgs: [{ id: 7, name: "Old", role: "owner" }, { id: 8, name: "Other", role: "member" }] };
    expect(applyWorkspaceName(session, { id: 7, name: "New", slug: "stale", policies: {}, provisioningStatus: "pending" })).toBe(true);
    expect(session.org).toEqual({ id: 7, name: "New", slug: "stable", policies, provisioningStatus: "ready" }); expect(session.orgs).toEqual([{ id: 7, name: "New", role: "owner" }, { id: 8, name: "Other", role: "member" }]);
    expect(applyWorkspaceName(session, { id: 8, name: "Wrong workspace" })).toBe(false); expect(session.org.name).toBe("New");
  });
});

describe("guided setup task hierarchy", () => {
  test("fresh setup starts with a direct empty choice and reveals only the selected client's guide", () => {
    const unselected = onboardingGuide(guideProps) as Element;
    const choice = find(unselected, node => node.tag === "select");
    expect(choice.value).toBe("");
    expect(all(unselected).filter(node => node.tag === "details").some(node => node.contains(choice))).toBe(false);
    expect(unselected.textContent).not.toContain("Private skills");
    expect(unselected.textContent).not.toContain("Copy skill setup prompt");

    const selected = onboardingGuide({ ...guideProps, agentId: "grok-bot" }) as Element;
    const workflow = disclosure(selected, "Set up or repair memory workflow");
    expect(workflow.open).toBe(false);
    expect(workflow.textContent).toContain("Private skills");
    const local = onboardingGuide({ ...guideProps, agentId: "codex" }) as Element;
    expect(disclosure(local, "Set up or repair memory workflow").open).toBe(true);
  });

  test("completed workspace evidence does not present the selected Grok Bot as verified", () => {
    const guide = onboardingGuide({ ...guideProps, data: complete, agentId: "grok-bot" }) as Element;
    const repair = disclosure(guide, "Add or repair an agent");
    expect(repair.attrs).not.toHaveProperty("open");
    expect(repair.textContent).toContain("Copy skill setup prompt");
    expect(all(guide).some(node => node.attrs["aria-label"] === "Getting started progress")).toBe(false);
    expect(guide.textContent.indexOf("Your workspace has memory.")).toBeLessThan(guide.textContent.indexOf("Add or repair an agent"));
    expect(guide.textContent.indexOf("Open Memory")).toBeLessThan(guide.textContent.indexOf("Copy skill setup prompt"));
    expect(guide.textContent).not.toMatch(/Grok Bot (?:is connected|connected|verified|has memory)/);
  });

  test("save and recall tasks precede optional agent connection help", () => {
    for (const [memorySaved, label] of [[false, "Copy save prompt"], [true, "Copy recall prompt"]] as const) {
      const data = { ...fresh, checks: { ...fresh.checks, agentConnected: true, memorySaved } };
      const guide = onboardingGuide({ ...guideProps, data, agentId: "codex" }) as Element;
      const help = disclosure(guide, "Agent connection help");
      const prompt = find(guide, node => node.tag === "button" && node.textContent === label);
      expect(help).toBeDefined(); expect(help.attrs).not.toHaveProperty("open");
      expect(prompt).toBeDefined(); expect(help.contains(prompt)).toBe(false);
      expect(all(guide).indexOf(prompt)).toBeLessThan(all(guide).indexOf(help));
      expect(help.textContent).toContain("setup codex");
    }
  });

  test("unavailable receipts remain unmeasured and refresh failures stay outside closed help", () => {
    const unavailable = onboardingGuide({ ...guideProps, data: undefined }) as Element;
    expect(unavailable.textContent).not.toContain("Your workspace has memory.");
    expect(all(unavailable).some(node => Object.hasOwn(node.attrs, "aria-valuenow"))).toBe(false);
    expect(unavailable.textContent).toMatch(/not checked|no checks|not received/i);

    const guide = onboardingGuide({ ...guideProps, data: complete, agentId: "grok-bot", error: "Progress service unavailable" }) as Element;
    const alert = find(guide, node => node.attrs.role === "alert" && node.textContent.includes("Progress service unavailable"));
    expect(alert).toBeDefined();
    expect(all(guide).filter(node => node.tag === "details").some(node => node.contains(alert))).toBe(false);
  });

  test("progress refresh remains actionable and blocks repeat checks while pending", async () => {
    let checks = 0;
    const guide = onboardingGuide({ ...guideProps, onCheck: () => { checks++; } }) as Element;
    await find(guide, node => node.dataset.setupFocus === "check").fire("click");
    expect(checks).toBe(1);
    const pending = onboardingGuide({ ...guideProps, checking: true, onCheck: () => { checks++; } }) as Element;
    const check = find(pending, node => node.dataset.setupFocus === "check");
    expect(pending.attrs["aria-busy"]).toBe("true");
    expect(check.disabled || check.attrs["aria-disabled"] === "true").toBe(true);
    await check.fire("click"); expect(checks).toBe(1);
  });

  test("secondary disclosures keep the user's open and closed choices across rerenders", async () => {
    const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => "session", save: async () => ({}) });
    const scenarios = [
      { key: "completedAgent", label: "Add or repair an agent", data: complete },
      { key: "agentHelp", label: "Agent connection help", data: { ...fresh, checks: { ...fresh.checks, agentConnected: true } } },
      { key: "workspaceName", label: "Workspace name (optional)", data: fresh },
    ];
    for (const scenario of scenarios) {
      const disclosures: Record<string, boolean> = {};
      const props = { ...guideProps, data: scenario.data, nameEditor: editor, disclosures, onDisclosureChange: (key: string, open: boolean) => { disclosures[key] = open; } };
      const initial = disclosure(onboardingGuide(props) as Element, scenario.label);
      expect(initial.open).toBe(false);
      initial.open = true; await initial.fire("toggle");
      expect(disclosures[scenario.key]).toBe(true);
      const refreshed = disclosure(onboardingGuide({ ...props, checking: true }) as Element, scenario.label);
      expect(refreshed.open).toBe(true);
      refreshed.open = false; await refreshed.fire("toggle");
      expect(disclosures[scenario.key]).toBe(false);
      expect(disclosure(onboardingGuide(props) as Element, scenario.label).open).toBe(false);
    }
  });

  test("local and provider workflow disclosures retain their choices, including nested Grok instructions", async () => {
    const disclosures: Record<string, boolean> = {};
    const onDisclosureChange = (key: string, open: boolean) => { disclosures[key] = open; };
    for (const agentId of ["codex", "grok-bot"]) {
      const props = { ...guideProps, agentId, disclosures, onDisclosureChange };
      const initial = disclosure(onboardingGuide(props) as Element, "Set up or repair memory workflow");
      const initialOpen = initial.open;
      initial.open = !initialOpen; await initial.fire("toggle");
      const refreshed = disclosure(onboardingGuide({ ...props, checking: true }) as Element, "Set up or repair memory workflow");
      expect(refreshed.open).toBe(!initialOpen);
      expect(disclosures[`workflow-${agentId}`]).toBe(!initialOpen);
    }
    const props = { ...guideProps, agentId: "grok-bot", disclosures, onDisclosureChange };
    const guide = onboardingGuide(props) as Element;
    const instructions = disclosure(guide, "Review skill instructions");
    const summary = instructions.querySelector("summary")!;
    expect(summary.dataset.setupFocus).toStartWith("workflow-grok-bot-");
    instructions.open = true; await instructions.fire("toggle");
    expect(disclosures[summary.dataset.setupFocus]).toBe(true);
    const refreshed = onboardingGuide({ ...props, checking: true }) as Element;
    expect(disclosure(refreshed, "Set up or repair memory workflow").open).toBe(true);
    const restoredInstructions = disclosure(refreshed, "Review skill instructions");
    expect(restoredInstructions.open).toBe(true);
    restoredInstructions.open = false; await restoredInstructions.fire("toggle");
    const closed = onboardingGuide(props) as Element;
    expect(disclosure(closed, "Review skill instructions").open).toBe(false);
    expect(disclosure(closed, "Set up or repair memory workflow").open).toBe(true);
    expect(disclosures["workflow-codex"]).toBe(false);
  });

  test("drafts and failures keep optional naming available when the guide rerenders", async () => {
    const editor = createWorkspaceNameEditor({ workspaceId: 7, name: "Original", context: () => "session", save: async () => { throw new Error("Name could not be saved"); } });
    editor.setDraft("Draft workspace");
    const draft = onboardingGuide({ ...guideProps, nameEditor: editor }) as Element;
    expect(disclosure(draft, "Workspace name (optional)").open).toBe(true);
    await editor.submit();
    const failed = onboardingGuide({ ...guideProps, data: complete, nameEditor: editor }) as Element;
    const naming = disclosure(failed, "Workspace name (optional)");
    expect(naming.open).toBe(true);
    expect(naming.textContent).toContain("Name could not be saved");
    expect(find(naming, node => node.tag === "input").value).toBe("Draft workspace");
  });

  test("focus survives agent selection rerenders and returns to the title when a completed task removes its prompt", () => {
    const props = { ...guideProps, data: complete, agentId: "codex", disclosures: { completedAgent: true } };
    const initial = onboardingGuide(props) as Element;
    const selector = find(initial, node => node.dataset.setupFocus === "agent");
    selector.focus();
    const selectionFocus = captureSetupFocus(initial as any);
    const changed = onboardingGuide({ ...props, agentId: "grok-bot" }) as Element;
    restoreSetupFocus(changed as any, selectionFocus);
    expect(disclosure(changed, "Add or repair an agent").open).toBe(true);
    expect(document.activeElement as any).toBe(find(changed, node => node.dataset.setupFocus === "agent"));

    const recallData = { ...fresh, checks: { ...fresh.checks, agentConnected: true, memorySaved: true } };
    const recall = onboardingGuide({ ...guideProps, data: recallData }) as Element;
    find(recall, node => node.dataset.setupFocus === "prompt").focus();
    const promptFocus = captureSetupFocus(recall as any);
    const completed = onboardingGuide({ ...guideProps, data: complete }) as Element;
    restoreSetupFocus(completed as any, promptFocus);
    expect(document.activeElement as any).toBe(find(completed, node => node.dataset.setupFocus === "title"));
  });

  test("focus restoration reaches a visible summary when the prior control moves into closed help", () => {
    const props = { ...guideProps, agentId: "grok-bot", disclosures: { "workflow-grok-bot": true } };
    const initial = onboardingGuide(props) as Element;
    find(initial, node => node.dataset.setupFocus === "command").focus();
    const snapshot = captureSetupFocus(initial as any);

    const workflowClosed = onboardingGuide({ ...props, disclosures: { "workflow-grok-bot": false } }) as Element;
    restoreSetupFocus(workflowClosed as any, snapshot);
    expect(document.activeElement as any).toBe(disclosure(workflowClosed, "Set up or repair memory workflow").querySelector("summary"));

    const helpClosed = onboardingGuide({ ...props, data: complete }) as Element;
    restoreSetupFocus(helpClosed as any, snapshot);
    expect(document.activeElement as any).toBe(disclosure(helpClosed, "Add or repair an agent").querySelector("summary"));

    const bothClosed = onboardingGuide({ ...props, data: complete, disclosures: { "workflow-grok-bot": false } }) as Element;
    restoreSetupFocus(bothClosed as any, snapshot);
    expect(document.activeElement as any).toBe(disclosure(bothClosed, "Add or repair an agent").querySelector("summary"));
  });
});
