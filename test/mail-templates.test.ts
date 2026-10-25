import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMAIL_DESIGN_TOKENS, EMAIL_TEMPLATE_IDS, renderEmail, type EmailTemplateId, type EmailTemplateInput } from "../gateway/src/mail-templates";

const action = "https://engram.example/app#activity";
const unsubscribe = "https://engram.example/email/unsubscribe?proof=example&stage=welcome";
function sample(template: EmailTemplateId): EmailTemplateInput {
  if (template === "team-invite") return { template, url: action, orgName: "Studio", invitedBy: "owner@example.com" };
  if (["welcome", "connect-agent", "first-memory", "second-agent"].includes(template)) return { template: template as "welcome", appUrl: action, unsubscribeUrl: unsubscribe, orgName: "Studio" };
  return { template: template as "login", url: action };
}

describe("shared email renderer", () => {
  test("renders every transactional and onboarding message with one primary action and an accessible text alternative", () => {
    for (const template of EMAIL_TEMPLATE_IDS) {
      const message = renderEmail(sample(template));
      expect(message.subject.length).toBeGreaterThan(10); expect(message.preheader.length).toBeGreaterThan(30);
      expect(message.html).toContain('lang="en"'); expect(message.html).toContain('role="presentation"'); expect(message.html).toContain("display:none");
      expect(message.text).toContain(action); expect(message.html).toContain(`href="${action}"`);
      expect(message.html).not.toMatch(/<(script|svg|img|style|iframe|link)\b/i); expect(message.html).not.toMatch(/\son\w+\s*=/i); expect(message.html).not.toContain("@font-face");
      const series = ["welcome", "connect-agent", "first-memory", "second-agent"].includes(template);
      expect((message.html.match(/<a\s/g) || []).length).toBe(series ? 2 : 1);
      expect(message.text.includes("Stop getting-started emails:")).toBe(series);
      if (series) { expect(message.html).toContain("essential account emails are separate"); expect(message.html).toContain("proof=example&amp;stage=welcome"); }
      else { expect(message.html).toContain("do not forward it"); expect(message.html).not.toContain("Stop getting-started emails"); }
    }
  });

  test("escapes dynamic names and URL delimiters in HTML without changing the plain-text action", () => {
    const orgName = '<svg onload="evil()">A & B</svg>', invitedBy = '<img src=x> "Someone" & team';
    const url = "https://engram.example/app?from=email&next=workspace#join=preview";
    const message = renderEmail({ template: "team-invite", orgName, invitedBy, url });
    expect(message.html).toContain("&lt;svg onload=&quot;evil()&quot;&gt;A &amp; B&lt;/svg&gt;"); expect(message.html).toContain("&lt;img src=x&gt;");
    expect(message.html).not.toMatch(/<svg|<img/); expect(message.html).toContain('href="https://engram.example/app?from=email&amp;next=workspace#join=preview"'); expect(message.text).toContain(url);
    expect(renderEmail({ template: "team-invite", orgName: "Workspace\r\nBcc: attacker", invitedBy: "Owner", url }).subject).not.toMatch(/[\r\n]/);
  });

  test("rejects unsafe or credential-bearing links for both actions and unsubscribe, without echoing them", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,evil", "mailto:someone@example.com", "ftp://example.com/file", "/relative", "//example.com", "https://user:private@example.com/app", "https://example.com/\nsecret"]) {
      expect(() => renderEmail({ template: "login", url })).toThrow("Email links must be absolute HTTP(S)");
      expect(() => renderEmail({ template: "welcome", appUrl: action, unsubscribeUrl: url, orgName: "Studio" })).toThrow("Email links must be absolute HTTP(S)");
    }
    expect(renderEmail({ template: "login", url: "http://localhost:8080/app#join=example" }).text).toContain("http://localhost:8080/app#join=example");
  });

  test("uses actual flow expiries and does not reuse the 24-hour login promise for OAuth", () => {
    expect(renderEmail(sample("login")).text).toContain("24 hours"); expect(renderEmail(sample("team-invite")).text).toContain("7 days");
    expect(renderEmail(sample("verify-signup")).text).toContain("within 24 hours, or before your invitation expires if sooner");
    const oauth = renderEmail({ template: "agent-authorize", url: action, expiresInMinutes: 15 });
    expect(oauth.text).toContain("15 minutes"); expect(oauth.text).not.toContain("24 hours"); expect(oauth.text).toContain("can complete the agent authorization request");
    const dated = renderEmail({ template: "login", url: action, expiresAt: "2026-10-25T09:30:00Z" });
    expect(dated.text).toMatch(/25 Oct 2026.*09:30 UTC/); expect(dated.preheader).not.toContain("24 hours");
    expect(() => renderEmail({ template: "login", url: action, expiresAt: "not-a-date" })).toThrow("valid timestamp");
  });

  test("derives email-safe inline values from the canonical design system", () => {
    const css = readFileSync(new URL("../web/design-system.css", import.meta.url), "utf8"), message = renderEmail(sample("welcome"));
    for (const token of ["paper", "ink", "lime", "lilac", "apricot"] as const) expect(css).toContain(`--ds-${token}: ${EMAIL_DESIGN_TOKENS[token]};`);
    expect(message.html).toContain(`max-width:${EMAIL_DESIGN_TOKENS.width}px`); expect(message.html).toContain(`padding:${EMAIL_DESIGN_TOKENS.padding}px`);
    expect(message.html).toContain(`margin:${EMAIL_DESIGN_TOKENS.labelTitleGap}px 0 ${EMAIL_DESIGN_TOKENS.titleBodyGap}px`);
    expect(message.html).toContain("font-size:16px"); expect(message.html).not.toContain("min-width:600"); expect(message.html).not.toContain("var(--");
  });
});
