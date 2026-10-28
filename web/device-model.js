// Browser-approved computer sign-in: pure helpers shared by the console view.
export const INSTALL_PACKAGE = "@ani-hq/engram-mcp@latest";
export const HOSTED_ORIGIN = "https://engram.ani.computer";
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_STATES = Object.freeze(["pending", "approved", "denied", "consumed", "expired"]);
const PENDING_KEY = "engram-pending-device";
const PENDING_TTL_MS = 15 * 60_000;

/** The one-step setup command. Other installations name their own address. */
export function installCommand(origin = HOSTED_ORIGIN) {
  let host = "";
  try { const url = new URL(origin); host = `${url.protocol}//${url.host}`; } catch {}
  return host && host !== HOSTED_ORIGIN ? `npx -y ${INSTALL_PACKAGE} --host ${host}` : `npx -y ${INSTALL_PACKAGE}`;
}

/** Case-insensitive and hyphen/space-optional; returns the stored 8-letter form. */
export function normalizeUserCode(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every(char => USER_CODE_ALPHABET.includes(char)) ? code : null;
}

export function formatUserCode(value) {
  const code = normalizeUserCode(value);
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}

/** `#device` or `#device=CODE`. Returns null for any other route. */
export function parseDeviceRoute(hash) {
  const raw = String(hash || "").replace(/^#/, "").split("?")[0];
  if (raw === "device") return { code: "", input: "" };
  if (!raw.startsWith("device=")) return null;
  let input = "";
  try { input = decodeURIComponent(raw.slice("device=".length)); } catch { input = raw.slice("device=".length); }
  return { code: formatUserCode(input) || "", input: input.slice(0, 32) };
}

export function deviceHref(code) {
  const shown = formatUserCode(code);
  return shown ? `#device=${shown}` : "#device";
}

/** Which screen to show for the current device state. */
export function devicePresentation({ code = "", request = null, loading = false, error = "", errorCode = "", result = "" } = {}) {
  if (result === "approved" || result === "denied") return result === "approved" ? "approved-now" : "denied-now";
  if (!code) return "entry";
  if (loading && !request) return "loading";
  if (errorCode === "not_found" || errorCode === "invalid_code") return "not-found";
  if (error && !request) return "error";
  if (!request) return "loading";
  return DEVICE_STATES.includes(request.status) ? request.status : "error";
}

export function requestedAgo(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export function agentList(agents = []) {
  const labels = agents.map(agent => String(agent?.label || agent?.harness || "")).filter(Boolean);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

// Sign-in can move to a new tab through an email link. Keep only the short,
// non-secret display code for a few minutes so that tab can return here.
export function rememberPendingDevice(storage, code, now = Date.now()) {
  const shown = formatUserCode(code);
  if (!shown) return false;
  try { storage?.setItem(PENDING_KEY, JSON.stringify({ code: shown, at: now })); return true; } catch { return false; }
}

export function takePendingDevice(storage, now = Date.now()) {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    storage?.removeItem(PENDING_KEY);
    const value = raw ? JSON.parse(raw) : null;
    const shown = formatUserCode(value?.code);
    return shown && Number.isFinite(value?.at) && now - value.at >= 0 && now - value.at < PENDING_TTL_MS ? shown : null;
  } catch { return null; }
}
