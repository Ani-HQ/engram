function secretValue(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return !value || value === "unset" ? "" : value;
}

export type MailDelivery = "sent" | "skipped" | "failed";

export type MailDeps = {
  apiKey?: string;
  from?: string;
  fetchImpl?: typeof fetch;
};

export function mailFrom(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ENGRAM_MAIL_FROM ?? "engram@updates.ani.computer").trim();
}

export function mailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(secretValue(env.RESEND_API_KEY) && mailFrom(env));
}

export async function sendMail(
  mail: { to: string; subject: string; text: string },
  deps: MailDeps = {},
): Promise<MailDelivery> {
  const apiKey = secretValue(deps.apiKey ?? process.env.RESEND_API_KEY);
  const from = (deps.from ?? mailFrom()).trim();
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!apiKey || !from) return "skipped";
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

export function loginLinkText(url: string): string {
  return [
    "Your engram login link expires in 24 hours.",
    "",
    url,
    "",
    "If you did not ask for this, ignore the email.",
  ].join("\n");
}

export function inviteLinkText(input: { orgName: string; invitedBy: string; url: string }): string {
  return [
    `${input.invitedBy} invited you to ${input.orgName} on engram.`,
    "",
    input.url,
    "",
    "This link expires in 7 days.",
  ].join("\n");
}

export function loginLinkResponse(delivery: MailDelivery, url: string): {
  status: number;
  body: { sent: boolean; url?: string; error?: string };
} {
  if (delivery === "sent") return { status: 200, body: { sent: true } };
  if (delivery === "skipped") return { status: 200, body: { sent: false, url } };
  return { status: 502, body: { error: "could not send email" } };
}
