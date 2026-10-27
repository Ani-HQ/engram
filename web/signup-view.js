import { h } from "./profile.js";
import { attribution } from "./analytics.js";
import { signupAuthMode, signupRequest } from "./signup-model.js";
import { memoryOrbit, sticker } from "./design-system.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const field = (label, input) => h("label", { class: "field" }, label, input);
let authIntroPlayed = false;

export function signupView({ mode = "email", policy, message = "", api, changeMode, signedIn, retryPolicy, inviteEntry = null, inviteSubmitted = () => {} }) {
  mode = signupAuthMode(mode, policy);
  const introMotion = authIntroPlayed ? "none" : "intro";
  authIntroPlayed = true;
  let active = true, pending = false;
  const create = mode === "create", inviteOnly = policy?.mode === "invite-only", tokenAllowed = policy?.tokenSignInAllowed === true;
  const email = h("input", { type: "email", inputmode: "email", name: "email", required: true, autocomplete: "email", placeholder: "you@example.com", maxlength: 254, spellcheck: "false", autocapitalize: "none", "aria-describedby": "auth-feedback" });
  const token = tokenAllowed ? h("input", { type: "password", name: "access-token", required: true, autocomplete: "off", placeholder: "Access token", spellcheck: "false", autocapitalize: "none", "aria-describedby": "auth-feedback" }) : null;
  const linked = create && typeof inviteEntry?.code === "string" && inviteEntry.code.length > 0;
  const code = h("input", { type: "password", name: "invite-code", required: true, readonly: linked, autocomplete: "off", maxlength: 512, placeholder: "Your invite code", spellcheck: "false", autocapitalize: "none", "aria-describedby": linked ? "invite-link-note auth-feedback" : "auth-feedback" });
  if (linked) { code.value = inviteEntry.code; email.value = inviteEntry.email || ""; }
  const name = create && policy && !inviteOnly ? h("input", { name: "workspace-name", placeholder: "My workspace", maxlength: 100, autocomplete: "organization" }) : null;
  const label = mode === "token" ? "Sign in" : create ? inviteOnly ? "Verify email & join" : "Create workspace" : "Email me a sign-in link";
  const submit = h("button", { type: "submit", class: "primary", disabled: create && !policy }, label);
  const feedback = h("div", { id: "auth-feedback", tabindex: -1, role: "status", "aria-live": "polite", "aria-atomic": "true", class: "detail-note ds-notice", "data-tone": "neutral" }, message);
  const form = h("form", { class: "stack", onsubmit: async event => {
    event.preventDefault(); if (!active || pending || (create && !policy)) return;
    pending = true; submit.disabled = true; form.setAttribute("aria-busy", "true"); submit.setAttribute("aria-busy", "true"); submit.replaceChildren(h("span", { class: "ds-spinner", "aria-hidden": "true" }), mode === "token" ? "Signing in…" : "Sending verification link…"); feedback.textContent = ""; feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
    try {
      if (mode === "token") {
        const session = await api.login(token.value.trim());
        token.value = ""; if (active) signedIn(session);
      } else {
        const address = email.value.trim();
        const result = create ? await api.createOrg(signupRequest(policy, { email: address, name: name?.value, inviteCode: code.value, attribution: attribution() })) : await api.loginEmail(address);
        if (!active) return;
        // A linked code remains masked in this form so the recipient can fix
        // their email or request another proof before anyone verifies it.
        // It is cleared on navigation/pagehide and is never put in attributes.
        if (!linked) code.value = "";
        if (create) inviteSubmitted();
        feedback.setAttribute("data-tone", "success");
        feedback.replaceChildren(result.url ? h("a", { href: result.url, class: "ds-touch-target" }, "Continue to verify your email") : `Check ${address} for a verification link. Open it to ${create ? "finish joining your workspace" : "sign in"}.`);
      }
    } catch (error) { if (active) { feedback.setAttribute("role", "alert"); feedback.setAttribute("aria-live", "assertive"); feedback.setAttribute("data-tone", "danger"); feedback.textContent = error.message || "The request could not be completed. Please try again."; if ([submit, document.body].includes(document.activeElement)) feedback.focus?.(); } }
    finally { pending = false; if (active) { form.removeAttribute("aria-busy"); submit.disabled = create && !policy; submit.removeAttribute("aria-busy"); submit.textContent = label; } }
  } }, field(mode === "token" ? "Access token" : "Email", mode === "token" ? token : email), create && inviteOnly && field(linked ? "Invite code · included in your link" : "Invite code", code),
    linked && h("p", { class: "field-hint", id: "invite-link-note" }, "The code comes from your link. You can change the email address above; verify that inbox to claim the invitation. Email-bound invitations must use their invited address."),
    name && h("details", { class: "signup-workspace-name" }, h("summary", {}, "Name your workspace (optional)"), field("Workspace name", name)), submit, feedback);
  const wordmark = h("a", { class: "wordmark ds-touch-target", href: "/" }, h("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 32, height: 32, alt: "" }), "engram");
  const story = h("aside", { class: "auth-story", "aria-label": "About Engram" },
    h("div", { class: "auth-story-top" }, wordmark, sticker("A little less starting over.", { tone: "lime", tilt: "right" })),
    h("div", { class: "auth-story-copy ds-heading-group" }, h("span", { class: "ds-eyebrow" }, "SEPARATE AGENTS. SHARED CONTEXT."),
      h("h2", {}, "Your agents. ", h("br"), h("em", {}, "Same page.")),
      h("p", {}, "Give disconnected agents a common place for notes, decisions, and project context. Keep personal memory separate, and share selected memories with your team.")),
    h("div", { class: "auth-orbit" }, memoryOrbit({ motion: introMotion, compact: true, className: "ds-orbit--on-ink" }), h("span", { class: "auth-orbit-caption" }, "SAVE SOMETHING. CONNECT THE DOTS.")),
    h("div", { class: "auth-story-foot" }, h("a", { href: "/how-it-works#sharing", class: "ds-touch-target" }, "How sharing works"), h("a", { href: "/self-host", class: "ds-touch-target" }, "Open source")));
  const panel = h("section", { class: "auth-panel", "aria-labelledby": "auth-title" },
    h("div", { class: "auth-panel-heading ds-heading-group" }, h("div", { class: "auth-panel-kicker ds-heading-label" }, h("span", { class: "ds-badge", "data-tone": create ? "lilac" : "lime" }, create ? inviteOnly ? "CLOSED BETA" : "NEW WORKSPACE" : "WELCOME BACK"), h("a", { href: "/", class: "auth-back ds-touch-target" }, "Back to Engram")),
    h("h1", { id: "auth-title" }, create && inviteOnly ? "Your invite starts here." : create ? "Make room for good work." : "Pick up the thread."),
    h("p", { class: "auth-intro" }, create && inviteOnly ? "Open your invite link or enter a code, then choose the email address you want to verify. An email-bound invitation needs its invited address." : create ? "Give your agents a shared place for useful context and a history of their work." : "Sign in to your workspace. Your agents’ activity and shared memory are waiting.")),
    create && inviteOnly && h("p", { class: "signup-promise" }, "60 days of unlimited knowledge transfers start after email verification. No card required. Jev is separate."),
    create && !policy && h("p", { class: "notice" }, "Signup availability could not be checked. You can still sign in. ", action("Try again", retryPolicy, { class: "text small" })), form,
    create && inviteOnly && h("p", { class: "auth-invite-request" }, "Curious about Engram? ", h("a", { href: "https://x.com/anirudh_twt", class: "ds-touch-target" }, "Ask for an invite")),
    h("div", { class: "auth-switch" }, tokenAllowed && action(mode === "token" ? "Sign in with email" : "Use an access token", () => { if (active) changeMode(mode === "token" ? "email" : "token"); }, { class: "text small" }), tokenAllowed && " · ",
      action(create ? "Already joined? Sign in" : inviteOnly || !policy ? "Have an invite?" : "Create a workspace", () => { if (active) changeMode(create ? "email" : "create"); }, { class: "text small" })),
    h("footer", { class: "auth-links" }, h("a", { href: "/pricing", class: "ds-touch-target" }, "Pricing"), h("a", { href: "/self-host", class: "ds-touch-target" }, "Self-host"), h("a", { href: "/privacy", class: "ds-touch-target" }, "Privacy"), h("a", { href: "mailto:ani@odstdio.com?subject=Engram%20support", class: "ds-touch-target" }, "Support")));
  const element = h("main", { class: "auth auth-layout" }, story, panel);
  return { element, clearSecrets() { code.value = ""; if (token) token.value = ""; }, dispose() { active = false; code.value = ""; if (token) token.value = ""; email.value = ""; if (name) name.value = ""; } };
}
