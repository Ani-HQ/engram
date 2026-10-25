import { renderEmail } from "./mail-templates";

function secretValue(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return !value || value === "unset" ? "" : value;
}

export type MailDelivery = "sent" | "skipped" | "failed";

export type MailDeps = {
  apiKey?: string;
  from?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type MailMessage = {
  to: string; subject: string; text: string; html?: string; replyTo?: string;
  headers?: Record<string, string>; idempotencyKey?: string;
};

export const MAIL_TIMEOUT_MS = 10_000;
const singleLine = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\r\n\u0000]/.test(value);
const address = (value: unknown): value is string => singleLine(value) && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const reservedHeaders = new Set(["from", "to", "cc", "bcc", "subject", "content-type", "mime-version", "reply-to", "sender", "return-path", "authorization", "cookie"]);

export function mailFrom(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ENGRAM_MAIL_FROM ?? "engram@updates.ani.computer").trim();
}

export function mailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(secretValue(env.RESEND_API_KEY) && mailFrom(env));
}

export async function sendMail(
  mail: MailMessage,
  deps: MailDeps = {},
): Promise<MailDelivery> {
  const apiKey = secretValue(deps.apiKey ?? process.env.RESEND_API_KEY);
  const from = (deps.from ?? mailFrom()).trim();
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!apiKey || !from) return "skipped";
  const replyTo = mail.replyTo ?? process.env.ENGRAM_MAIL_REPLY_TO ?? "ani@odstdio.com";
  if (!singleLine(from) || !address(mail.to) || !singleLine(mail.subject) || typeof mail.text !== "string" || !mail.text || !address(replyTo)) return "failed";
  if (mail.html !== undefined && typeof mail.html !== "string") return "failed";
  if (mail.idempotencyKey !== undefined && (!/^[\x21-\x7e]{1,256}$/.test(mail.idempotencyKey))) return "failed";
  if (mail.headers && Object.entries(mail.headers).some(([key, value]) => !/^[A-Za-z0-9-]+$/.test(key) || reservedHeaders.has(key.toLowerCase()) || !singleLine(value))) return "failed";
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(1, Math.min(deps.timeoutMs!, 30_000)) : MAIL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Email delivery timed out")); }, timeoutMs); });
  try {
    const res = await Promise.race([fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(mail.idempotencyKey ? { "Idempotency-Key": mail.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html !== undefined ? { html: mail.html } : {}),
        reply_to: replyTo,
        ...(mail.headers ? { headers: { ...mail.headers } } : {}),
      }),
    }), timeout]);
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  } finally { clearTimeout(timer!); }
}

export function loginLinkText(url: string): string {
  return renderEmail({ template: "login", url }).text;
}

export function inviteLinkText(input: { orgName: string; invitedBy: string; url: string }): string {
  return renderEmail({ template: "team-invite", ...input }).text;
}

export function devLoginLinksAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENGRAM_DEPLOYMENT_MODE !== "hosted" && env.ENGRAM_DEV_LOGIN_LINKS === "1";
}

export function loginLinkResponse(delivery: MailDelivery, url: string, env: NodeJS.ProcessEnv = process.env): {
  status: number;
  body: { sent: boolean; url?: string; error?: string };
} {
  if (delivery === "sent") return { status: 200, body: { sent: true } };
  if (delivery === "skipped" && devLoginLinksAllowed(env)) return { status: 200, body: { sent: false, url } };
  if (delivery === "skipped") return { status: 503, body: { error: "email login is not configured" } };
  return { status: 502, body: { error: "could not send email" } };
}
