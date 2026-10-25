import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sharingView } from "./sharing-view.js";

class Element {
  attrs: Record<string,string> = {}; dataset: Record<string,string> = {}; children: Element[] = []; events: Record<string,Function> = {};
  value = ""; type = ""; checked = false; disabled = false; hidden = false; open = false; parentElement: Element | null = null; text = "";
  constructor(public tag: string, text = "") { this.text = text; }
  set className(value: string) { this.attrs.class = value; }
  get className() { return this.attrs.class || ""; }
  get childNodes() { return this.children; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "type") this.type = value; if (key === "value") this.value = value; if (key === "disabled") this.disabled = true; if (key === "hidden") this.hidden = true; if (key.startsWith("data-")) this.dataset[key.slice(5)] = value; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(key: string, callback: Function) { this.events[key] = callback; }
  append(...items: Element[]) { items.forEach(item => { item.parentElement = this; this.children.push(item); }); }
  replaceChildren(...items: (Element|string)[]) { this.text = ""; this.children = []; this.append(...items.map(item => item instanceof Element ? item : new Element("#text", String(item)))); }
  get textContent(): string { return this.text + this.children.map(item => item.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.text = value; }
  querySelectorAll(selector: string): Element[] { return all(this).slice(1).filter(node => selector === "details[open]" ? node.tag === "details" && node.open : selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1)) : node.tag === selector); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  focus() { (document as any).activeElement = this; }
  async fire(type: string) { await this.events[type]?.({ currentTarget: this, target: this, preventDefault() {} }); }
}
const all = (node: Element): Element[] => [node,...node.children.flatMap(all)];
const find = (node: Element, predicate: (value: Element) => boolean) => all(node).find(predicate)!;
const field = (node: Element, name: string) => find(node, item => item.attrs.name === name);
const button = (node: Element, text: string) => find(node, item => item.tag === "button" && item.textContent === text);
const tick = () => Bun.sleep(0);
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { activeElement: null, createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));
const candidate = { id: "candidate-1", title: "Memory excerpt", text: "Use stable IDs. Keep private contact details out.", reason: "Project text match.", sourceKind: "memory" };
const preview = () => ({ previewId: "preview-1", expiresAt: new Date(Date.now()+60_000).toISOString(), method: "text", candidates: [candidate], excludedCount: 1 });
const catalog = { sourceKind: "personal", targets: [{ id: 1, name: "Design team" }], shares: [], modelAvailable: false };
const share = { id: "share-1", instruction: "Share project decisions, exclude personal details.", recipient: { kind: "team", orgId: 1, name: "Design team" }, itemCount: 1, items: [{ id: candidate.id, title: candidate.title, text: "Use stable IDs." }], createdAt: new Date().toISOString(), revokedAt: null };
async function draft(view: Element, kind = "team") {
  field(view, "instruction").value = "Share project decisions, exclude personal details.";
  field(view, "recipient-kind").value = kind; await field(view,"recipient-kind").fire("change");
  field(view, kind === "team" ? "team" : "agent-name").value = kind === "team" ? "1" : "Research assistant";
  await find(view, item => item.tag === "form").fire("submit"); await tick();
}
async function approve(view: Element, text = candidate.text) {
  const editor = all(view).filter(item => item.tag === "textarea")[1]; editor.value = text; await editor.fire("input");
  const checks = all(view).filter(item => item.tag === "input" && item.type === "checkbox");
  checks[0].checked = true; await checks[0].fire("change");
  checks[1].checked = true; await checks[1].fire("change");
}

describe("reviewed selective sharing", () => {
  test("starts with nothing selected and commits only explicitly reviewed exact text to the selected recipient", async () => {
    const calls: any[] = [];
    const panel = sharingView({ api: { sharing: async () => catalog, sharingPreview: async (payload: any) => { calls.push(payload); return preview(); }, sharingCommit: async (payload: any) => { calls.push(payload); return { share }; } } });
    const view = panel.element as Element; await tick(); await draft(view);
    expect(calls[0].recipient).toEqual({kind:"team",orgId:1});
    expect(all(view).filter(item => item.type === "checkbox").every(item => !item.checked)).toBe(true);
    expect(button(view,"Share approved text").disabled).toBe(true);
    expect(view.textContent).toContain("Text match · manual review"); expect(view.textContent).toContain("Everyone authorized in that team");
    await approve(view, "Use stable IDs."); expect(button(view,"Share approved text").disabled).toBe(false);
    await button(view,"Share approved text").fire("click");
    expect(calls[1]).toEqual({ previewId:"preview-1", selections:[{id:candidate.id,text:"Use stable IDs."}], acknowledged:true });
    expect(view.textContent).toContain("Approved snapshot shared with Design team");
    expect(view.textContent).toContain("New or changed memories were not added"); panel.dispose();
  });

  test("instruction edits cancel pending previews and cannot commit an old response", async () => {
    let finish: (value:any)=>void = ()=>{}, commits=0;
    const panel = sharingView({api:{sharing:async()=>catalog,sharingPreview:()=>new Promise(resolve=>finish=resolve),sharingCommit:async()=>{commits++;return{share};}}});
    const view=panel.element as Element;await tick();await draft(view);
    field(view,"instruction").value="Share only deployment notes.";await field(view,"instruction").fire("input");
    finish(preview());await tick();
    expect(all(view).some(item=>item.type==="checkbox")).toBe(false);expect(commits).toBe(0);
    expect(button(view,"Preview matching text").disabled).toBe(false);panel.dispose();
  });

  test("added text is blocked, edits reset acknowledgment, and expired previews require another review", async () => {
    let clock=Date.now(), commits=0;
    const result={...preview(),expiresAt:new Date(clock+60_000).toISOString()};
    const panel=sharingView({now:()=>clock,api:{sharing:async()=>catalog,sharingPreview:async()=>result,sharingCommit:async()=>{commits++;return{share};}}});
    const view=panel.element as Element;await tick();await draft(view);await approve(view,"Invented unrelated material");
    expect(button(view,"Share approved text").disabled).toBe(true);
    await approve(view,"Use stable IDs.");expect(button(view,"Share approved text").disabled).toBe(false);
    const editor=all(view).filter(item=>item.tag==="textarea")[1];editor.value="Use stable";await editor.fire("input");
    expect(all(view).filter(item=>item.type==="checkbox")[1].checked).toBe(false);
    await approve(view,"Use stable IDs.");clock+=60_001;await button(view,"Share approved text").fire("click");
    expect(commits).toBe(0);expect(view.textContent).toContain("Preview expired");panel.dispose();
  });

  test("stale commit failures keep reviewed drafts while preventing a stale retry",async()=>{
    const panel=sharingView({api:{sharing:async()=>catalog,sharingPreview:async()=>preview(),sharingCommit:async()=>{throw Object.assign(new Error("Preview expired. Preview again."),{status:410,code:"preview_expired"});}}});
    const view=panel.element as Element;await tick();await draft(view);await approve(view,"Use stable IDs.");await button(view,"Share approved text").fire("click");
    expect(all(view).filter(item=>item.tag==="textarea")[1].value).toBe("Use stable IDs.");expect(button(view,"Share approved text").disabled).toBe(true);
    expect(view.textContent).toContain("Preview expired");panel.dispose();
  });

  test("an agent credential is masked, copied only on action, and erased on leaving",async()=>{
    const token="egs_"+"a".repeat(32), copied:string[]=[];
    const agentShare={...share,recipient:{kind:"agent",name:"Research assistant"}};
    const panel=sharingView({copy:async value=>{copied.push(value);},api:{sharing:async()=>catalog,sharingPreview:async()=>preview(),sharingCommit:async()=>({share:agentShare,credential:{token,mcpUrl:"https://engram.example/mcp/shared"}})}});
    const view=panel.element as Element;await tick();await draft(view,"agent");expect(view.textContent).toContain("Existing full workspace connections keep their prior access");
    await approve(view,"Use stable IDs.");await button(view,"Share approved text").fire("click");
    const secret=find(view,item=>item.attrs["aria-label"]==="Read-only share token");
    expect(secret.type).toBe("password");expect(secret.value).toBe(token);expect(secret.attrs.value).toBeUndefined();expect(copied).toEqual([]);
    await button(view,"Copy token").fire("click");expect(copied).toEqual([token]);
    panel.clearSecrets();expect(secret.value).toBe("");expect(view.textContent).not.toContain(token);panel.dispose();
  });

  test("scope changes discard late commit credentials and team workspaces show source guidance",async()=>{
    let finish:(value:any)=>void=()=>{};
    const panel=sharingView({api:{sharing:async()=>catalog,sharingPreview:async()=>preview(),sharingCommit:()=>new Promise(resolve=>finish=resolve)}});
    const view=panel.element as Element;await tick();await draft(view,"agent");await approve(view,"Use stable IDs.");
    const pending=button(view,"Share approved text").fire("click");panel.dispose();finish({share,credential:{token:"egs_"+"x".repeat(32),mcpUrl:"https://engram.example/mcp/shared"}});await pending;
    expect(all(view).some(item=>item.value.startsWith("egs_"))).toBe(false);
    const teamPanel=sharingView({api:{sharing:async()=>({...catalog,sourceKind:"team"})}});
    await tick();expect(teamPanel.element.textContent).toContain("Choose your personal workspace");expect((teamPanel.element as Element).querySelector("form")?.hidden).toBe(true);teamPanel.dispose();
  });
});
