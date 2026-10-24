import { redactSecrets } from "../redact";

// Redact strings before JSON encoding: redacting serialized JSON misses escaped
// credential objects embedded inside a memory string.
export function sanitizeProviderInput(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") return redactSecrets(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/https?:\/\/[^\s]+/gi, "[resource]").slice(0, 1200);
  if (Array.isArray(value)) return value.slice(0, 32).map(item => sanitizeProviderInput(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key,
    /^(password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key) ? "[REDACTED]" : sanitizeProviderInput(item, depth + 1)]));
  return typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null ? value : null;
}
