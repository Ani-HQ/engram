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

  test("scope changes discard late commit credentials and a mismatched source never exposes its form",async()=>{
    let finish:(value:any)=>void=()=>{};
    const panel=sharingView({api:{sharing:async()=>catalog,sharingPreview:async()=>preview(),sharingCommit:()=>new Promise(resolve=>finish=resolve)}});
    const view=panel.element as Element;await tick();await draft(view,"agent");await approve(view,"Use stable IDs.");
    const pending=button(view,"Share approved text").fire("click");panel.dispose();finish({share,credential:{token:"egs_"+"x".repeat(32),mcpUrl:"https://engram.example/mcp/shared"}});await pending;
    expect(all(view).some(item=>item.value.startsWith("egs_"))).toBe(false);
    const teamPanel=sharingView({api:{sharing:async()=>({...catalog,sourceKind:"team"})}});
    await tick();expect(teamPanel.element.textContent).toContain("Open team memory");expect((teamPanel.element as Element).querySelector("form")?.hidden).toBe(true);teamPanel.dispose();
  });

  test("personal sharing leads with the form and keeps optional explanation in a disclosure", async () => {
    const panel = sharingView({ api: { sharing: async () => catalog } });
    const view = panel.element as Element; await tick();
    expect(view.children[0].tag).toBe("form"); expect(view.children[0].hidden).toBe(false);
    expect(view.textContent).toContain("Create a share");
    expect(view.textContent).not.toContain("Share the useful slice"); expect(view.textContent).not.toContain("Review before sharing");
    const help = find(view, item => item.tag === "details");
    expect(help.textContent).toContain("does not understand intent or exclusions");
    expect(help.textContent).toContain("fixed snapshot"); expect(help.open).toBe(false); panel.dispose();
  });

  test("a catalog refresh started before commit cannot discard the newly approved share",async()=>{
    let loadCalls=0, finishLoad:(value:any)=>void=()=>{}, finishCommit:(value:any)=>void=()=>{};
    const panel=sharingView({api:{
      sharing:()=>++loadCalls===1?Promise.resolve(catalog):new Promise(resolve=>finishLoad=resolve),
      sharingPreview:async()=>preview(), sharingCommit:()=>new Promise(resolve=>finishCommit=resolve),
    }});
    const view=panel.element as Element;await tick();await draft(view);await approve(view,"Use stable IDs.");
    const loading=button(view,"Refresh shares").fire("click");
    expect(view.textContent).toContain("Loading sharing settings");
    const committing=button(view,"Share approved text").fire("click");
    expect(button(view,"Refresh shares").disabled).toBe(true);
    expect(view.textContent).not.toContain("Loading sharing settings");
    await button(view,"Refresh shares").fire("click");expect(loadCalls).toBe(2);
    finishCommit({share});await committing;
    finishLoad({...catalog,shares:[]});await loading;
    expect(view.textContent).toContain("Read approved text · 1 excerpt(s)");
    expect(view.textContent).toContain("Use stable IDs.");
    expect(button(view,"Refresh shares").disabled).toBe(false);panel.dispose();
  });

  for(const operation of ["revoke","rotate"] as const) test("an earlier catalog refresh cannot overwrite "+operation+" and stays disabled until it completes",async()=>{
    const grant=operation==="rotate"?{...share,recipient:{kind:"agent",name:"Example assistant"}}:share;
    let loadCalls=0, finishLoad:(value:any)=>void=()=>{}, finishMutation:(value:any)=>void=()=>{};
    const panel=sharingView({api:{
      sharing:()=>++loadCalls===1?Promise.resolve({...catalog,shares:[grant]}):new Promise(resolve=>finishLoad=resolve),
      revokeSharing:()=>new Promise(resolve=>finishMutation=resolve),rotateSharingToken:()=>new Promise(resolve=>finishMutation=resolve),
    }});
    const view=panel.element as Element;await tick();
    const loading=button(view,"Refresh shares").fire("click");
    await button(view,operation==="revoke"?"Revoke sharing":"Replace agent token").fire("click");
    const mutating=button(view,operation==="revoke"?"Confirm revoke":"Confirm token replacement").fire("click");
    expect(button(view,"Refresh shares").disabled).toBe(true);
    expect(view.textContent).not.toContain("Loading sharing settings");
    await button(view,"Refresh shares").fire("click");expect(loadCalls).toBe(2);
    finishMutation(operation==="revoke"?{share:{...grant,revokedAt:new Date().toISOString()}}:{credential:{token:"egs_"+"r".repeat(32),mcpUrl:"https://engram.example/mcp/shared"}});await mutating;
    finishLoad({...catalog,shares:operation==="revoke"?[grant]:[]});await loading;
    expect(view.textContent).toContain(operation==="revoke"?"Revoked":"Example assistant");
    if(operation==="revoke")expect(view.textContent).not.toContain("Active snapshot");
    else expect(find(view,item=>item.attrs["aria-label"]==="Read-only share token").value).toBe("egs_"+"r".repeat(32));
    expect(button(view,"Refresh shares").disabled).toBe(false);panel.dispose();
  });
});

const received = (id: string, text = "Approved deployment guidance.") => ({ id, shareId: "shared-1", title: "Memory excerpt", text });
const teamCatalog = (items: any[] = [], more = false) => ({ sourceKind: "team", received: items, more });
const teamOptions = (api: any, extra: any = {}) => ({ workspaceKind: "team", personalWorkspaces: [{ id: 2, name: "Ada’s memory" }], onOpenPersonal: async () => true, api, ...extra });

describe("sharing in a team workspace", () => {
  test("provides actions immediately, then displays only received approved excerpts without a sharing form", async () => {
    let finish: (value: any) => void = () => {}, selected = 0, writes = 0;
    const panel = sharingView(teamOptions({ receivedSharing: () => new Promise(resolve => finish = resolve), sharingCommit: () => writes++ }, { role: "owner", onOpenPersonal: async (id: number) => { selected = id; return true; } }));
    const view = panel.element as Element;
    expect(view.textContent).toContain("Loading received shares"); expect(button(view, "Refresh shares").disabled).toBe(true);
    expect(view.querySelector("form")).toBeNull(); expect(view.querySelector("textarea")).toBeNull();
    await button(view, "Share from personal workspace").fire("click"); expect(selected).toBe(2);
    finish({ ...teamCatalog([received("item-1")]), privateSource: "PRIVATE SOURCE MUST NOT RENDER", credential: { token: "PRIVATE TOKEN" } }); await tick();
    expect(view.textContent).toContain("Approved deployment guidance.");
    expect(view.textContent).not.toContain("PRIVATE"); expect(view.textContent).not.toContain("Revoke sharing"); expect(writes).toBe(0);
    expect(find(view, item => item.tag === "a" && item.textContent === "Open team memory").attrs.href).toBe("#memory");
    expect(find(view, item => item.tag === "a" && item.textContent === "Manage people").attrs.href).toBe("#workspace");
    expect(button(view, "Refresh shares").disabled).toBe(false); panel.dispose();
  });

  test("requires an explicit choice between multiple personal workspaces and ignores unknown selections", async () => {
    const selected: number[] = [];
    const panel = sharingView(teamOptions({ receivedSharing: async () => teamCatalog() }, { personalWorkspaces: [{ id: 2, name: "Personal A" }, { id: 3, name: "Personal B" }], onOpenPersonal: async (id: number) => { selected.push(id); return true; } }));
    const view = panel.element as Element; await tick(); const open = button(view, "Share from personal workspace"), chooser = field(view, "personal-workspace");
    expect(open.disabled).toBe(true); await open.fire("click"); expect(selected).toEqual([]);
    chooser.value = "999"; await chooser.fire("change"); await open.fire("click"); expect(selected).toEqual([]);
    chooser.value = "3"; await chooser.fire("change"); expect(open.disabled).toBe(false); await open.fire("click"); expect(selected).toEqual([3]);
    expect(view.textContent).toContain("No received shares available"); panel.dispose();
  });

  test("short approved excerpts are complete without a redundant disclosure and long excerpts can expand", async () => {
    const short = "Short approved excerpt.", long = "Long approved context. ".repeat(12);
    const panel = sharingView(teamOptions({ receivedSharing: async () => teamCatalog([received("short", short), received("long", long)]) }));
    const view = panel.element as Element; await tick();
    const cards = view.querySelectorAll("article"); expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("p")?.textContent).toBe(short); expect(cards[0].querySelector("details")).toBeNull();
    expect(cards[1].querySelector("p")?.textContent).toBe(long.slice(0, 179) + "…");
    expect(cards[1].querySelector("summary")?.textContent).toBe("Read full excerpt");
    expect(cards[1].querySelector("details")?.textContent).toContain(long); panel.dispose();
  });

  test("without a personal workspace preserves useful navigation and offers no unavailable switch", async () => {
    const panel = sharingView(teamOptions({ receivedSharing: async () => teamCatalog() }, { personalWorkspaces: [], role: "member" }));
    const view = panel.element as Element; await tick();
    expect(view.textContent).toContain("Open team memory");
    expect(view.textContent).not.toContain("Share from personal workspace"); expect(view.textContent).not.toContain("Manage people");
    expect(view.textContent).toContain("No received shares available"); panel.dispose();
  });

  test("failed personal switches show a retryable error and never claim success", async () => {
    let calls = 0;
    const panel = sharingView(teamOptions({ receivedSharing: async () => teamCatalog() }, { initialError: "The workspace switch failed.", onOpenPersonal: async () => { calls++; return false; } }));
    const view = panel.element as Element; await tick();
    expect(view.textContent).toContain("The workspace switch failed."); await button(view, "Share from personal workspace").fire("click");
    expect(view.textContent).toContain("could not be opened"); expect(button(view, "Share from personal workspace").disabled).toBe(false); expect(calls).toBe(1); panel.dispose();
  });

  test("received pages use server offsets, deduplicate items, preserve focus, and refresh from zero", async () => {
    const requests: any[] = [];
    const panel = sharingView(teamOptions({ receivedSharing: async (params: any) => { requests.push(params); return requests.length === 1 ? teamCatalog([received("one")], true) : requests.length === 2 ? teamCatalog([received("one"), received("two", "Second approved excerpt.")]) : teamCatalog([received("current", "Current approved excerpt.")]); } }));
    const view = panel.element as Element; await tick();
    const more = button(view, "Load more shares"); expect(more.hidden).toBe(false); more.focus(); await more.fire("click");
    expect(requests).toEqual([{ limit: 25, offset: 0 }, { limit: 25, offset: 1 }]);
    expect(view.textContent).toContain("Showing 2 approved excerpts."); expect(more.hidden).toBe(true);
    expect((document.activeElement as any).textContent).toBe("Memory excerpt");
    await button(view, "Refresh shares").fire("click"); expect(requests[2]).toEqual({ limit: 25, offset: 0 });
    expect(view.textContent).toContain("Current approved excerpt."); expect(view.textContent).not.toContain("Second approved excerpt."); panel.dispose();
  });

  test("load-more failures keep received items and retry the same offset", async () => {
    const requests: any[] = [];
    const panel = sharingView(teamOptions({ receivedSharing: async (params: any) => { requests.push(params); if (requests.length === 1) return teamCatalog([received("one")], true); if (requests.length === 2) throw new Error("Received shares are unavailable."); return teamCatalog([received("two", "Recovered excerpt.")]); } }));
    const view = panel.element as Element; await tick(); await button(view, "Load more shares").fire("click");
    expect(view.textContent).toContain("Received shares are unavailable."); expect(view.textContent).toContain("Approved deployment guidance.");
    await button(view, "Try again").fire("click"); expect(requests[2]).toEqual({ limit: 25, offset: 1 }); expect(view.textContent).toContain("Recovered excerpt."); panel.dispose();
  });

  test("disposed and cleared controllers discard late received responses", async () => {
    for (const operation of ["dispose", "clearSecrets"] as const) {
      let finish: (value: any) => void = () => {};
      const panel = sharingView(teamOptions({ receivedSharing: () => new Promise(resolve => finish = resolve) }));
      const view = panel.element as Element; panel[operation](); finish(teamCatalog([received("late", "Late approved text must disappear.")])); await tick();
      expect(view.textContent).not.toContain("Late approved text");
      if (operation === "clearSecrets") expect(view.textContent).toContain("Refresh shares to reload"); panel.dispose();
    }
  });

  test("a wrong source response never displays personal content and can be retried", async () => {
    let calls = 0;
    const panel = sharingView(teamOptions({ receivedSharing: async () => ++calls === 1 ? { sourceKind: "personal", received: [received("private", "PRIVATE PERSONAL CONTENT")], more: false } : teamCatalog() }));
    const view = panel.element as Element; await tick();
    expect(view.textContent).not.toContain("PRIVATE PERSONAL CONTENT"); expect(view.textContent).toContain("could not be read");
    await button(view, "Try again").fire("click"); expect(view.textContent).toContain("No received shares available"); panel.dispose();
  });
});
