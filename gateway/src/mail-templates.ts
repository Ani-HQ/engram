import { readFileSync } from "node:fs";

export const EMAIL_TEMPLATE_IDS = ["login", "verify-signup", "team-invite", "agent-authorize", "welcome", "connect-agent", "first-memory", "second-agent"] as const;
export type EmailTemplateId = typeof EMAIL_TEMPLATE_IDS[number];
export type OnboardingEmailId = Extract<EmailTemplateId, "welcome" | "connect-agent" | "first-memory" | "second-agent">;
type LinkInput = { url: string; orgName?: string; expiresAt?: string };
export type EmailTemplateInput =
  | ({ template: "login" | "verify-signup" } & LinkInput)
  | ({ template: "team-invite"; orgName: string; invitedBy: string } & LinkInput)
  | ({ template: "agent-authorize"; clientName?: string; expiresInMinutes?: number } & LinkInput)
  | { template: OnboardingEmailId; appUrl: string; unsubscribeUrl: string; orgName: string };
export type RenderedEmail = { subject: string; preheader: string; text: string; html: string };

// Email clients need literal inline values. Resolve them from the same source
// used by the console and public pages, rather than maintaining another palette.
const designSource = readFileSync(new URL("../../web/design-system.css", import.meta.url), "utf8");
function token(name: string, ancestors: string[] = []): string {
  if (ancestors.includes(name)) throw new Error("Circular email design token.");
  const value = designSource.match(new RegExp(`--ds-${name}:\\s*([^;]+);`, "i"))?.[1]?.trim();
  if (!value) throw new Error(`Missing email design token: ${name}`);
  const alias = value.match(/^var\(--ds-([a-z0-9-]+)\)$/);
  return alias ? token(alias[1], [...ancestors, name]) : value;
}
function color(name: string) {
  const value = token(name);
  if (!/^#[a-f0-9]{6}$/i.test(value)) throw new Error(`Invalid email color token: ${name}`);
  return value;
}
function pixels(name: string) {
  const value = token(name), parsed = value.match(/^([0-9.]+)(px|rem)$/);
  if (!parsed) throw new Error(`Invalid email size token: ${name}`);
  return Number(parsed[1]) * (parsed[2] === "rem" ? 16 : 1);
}
export const EMAIL_DESIGN_TOKENS = Object.freeze({
  paper: color("paper"), ink: color("ink"), surface: color("surface"), muted: color("muted"), line: color("line"),
  lime: color("lime"), lilac: color("lilac"), apricot: color("apricot"),
  font: token("email-font-sans"), editorial: token("email-font-editorial"), mono: token("email-font-mono"),
  width: pixels("email-width"), padding: pixels("email-padding"), labelTitleGap: pixels("gap-label-title"), titleBodyGap: pixels("gap-title-body"), actionGap: pixels("gap-heading-actions"),
  radius: pixels("radius-card"), controlRadius: pixels("radius-control"), headingSize: pixels("email-heading-size"), bodySize: pixels("email-body-size"),
});

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const name = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : fallback;

function link(value: string): string {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f-\u009f]/.test(value)) throw new Error("Email links must be absolute HTTP(S) URLs without credentials.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Email links must be absolute HTTP(S) URLs without credentials."); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Email links must be absolute HTTP(S) URLs without credentials.");
  return parsed.href;
}

function expiry(expiresAt: string | undefined, fallback: string) {
  if (!expiresAt) return fallback;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) throw new Error("Email expiry must be a valid timestamp.");
  return `This link expires ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC and can be used once.`;
}

type Content = {
  subject: string; preheader: string; eyebrow: string; title: string; paragraphs: string[];
  cta: string; url: string; note?: string; steps?: string[]; unsubscribeUrl?: string;
};

function content(input: EmailTemplateInput): Content {
  const org = name(input.orgName, "your workspace");
  switch (input.template) {
    case "login": return {
      subject: "Your Engram sign-in link", preheader: input.expiresAt ? "A one-time link to your workspace. Use it before the expiry shown below." : "A one-time link to your workspace. It expires in 24 hours.", eyebrow: "SIGN IN", title: "Pick up the thread.",
      paragraphs: ["Use this one-time link to sign in to Engram with the email address you just entered."],
      cta: "Sign in to Engram", url: link(input.url), note: expiry(input.expiresAt, "This sign-in link expires in 24 hours and can be used once."),
    };
    case "verify-signup": return {
      subject: "Verify your email for Engram", preheader: "Confirm this address to continue setting up your shared drive for agent context.", eyebrow: "VERIFY YOUR EMAIL", title: "A quick email check.",
      paragraphs: ["Confirm this email address to continue to Engram. Your agents will have a shared place for useful context, decisions, and memory pages.", "You can choose a workspace name and connect your first agent after signing in."],
      cta: "Verify my email", url: link(input.url), note: input.expiresAt ? `${expiry(input.expiresAt, "")} An invitation can expire or be revoked sooner.` : "Use this link within 24 hours, or before your invitation expires if sooner. It can be used once.",
    };
    case "team-invite": return {
      subject: `You're invited to ${org} on Engram`, preheader: "Join the workspace to share useful context with the people and agents working there.", eyebrow: "WORKSPACE INVITATION", title: "A shared place to work.",
      paragraphs: [`${name(input.invitedBy, "A workspace owner")} invited you to join ${org} on Engram.`, "People authorized in this workspace can access its shared memory and activity. Accept only if you recognize the invitation."],
      cta: "Join the workspace", url: link(input.url), note: expiry(input.expiresAt, "This invitation expires in 7 days and can be used once."),
    };
    case "agent-authorize": {
      const minutes = input.expiresInMinutes ?? 15;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("Agent sign-in expiry must be a positive number of minutes.");
      return {
        subject: "Continue your agent sign-in to Engram", preheader: "Finish the connection you started. Only continue if you recognize this request.", eyebrow: "AGENT CONNECTION", title: "Give your agent a way in.",
        paragraphs: [`Use this link to finish the Engram sign-in you started for ${name(input.clientName, "your agent")}.`, "Only continue if you started this connection. This link can complete the agent authorization request; keep it private."],
        cta: "Continue agent sign-in", url: link(input.url), note: expiry(input.expiresAt, `This connection request expires in ${minutes} minutes. If it has expired, restart the connection in your agent.`),
      };
    }
    case "welcome": return {
      subject: "Welcome to Engram. Keep the useful bits.", preheader: "Your shared drive for agent context starts with one workspace and one connected agent.", eyebrow: "WELCOME TO ENGRAM", title: "Good context deserves a home.",
      paragraphs: [`Welcome to ${org}. You've got a shared drive for agent context: a home for useful decisions, preferences, and memory pages.`, "Start with one thing you want your next task to know. A project constraint, a naming choice, or a preference you keep repeating is plenty.", "No big migration or perfect filing system to invent. Just one useful thing, saved on purpose, ready to ask for again."],
      steps: ["Connect your usual agent.", "Save one decision worth keeping.", "Recall it when you pick up the next task."],
      cta: "Open your workspace", url: link(input.appUrl), unsubscribeUrl: link(input.unsubscribeUrl), note: "Open Get started in your workspace whenever you want a hand. You can name the workspace there, too.",
    };
    case "connect-agent": return {
      subject: "One agent is a good place to start", preheader: "Choose the tool you already use. Check the connection from the agent before saving memory.", eyebrow: "GETTING STARTED / CONNECT", title: "Start with your usual agent.",
      paragraphs: ["You don't need to connect every tool at once. Pick the agent you already work with and give it a path to your Engram workspace.", "Open Get started and choose your agent. The guide gives you the endpoint, setup command, or connector instructions that fit the tool you picked.", "Once the connection works, that agent can help you keep useful context close to the work. You can add the others later, without doing all the setup in one sitting."],
      steps: ["Choose your agent in Get started.", "Follow its setup instructions and choose the access it needs.", "Ask the agent to check the connection."],
      cta: "Set up your agent", url: link(input.appUrl), unsubscribeUrl: link(input.unsubscribeUrl), note: "Your setup guide helps you check the connection as you go. If anything gets stuck, reply and tell us which agent you're using.",
    };
    case "first-memory": return {
      subject: "Save one decision. Ask for it again.", preheader: "A small, useful memory is a better first test than a whole conversation.", eyebrow: "GETTING STARTED / REMEMBER", title: "Give the next task a head start.",
      paragraphs: ["Choose one real decision or preference from the work you're doing. Ask your agent to save it to Engram, then ask for it again.", "A project constraint, an agreed naming convention, or a preference you want to keep across sessions makes a good first memory. A short, specific note is easier to recognize than a whole conversation.", "When you start the next task, try asking for that context before explaining it all over again. Check the source your agent returns so you can see what it found."],
      steps: ["Choose the context you want to remember.", "Ask your connected agent to save it.", "Recall it and check the returned source."],
      cta: "Open your workspace", url: link(input.appUrl), unsubscribeUrl: link(input.unsubscribeUrl), note: "Need a hand? Open Get started in the app for the save-and-recall walkthrough.",
    };
    case "second-agent": return {
      subject: "Let another agent pick up the thread", preheader: "Connect a second agent to the same workspace and test it with context you chose to share.", eyebrow: "GETTING STARTED / SHARE CONTEXT", title: "New agent. Less catching up.",
      paragraphs: ["Once you've saved one useful decision in Engram, try asking another connected agent for it. It's a small way to put the shared-drive idea to work.", "Connect the other agent to the same workspace and ask for something specific: the constraint you agreed on, a project preference, or the decision behind your next step.", "Check what it returns and the source it used. You get to choose which context is worth carrying forward; there's no need to move everything at once."],
      steps: ["Save one useful decision if you haven't yet.", "Connect another agent to the same workspace.", "Ask it to recall that decision and show the source."],
      cta: "Connect another agent", url: link(input.appUrl), unsubscribeUrl: link(input.unsubscribeUrl), note: "Personal and team workspaces are separate. In a team workspace, authorized people can read its shared memory, so choose where you save.",
    };
  }
}

export function renderEmail(input: EmailTemplateInput): RenderedEmail {
  const message = content(input), ds = EMAIL_DESIGN_TOKENS;
  if (!message) throw new Error("Unknown email template.");
  const onboarding = Boolean(message.unsubscribeUrl);
  const footer = onboarding
    ? "You're receiving a few getting-started tips because you created an Engram workspace. You can stop these tips below; essential account emails are separate."
    : "If you didn't request this, you can ignore this email. This private link is intended for this inbox only; do not forward it.";
  const text = [message.title, "", ...message.paragraphs.flatMap(paragraph => [paragraph, ""]), ...(message.steps ? message.steps.map((step, index) => `${index + 1}. ${step}`) : []), ...(message.steps ? [""] : []), `${message.cta}:`, message.url, "", message.note || "", "", "— Engram", "Questions? Reply to this email or contact ani@odstdio.com.", "", footer,
    ...(message.unsubscribeUrl ? ["", `Stop getting-started emails: ${message.unsubscribeUrl}`] : []), "", "Engram · Outcome Driven Holdings LLC"].join("\n");
  const paragraph = (value: string) => `<p style="margin:0 0 18px;color:${ds.ink};font-family:${escape(ds.font)};font-size:${ds.bodySize}px;line-height:1.75;">${escape(value)}</p>`;
  const steps = message.steps ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 24px;border-collapse:collapse;">${message.steps.map((step, index) => `<tr><td width="30" valign="top" style="padding:0 10px 12px 0;color:${ds.ink};font-family:${ds.mono};font-size:13px;line-height:1.8;">${index + 1}.</td><td valign="top" style="padding:0 0 12px;color:${ds.ink};font-family:${ds.font};font-size:15px;line-height:1.7;">${escape(step)}</td></tr>`).join("")}</table>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(message.subject)}</title></head><body style="margin:0;padding:0;background-color:${ds.paper};color:${ds.ink};font-family:${ds.font};-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;color:${ds.paper};max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escape(message.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background-color:${ds.paper};"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:${ds.width}px;border-collapse:separate;"><tr><td style="padding:0 0 24px;font-family:${ds.font};font-size:26px;font-weight:700;letter-spacing:-1px;color:${ds.ink};">engram<span style="color:${ds.muted};font-family:${ds.mono};font-size:11px;font-weight:400;letter-spacing:0;">&nbsp; / &nbsp;shared context</span></td></tr>
<tr><td style="padding:${ds.padding}px;background-color:${ds.surface};border:1px solid ${ds.line};border-radius:${ds.radius}px;">
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;"><tr><td style="padding:6px 10px;background-color:${onboarding ? ds.lime : ds.lilac};border:1px solid ${ds.ink};border-radius:6px;font-family:${ds.mono};font-size:10px;font-weight:700;letter-spacing:1px;color:${ds.ink};">${escape(message.eyebrow)}</td></tr></table>
<h1 style="margin:${ds.labelTitleGap}px 0 ${ds.titleBodyGap}px;font-family:${escape(ds.editorial)};font-size:${ds.headingSize}px;font-weight:400;letter-spacing:-1px;line-height:1.15;color:${ds.ink};">${escape(message.title)}</h1>
${message.paragraphs.map(paragraph).join("")}${steps}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:${ds.actionGap}px 0;border-collapse:separate;"><tr><td align="center" bgcolor="${ds.ink}" style="border-radius:10px;background-color:${ds.ink};mso-padding-alt:14px 20px;"><a href="${escape(message.url)}" style="display:inline-block;padding:14px 20px;border:1px solid ${ds.ink};border-radius:10px;color:${ds.paper};background-color:${ds.ink};font-family:${ds.font};font-size:15px;font-weight:600;line-height:1.4;text-decoration:none;">${escape(message.cta)}</a></td></tr></table>
${message.note ? `<p style="margin:0;padding:16px;background-color:${ds.paper};border:1px solid ${ds.line};border-radius:10px;font-family:${ds.font};font-size:13px;line-height:1.75;color:${ds.muted};">${escape(message.note)}</p>` : ""}
<p style="margin:24px 0 0;font-family:${ds.font};font-size:14px;line-height:1.8;color:${ds.ink};">A little less catching up.<br>— Engram</p>
</td></tr><tr><td style="padding:24px 2px 0;color:${ds.muted};font-family:${ds.font};font-size:12px;line-height:1.8;">
<p style="margin:0 0 12px;">Questions? Reply to this email or contact ani@odstdio.com.</p><p style="margin:0 0 12px;">${escape(footer)}</p>
${message.unsubscribeUrl ? `<p style="margin:0 0 12px;"><a href="${escape(message.unsubscribeUrl)}" style="color:${ds.ink};text-decoration:underline;">Stop getting-started emails</a></p>` : ""}
<p style="margin:0;">Engram · Outcome Driven Holdings LLC</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: message.subject, preheader: message.preheader, text, html };
}
