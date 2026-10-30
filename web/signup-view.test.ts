import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signupView } from "./signup-view.js";
import { signupAdminPanel } from "./signup-admin.js";
import { parseInviteEntry, parseSignupPolicy, signupAuthMode, signupEntryMode, signupInviteStatus, signupRequest, emailLinkRecovery } from "./signup-model.js";
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
const beta = parseSignupPolicy({ mode: "invite-only", complimentary: true, verificationRequired: true, inviteCodeRequired: true, tokenSignInAllowed: false });
const open = parseSignupPolicy({ mode: "open", complimentary: true, verificationRequired: true, inviteCodeRequired: false, tokenSignInAllowed: true });
const operator = { capabilities: { manageSignupInvites: true } };
const invite = { id: "invite-1", email: "friend@example.com", createdAt: "2026-10-24T00:00:00Z", expiresAt: "2099-10-31T00:00:00Z", revokedAt: null, redeemedAt: null, accessExpiresAt: null, complimentaryAppliedAt: null, complimentaryRevokedAt: null };
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));

describe("email-bound beta signup", () => {
  test("invite-link email hints stay editable while the private URL code is read-only and sent in the body", async () => {
    const entry = parseInviteEntry("#invite=eg_inv_example&email=person%40example.com");
    expect(entry).toEqual({ code: "eg_inv_example", email: "person@example.com" });
    expect(signupEntryMode(beta, "#invite=eg_inv_example&email=person%40example.com")).toBe("create");
    expect(parseInviteEntry("#invite=bad%0Acode")).toBeNull(); expect(parseInviteEntry("#invite=first&invite=second")).toBeNull();
    expect(parseInviteEntry("#invite=eg_inv_example&email=%3Cscript%3E%40example.com")).toEqual({ code: "eg_inv_example", email: "" });
    const calls: any[] = []; let completed = 0;
    const view = signupView({ mode: "create", policy: beta, inviteEntry: entry, inviteSubmitted: () => completed++, api: { createOrg: async (body: any) => { calls.push(body); return { sent: true }; } }, changeMode() {}, signedIn() {} }).element as Element;
    const code = input(view, "password"), email = input(view, "email");
    expect(code.attrs.readonly).toBe(""); expect(code.disabled).toBe(false); expect(code.value).toBe("eg_inv_example"); expect(code.attrs.value).toBeUndefined();
    expect(email.attrs.readonly).toBeUndefined(); expect(email.value).toBe("person@example.com");
    email.value = "changed@example.com"; await submit(view).fire("submit");
    expect(calls).toEqual([{ email: "changed@example.com", inviteCode: "eg_inv_example" }]); expect(completed).toBe(1); expect(code.value).toBe("eg_inv_example"); expect(code.attrs.value).toBeUndefined();
    email.value = "corrected@example.com"; await submit(view).fire("submit"); expect(calls[1]).toEqual({ email: "corrected@example.com", inviteCode: "eg_inv_example" });
    expect((input(signupView({ mode: "create", policy: beta, api: {}, changeMode() {}, signedIn() {} }).element as Element, "password")).attrs.readonly).toBeUndefined();
  });
  test("invite requests go to the operator’s X profile", () => {
    const view = signupView({ mode: "create", policy: beta, api: {}, changeMode() {}, signedIn() {} }).element as Element;
    const request = find(view, item => item.tag === "a" && item.textContent === "Ask for an invite");
    expect(request.attrs.href).toBe("https://x.com/anirudh_twt");
    expect(all(view).some(item => item.tag === "a" && item.attrs.href?.includes("Engram%20early%20access"))).toBe(false);
    expect(all(view).some(item => item.tag === "input" && item.attrs.autocomplete === "organization")).toBe(false);
  });

  test("hosted email and invite forms have no token entry or separator, including a legacy token mode", async () => {
    let tokenCalls = 0; const addresses: string[] = [];
    for (const mode of ["email", "create", "token"]) {
      const view = signupView({ mode, policy: beta, api: { login: async () => { tokenCalls++; }, loginEmail: async (email: string) => { addresses.push(email); return {}; } }, changeMode() {}, signedIn() {} }).element as Element;
      expect(view.textContent).not.toContain("Use an access token");
      expect(all(view).some(item => item.attrs.placeholder === "Access token")).toBe(false);
      expect(find(view, item => item.attrs.class === "auth-switch").textContent).toBe(mode === "create" ? "Already joined? Sign in" : "Have an invite?");
      if (mode === "token") { input(view, "email").value = "existing@example.com"; await submit(view).fire("submit"); }
    }
    expect(tokenCalls).toBe(0); expect(addresses).toEqual(["existing@example.com"]);
    expect(signupAuthMode("token", beta)).toBe("email");
  });

  test("unknown, malformed, and older policy flags cannot enable token sign-in", async () => {
    let tokenCalls = 0, emailCalls = 0;
    const policies = [null, ...[undefined, false, null, "true", 1].map(flag => parseSignupPolicy({ ...beta, tokenSignInAllowed: flag }))];
    for (const policy of policies) {
      expect(signupAuthMode("token", policy)).toBe("email");
      const view = signupView({ mode: "token", policy, api: { login: async () => { tokenCalls++; }, loginEmail: async () => { emailCalls++; return {}; } }, changeMode() {}, signedIn() {} }).element as Element;
      expect(view.textContent).not.toContain("Use an access token"); expect(all(view).some(item => item.type === "password")).toBe(false);
      input(view, "email").value = "existing@example.com"; await submit(view).fire("submit");
    }
    expect(tokenCalls).toBe(0); expect(emailCalls).toBe(policies.length);
  });

  test("self-host token recovery requires explicit permission and obsolete controls cannot reopen it", async () => {
    const modes: string[] = [], logins: string[] = [], sessions: any[] = [];
    const chooser = signupView({ mode: "email", policy: open, api: {}, changeMode: (mode: string) => modes.push(mode), signedIn() {} });
    const oldSwitch = button(chooser.element as Element, "Use an access token"); await oldSwitch.fire("click"); expect(modes).toEqual(["token"]);
    const token = signupView({ mode: "token", policy: open, api: { login: async (value: string) => { logins.push(value); return { org: { id: 7 } }; } }, changeMode() {}, signedIn: (session: any) => sessions.push(session) });
    input(token.element as Element, "password").value = " sample-self-host-token "; await submit(token.element as Element).fire("submit");
    expect(logins).toEqual(["sample-self-host-token"]); expect(sessions).toEqual([{ org: { id: 7 } }]); expect(input(token.element as Element, "password").value).toBe("");
    chooser.dispose(); token.dispose();
    const hosted = signupView({ mode: "token", policy: beta, api: {}, changeMode() {}, signedIn() {} });
    await oldSwitch.fire("click"); await submit(token.element as Element).fire("submit");
    expect(modes).toEqual(["token"]); expect(logins).toHaveLength(1); expect(input(hosted.element as Element, "email")).toBeDefined();
  });

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
    expect(view.textContent).not.toContain("Name your workspace"); expect(all(view).filter(item => item.tag === "input")).toHaveLength(2);
    expect(signupRequest(beta, { email: "friend@example.com", name: "Ignore pre-signup name", inviteCode: "example-invite" })).toEqual({ email: "friend@example.com", inviteCode: "example-invite" });
    await submit(view).fire("submit");
    expect(calls).toEqual([{ email: "friend@example.com", inviteCode: "example-invite" }]);
    expect(sessions).toHaveLength(0);
    expect(view.textContent).toContain("Check friend@example.com for a verification link");
    expect(view.textContent).toContain("No card required.");
    expect(input(view, "password").value).toBe("");
    const feedback = find(view, item => item.attrs.id === "auth-feedback");
    expect(feedback.attrs.role).toBe("status"); expect(feedback.attrs["data-tone"]).toBe("success");
    expect(input(view, "email").attrs["aria-describedby"]).toContain("auth-feedback");
  });

  test("retains fields on rejection and clears detached fields and late login callbacks", async () => {
    const panel = signupView({ mode: "create", policy: beta, api: { createOrg: async () => { throw new Error("Invite is invalid"); } }, changeMode() {}, signedIn() {} });
    const view = panel.element as Element;
    input(view, "email").value = "friend@example.com"; input(view, "password").value = "wrong-code";
    await submit(view).fire("submit");
    expect(input(view, "email").value).toBe("friend@example.com"); expect(input(view, "password").value).toBe("wrong-code"); expect(view.textContent).toContain("Invite is invalid");
    const feedback = find(view, item => item.attrs.id === "auth-feedback");
    expect(feedback.attrs.role).toBe("alert"); expect(feedback.attrs["data-tone"]).toBe("danger");
    expect(submit(view).attrs["aria-busy"]).toBeUndefined();
    panel.dispose(); expect(input(view, "password").value).toBe("");
    let finish: (value: any) => void = () => {}; let signedIn = false;
    const login = signupView({ mode: "token", policy: open, api: { login: () => new Promise(resolve => { finish = resolve; }) }, changeMode() {}, signedIn() { signedIn = true; } });
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
    expect(view.textContent).toContain("Closed beta · invited access");
    const cloud = view.children[0], selfHosted = view.children[1];
    expect(find(cloud, item => item.tag === "strong").textContent).toBe("60 days free");
    expect(cloud.textContent).toContain("with an invite");
    expect(cloud.textContent).toContain("Starts after email verification. No card needed. Jev is separate.");
    expect(find(selfHosted, item => item.tag === "strong").textContent).toBe("$0");
    expect(view.textContent).not.toMatch(/14-day|Subscribe when/);
    expect(all(view).filter(item => item.tag === "a").map(item => item.attrs.href)).toEqual(["/app#invite", "/self-host"]);
    expect((planCards(catalog) as Element).textContent).toContain("Start a 14-day trial");
    const regular = planCards(catalog, undefined, undefined, open) as Element;
    expect(find(regular.children[0], item => item.tag === "strong").textContent).toBe("$19");
    expect(regular.children[0].textContent).toContain("/ workspace / month");
    expect(regular.children[0].textContent).not.toContain("60 days free");
    expect(catalog.plans[0].monthlyPrice).toBe(19);
    expect(all(planCards({ ...catalog, mode: "self-hosted" }, undefined, undefined, beta) as Element).find(item => item.attrs.href === "/hosted")).toBeDefined();
  });
});

describe("operator early access invitations", () => {
  test("listed unused invitations copy a usable link on demand after reopening without exposing credentials in inventory", async () => {
    const copied: string[] = [], requested: string[] = [];
    const link = "https://engram.example/app#invite=eg_link_v1_private_sample";
    const api = { signupInvites: async () => ({ invites: [invite], more: false }), signupInviteLink: async (id: string) => { requested.push(id); return { inviteUrl: link }; } };
    for (let reopen = 0; reopen < 2; reopen++) {
      const panel = signupAdminPanel({ session: operator, api, copy: async (value: string) => { copied.push(value); } })!;
      const view = panel.element as Element; view.open = true; await view.fire("toggle");
      expect(requested).toHaveLength(reopen);
      await button(view, "Copy link").fire("click");
      expect(requested[reopen]).toBe(invite.id); expect(copied[reopen]).toBe(link);
      expect(view.textContent).toContain("Invite link copied");
      expect(view.textContent).not.toContain("eg_link_v1_private_sample");
      expect(all(view).some(item => item.value === link || Object.values(item.attrs).includes(link))).toBe(false);
      panel.dispose();
    }
  });

  test("only unused and unexpired invitation rows offer copying", async () => {
    let calls = 0;
    const variants = [invite, { ...invite, id: "expired", expiresAt: "2020-01-01" }, { ...invite, id: "redeemed", redeemedAt: "2026-10-24" }, { ...invite, id: "revoked", revokedAt: "2026-10-24" }, { ...invite, id: "unknown", expiresAt: null }];
    const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: variants }), signupInviteLink: async () => { calls++; return { inviteUrl: "https://engram.example/app#invite=eg_link_v1_sample" }; } }, copy: async () => {} })!;
    const view = panel.element as Element; view.open = true; await view.fire("toggle");
    const buttons = all(view).filter(item => item.tag === "button" && item.textContent === "Copy link");
    expect(buttons.map(item => item.disabled)).toEqual([false, true, true, true, true]);
    for (const item of buttons) await item.fire("click");
    expect(calls).toBe(1);
  });

  test("copy requests cannot duplicate or copy after the panel closes or is disposed", async () => {
    for (const dispose of [false, true]) {
      let finish: (value: any) => void = () => {}, calls = 0; const copied: string[] = [];
      const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [invite] }), signupInviteLink: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }, copy: async (value: string) => { copied.push(value); } })!;
      const view = panel.element as Element; view.open = true; await view.fire("toggle");
      const control = button(view, "Copy link"), pending = control.fire("click"); await control.fire("click");
      expect(calls).toBe(1); expect(control.disabled).toBe(true);
      if (dispose) panel.dispose(); else { view.open = false; await view.fire("toggle"); view.open = true; await view.fire("toggle"); }
      finish({ inviteUrl: "https://engram.example/app#invite=late_secret" }); await pending;
      expect(copied).toEqual([]); expect(all(view).some(item => item.value.includes("late_secret"))).toBe(false);
      expect(control.disabled).toBe(false);
    }
  });

  test("clipboard refusal retains a masked selectable link and permits a fresh user-initiated copy", async () => {
    const link = "https://engram.example/app#invite=eg_link_v1_clipboard_sample";
    let copies = 0, requests = 0;
    const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [invite] }), signupInviteLink: async () => { requests++; return { inviteUrl: link }; } }, copy: async () => { if (++copies === 1) throw new Error("denied"); } })!;
    const view = panel.element as Element; view.open = true; await view.fire("toggle"); await button(view, "Copy link").fire("click");
    const secret = input(view, "password"); expect(secret.value).toBe(link); expect(secret.attrs.value).toBeUndefined();
    expect(view.textContent).toContain("Could not copy automatically"); expect(view.textContent).not.toContain("eg_link_v1_clipboard_sample");
    const region = find(view, item => item.attrs.class === "signup-issued");
    await button(region, "Copy link").fire("click"); expect(copies).toBe(2); expect(requests).toBe(1); expect(view.textContent).toContain("Invite link copied");
    panel.dispose(); expect(secret.value).toBe("");
  });

  test("a slower earlier row cannot overwrite the most recently selected invitation", async () => {
    let finishFirst: (value: any) => void = () => {};
    const copied: string[] = [], latest = "https://engram.example/app#invite=latest_link";
    const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [invite, { ...invite, id: "second" }] }), signupInviteLink: async (id: string) => id === invite.id ? new Promise(resolve => { finishFirst = resolve; }) : { inviteUrl: latest } }, copy: async (value: string) => { copied.push(value); } })!;
    const view = panel.element as Element; view.open = true; await view.fire("toggle");
    const buttons = all(view).filter(item => item.tag === "button" && item.textContent === "Copy link");
    const first = buttons[0].fire("click"); await buttons[1].fire("click");
    finishFirst({ inviteUrl: "https://engram.example/app#invite=older_link" }); await first;
    expect(copied).toEqual([latest]); expect(all(view).some(item => item.value.includes("older_link"))).toBe(false);
    expect(buttons.every(item => !item.disabled)).toBe(true);
  });

  test("link retrieval failures keep rows usable for retry and reject unsafe URLs", async () => {
    let requests = 0, copies = 0;
    const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [invite] }), signupInviteLink: async () => { if (++requests === 1) throw new Error("Try again"); return { inviteUrl: "javascript:alert(1)" }; } }, copy: async () => { copies++; } })!;
    const view = panel.element as Element; view.open = true; await view.fire("toggle"); const control = button(view, "Copy link");
    await control.fire("click"); expect(control.disabled).toBe(false); expect(view.textContent).toContain("Try again");
    await control.fire("click"); expect(control.disabled).toBe(false); expect(view.textContent).toContain("could not be loaded"); expect(copies).toBe(0);
  });

  test("an optional recipient creates an unbound single-use link shown and copied once", async () => {
    const copied: string[] = [], payloads: any[] = [], unbound = { ...invite, email: null, emailBound: false, accessDurationDays: 60 };
    const inviteUrl = "https://engram.example/app#invite=eg_inv_sample_once";
    const panel = signupAdminPanel({ session: operator, api: { signupInvites: async () => ({ invites: [], more: false }), issueSignupInvite: async (body: any) => { payloads.push(body); return { invite: unbound, inviteCode: "eg_inv_sample_once", inviteUrl }; } }, copy: async (value: string) => copied.push(value) })!;
    const view = panel.element as Element; view.open = true; await view.fire("toggle");
    expect(input(view, "email").attrs.required).toBeUndefined();
    await submit(view).fire("submit"); expect(payloads).toEqual([{}]);
    const secret = input(view, "password"), copyLink = button(view, "Copy link");
    expect(secret.value).toBe(inviteUrl); expect(secret.attrs.value).toBeUndefined(); expect(view.textContent).not.toContain("eg_inv_sample_once");
    expect(view.textContent).toContain("first person to verify an email address claims it");
    await copyLink.fire("click"); expect(copied).toEqual([inviteUrl]);
    panel.dispose(); expect(secret.value).toBe(""); await copyLink.fire("click"); expect(copied).toHaveLength(1);
    expect(signupInviteStatus({ ...invite, complimentaryAppliedAt: "2026-10-25", accessExpiresAt: "2026-12-24" }, Date.parse("2026-12-25"))).toBe("Friend access ended");
  });
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
    expect(payloads).toEqual([{ email: "friend@example.com" }]); expect(view.textContent).toContain("Generating an invitation does not send an email");
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
    expect(view.textContent).toContain("Friend access active"); expect(view.textContent).toContain("100 newest");
    const revoke = button(view, "Revoke code and free access"); await revoke.fire("click"); expect(calls).toBe(0); await revoke.fire("click");
    expect(calls).toBe(1); expect(view.textContent).toContain("Revocation pending"); expect(view.textContent).toContain("free access removal is still queued"); expect(button(view, "Retry revocation")).toBeDefined();
    expect(signupInviteStatus({ ...redeemed, revokedAt: "2026-10-24", complimentaryRevokedAt: "2026-10-24" })).toBe("Revoked");
    expect(signupInviteStatus({ ...invite, expiresAt: "2020-01-01" })).toBe("Code expired");
    expect(signupInviteStatus({ ...invite, redeemedAt: "2026-10-24" })).toBe("Activating free access");
    expect(signupInviteStatus({ ...redeemed, complimentaryErrorCode: "authority_conflict" })).toBe("Access needs attention");
  });
});

describe("check-your-inbox state", () => {
  test("a sent sign-in link switches to the inbox state with a resend timer, and can return to the form", async () => {
    const sent: string[] = [];
    const panel = signupView({ mode: "email", policy: beta, api: { loginEmail: async (email: string) => { sent.push(email); return { sent: true }; } }, changeMode() {}, signedIn() {} });
    const view = panel.element as Element;
    const body = find(view, item => item.attrs.class?.includes("ds-auth-body"));
    input(view, "email").value = "ada@example.com"; await submit(view).fire("submit");
    expect(sent).toEqual(["ada@example.com"]); expect(body.attrs["data-state"]).toBe("sent");
    expect(find(view, item => item.attrs.id === "auth-sent-title").textContent).toBe("Check your inbox");
    expect(view.textContent).toContain("Check ada@example.com for a sign-in link");
    const resend = find(view, item => item.tag === "button" && item.attrs.class?.includes("auth-resend"));
    expect(resend.disabled).toBe(true); expect(resend.textContent).toBe("Resend in 30s");
    await resend.fire("click"); expect(sent).toHaveLength(1);
    await button(view, "Use a different email").fire("click");
    expect(body.attrs["data-state"]).toBeUndefined(); expect(find(view, item => item.attrs.id === "auth-feedback").textContent).toBe("");
    panel.dispose();
  });

  test("an unlinked invite cannot be resent after its code is cleared; the product panel makes no customer claims", async () => {
    const panel = signupView({ mode: "create", policy: beta, api: { createOrg: async () => ({ sent: true }) }, changeMode() {}, signedIn() {} });
    const view = panel.element as Element;
    input(view, "email").value = "friend@example.com"; input(view, "password").value = "example-invite"; await submit(view).fire("submit");
    expect(all(view).some(item => item.attrs.class?.includes("auth-resend"))).toBe(false);
    expect(button(view, "Start over")).toBeDefined();
    const aside = find(view, item => item.tag === "aside");
    expect(aside.textContent).toContain("Outside work appears only when an agent reports it");
    expect(aside.textContent).not.toMatch(/customers?|trusted by|testimonial|“[^”]+” —/i);
    panel.dispose();
  });
});
