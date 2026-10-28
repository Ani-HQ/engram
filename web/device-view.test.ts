import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deviceView } from "./device-view.js";
import { agentList, deviceHref, devicePresentation, formatUserCode, installCommand, normalizeUserCode, parseDeviceRoute, rememberPendingDevice, requestedAgo, takePendingDevice } from "./device-model.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {}; text = ""; value = ""; dataset: Record<string, string> = {};
  className = ""; src = ""; width = 0; height = 0; alt = ""; draggable = true;
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, action: Function) { this.events[key] = action; }
  append(...children: Element[]) { this.children.push(...children); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  fire(type: string, extra: Record<string, unknown> = {}) { return this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this, ...extra }); }
}
const nodes = (node: Element): Element[] => [node, ...node.children.flatMap(nodes)];
const find = (node: Element, predicate: (item: Element) => boolean) => nodes(node).find(predicate);
const buttons = (node: Element) => nodes(node).filter(item => item.tag === "button");
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));

const now = Date.parse("2026-10-28T12:00:00Z");
const request = {
  userCode: "BCDF-GHJK", device: "Ada's MacBook", status: "pending", createdAt: "2026-10-28T11:58:00Z", expiresAt: "2026-10-28T12:08:00Z",
  agents: [{ harness: "claude-code", label: "Claude Code" }, { harness: "codex", label: "Codex" }, { harness: "cursor", label: "Cursor" }],
};
const workspace = { id: 1, name: "Team memory" };
const render = (options: Record<string, unknown> = {}) => deviceView({ code: "BCDF-GHJK", workspace, workspaces: [workspace], now, ...options }) as unknown as Element;

describe("device model", () => {
  test("user codes are case-insensitive and hyphen-optional", () => {
    for (const value of ["BCDF-GHJK", "bcdfghjk", " bcdf ghjk "]) { expect(normalizeUserCode(value)).toBe("BCDFGHJK"); expect(formatUserCode(value)).toBe("BCDF-GHJK"); }
    for (const value of ["", "AEIO-UAEI", "BCDF-GHJ", null, 7]) expect(formatUserCode(value as string)).toBeNull();
  });

  test("routes parse #device and #device=CODE, keeping invalid input for correction", () => {
    expect(parseDeviceRoute("#device")).toEqual({ code: "", input: "" });
    expect(parseDeviceRoute("#device=bcdf-ghjk")).toEqual({ code: "BCDF-GHJK", input: "bcdf-ghjk" });
    expect(parseDeviceRoute("#device=hello")).toEqual({ code: "", input: "hello" });
    expect(parseDeviceRoute("#device=%E0%A4%A")).toEqual({ code: "", input: "%E0%A4%A" });
    expect(parseDeviceRoute("#activity")).toBeNull(); expect(parseDeviceRoute("#devices")).toBeNull();
    expect(deviceHref("bcdfghjk")).toBe("#device=BCDF-GHJK"); expect(deviceHref("")).toBe("#device");
  });

  test("the setup command names a self-hosted address and stays plain for hosted Engram", () => {
    expect(installCommand("https://engram.ani.computer")).toBe("npx @ani-hq/engram-mcp@latest");
    expect(installCommand("https://memory.example.com")).toBe("npx @ani-hq/engram-mcp@latest --host https://memory.example.com");
    expect(installCommand("not a url")).toBe("npx @ani-hq/engram-mcp@latest");
  });

  test("presentation follows request state, errors and the person's decision", () => {
    expect(devicePresentation({})).toBe("entry");
    expect(devicePresentation({ code: "BCDF-GHJK", loading: true })).toBe("loading");
    expect(devicePresentation({ code: "BCDF-GHJK", error: "x", errorCode: "not_found" })).toBe("not-found");
    expect(devicePresentation({ code: "BCDF-GHJK", error: "Network" })).toBe("error");
    for (const status of ["pending", "approved", "denied", "consumed", "expired"]) expect(devicePresentation({ code: "BCDF-GHJK", request: { status } })).toBe(status);
    expect(devicePresentation({ code: "BCDF-GHJK", request: { status: "weird" } })).toBe("error");
    expect(devicePresentation({ code: "BCDF-GHJK", request, result: "approved" })).toBe("approved-now");
    expect(devicePresentation({ code: "BCDF-GHJK", request, result: "denied" })).toBe("denied-now");
  });

  test("pending codes survive sign-in briefly and are read once", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
    expect(rememberPendingDevice(storage, "bcdfghjk", now)).toBe(true);
    expect(takePendingDevice(storage, now + 60_000)).toBe("BCDF-GHJK");
    expect(takePendingDevice(storage, now + 60_000)).toBeNull();
    rememberPendingDevice(storage, "BCDF-GHJK", now);
    expect(takePendingDevice(storage, now + 16 * 60_000)).toBeNull();
    expect(rememberPendingDevice(storage, "nope", now)).toBe(false);
    expect(rememberPendingDevice({ setItem() { throw new Error("blocked"); } }, "BCDF-GHJK", now)).toBe(false);
    expect(takePendingDevice({ getItem() { throw new Error("blocked"); } }, now)).toBeNull();
  });

  test("times and agent lists read naturally", () => {
    expect(requestedAgo("2026-10-28T11:59:40Z", now)).toBe("Just now");
    expect(requestedAgo("2026-10-28T11:58:00Z", now)).toBe("2 minutes ago");
    expect(requestedAgo("2026-10-28T11:59:00Z", now)).toBe("1 minute ago");
    expect(requestedAgo("bad", now)).toBe("");
    expect(agentList(request.agents)).toBe("Claude Code, Codex and Cursor");
    expect(agentList([{ label: "Codex" }])).toBe("Codex");
  });
});

describe("device view", () => {
  test("without a code, shows the setup command and a labeled code field", () => {
    const copies: string[] = [];
    let submitted = "";
    const view = render({ code: "", origin: "https://engram.ani.computer", copyControl: (label: string, value: string) => { copies.push(value); return new Element("button", label); }, onSubmitCode: (value: string) => { submitted = value; } });
    expect(view.textContent).toContain("Connect a computer");
    expect(copies).toEqual(["npx @ani-hq/engram-mcp@latest"]);
    const input = find(view, item => item.tag === "input")!;
    expect(input.attrs).toMatchObject({ id: "device-code", autocomplete: "one-time-code", "aria-describedby": "device-code-hint" });
    expect(find(view, item => item.tag === "label")!.textContent).toContain("Code from your terminal");
    input.value = "bcdf-ghjk";
    find(view, item => item.tag === "form")!.fire("submit");
    expect(submitted).toBe("bcdf-ghjk");
  });

  test("an invalid code keeps the entry and links the error to the field", () => {
    const view = render({ code: "", input: "hello", entryError: "Enter the 8-letter code shown in your terminal, like BCDF-GHJK." });
    const input = find(view, item => item.tag === "input")!;
    expect(input.value).toBe("hello");
    expect(input.attrs).toMatchObject({ "aria-invalid": "true", "aria-describedby": "device-code-hint device-code-error" });
    expect(find(view, item => item.attrs.id === "device-code-error")!.attrs.role).toBe("alert");
  });

  test("a pending request shows the code to compare, device, agents, workspace and time", () => {
    let approved = 0, denied = 0;
    const view = render({ request, onApprove: () => approved++, onDeny: () => denied++ });
    expect(view.attrs["aria-labelledby"]).toBe("device-title");
    expect(find(view, item => item.attrs.id === "device-title")!.textContent).toBe("Connect this computer?");
    expect(find(view, item => item.attrs.class === "ds-confirm-code")!.textContent).toBe("Check this code matches your terminalBCDF-GHJK");
    const text = view.textContent;
    for (const expected of ["Ada's MacBook", "Claude Code", "Codex", "Cursor", "Team memory", "2 minutes ago", "in your name, with read and write access to Team memory", "Choose Deny"]) expect(text).toContain(expected);
    const [approve, deny] = buttons(view);
    expect([approve.textContent, approve.attrs.class, deny.textContent]).toEqual(["Approve", "primary", "Deny"]);
    approve.fire("click"); deny.fire("click");
    expect([approved, denied]).toEqual([1, 1]);
  });

  test("several workspaces offer the existing switcher; busy and switching states disable decisions", () => {
    const switched: string[] = [];
    const view = render({ request, workspaces: [workspace, { id: 2, name: "Personal" }], onSwitchWorkspace: (id: string) => switched.push(id) });
    const select = find(view, item => item.tag === "select")!;
    expect(select.value).toBe("1"); expect(select.attrs["aria-label"]).toBe("Workspace for this computer");
    select.fire("change", { target: { value: "2" } });
    expect(switched).toEqual(["2"]);
    expect(find(render({ request }), item => item.tag === "select")).toBeUndefined();
    const approving = render({ request, busy: "approve" });
    expect(buttons(approving).map(item => [item.textContent, item.attrs.disabled])).toEqual([["Approving…", ""], ["Deny", ""]]);
    expect(approving.attrs["aria-busy"]).toBe("true");
    expect(buttons(render({ request, switching: true })).every(item => item.attrs.disabled === "")).toBe(true);
  });

  test("final states explain what happened without offering approval", () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ request: { ...request, status: "expired" } }, "This code has expired", "Codes last 10 minutes"],
      [{ request: { ...request, status: "denied" } }, "This request was denied", "Nothing was connected"],
      [{ request: { ...request, status: "approved" } }, "Already approved", "Return to your terminal"],
      [{ request: { ...request, status: "consumed" } }, "This computer is connected", "revoke them in Connections"],
      [{ request, result: "approved" }, "Computer approved", "Approved. Return to your terminal. Your agents are being set up."],
      [{ request, result: "denied" }, "Request denied", "Nothing was connected. You can close this tab."],
      [{ errorCode: "not_found", error: "This code was not found." }, "We couldn’t find that code", "This code was not found."],
    ];
    for (const [options, heading, body] of cases) {
      const view = render(options);
      expect(find(view, item => item.attrs.id === "device-title")!.textContent).toBe(heading);
      expect(view.textContent).toContain(body);
      expect(buttons(view).some(item => item.textContent === "Approve")).toBe(false);
    }
    expect(render({ request, result: "approved" }).textContent).toContain("connecting Claude Code, Codex and Cursor to Team memory");
  });

  test("loading, errors and people without a console account", () => {
    expect(render({ loading: true }).textContent).toContain("Checking this code…");
    let retried = 0;
    const failed = render({ error: "Approval is temporarily unavailable.", onRetry: () => retried++ });
    expect(find(failed, item => item.attrs.role === "alert")!.textContent).toBe("Approval is temporarily unavailable.");
    buttons(failed).find(item => item.textContent === "Try again")!.fire("click");
    expect(retried).toBe(1);
    const declined = render({ request, error: "This workspace needs an active Cloud subscription." });
    expect(declined.textContent).toContain("needs an active Cloud subscription"); expect(buttons(declined)[0].textContent).toBe("Approve");
    const agent = render({ request, role: "agent" });
    expect(agent.textContent).toContain("Sign in with your own account"); expect(buttons(agent)).toHaveLength(0);
  });
});
