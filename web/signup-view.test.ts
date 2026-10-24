import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signupView } from "./signup-view.js";
import { signupAdminPanel } from "./signup-admin.js";
import { parseSignupPolicy, signupEntryMode, signupInviteStatus, signupRequest, emailLinkRecovery } from "./signup-model.js";
import { planCards } from "./account.js";

class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {}; dataset: Record<string, string> = {};
  value = ""; type = ""; disabled = false; open = false; text = "";
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "type") this.type = value; if (key === "disabled") this.disabled = true; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(key: string, fn: Function) { this.events[key] = fn; }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: (Element | string)[]) { this.text = ""; this.children = items.map(item => item instanceof Element ? item : new Element("#text", String(item))); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.text = value; }
  async fire(type: string) { await this.events[type]?.({ preventDefault() {}, currentTarget: this, target: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const find = (node: Element, predicate: (item: Element) => boolean) => all(node).find(predicate)!;
const input = (node: Element, type: string) => find(node, item => item.tag === "input" && item.type === type);
const button = (node: Element, text: string) => find(node, item => item.tag === "button" && item.textContent === text);
const submit = (node: Element) => find(node, item => item.tag === "form");
const beta = parseSignupPolicy({ mode: "invite-only", complimentary: true, verificationRequired: true, inviteCodeRequired: true });
const open = parseSignupPolicy({ mode: "open", complimentary: true, verificationRequired: true, inviteCodeRequired: false });
const operator = { capabilities: { manageSignupInvites: true } };
const invite = { id: "invite-1", email: "friend@example.com", createdAt: "2026-10-24T00:00:00Z", expiresAt: "2099-10-31T00:00:00Z", revokedAt: null, redeemedAt: null, accessExpiresAt: null, complimentaryAppliedAt: null, complimentaryRevokedAt: null };
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));

describe("email-bound beta signup", () => {
  test("fails closed on unknown policy and preserves explicit existing sign-in entry", () => {
    for (const value of [null, {}, { mode: "invite-only", verificationRequired: true, inviteCodeRequired: false }, { mode: "open", verificationRequired: false, inviteCodeRequired: false }]) expect(() => parseSignupPolicy(value)).toThrow();
    expect(signupEntryMode(beta, "", "/")).toBe("create");
    expect(signupEntryMode(beta, "", "/app")).toBe("email");
    expect(signupEntryMode(beta, "#signin", "/")).toBe("email");
    expect(signupEntryMode(open, "", "/")).toBe("email");
    expect(signupEntryMode(open, "#start")).toBe("create");
    expect(() => signupRequest(null, { email: "a@example.com" })).toThrow();
    const view = signupView({ mode: "create", policy: null, api: {}, changeMode() {}, signedIn() {}, retryPolicy() {} }).element as Element;
    expect(find(view, item => item.attrs.type === "submit").disabled).toBe(true);
    expect(view.textContent).toContain("You can still sign in");
  });

  test("expired beta verification offers invite-code resend while old email links keep sign-in recovery", () => {
    const signup = emailLinkRecovery("svf_example-email-link"), login = emailLinkRecovery("inv_example-email-link");
    expect(signup.hash).toBe("#invite"); expect(signup.message).toContain("email and invite code below to request a new link"); expect(signup.message).toContain("revoked"); expect(signup.message).not.toContain("svf_");
    expect(login.hash).toBe("#signin"); expect(login.message).toContain("Request a new sign-in link"); expect(login.message).not.toContain("inv_");
    expect(signupEntryMode(beta, signup.hash)).toBe("create"); expect(signupEntryMode(beta, login.hash)).toBe("email");
  });

  test("requires only email and code, waits for verification, and clears code after sending", async () => {
    const calls: any[] = [], sessions: any[] = [];
    const view = signupView({ mode: "create", policy: beta, api: { createOrg: async (payload: any) => { calls.push(payload); return { sent: true }; } }, changeMode() {}, signedIn: (session: any) => sessions.push(session) }).element as Element;
    input(view, "email").value = " friend@example.com "; input(view, "password").value = " example-invite ";
    expect(all(view).filter(item => item.tag === "input" && item.attrs.required !== undefined)).toHaveLength(2);
    await submit(view).fire("submit");
    expect(calls).toEqual([{ email: "friend@example.com", inviteCode: "example-invite" }]);
    expect(sessions).toHaveLength(0);
    expect(view.textContent).toContain("Check friend@example.com for a verification link");
    expect(view.textContent).toContain("No card required. Verify your email to get started.");
    expect(find(view, item => item.attrs.href === "mailto:ani@odstdio.com?subject=Engram%20early%20access").textContent).toBe("Don’t have a code? Ask for an invite");
    expect(input(view, "password").value).toBe("");
  });

  test("retains fields on rejection and clears detached fields and late login callbacks", async () => {
    const panel = signupView({ mode: "create", policy: beta, api: { createOrg: async () => { throw new Error("Invite is invalid"); } }, changeMode() {}, signedIn() {} });
    const view = panel.element as Element;
    input(view, "email").value = "friend@example.com"; input(view, "password").value = "wrong-code";
    await submit(view).fire("submit");
    expect(input(view, "email").value).toBe("friend@example.com"); expect(input(view, "password").value).toBe("wrong-code"); expect(view.textContent).toContain("Invite is invalid");
    panel.dispose(); expect(input(view, "password").value).toBe("");
    let finish: (value: any) => void = () => {}; let signedIn = false;
    const login = signupView({ mode: "token", policy: beta, api: { login: () => new Promise(resolve => { finish = resolve; }) }, changeMode() {}, signedIn() { signedIn = true; } });
    input(login.element as Element, "password").value = "sample-token";
    const pending = submit(login.element as Element).fire("submit"); login.dispose(); finish({ org: { id: 1 } }); await pending;
    expect(signedIn).toBe(false); expect(input(login.element as Element, "password").value).toBe("");
  });

  test("keeps open self-host signup and existing email sign-in free of invite code", async () => {
    const calls: any[] = [];
    const view = signupView({ mode: "create", policy: open, api: { createOrg: async (payload: any) => { calls.push(payload); return {}; } }, changeMode() {}, signedIn() {} }).element as Element;
    input(view, "email").value = "new@example.com";
    expect(all(view).some(item => item.type === "password")).toBe(false);
    await submit(view).fire("submit"); expect(calls).toEqual([{ email: "new@example.com" }]);
    const login = signupView({ mode: "email", policy: beta, api: { loginEmail: async (email: string) => { calls.push(email); return {}; } }, changeMode() {}, signedIn() {} }).element as Element;
    input(login, "email").value = "existing@example.com"; await submit(login).fire("submit");
    expect(calls[1]).toBe("existing@example.com"); expect(all(login).some(item => item.type === "password")).toBe(false);
  });

  test("public beta offers no open trial while self-hosting and paid billing cards retain their paths", () => {
    const catalog = { mode: "hosted", plans: [{ id: "cloud", name: "Cloud", description: "Hosted", monthlyPrice: 19, features: ["Cancel any time"] }, { id: "self-hosted", name: "Self-hosted", description: "Run it", monthlyPrice: 0, features: [] }] };
    const view = planCards(catalog, undefined, undefined, beta) as Element;
    expect(view.textContent).toContain("Closed beta · free until access is revoked");
    expect(view.textContent).not.toMatch(/14-day|Subscribe when/);
    expect(all(view).filter(item => item.tag === "a").map(item => item.attrs.href)).toEqual(["/app#invite", "/self-host"]);
    expect((planCards(catalog) as Element).textContent).toContain("Start a 14-day trial");
    expect(all(planCards({ ...catalog, mode: "self-hosted" }, undefined, undefined, beta) as Element).find(item => item.attrs.href === "/hosted")).toBeDefined();
  });
});

describe("operator early access invitations", () => {
  test("requires an explicit capability rather than owner role alone and only loads on opening", async () => {
    let calls = 0;
    const api = { signupInvites: async () => { calls++; return { invites: [], more: false }; } };
    for (const session of [{ role: "owner" }, { role: "owner", capabilities: { manageSignupInvites: false } }, null]) expect(signupAdminPanel({ session, api })).toBeNull();
    expect(calls).toBe(0);
    const panel = signupAdminPanel({ session: operator, api })!; const view = panel.element as Element;
    expect(calls).toBe(0); view.open = true; await view.fire("toggle"); expect(calls).toBe(1);
    expect(signupInviteStatus(invite)).toBe("Code unused");
  });

  test("shows an issued code once, copies privately, clears it on close, and keeps raw code out of attributes and list", async () => {
    const copied: string[] = [], payloads: any[] = [];
    const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [], more: false }), issueSignupInvite: async (payload: any) => { payloads.push(payload); return { invite, inviteCode: "sample-once-code" }; } }, copy: async (value: string) => copied.push(value) })!;
    const view = panel.element as Element; view.open = true; await view.fire("toggle"); input(view, "email").value = "friend@example.com"; await submit(view).fire("submit");
    const secret = input(view, "password"), copyCode = button(view, "Copy code");
    expect(secret.value).toBe("sample-once-code"); expect(secret.attrs.value).toBeUndefined(); expect(JSON.stringify(view.attrs)).not.toContain("sample-once-code"); expect(view.textContent).not.toContain("sample-once-code");
    expect(payloads).toEqual([{ email: "friend@example.com" }]); expect(view.textContent).toContain("generating a code does not send an email");
    await copyCode.fire("click"); expect(copied).toEqual(["sample-once-code"]);
    view.open = false; await view.fire("toggle"); expect(secret.value).toBe(""); await copyCode.fire("click"); expect(copied).toHaveLength(1);
    view.open = true; await view.fire("toggle"); expect(all(view).some(item => item.type === "password")).toBe(false);
  });

  test("late issuance cannot redisplay a code after closing or navigating to another workspace", async () => {
    for (const dispose of [false, true]) {
      let finish: (value: any) => void = () => {};
      const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [], more: false }), issueSignupInvite: () => new Promise(resolve => { finish = resolve; }) } })!;
      const view = panel.element as Element; view.open = true; await view.fire("toggle"); input(view, "email").value = "friend@example.com";
      const pending = submit(view).fire("submit");
      if (dispose) panel.dispose(); else { view.open = false; await view.fire("toggle"); view.open = true; await view.fire("toggle"); }
      finish({ invite, inviteCode: "late-secret" }); await pending;
      expect(all(view).some(item => item.value === "late-secret")).toBe(false); expect(view.textContent).not.toContain("Invite created");
    }
  });

  test("revocation needs an explicit confirmation and reports pending access removal truthfully", async () => {
    let calls = 0;
    const redeemed = { ...invite, redeemedAt: "2026-10-24T01:00:00Z", complimentaryAppliedAt: "2026-10-24T01:00:00Z" };
    const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [redeemed], more: true }), revokeSignupInvite: async (id: string) => { calls++; expect(id).toBe(invite.id); return { invite: { ...redeemed, revokedAt: "2026-10-24T02:00:00Z" }, revocationPending: true }; } } })!;
    const view = panel.element as Element; view.open = true; await view.fire("toggle");
    expect(view.textContent).toContain("Free access active"); expect(view.textContent).toContain("100 newest");
    const revoke = button(view, "Revoke code and free access"); await revoke.fire("click"); expect(calls).toBe(0); await revoke.fire("click");
    expect(calls).toBe(1); expect(view.textContent).toContain("Revocation pending"); expect(view.textContent).toContain("free access removal is still queued"); expect(button(view, "Retry revocation")).toBeDefined();
    expect(signupInviteStatus({ ...redeemed, revokedAt: "2026-10-24", complimentaryRevokedAt: "2026-10-24" })).toBe("Revoked");
    expect(signupInviteStatus({ ...invite, expiresAt: "2020-01-01" })).toBe("Code expired");
    expect(signupInviteStatus({ ...invite, redeemedAt: "2026-10-24" })).toBe("Activating free access");
    expect(signupInviteStatus({ ...redeemed, complimentaryErrorCode: "authority_conflict" })).toBe("Access needs attention");
  });
});
