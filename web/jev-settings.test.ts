import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createJevSettingsPanel, jevUsageSummary, jevUsd } from "./jev-settings.js";
import { aiConfiguration } from "./insights-view.js";

class Element {
  tag: string; attrs: Record<string,string> = {}; children: Element[] = []; events: Record<string,Function> = {};
  value = ""; checked = false; disabled = false; hidden = false; required = false; text = "";
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "value") this.value = value; if (key === "checked") this.checked = true; if (key === "disabled") this.disabled = true; }
  addEventListener(key: string, fn: Function) { this.events[key] = fn; }
  append(...items: Element[]) { this.children.push(...items); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.text = value; }
  async fire(type: string) { return await this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const named = (node: Element, name: string) => all(node).find(item => item.attrs.name === name)!;
const form = (node: Element) => all(node).find(item => item.tag === "form")!;
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));
const fixture = (extra = {}) => ({ enabled: false, available: false, canManage: true, configured: true, eligibility: "subscription", unavailableReason: "disabled", pricing: { currency: "usd", inputPerMillionUsd: "0.042", outputPerMillionUsd: "0.00", markupBps: 0, rateVersion: "sample-rate-not-a-release-approval" }, budget: { monthlyUsd: "0", spentUsd: "0.000000042", remainingUsd: "0", periodStartsAt: "2026-10-01T00:00:00Z", periodEndsAt: "2026-11-01T00:00:00Z", softLimit: true }, usage: { calls: 2, inputTokens: "9007199254740993", outputTokens: "0", pendingCalls: 1, unknownCalls: 1 }, ...extra });
const panel = (data = fixture(), extra = {}) => createJevSettingsPanel({ data, api: { saveJev: async () => data }, saved() {}, ...extra });

describe("separate Jev consent and usage", () => {
  test("preserves tiny decimal rates and large token counts without rounding or client markup math", () => {
    expect(jevUsd("0.042")).toBe("US$0.042");
    expect(jevUsd("0.000000042")).toBe("US$0.000000042");
    expect(jevUsd("10000000000000000000.123400")).toBe("US$10,000,000,000,000,000,000.1234");
    expect(jevUsd(null)).toBe("Unavailable");
    const view = jevUsageSummary(fixture()) as Element;
    expect(view.textContent).toContain("9,007,199,254,740,993 input tokens");
    expect(view.textContent).toContain("Unknown usage is excluded from customer billing");
    expect(view.textContent).toContain("Pending calls are not included in settled spend");
  });
  test("requires deliberate subscription rate acceptance on every enabled save", async () => {
    const calls: any[] = [], view = panel(fixture(), { api: { saveJev: async (body: any) => { calls.push(body); return fixture({ enabled: true }); } } }).element as Element;
    named(view, "jev-processing").checked = true; await named(view, "jev-processing").fire("change");
    named(view, "jev-monthly-budget").value = "1.50";
    await form(view).fire("submit"); expect(calls).toHaveLength(0);
    named(view, "jev-rate-acknowledgement").checked = true;
    await form(view).fire("submit");
    expect(calls).toEqual([{ enabled: true, monthlyBudgetUsd: "1.50", acceptedRateVersion: "sample-rate-not-a-release-approval" }]);
    expect(Object.keys(calls[0])).not.toContain("externalAiProcessing");
    expect(all(view).some(item => /key|secret/i.test(item.attrs.name || ""))).toBe(false);
    const again = panel(fixture({ enabled: true, budget: { ...fixture().budget, monthlyUsd: "1.50" } })).element as Element;
    expect(named(again, "jev-rate-acknowledgement").checked).toBe(false);
  });
  test("unapproved rates block billed opt-in but never prevent turning off", async () => {
    const calls: any[] = [], data = fixture({ enabled: true, configured: false, pricing: { currency: "usd", inputPerMillionUsd: null, outputPerMillionUsd: null, markupBps: null, rateVersion: null } });
    const view = panel(data, { api: { saveJev: async (body: any) => { calls.push(body); return data; } } }).element as Element;
    const off = panel(fixture()).element as Element;
    expect(all(off).find(item => item.attrs.type === "submit")!.textContent).toBe("Save Jev settings");
    await form(view).fire("submit"); expect(calls).toHaveLength(0);
    named(view, "jev-processing").checked = false; await named(view, "jev-processing").fire("change");
    expect(all(view).find(item => item.attrs.type === "submit")!.textContent).toBe("Turn Jev off");
    await form(view).fire("submit"); expect(calls).toEqual([{ enabled: false, monthlyBudgetUsd: "0" }]);
  });
  test("operator funding needs a positive budget without customer price acceptance", async () => {
    const calls: any[] = [], data = fixture({ eligibility: "operator-funded", pricing: { currency: "usd", inputPerMillionUsd: null, outputPerMillionUsd: null, markupBps: null, rateVersion: null } });
    const view = panel(data, { api: { saveJev: async (body: any) => { calls.push(body); return data; } } }).element as Element;
    named(view, "jev-processing").checked = true; await named(view, "jev-processing").fire("change");
    await form(view).fire("submit"); expect(calls).toHaveLength(0);
    named(view, "jev-monthly-budget").value = "1"; await form(view).fire("submit");
    expect(calls).toEqual([{ enabled: true, monthlyBudgetUsd: "1" }]);
    expect(view.textContent).toContain("No usage charge is added to your bill");
  });
  test("self-host opt-in sends no rate acceptance or monetary budget and shows direct provider billing", async () => {
    const calls: any[] = [], data = fixture({ eligibility: "self-hosted", pricing: { currency: "usd", inputPerMillionUsd: null, outputPerMillionUsd: null, markupBps: null, rateVersion: null } });
    const view = panel(data, { api: { saveJev: async (body: any) => { calls.push(body); return data; } } }).element as Element;
    named(view, "jev-processing").checked = true; await named(view, "jev-processing").fire("change"); await form(view).fire("submit");
    expect(calls).toEqual([{ enabled: true, monthlyBudgetUsd: "0" }]);
    expect(named(view, "jev-monthly-budget")).toBeUndefined();
    expect(view.textContent).toContain("Your provider account is billed directly");
    expect(view.textContent).toContain("does not enforce a monetary budget");
    expect((jevUsageSummary(data) as Element).textContent).not.toContain("settled Jev usage cost");
  });
  test("retains failed drafts and suppresses duplicate and stale requests", async () => {
    let reject!: (reason: Error) => void, calls = 0, saves = 0, errors = 0;
    const pending = new Promise((_, no) => { reject = no; });
    const instance = panel(fixture({ eligibility: "operator-funded" }), { api: { saveJev: () => { calls++; return pending; } }, saved: () => saves++, fail: () => errors++ });
    const view = instance.element as Element;
    named(view, "jev-processing").checked = true; named(view, "jev-monthly-budget").value = "2.25";
    const saving = form(view).fire("submit"); await form(view).fire("submit"); expect(calls).toBe(1);
    reject(new Error("Please retry")); await saving;
    expect(named(view, "jev-monthly-budget").value).toBe("2.25"); expect(view.textContent).toContain("Please retry"); expect(errors).toBe(1);
    instance.dispose(); await form(view).fire("submit"); expect(calls).toBe(1); expect(saves).toBe(0);
    let resolve!: (data: any) => void;
    const late = panel(fixture({ eligibility: "operator-funded" }), { api: { saveJev: () => new Promise(done => { resolve = done; }) }, saved: () => saves++ });
    named(late.element as Element, "jev-monthly-budget").value = "1";
    const operation = form(late.element as Element).fire("submit"); late.dispose(); resolve(fixture()); await operation; expect(saves).toBe(0);
  });
  test("does not offer mutations to members or fabricate successful details when loading failed", async () => {
    let calls = 0, retries = 0;
    const view = panel(fixture({ canManage: false }), { api: { saveJev: async () => calls++ } }).element as Element;
    expect(named(view, "jev-processing").disabled).toBe(true);
    await form(view).fire("submit"); expect(calls).toBe(0);
    const unavailable = panel(null as any, { refresh: () => retries++ }).element as Element;
    expect(unavailable.textContent).toContain("existing setting has not changed");
    await all(unavailable).find(item => item.tag === "button")!.fire("click"); expect(retries).toBe(1);
  });
  test("attention view distinguishes Jev permission from embeddings and briefs", () => {
    const view = aiConfiguration({ jevConsented: true, jevConfigured: true, consented: false, embeddingConfigured: true, generativeConfigured: true }) as Element;
    const text = view.textContent;
    expect(text).toContain("Jev · TypeSafePermission on · server configured");
    expect(text).toContain("Voyage embeddingsPermission off · server configured");
    expect(text).toContain("OpenAI briefsPermission off · server configured");
    expect(text).not.toContain("External AI processing off");
  });
});
