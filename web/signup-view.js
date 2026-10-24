import { h } from "./profile.js";
import { signupAuthMode, signupRequest } from "./signup-model.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const field = (label, input) => h("label", { class: "field" }, label, input);

export function signupView({ mode = "email", policy, message = "", api, changeMode, signedIn, retryPolicy }) {
  mode = signupAuthMode(mode, policy);
  let active = true, pending = false;
  const create = mode === "create", inviteOnly = policy?.mode === "invite-only", tokenAllowed = policy?.tokenSignInAllowed === true;
  const email = h("input", { type: "email", required: true, autocomplete: "email", placeholder: "you@example.com", maxlength: 254 });
  const token = tokenAllowed ? h("input", { type: "password", required: true, autocomplete: "off", placeholder: "Access token" }) : null;
  const code = h("input", { type: "password", required: true, autocomplete: "off", placeholder: "Your invite code", spellcheck: "false", autocapitalize: "none" });
  const name = h("input", { placeholder: "My workspace", maxlength: 100, autocomplete: "organization" });
  const label = mode === "token" ? "Sign in" : create ? inviteOnly ? "Verify email & join" : "Create workspace" : "Email me a sign-in link";
  const submit = h("button", { type: "submit", class: "primary", disabled: create && !policy }, label);
  const feedback = h("div", { role: "status", "aria-live": "polite", class: "detail-note" }, message);
  const form = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); if (!active || pending || (create && !policy)) return;
    pending = true; submit.disabled = true; submit.textContent = mode === "token" ? "Signing in…" : "Sending verification link…"; feedback.textContent = "";
    try {
      if (mode === "token") {
        const session = await api.login(token.value.trim());
        token.value = ""; if (active) signedIn(session);
      } else {
        const address = email.value.trim();
        const result = create ? await api.createOrg(signupRequest(policy, { email: address, name: name.value, inviteCode: code.value })) : await api.loginEmail(address);
        if (!active) return;
        code.value = "";
        feedback.replaceChildren(result.url ? h("a", { href: result.url }, "Continue to verify your email →") : `Check ${address} for a verification link. Open it to ${create ? "finish joining your workspace" : "sign in"}.`);
      }
    } catch (error) { if (active) feedback.textContent = error.message || "Please try again."; }
    finally { pending = false; if (active) { submit.disabled = create && !policy; submit.textContent = label; } }
  } }, field(mode === "token" ? "Access token" : "Email", mode === "token" ? token : email), create && inviteOnly && field("Invite code", code),
    create && policy && h("details", { class: "signup-workspace-name" }, h("summary", {}, "Name your workspace (optional)"), field("Workspace name", name)), submit, feedback);
  const element = h("main", { class: "auth" }, h("a", { class: "wordmark", href: "/" }, h("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 27, height: 27, alt: "" }), "engram"),
    h("h1", {}, create && inviteOnly ? "Have an invite?" : create ? "A home for your agents." : "Your agents. One place."),
    h("p", {}, create && inviteOnly ? "Engram is in a closed beta. Use the email address your invite was issued for." : "Activity and shared memory across the agents you use."),
    create && inviteOnly && h("p", { class: "signup-promise" }, "No card required. Verify your email to get started."),
    create && !policy && h("p", { class: "notice" }, "Signup availability could not be checked. You can still sign in. ", action("Try again", retryPolicy, { class: "text small" })), form,
    create && inviteOnly && h("p", { class: "detail-note" }, h("a", { href: "mailto:ani@odstdio.com?subject=Engram%20early%20access" }, "Don’t have a code? Ask for an invite")),
    h("div", { class: "auth-switch" }, tokenAllowed && action(mode === "token" ? "Sign in with email" : "Use an access token", () => { if (active) changeMode(mode === "token" ? "email" : "token"); }, { class: "text small" }), tokenAllowed && " · ",
      action(create ? "Already joined? Sign in" : inviteOnly || !policy ? "Have an invite?" : "Create a workspace", () => { if (active) changeMode(create ? "email" : "create"); }, { class: "text small" })),
    h("div", { class: "auth-links" }, h("a", { href: "/pricing" }, "Pricing"), h("a", { href: "/self-host" }, "Self-host"), h("a", { href: "/privacy" }, "Privacy"), h("a", { href: "mailto:ani@odstdio.com?subject=Engram%20support" }, "Support")));
  return { element, clearSecrets() { code.value = ""; if (token) token.value = ""; }, dispose() { active = false; code.value = ""; if (token) token.value = ""; email.value = ""; name.value = ""; } };
}
