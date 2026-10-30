import { h } from "./profile.js";
import { attribution } from "./analytics.js";
import { signupAuthMode, signupRequest } from "./signup-model.js";
import { icon } from "./icons.js";
import { identityMark, markStack } from "./design-system.js";
import { brandIcon } from "./tooling.js";

const action = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const field = (label, input) => h("label", { class: "field" }, label, input);
const RESEND_SECONDS = 30;

// The panel beside the form states what Engram is, in product terms only:
// no customer quotes, metrics or logos of customers.
function productPanel() {
  const marks = ["claude", "codex", "cursor", "gemini", "openai"].map(brand => identityMark(brandIcon(brand, { size: 16 }), { size: "md" }));
  return h("aside", { class: "ds-auth-aside ds-dotgrid", "aria-label": "About Engram" },
    h("div", { class: "ds-auth-statement" },
      markStack(marks, { max: 5 }),
      h("p", {}, "A shared drive for your agents’ context. ", h("span", {}, "Save a decision in one agent, recall it in another.")),
      h("ul", { class: "ds-auth-facts" },
        h("li", {}, icon("plug", { size: 15 }), "Agents connect over MCP: Claude Code, Codex, Cursor and other clients."),
        h("li", {}, icon("brain", { size: 15 }), "Memory pages, decisions and a readable history of work in one console."),
        h("li", {}, icon("eye", { size: 15 }), "Engram shows its own calls as observed. Outside work appears only when an agent reports it."))));
}

export function signupView({ mode = "email", policy, message = "", api, changeMode, signedIn, retryPolicy, inviteEntry = null, inviteSubmitted = () => {} }) {
  mode = signupAuthMode(mode, policy);
  let active = true, pending = false, resendTimer = 0, remaining = 0;
  const create = mode === "create", inviteOnly = policy?.mode === "invite-only", tokenAllowed = policy?.tokenSignInAllowed === true;
  const email = h("input", { type: "email", inputmode: "email", name: "email", required: true, autocomplete: "email", placeholder: "you@example.com", maxlength: 254, spellcheck: "false", autocapitalize: "none", "aria-describedby": "auth-feedback" });
  const token = tokenAllowed ? h("input", { type: "password", name: "access-token", required: true, autocomplete: "off", placeholder: "Access token", spellcheck: "false", autocapitalize: "none", "aria-describedby": "auth-feedback" }) : null;
  const linked = create && typeof inviteEntry?.code === "string" && inviteEntry.code.length > 0;
  const code = h("input", { type: "password", name: "invite-code", required: true, readonly: linked, autocomplete: "off", maxlength: 512, placeholder: "Your invite code", spellcheck: "false", autocapitalize: "none", "aria-describedby": linked ? "invite-link-note auth-feedback" : "auth-feedback" });
  if (linked) { code.value = inviteEntry.code; email.value = inviteEntry.email || ""; }
  const name = create && policy && !inviteOnly ? h("input", { name: "workspace-name", placeholder: "My workspace", maxlength: 100, autocomplete: "organization" }) : null;
  const label = mode === "token" ? "Sign in" : create ? inviteOnly ? "Verify email and join" : "Create workspace" : "Send sign-in link";
  const busyLabel = mode === "token" ? "Signing in…" : create ? "Sending verification link…" : "Sending link…";
  const submit = h("button", { type: "submit", class: "primary", disabled: create && !policy }, label);
  const feedback = h("div", { id: "auth-feedback", tabindex: -1, role: "status", "aria-live": "polite", "aria-atomic": "true", class: "detail-note ds-notice", "data-tone": "neutral" }, message);

  // "Check your inbox" replaces the form visually; the fields stay mounted so a
  // linked invite keeps its masked code and the address can be corrected.
  const sentTitle = h("h2", { class: "ds-result-title", id: "auth-sent-title", tabindex: -1 }, "Check your inbox");
  const sent = h("div", { class: "ds-result auth-sent", "aria-labelledby": "auth-sent-title" },
    h("span", { class: "ds-result-tile", "aria-hidden": "true" }, icon("mail", { size: 22 })), sentTitle);
  // Resending reuses the same request. An unlinked invite code is cleared after
  // sending, so that path returns to the form instead.
  const canResend = mode !== "token" && (!create || linked);
  const resend = canResend ? action("Resend link", () => { if (active && !pending && remaining <= 0) send(); }, { class: "small auth-resend", "aria-live": "off" }) : null;
  const tick = () => {
    if (!resend) return;
    resend.disabled = remaining > 0;
    resend.textContent = remaining > 0 ? `Resend in ${remaining}s` : "Resend link";
    if (remaining > 0 && active && resend.isConnected !== false) resendTimer = setTimeout(() => { remaining -= 1; tick(); }, 1000);
  };
  const back = action(create && !linked ? "Start over" : "Use a different email", () => {
    if (!active) return;
    clearTimeout(resendTimer); remaining = 0; body.removeAttribute("data-state");
    feedback.textContent = ""; feedback.setAttribute("data-tone", "neutral"); email.focus?.();
  }, { class: "text small" });
  const sentActions = h("div", { class: "auth-sent-actions" }, resend, back);

  async function send() {
    if (!active || pending || (create && !policy)) return;
    pending = true; submit.disabled = true; form.setAttribute("aria-busy", "true"); submit.setAttribute("aria-busy", "true");
    submit.replaceChildren(icon("loader-circle", { size: 16, class: "ds-spin" }), busyLabel);
    if (resend) { resend.disabled = true; resend.setAttribute("aria-busy", "true"); }
    feedback.textContent = ""; feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
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
        sentTitle.textContent = result.url ? "Verify your email" : "Check your inbox";
        feedback.replaceChildren(result.url ? h("a", { href: result.url, class: "ds-touch-target" }, "Continue to verify your email") : create ? `Check ${address} for a verification link. Open it to finish joining your workspace.` : `Check ${address} for a sign-in link. Open it to sign in.`);
        body.setAttribute("data-state", "sent");
        clearTimeout(resendTimer); remaining = result.url ? 0 : RESEND_SECONDS; tick();
        if ([submit, document.body].includes(document.activeElement)) sentTitle.focus?.();
      }
    } catch (error) { if (active) { body.removeAttribute("data-state"); feedback.setAttribute("role", "alert"); feedback.setAttribute("aria-live", "assertive"); feedback.setAttribute("data-tone", "danger"); feedback.textContent = error.message || "The request could not be completed. Please try again."; if ([submit, document.body].includes(document.activeElement)) feedback.focus?.(); } }
    finally {
      pending = false;
      if (active) { form.removeAttribute("aria-busy"); submit.disabled = create && !policy; submit.removeAttribute("aria-busy"); submit.textContent = label; if (resend) { resend.removeAttribute("aria-busy"); resend.disabled = remaining > 0; } }
    }
  }

  const form = h("form", { class: "stack", onsubmit: event => { event.preventDefault(); send(); } },
    field(mode === "token" ? "Access token" : "Email", mode === "token" ? token : email), create && inviteOnly && field(linked ? "Invite code · included in your link" : "Invite code", code),
    linked && h("p", { class: "field-hint", id: "invite-link-note" }, "The code comes from your link. You can change the email address above; verify that inbox to claim the invitation. Email-bound invitations must use their invited address."),
    name && h("details", { class: "signup-workspace-name" }, h("summary", {}, "Name your workspace (optional)"), field("Workspace name", name)), submit, feedback);

  const title = create ? "Get started" : "Welcome back";
  const subtitle = mode === "token" ? "Sign in with an access token for this installation."
    : create && inviteOnly ? "Enter your invite code and the email you want to verify. An email-bound invitation needs its invited address."
      : create ? "Create a workspace where your agents share context and a history of their work."
        : "Sign in with your email. We’ll send you a sign-in link.";
  const body = h("section", { class: "ds-auth-body auth-panel", "aria-labelledby": "auth-title" },
    h("div", { class: "ds-auth-heading auth-heading" },
      h("h1", { id: "auth-title", class: "ds-auth-title" }, title),
      h("p", { class: "ds-auth-subtitle auth-intro" }, subtitle)),
    create && inviteOnly && h("p", { class: "signup-promise" }, icon("sparkles", { size: 14 }), h("span", {}, "60 days of unlimited knowledge transfers start after email verification. No card required. Jev is separate.")),
    create && !policy && h("p", { class: "ds-notice", "data-tone": "warning" }, "Signup availability could not be checked. You can still sign in. ", action("Try again", retryPolicy, { class: "text small" })),
    sent, form, sentActions,
    create && inviteOnly && h("p", { class: "auth-invite-request" }, "Curious about Engram? ", h("a", { href: "https://x.com/anirudh_twt", class: "ds-touch-target" }, "Ask for an invite")),
    h("div", { class: "auth-switch" }, tokenAllowed && action(mode === "token" ? "Sign in with email" : "Use an access token", () => { if (active) changeMode(mode === "token" ? "email" : "token"); }, { class: "text small" }), tokenAllowed && " · ",
      action(create ? "Already joined? Sign in" : inviteOnly || !policy ? "Have an invite?" : "Create a workspace", () => { if (active) changeMode(create ? "email" : "create"); }, { class: "text small" })));
  const wordmark = h("a", { class: "ds-auth-brand wordmark ds-touch-target", href: "/" }, h("img", { class: "brand-mark", src: "/brand/engram-mark.svg", width: 24, height: 24, alt: "" }), "engram");
  const legal = h("footer", { class: "ds-auth-legal" },
    h("p", {}, "By continuing, you acknowledge Engram’s ", h("a", { href: "/privacy" }, "Privacy Policy"), "."),
    h("nav", { class: "auth-links", "aria-label": "Engram links" }, h("a", { href: "/how-it-works#sharing", class: "ds-touch-target" }, "How sharing works"), h("a", { href: "/pricing", class: "ds-touch-target" }, "Pricing"), h("a", { href: "/self-host", class: "ds-touch-target" }, "Self-host"), h("a", { href: "mailto:ani@odstdio.com?subject=Engram%20support", class: "ds-touch-target" }, "Support")));
  const element = h("main", { class: "ds-auth signup-auth" }, h("div", { class: "ds-auth-main" }, wordmark, body, legal), productPanel());
  const clear = () => { code.value = ""; if (token) token.value = ""; };
  return { element, clearSecrets: clear, dispose() { active = false; clearTimeout(resendTimer); clear(); email.value = ""; if (name) name.value = ""; } };
}
