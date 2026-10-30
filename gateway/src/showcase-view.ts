import { resolve } from "node:path";
import { renderAsync } from "@resvg/resvg-js";
import { publicActivityEvents, PRODUCTS, type PublicActivityEvent } from "./public-activity";
import { designColor } from "./design-tokens";

export type ShowcaseLayout = "studio" | "field-notes";
export interface ShowcaseHighlight { title: string; body: string; url: string; }

export interface ShowcaseProfile {
  slug: string;
  displayName: string;
  bio: string;
  published: boolean;
  showActivity?: boolean;
  layout?: ShowcaseLayout;
  highlights?: ShowcaseHighlight[];
  photo?: string | null;
}

export interface PublicActivity {
  profile: Pick<ShowcaseProfile, "slug" | "displayName" | "bio"> & { layout: ShowcaseLayout; highlights: ShowcaseHighlight[]; photoUrl: string | null };
  stats: {
    totalActions: number;
    completedActions: number;
    failedActions: number;
    runningActions: number;
    activeAgents: number;
    activeDays: number;
  };
  daily: { date: string; count: number }[];
  tools: { category: string; count: number }[];
  agents: { product: string; label: string; agents: number; actions: number }[];
  updatedAt: string | null;
  activity: { enabled: boolean; events: PublicActivityEvent[] };
  live: {
    workingAgents: number;
    recentlyActiveAgents: number;
    completedAgents: number;
    failedAgents: number;
    workingActions: number;
    staleActions: number;
    lastActivityAt: string | null;
    checkedAt: string;
    freshnessSeconds: 900;
  };
}

export class ShowcaseError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const PROFILE_FIELDS = new Set(["slug", "displayName", "bio", "published", "showActivity", "layout", "highlights", "photo"]);
const HIGHLIGHT_FIELDS = new Set(["title", "body", "url"]);
// Text/presentation budget plus one bounded 512 KiB PNG encoded as base64.
export const SHOWCASE_PAYLOAD_LIMIT = 32_768 + Math.ceil(512 * 1024 / 3) * 4 + 64;
export const SHOWCASE_CATEGORIES = ["code", "files", "email", "calendar", "cloud", "browser", "data", "memory", "other"] as const;
const CATEGORY_SET = new Set<string>(SHOWCASE_CATEGORIES);

// Keep these broad groupings aligned with the public SQL projection. Unknown
// tools are deliberately collapsed into "other", never exposed by identifier.
export function showcaseCategory(tool: string): string {
  const name = tool.toLowerCase();
  if (["search", "get_page", "list_pages", "put_page", "remember", "recall", "add_tag", "add_link", "add_timeline_entry"].includes(name)) return "memory";
  for (const [pattern, category] of [
    [/calendar|gcal/, "calendar"], [/email|gmail|mail[._]/, "email"],
    [/deploy|cloud|aws|azure|docker|kubernetes|vercel/, "cloud"],
    [/github|gitlab|commit|pull_request|code|shell|terminal|exec_command|build/, "code"],
    [/file|drive|dropbox|directory|read_text|write_text/, "files"],
    [/browser|browse|playwright|web[._]|search/, "browser"],
    [/sql|database|postgres|spreadsheet|sheets|query/, "data"],
    [/memory|remember|recall|page|add_tag|add_link|timeline/, "memory"],
  ] as [RegExp, string][]) if (pattern.test(name)) return category;
  return "other";
}

export function validShowcaseSlug(value: unknown): value is string {
  return typeof value === "string" && /^(?=.{3,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function parseHighlights(value: unknown): ShowcaseHighlight[] {
  if (!Array.isArray(value) || value.length > 3) throw new ShowcaseError("Choose up to three profile highlights");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !HIGHLIGHT_FIELDS.has(key))) throw new ShowcaseError(`Highlight ${index + 1} has unknown or invalid fields`);
    if (typeof item.title !== "string" || !item.title.trim() || item.title.trim().length > 80) throw new ShowcaseError(`Highlight ${index + 1} needs a title from 1 to 80 characters`);
    if (typeof item.body !== "string" || item.body.trim().length > 600) throw new ShowcaseError(`Highlight ${index + 1} text must be at most 600 characters`);
    if (item.url !== undefined && typeof item.url !== "string") throw new ShowcaseError(`Highlight ${index + 1} link must be an HTTP or HTTPS URL`);
    const url = (item.url || "").trim();
    if (url.length > 2048 || /[\u0000-\u001f\u007f]/.test(url)) throw new ShowcaseError(`Highlight ${index + 1} link must be at most 2,048 characters without control characters`);
    if (url) {
      if (!/^https?:\/\//i.test(url)) throw new ShowcaseError(`Highlight ${index + 1} link must be an absolute HTTP or HTTPS URL`);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new ShowcaseError(`Highlight ${index + 1} link must be an HTTP or HTTPS URL`); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new ShowcaseError(`Highlight ${index + 1} link must use HTTP or HTTPS without credentials`);
    }
    return { title: item.title.trim(), body: item.body.trim(), url };
  });
}

// Legacy rows have no presentation fields. Corrupt stored highlights must not
// introduce unsafe links or arbitrary record fields into the public projection.
export function showcasePresentation(value: { layout?: unknown; highlights?: unknown }): { layout: ShowcaseLayout; highlights: ShowcaseHighlight[] } {
  let highlights: ShowcaseHighlight[] = [];
  try { highlights = parseHighlights(value.highlights ?? []); } catch { /* Invalid stored highlights stay out of the projection. */ }
  return { layout: value.layout === "field-notes" ? "field-notes" : "studio", highlights };
}

export function parseShowcaseInput(value: unknown): ShowcaseProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShowcaseError("Expected a profile object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !PROFILE_FIELDS.has(key))) throw new ShowcaseError("Unknown profile field");
  if (!validShowcaseSlug(input.slug)) throw new ShowcaseError("Use 3–48 lowercase letters, numbers, or single hyphens for your address");
  if (typeof input.displayName !== "string" || input.displayName.trim().length > 80) throw new ShowcaseError("Display name must be at most 80 characters");
  if (typeof input.bio !== "string" || input.bio.trim().length > 160) throw new ShowcaseError("Bio must be at most 160 characters");
  if (typeof input.published !== "boolean") throw new ShowcaseError("published must be true or false");
  if (input.showActivity !== undefined && typeof input.showActivity !== "boolean") throw new ShowcaseError("showActivity must be true or false");
  if (Object.hasOwn(input, "layout") && !["studio", "field-notes"].includes(input.layout as string)) throw new ShowcaseError("Choose the Studio or Field notes profile layout");
  const highlights = Object.hasOwn(input, "highlights") ? parseHighlights(input.highlights) : [];
  if (Object.hasOwn(input, "photo") && input.photo !== null && (typeof input.photo !== "string" || !input.photo.startsWith("data:image/png;base64,") || input.photo.length > Math.ceil(512 * 1024 / 3) * 4 + 22)) throw new ShowcaseError("Choose a PNG profile photo, up to 512 KB");
  return { slug: input.slug, displayName: input.displayName.trim(), bio: input.bio.trim(), published: input.published, showActivity: input.showActivity === true, layout: input.layout === "field-notes" ? "field-notes" : "studio", highlights, ...(Object.hasOwn(input, "photo") ? { photo: input.photo as string | null } : {}) };
}

export function showcaseUrls(profile: ShowcaseProfile, origin: string) {
  const base = origin.replace(/\/$/, "");
  return profile.slug ? {
    page: `${base}/u/${profile.slug}`,
    json: `${base}/api/public/activity/${profile.slug}`,
    card: `${base}/api/public/activity/${profile.slug}/card.png`,
    stream: `${base}/api/public/activity/${profile.slug}/stream`,
  } : { page: null, json: null, card: null, stream: null };
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function publicActivitySnapshot(profile: ShowcaseProfile, row: any = {}, now = new Date(), eventSource: { rows?: unknown; scope?: string; key?: string; preview?: boolean; photoUrl?: string | null } = {}): PublicActivity {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const counts = new Map<string, number>();
  for (const day of Array.isArray(row.daily) ? row.daily : []) {
    if (typeof day?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date)) counts.set(day.date, count(day.count));
  }
  const daily = Array.from({ length: 84 }, (_, index) => {
    const date = new Date(today.getTime() - (83 - index) * 86_400_000).toISOString().slice(0, 10);
    return { date, count: counts.get(date) ?? 0 };
  });
  const categories = new Map<string, number>();
  for (const tool of Array.isArray(row.tools) ? row.tools : []) {
    const category = CATEGORY_SET.has(tool?.category) ? tool.category : "other";
    categories.set(category, (categories.get(category) ?? 0) + count(tool?.count));
  }
  // Known product keys only; anything else is grouped as "other", never named.
  const products = new Map<string, { agents: number; actions: number }>();
  for (const item of Array.isArray(row.products) ? row.products : []) {
    const key = typeof item?.product === "string" && item.product !== "other" && Object.hasOwn(PRODUCTS, item.product) ? item.product : "other";
    const total = products.get(key) ?? { agents: 0, actions: 0 };
    total.agents += count(item?.agents); total.actions += count(item?.actions);
    products.set(key, total);
  }
  const last = row.updated_at ? new Date(row.updated_at) : null;
  const received = row.last_activity_at ? new Date(row.last_activity_at) : null;
  return {
    profile: { slug: profile.slug, displayName: profile.displayName, bio: profile.bio, ...showcasePresentation(profile), photoUrl: eventSource.photoUrl ?? null },
    stats: {
      totalActions: count(row.total_actions), completedActions: count(row.completed_actions),
      failedActions: count(row.failed_actions), runningActions: count(row.running_actions),
      activeAgents: count(row.active_agents), activeDays: count(row.active_days),
    },
    daily,
    tools: [...categories].filter(([, total]) => total > 0).map(([category, total]) => ({ category, count: total }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    agents: [...products].filter(([, total]) => total.agents > 0)
      .map(([product, total]) => ({ product, label: PRODUCTS[product], ...total }))
      .sort((a, b) => Number(a.product === "other") - Number(b.product === "other") || b.agents - a.agents || b.actions - a.actions || a.product.localeCompare(b.product)),
    updatedAt: last && Number.isFinite(last.getTime()) ? last.toISOString() : null,
    activity: { enabled: profile.showActivity === true, events: publicActivityEvents(eventSource.rows, { enabled: profile.showActivity === true || eventSource.preview === true, scope: eventSource.scope || "", key: eventSource.key || "", now }) },
    live: {
      workingAgents: count(row.working_agents), recentlyActiveAgents: count(row.recently_active_agents),
      completedAgents: count(row.completed_agents), failedAgents: count(row.failed_agents),
      workingActions: count(row.working_actions), staleActions: count(row.stale_actions),
      lastActivityAt: received && Number.isFinite(received.getTime()) ? received.toISOString() : null,
      checkedAt: now.toISOString(), freshnessSeconds: 900,
    },
  };
}

export function escapeShowcaseHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

export function renderShowcasePage(activity: PublicActivity, origin: string): string {
  const { profile } = activity;
  const urls = showcaseUrls({ ...profile, published: true }, origin);
  const title = `${profile.displayName || profile.slug} · Agent activity`;
  const description = profile.bio || `${activity.stats.totalActions.toLocaleString("en-US")} agent actions, connected through Engram.`;
  const escape = escapeShowcaseHtml;
  return `<!doctype html>
<html lang="en" data-design-system="signal"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${escape(description)}">
<link rel="canonical" href="${escape(urls.page!)}"><meta property="og:type" content="profile">
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${escape(urls.page!)}"><meta property="og:image" content="${escape(urls.card!)}">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(title)}">
<meta name="twitter:description" content="${escape(description)}"><meta name="twitter:image" content="${escape(urls.card!)}">
<link rel="stylesheet" href="/design-system.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/showcase.css"><link rel="stylesheet" href="/app-theme.css"><script type="module" src="/showcase.js"></script>
</head><body><div id="public-showcase" data-slug="${escape(profile.slug)}"><main class="public-showcase-fallback"><p>engram</p><h1>${escape(profile.displayName || profile.slug)}</h1><p>${escape(description)}</p><p>${activity.stats.totalActions.toLocaleString("en-US")} actions · ${activity.stats.activeAgents.toLocaleString("en-US")} agents</p></main></div></body></html>`;
}

export function renderUnavailableShowcasePage(): string {
  return `<!doctype html><html lang="en" data-design-system="signal"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Profile unavailable · engram</title><link rel="stylesheet" href="/design-system.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/showcase.css"><link rel="stylesheet" href="/app-theme.css"></head><body><main class="public-unavailable"><a class="wordmark" href="/">engram</a><h1>Nothing public here yet.</h1><p>This profile is private, unavailable, or has moved.</p><a class="button-link" href="/">Back to engram</a></main></body></html>`;
}

// Mirrors activityRhythm() in web/profile.js: UTC days, and a streak that ended
// yesterday still counts because today may be in progress.
function currentStreak(daily: { count: number }[]): number {
  let index = daily.length - 1, streak = 0;
  if (index >= 0 && !(daily[index].count > 0)) index--;
  while (index >= 0 && daily[index].count > 0) { streak++; index--; }
  return streak;
}

export function renderShowcaseCard(activity: PublicActivity): string {
  const { profile, stats, daily } = activity;
  const escape = escapeShowcaseHtml;
  const name = profile.displayName || profile.slug;
  const shortName = Array.from(name).length > 40 ? Array.from(name).slice(0, 39).join("") + "…" : name;
  const actions = stats.totalActions.toLocaleString("en-US");
  const fittedSize = (text: string, maximum: number, width = 520) => {
    const units = Array.from(text).reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1.15 : /[MW@%]/.test(char) ? 1 : /[il.,' ]/.test(char) ? 0.32 : /[A-Z0-9]/.test(char) ? 0.7 : 0.6), 0);
    return Math.min(maximum, width / Math.max(1, units));
  };
  const paper = designColor("paper"), ink = designColor("ink"), surface = designColor("surface"), muted = designColor("muted"), accent = designColor("accent");
  // One accent at four strengths, square-root scaled like the page; counts stay in the text.
  const maximum = Math.max(1, ...daily.map(day => day.count));
  const strength = [0, 0.3, 0.52, 0.76, 1];
  const cells = daily.map((day, i) => {
    const level = day.count > 0 ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(day.count / maximum) * 4))) : 0;
    const x = 668 + Math.floor(i / 7) * 38, y = 176 + (i % 7) * 38;
    return `<rect x="${x}" y="${y}" width="31" height="31" rx="5" fill="${surface}"/>${level ? `<rect x="${x}" y="${y}" width="31" height="31" rx="5" fill="${accent}" fill-opacity="${strength[level]}"/>` : ""}`;
  }).join("");
  const streak = currentStreak(daily);
  const agents = stats.activeAgents, days = stats.activeDays;
  const summary = `across ${agents.toLocaleString("en-US")} ${agents === 1 ? "agent" : "agents"} · ${days.toLocaleString("en-US")} active ${days === 1 ? "day" : "days"}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escape(name)} agent activity">
<defs><radialGradient id="glow" cx="0.2" cy="0" r="0.8"><stop offset="0" stop-color="${accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="${ink}" fill-opacity="0.07"/></pattern></defs>
<rect width="1200" height="630" fill="${paper}"/><rect width="1200" height="630" fill="url(#dots)"/><rect width="1200" height="630" fill="url(#glow)"/>
<g font-family="Inter, Arial, sans-serif" fill="${ink}">
<g transform="translate(78 74) scale(0.5)"><rect width="64" height="64" rx="15" fill="#171717"/><path d="M12 33h9l6-17 10 32 6-15h9" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></g><text x="124" y="103" font-size="26" font-weight="600">engram</text>
<text x="78" y="230" font-size="${fittedSize(shortName, 56)}" font-weight="600">${escape(shortName)}</text>
<text x="80" y="272" font-size="22" fill="${muted}">@${escape(profile.slug)}</text>
<text x="76" y="400" font-size="${fittedSize(actions, 96, 480)}" font-weight="600">${actions}</text>
<text x="80" y="440" font-size="22" fill="${muted}">agent actions</text>
<text x="80" y="472" font-size="22" fill="${muted}">${escape(summary)}</text>
${streak ? `<rect x="78" y="512" width="${Math.round(196 + String(streak).length * 13)}" height="44" rx="22" fill="${accent}" fill-opacity="0.12" stroke="${accent}" stroke-opacity="0.45"/><circle cx="104" cy="534" r="5" fill="${accent}"/><text x="120" y="542" font-size="20" font-weight="600" fill="${accent}">${streak}-day streak</text>` : ""}
<text x="668" y="150" font-size="18" fill="${muted}">The last 12 weeks</text></g>${cells}
</svg>`;
}

export async function renderShowcasePng(activity: PublicActivity): Promise<Buffer> {
  const image = await renderAsync(renderShowcaseCard(activity), {
    font: { loadSystemFonts: false, fontDirs: [resolve(import.meta.dir, "../../web/vendor")], defaultFontFamily: "Inter" },
  });
  return image.asPng();
}
