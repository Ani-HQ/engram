import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAccessClock, friendAccessCard, friendAccessPresentation, INVITE_EXTENSION_URL } from "./access-view.js";

class Element {
  tag: string; attrs: Record<string,string> = {}; children: Element[] = []; events: Record<string,Function> = {}; text: string;
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, fn: Function) { this.events[key] = fn; }
  append(...items: Element[]) { this.children.push(...items); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));
const grant = { active: true, source: "invite", durationDays: 60, grantedAt: "2026-10-25T09:00:00Z", expiresAt: "2026-12-24T09:00:00Z", revokedAt: null, unlimitedKnowledgeTransfers: true, extensionUrl: INVITE_EXTENSION_URL };
const access = { serverNow: "2026-10-25T09:00:00Z", canWrite: true, entitlementSource: "complimentary", complimentary: grant };

test("finite friend access uses actual expiry and server time, with no fabricated legacy end date", () => {
  expect(friendAccessPresentation(access)).toMatchObject({ state: "active", days: 60, unlimited: true, expiresAt: grant.expiresAt });
  expect(friendAccessPresentation({ ...access, serverNow: "2026-12-24T08:59:59Z" })).toMatchObject({ state: "active", days: 1, headline: "Less than a day left" });
  for (const complimentary of [null, { ...grant, source: "operator" }, { ...grant, expiresAt: null }, { ...grant, expiresAt: "invalid" }]) expect(friendAccessPresentation({ ...access, complimentary })).toBeNull();
  expect(friendAccessPresentation({ ...access, serverNow: "invalid" })).toMatchObject({ state: "unknown", unlimited: false });
  const clock = createAccessClock(access, 1000);
  expect(clock(86_401_000)).toBe(Date.parse(access.serverNow) + 86_400_000);
  expect(friendAccessPresentation(access, { now: clock(86_401_000) })).toMatchObject({ days: 59 });
  expect(createAccessClock({ serverNow: "invalid" })(1000)).toBeNull();
});
test("expired or revoked invitation never promises active unlimited transfers, including with a paid plan", () => {
  const expired = { ...access, serverNow: grant.expiresAt, canWrite: false, entitlementSource: "none" };
  expect(friendAccessPresentation(expired)).toMatchObject({ state: "ended", days: 0, unlimited: false });
  const view = friendAccessCard(expired) as Element;
  expect(view.textContent).toContain("readable and exportable"); expect(view.textContent).not.toContain("Unlimited knowledge transfers");
  const paid = friendAccessCard({ ...expired, canWrite: true, entitlementSource: "subscription" }) as Element;
  expect(paid.textContent).toContain("Your current plan keeps core write access available");
  expect(friendAccessPresentation({ ...access, complimentary: { ...grant, revokedAt: "2026-10-26T00:00:00Z", active: false } })).toMatchObject({ state: "ended", unlimited: false });
});
test("benefit card has an exact semantic date, fixed extension link, separate Jev terms and refresh recovery", () => {
  let retries = 0;
  const view = friendAccessCard(access, { error: "unavailable", retry: () => retries++ }) as Element;
  expect(view.textContent).toContain("60 days left"); expect(view.textContent).toContain("Unlimited knowledge transfers"); expect(view.textContent).toContain("Jev has separate permission and usage costs");
  expect(all(view).find(item => item.tag === "time")!.attrs.datetime).toBe(grant.expiresAt);
  expect(all(view).find(item => item.tag === "time")!.textContent).toContain("UTC");
  expect(all(view).find(item => item.tag === "a")!.attrs.href).toBe(INVITE_EXTENSION_URL);
  all(view).find(item => item.tag === "button")!.events.click(); expect(retries).toBe(1);
  expect(all(view).some(item => item.attrs["aria-live"])).toBe(false);
});
