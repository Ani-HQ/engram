import { redactSecrets } from "./redact";

// Product/source names are display metadata, never authentication or a claim
// that Engram verified the program or model behind a credential.
export const COMMON_HARNESSES = [
  "codex", "claude-code", "claude", "cursor", "chatgpt", "grok-bot", "grok",
  "gemini-cli", "opencode", "cline", "windsurf", "aider", "goose", "amp", "github-copilot",
  "openclaw", "hermes", "devin", "other",
] as const;

export function parseReportedSource(harness: unknown, sourceLabel: unknown): { harness: string | null; sourceLabel: string | null } {
  let id: string | null = null, label: string | null = null;
  if (harness !== undefined && harness !== null) {
    if (typeof harness !== "string") throw new Error("harness must be a source identifier");
    const value = harness.trim().toLowerCase();
    if (value && !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value)) throw new Error("harness must be a source identifier of at most 80 characters");
    if (redactSecrets(value) !== value) throw new Error("harness must not contain credentials");
    id = value || null;
  }
  if (sourceLabel !== undefined && sourceLabel !== null) {
    if (typeof sourceLabel !== "string" || sourceLabel.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(sourceLabel)) throw new Error("sourceLabel must be text of at most 100 characters");
    label = redactSecrets(sourceLabel.trim()) || null;
  }
  return { harness: id, sourceLabel: label };
}
