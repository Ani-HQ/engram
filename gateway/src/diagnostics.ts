// Database/provider exception messages can echo credentials or tenant content.
// Shared diagnostics retain a small actionable category, never arbitrary text.
const CODES = new Set(["23505","23503","22P02","42501","57014","53300","08000","08001","08006","57P01","42P01","42703","28P01","ECONNREFUSED","ECONNRESET","ETIMEDOUT","ENOTFOUND"]);
export function failureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unavailable";
  const value = error as {code?:unknown;name?:unknown};
  if (typeof value.code === "string" && CODES.has(value.code)) return value.code;
  if (value.name === "TimeoutError" || value.name === "AbortError") return value.name;
  return "unavailable";
}
