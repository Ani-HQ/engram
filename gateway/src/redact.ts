export const TRANSCRIPT_CHAR_CAP = 200_000;

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "REDACTED_PRIVATE_KEY" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: "REDACTED_API_KEY" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, label: "REDACTED_API_KEY" },
  { re: /\bsk-svcacct-[A-Za-z0-9_-]{20,}\b/g, label: "REDACTED_API_KEY" },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, label: "REDACTED_TOKEN" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "REDACTED_TOKEN" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: "REDACTED_TOKEN" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, label: "REDACTED_TOKEN" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "REDACTED_ACCESS_KEY" },
  { re: /\beng_[A-Za-z0-9_-]{20,}\b/g, label: "REDACTED_TOKEN" },
  { re: /\bens_[A-Za-z0-9_-]{20,}\b/g, label: "REDACTED_TOKEN" },
  { re: /\binv_[A-Za-z0-9_-]{20,}\b/g, label: "REDACTED_TOKEN" },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, label: "Bearer REDACTED_TOKEN" },
  { re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"`]+/gi, label: "REDACTED_CONNECTION" },
  { re: /\bhttps?:\/\/[^\s'"`/]+@[^\s'"`]+/gi, label: "REDACTED_CONNECTION" },
  { re: /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*)\s*=\s*.+$/gim, label: "$1=REDACTED" },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, label);
    re.lastIndex = 0;
  }
  return out;
}

export function capTranscript(text: string, cap = TRANSCRIPT_CHAR_CAP): string {
  if (text.length <= cap) return text;
  const keep = Math.floor((cap - 80) / 2);
  return `${text.slice(0, keep)}\n\n[… ${text.length - keep * 2} characters omitted …]\n\n${text.slice(-keep)}`;
}

export function normalizeRepo(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let value = raw.trim();
  value = value.replace(/^git\+/, "");
  const scp = value.match(/^git@([^:]+):(.+)$/);
  if (scp) value = `${scp[1]}/${scp[2]}`;
  value = value.replace(/^https?:\/\//, "").replace(/^ssh:\/\//, "");
  value = value.replace(/\.git$/, "").replace(/\/+$/, "");
  value = value.replace(/^www\./, "");
  const lower = value.toLowerCase();
  return lower || null;
}

export function repoPageSlug(repo: string | null | undefined): string {
  const normalized = normalizeRepo(repo);
  if (!normalized) return "local";
  const withoutHost = normalized.replace(/^(github\.com|gitlab\.com|bitbucket\.org)\//, "");
  const cleaned = withoutHost
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
  return cleaned || "local";
}
