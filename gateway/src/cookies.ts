export const SESSION_COOKIE_NAME = "engram_session";
export const SESSION_COOKIE_MAX_AGE = 1_209_600;

export function serializeSessionCookie(token: string, maxAge = SESSION_COOKIE_MAX_AGE): string {
  const parts = [`${SESSION_COOKIE_NAME}=${token}`, "HttpOnly"];
  if (process.env.ENGRAM_INSECURE_COOKIE !== "1") parts.push("Secure");
  parts.push("SameSite=Strict", "Path=/", `Max-Age=${maxAge}`);
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return serializeSessionCookie("", 0);
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE_NAME) return trimmed.slice(eq + 1);
  }
  return null;
}
