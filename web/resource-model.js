// Pure resource identity shared by private views and the public allowlist.
// A provider mark is a display hint, never connection or execution evidence.
export const RESOURCE_SERVICES = Object.freeze([
  "github", "gitlab", "git", "googledocs", "googlesheets", "googledrive",
  "notion", "linear", "slack", "figma", "vercel", "dropbox", "supabase",
  "gmail", "googlecalendar", "microsoftoutlook", "postgresql", "memory",
  "files", "email", "calendar", "browser", "deployment", "database", "other",
]);

const result = (service, label, kind = "resource") => ({ service, label, kind });
const unknown = () => result("other", "Resource");
const unsafe = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const segment = /^[\p{L}\p{N}_.~-]+$/u;
const withoutSuffix = value => value.split(/[?#]/, 1)[0];
function pathParts(path) {
  try {
    const parts = path.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    return parts.every(part => !unsafe.test(part) && !/[\\/?#@]/.test(part) && part !== "." && part !== "..") ? parts : null;
  } catch { return null; }
}
function providerTool(tool, provider) {
  if (typeof tool !== "string" || tool.length > 256 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(tool) || tool.includes("://")) return false;
  const name = tool.toLowerCase();
  return name.startsWith("mcp__") ? name.startsWith(`mcp__${provider}__`) && /^[a-z0-9][a-z0-9._:/-]*$/.test(name.slice(provider.length + 7))
    : new RegExp(`^${provider}(?:$|[._:/-])`).test(name);
}
function repository(parts, service) {
  if (parts.length < 2 || !parts.every(part => segment.test(part))) return null;
  const clean = [...parts]; clean[clean.length - 1] = clean.at(-1).replace(/\.git$/i, "");
  return clean.at(-1) ? result(service, clean.join("/"), "repository") : null;
}
function gitHub(parts) {
  const repo = repository(parts.slice(0, 2), "github");
  if (!repo) return result("github", parts.join("/") || "github.com");
  if (parts[2] === "pull" && /^\d+$/.test(parts[3] || "")) return result("github", `${repo.label} #${parts[3]}`, "pull-request");
  if (parts[2] === "issues" && /^\d+$/.test(parts[3] || "")) return result("github", `${repo.label} #${parts[3]}`, "issue");
  if (parts[2] === "blob" && parts.length > 4) return result("github", `${repo.label} · ${parts.slice(4).join("/")}`, "file");
  return parts.length <= 2 ? repo : result("github", `${repo.label}/${parts.slice(2).join("/")}`);
}
function gitLab(parts) {
  const split = parts.indexOf("-");
  const repo = repository(split < 0 ? parts : parts.slice(0, split), "gitlab");
  if (!repo) return result("gitlab", parts.join("/") || "gitlab.com");
  if (split >= 0 && parts[split + 1] === "merge_requests" && /^\d+$/.test(parts[split + 2] || "")) return result("gitlab", `${repo.label} !${parts[split + 2]}`, "pull-request");
  if (split >= 0 && parts[split + 1] === "issues" && /^\d+$/.test(parts[split + 2] || "")) return result("gitlab", `${repo.label} #${parts[split + 2]}`, "issue");
  return split < 0 ? repo : result("gitlab", `${repo.label}/${parts.slice(split + 1).join("/")}`, parts[split + 1] === "blob" ? "file" : "resource");
}
const exact = (host, ...hosts) => hosts.includes(host);
const tenant = (host, domain) => new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${domain.replaceAll(".", "\\.")}$`).test(host);

/** Returns only an allowlisted service and a private display label. Never use
 * label, raw resources, or parsed identifiers in a public activity payload. */
export function resourceIdentity(resource, { tool } = {}) {
  if (typeof resource !== "string") return unknown();
  const raw = resource.trim();
  if (!raw || raw.length > 4096 || unsafe.test(raw)) return unknown();

  const shorthand = raw.match(/^repo:(?:\/\/)?(.+)$/i);
  if (shorthand) {
    const parts = pathParts(withoutSuffix(shorthand[1]));
    return parts?.length === 2 ? repository(parts, providerTool(tool, "github") ? "github" : providerTool(tool, "gitlab") ? "gitlab" : "git") || unknown() : unknown();
  }
  const scp = withoutSuffix(raw).match(/^git@(github\.com|gitlab\.com):(.+)$/i);
  if (scp) {
    const parts = pathParts(scp[2]);
    return parts && (scp[1].toLowerCase() === "github.com" ? parts.length === 2 && repository(parts, "github") : repository(parts, "gitlab")) || unknown();
  }
  if (/^git@/i.test(raw)) return unknown();
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  const infrastructure = { cloud: "deployment", deployment: "deployment", database: "database", db: "database", sql: "database", postgres: "postgresql", postgresql: "postgresql" };
  if (Object.hasOwn(infrastructure, scheme)) {
    let url;
    try { url = new URL(raw); } catch { return unknown(); }
    if (raw.slice(0, scheme.length + 3).toLowerCase() !== `${scheme}://` || !url.hostname || url.username || url.password || /[\\\s]/.test(raw)) return unknown();
    const parts = pathParts(url.pathname);
    return parts ? result(infrastructure[scheme], `${url.hostname}${parts.length ? `/${parts.join("/")}` : ""}`, infrastructure[scheme] === "deployment" ? "deployment" : "database") : unknown();
  }
  if (["engram", "memory", "gbrain"].includes(scheme)) {
    const parts = pathParts(raw.slice(raw.indexOf(":") + 1).replace(/^\/\//, ""));
    return parts?.length ? result("memory", parts.join("/"), "memory") : unknown();
  }
  if (scheme === "mailto") return result("email", "Email address", "message");
  if (["email", "gmail", "calendar", "googlecalendar", "slack", "notion", "linear", "figma", "vercel", "dropbox"].includes(scheme)) {
    const parts = pathParts(withoutSuffix(raw.slice(raw.indexOf(":") + 1).replace(/^\/\//, "")));
    return parts?.length ? result(scheme, parts.join("/"), scheme === "email" || scheme === "gmail" ? "message" : scheme === "calendar" || scheme === "googlecalendar" ? "event" : "resource") : unknown();
  }
  if (/^(?:[a-z]:[\\/]|\.{0,2}\/|~\/)/i.test(raw) && scheme !== "file") return result("files", withoutSuffix(raw), "file");
  const bareWeb = /^(?:www\.)?(?:github\.com|gitlab\.com)\//i.test(raw);
  if (scheme || bareWeb || raw.startsWith("//")) {
    let url;
    try { url = new URL(bareWeb ? `https://${raw}` : raw.startsWith("//") ? `https:${raw}` : raw); } catch { return unknown(); }
    if (url.username || url.password || /[\\\s]/.test(raw)) return unknown();
    if (url.protocol === "file:") return url.hostname && url.hostname !== "localhost" ? unknown() : result("files", url.pathname, "file");
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return unknown();
    const parts = pathParts(url.pathname);
    if (!parts) return unknown();
    const host = url.hostname.toLowerCase();
    const plain = () => result("browser", `${host}${parts.length ? `/${parts.join("/")}` : ""}`, "website");
    if (url.port) return plain();
    if (exact(host, "github.com", "www.github.com")) return gitHub(parts);
    if (exact(host, "gitlab.com", "www.gitlab.com")) return gitLab(parts);
    if (!["https:", "http:"].includes(url.protocol)) return unknown();
    if (host === "docs.google.com") {
      const type = { document: ["googledocs", "Document", "document"], spreadsheets: ["googlesheets", "Spreadsheet", "spreadsheet"], presentation: ["googledrive", "Presentation", "presentation"] }[parts[0]];
      const index = parts.indexOf("d");
      return type ? result(type[0], `${type[1]}${index >= 0 && parts[index + 1] ? ` ${parts[index + 1]}` : ""}`, type[2]) : result("googledrive", "Google document", "document");
    }
    if (host === "drive.google.com") {
      const folder = parts.indexOf("folders"), file = parts.indexOf("d");
      return folder >= 0 ? result("googledrive", `Folder${parts[folder + 1] ? ` ${parts[folder + 1]}` : ""}`, "folder") : file >= 0 ? result("googledrive", `File${parts[file + 1] ? ` ${parts[file + 1]}` : ""}`, "file") : result("googledrive", "Google Drive", "folder");
    }
    if (exact(host, "notion.so", "www.notion.so", "notion.site", "www.notion.site") || tenant(host, "notion.site")) return result("notion", parts.at(-1) || "Notion page", "document");
    if (exact(host, "linear.app", "www.linear.app")) {
      const issue = parts.indexOf("issue");
      return result("linear", issue >= 0 && parts[issue + 1] ? parts[issue + 1] : parts.at(-1) || "Linear", issue >= 0 ? "issue" : "project");
    }
    if (exact(host, "slack.com", "app.slack.com") || tenant(host, "slack.com")) {
      const archive = parts.indexOf("archives");
      return archive >= 0 ? result("slack", parts.slice(archive + 1).join("/") || "Slack channel", parts[archive + 2] ? "message" : "channel") : result("slack", parts.at(-1) || "Slack", "channel");
    }
    if (exact(host, "figma.com", "www.figma.com")) return result("figma", parts[2] || parts[1] || "Figma", parts[0] === "proto" ? "prototype" : "design");
    if (exact(host, "vercel.com", "www.vercel.com") || tenant(host, "vercel.app")) return result("vercel", parts.length ? parts.join("/") : host, host.endsWith(".vercel.app") || parts.length > 2 ? "deployment" : "project");
    if (exact(host, "dropbox.com", "www.dropbox.com", "paper.dropbox.com")) return result("dropbox", parts.at(-1) || "Dropbox", host === "paper.dropbox.com" ? "document" : "file");
    if (exact(host, "supabase.com", "www.supabase.com", "app.supabase.com")) return result("supabase", parts.at(-1) || "Supabase", "database");
    if (host === "mail.google.com") return result("gmail", "Gmail", "message");
    if (host === "calendar.google.com") return result("googlecalendar", "Google Calendar", "event");
    if (exact(host, "outlook.office.com", "outlook.office365.com", "outlook.live.com")) return result("microsoftoutlook", "Outlook", parts.includes("calendar") ? "event" : "message");
    return plain();
  }
  // A local path stays a file even when a GitHub tool happens to report it.
  if (/[\\/]/.test(raw) || /\.[a-z0-9]{1,12}$/i.test(withoutSuffix(raw))) return result("files", withoutSuffix(raw), "file");
  return result("other", withoutSuffix(raw) || "Resource");
}

export const resourceService = (resource, tool) => resourceIdentity(resource, { tool }).service;
