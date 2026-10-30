import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderAsync } from "@resvg/resvg-js";
import { publicActivityEvents, PRODUCTS, type PublicActivityEvent } from "./public-activity";
import { designColor } from "./design-tokens";
import { brandCatalog } from "../../web/brand-catalog.js";
import { sourceBrands } from "../../web/tooling.js";

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

// Share card fonts are static Inter cuts: resvg ignores the weight axis of InterVariable.
const CARD_FONTS = resolve(import.meta.dir, "../assets/card-fonts");
const CARD_FONT = "Inter Variable Display, Inter, Arial, sans-serif";
const brandFiles = new Map<string, string | null>();
function brandMark(product: string): { uri: string; mono: boolean } | null {
  const brand = Object.hasOwn(sourceBrands, product) ? sourceBrands[product as keyof typeof sourceBrands] : null;
  const entry = brand && Object.hasOwn(brandCatalog, brand) ? (brandCatalog as Record<string, { file: string; tone: string }>)[brand] : null;
  if (!entry || !/^[a-z0-9-]+\.svg$/.test(entry.file)) return null;
  if (!brandFiles.has(entry.file)) {
    try { brandFiles.set(entry.file, `data:image/svg+xml;base64,${readFileSync(resolve(import.meta.dir, "../../web/vendor/brands", entry.file)).toString("base64")}`); }
    catch { brandFiles.set(entry.file, null); }
  }
  const uri = brandFiles.get(entry.file);
  return uri ? { uri, mono: entry.tone === "mono" } : null;
}
// Rough Inter advance widths in em, enough to fit and wrap short profile text.
function textUnits(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + (/[^\u0000-ÿ]/.test(char) ? 1.1 : /[MW@%]/.test(char) ? 0.86 : /[il.,'!|:]/.test(char) ? 0.26 : char === " " ? 0.25 : /[A-Z0-9]/.test(char) ? 0.64 : /[mw]/.test(char) ? 0.78 : 0.5), 0);
}
function clip(text: string, units: number): string {
  if (textUnits(text) <= units) return text;
  const chars = Array.from(text);
  while (chars.length && textUnits(chars.join("") + "…") > units) chars.pop();
  return chars.join("").trimEnd() + "…";
}
function wrapLines(text: string, units: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean), out: string[] = [];
  let line = "";
  for (const [index, word] of words.entries()) {
    const next = line ? `${line} ${word}` : word;
    if (textUnits(next) <= units || !line) { line = next; continue; }
    if (out.length === lines - 1) { out.push(clip(`${line} ${words.slice(index).join(" ")}`, units)); return out; }
    out.push(line); line = word;
  }
  if (line) out.push(out.length === lines - 1 ? clip(line, units) : line);
  return out.slice(0, lines);
}
const ICONS = {
  flame: `<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>`,
  bot: `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
  trophy: `<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>`,
};

// Names every product that fits, then counts the rest, so the label never ends mid-name.
function crewLabel(labels: string[], rest: number, units: number): string {
  for (let shown = labels.length; shown > 0; shown--) {
    const hidden = labels.length - shown;
    const text = labels.slice(0, shown).join(", ") + (hidden ? ` and ${hidden} more` : "");
    if (textUnits(text) <= units) return text;
  }
  return labels.length ? "" : `${rest} connected ${rest === 1 ? "agent" : "agents"}`;
}

export function renderShowcaseCard(activity: PublicActivity, options: { origin?: string; photo?: Uint8Array | null } = {}): string {
  const { profile, stats, daily } = activity;
  const escape = escapeShowcaseHtml;
  const n = (value: number) => value.toLocaleString("en-US");
  const paper = designColor("paper"), ink = designColor("ink"), raised = designColor("surface-raised"), muted = designColor("muted"), accent = designColor("accent"), hairline = designColor("hairline"), line = designColor("line");
  const name = profile.displayName || profile.slug;
  const photo = options.photo?.length ? `data:image/png;base64,${Buffer.from(options.photo).toString("base64")}` : null;
  const nameX = photo ? 64 + 76 + 22 : 64;
  const nameWidth = 548 - nameX + 64;
  let nameLines = [name], nameSize = Math.min(60, nameWidth / Math.max(1, textUnits(name)));
  if (nameSize < 40) { nameLines = wrapLines(name, nameWidth / 44, 2); nameSize = Math.min(44, nameWidth / Math.max(1, ...nameLines.map(textUnits))); }
  const bio = wrapLines(profile.bio || "", 560 / 21, 2);
  let host = "";
  try { host = options.origin ? new URL(options.origin).host : ""; } catch { /* Leave the address out. */ }
  const address = clip(`${host}/u/${profile.slug}`, 420 / 18);

  // Headline stats mirror the page's .ds-stat row: accent tick on a hairline.
  const statRow = [[stats.totalActions, stats.totalActions === 1 ? "Action" : "Actions"], [stats.activeAgents, stats.activeAgents === 1 ? "Agent" : "Agents"], [stats.activeDays, stats.activeDays === 1 ? "Active day" : "Active days"]] as const;
  const statValues = statRow.map(([value]) => n(value));
  const statSize = Math.min(48, 158 / Math.max(...statValues.map(textUnits)));
  const statsSvg = statRow.map(([, label], index) => {
    const x = 64 + index * 184;
    return `<rect x="${x}" y="376" width="160" height="1" fill="${line}"/><rect x="${x}" y="375" width="40" height="2" fill="${accent}"/>
<text x="${x}" y="${376 + 24 + statSize * 0.78}" font-size="${statSize.toFixed(1)}" font-weight="600" letter-spacing="-1">${statValues[index]}</text>
<text x="${x}" y="${376 + 24 + statSize * 0.78 + 30}" font-size="18" fill="${muted}">${label}</text>`;
  }).join("");

  // Product marks only; agents without a known product become a "+N" tile.
  const known = activity.agents.filter(item => item.product !== "other");
  const marks = known.map(item => ({ item, mark: brandMark(item.product) })).filter(entry => entry.mark).slice(0, 5);
  const rest = activity.agents.reduce((sum, item) => sum + item.agents, 0) - marks.reduce((sum, entry) => sum + entry.item.agents, 0);
  const tiles = [...marks.map(({ mark }) => `<image href="${mark!.uri}" width="26" height="26"${mark!.mono ? ` filter="url(#invert)"` : ""}/>`), ...(rest > 0 && !marks.length ? [`<g transform="translate(1 1)" fill="none" stroke="${muted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.bot}</g>`] : rest > 0 ? [`<text x="13" y="18" font-size="${rest > 99 ? 13 : 16}" font-weight="600" fill="${muted}" text-anchor="middle">+${n(rest)}</text>`] : [])];
  const crewY = 520;
  const crewSvg = tiles.length ? tiles.map((content, index) => `<g transform="translate(${64 + index * 54} ${crewY})"><rect width="46" height="46" rx="12" fill="${raised}" stroke="${line}"/><g transform="translate(10 10)">${content}</g></g>`).join("")
    + `<text x="${64 + tiles.length * 54 + 8}" y="${crewY + 29}" font-size="18" fill="${muted}">${escape(crewLabel(marks.map(entry => entry.item.label), rest, (572 - tiles.length * 54 - 8) / 18))}</text>` : "";

  // Shipping rhythm card: two facts, then the same four-strength chart as the page.
  const maximum = Math.max(1, ...daily.map(day => day.count));
  const strength = [0, 0.3, 0.52, 0.76, 1];
  const card = { x: 648, y: 120, w: 488, h: 446 }, pad = 26;
  const pitch = 37, cell = 31, gridX = card.x + pad + (card.w - pad * 2 - (12 * pitch - 6)) / 2, gridY = card.y + 172;
  const cells = daily.map((day, i) => {
    const level = day.count > 0 ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(day.count / maximum) * 4))) : 0;
    const x = gridX + Math.floor(i / 7) * pitch, y = gridY + (i % 7) * pitch;
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="6" fill="${paper}"/>${level ? `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="6" fill="${accent}" fill-opacity="${strength[level]}"/>` : ""}`;
  }).join("");
  const streak = currentStreak(daily);
  const best = daily.reduce<{ date: string; count: number } | null>((top, day) => day.count > 0 && (!top || day.count > top.count) ? day : top, null);
  const bestDate = best ? new Date(`${best.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const facts = [
    { icon: ICONS.flame, value: `${n(streak)} ${streak === 1 ? "day" : "days"}`, label: "Current streak" },
    { icon: ICONS.trophy, value: best ? `${n(best.count)} ${best.count === 1 ? "action" : "actions"}` : "None yet", label: best ? `Best day · ${bestDate}` : "Best day" },
  ];
  const factW = (card.w - pad * 2 - 12) / 2;
  const factsSvg = facts.map((fact, index) => {
    const x = card.x + pad + index * (factW + 12), y = card.y + 76;
    return `<rect x="${x}" y="${y}" width="${factW}" height="68" rx="10" fill="${paper}"/>
<rect x="${x + 14}" y="${y + 15}" width="38" height="38" rx="9" fill="none" stroke="${line}"/>
<g transform="translate(${x + 23} ${y + 24}) scale(0.8333)" fill="none" stroke="${index === 0 ? accent : muted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${fact.icon}</g>
<text x="${x + 66}" y="${y + 31}" font-size="19" font-weight="600">${escape(fact.value)}</text>
<text x="${x + 66}" y="${y + 52}" font-size="15" fill="${muted}">${escape(fact.label)}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escape(name)} agent activity">
<defs>
<radialGradient id="glow" cx="0.3" cy="0" r="0.75"><stop offset="0" stop-color="${accent}" stop-opacity="0.17"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
<radialGradient id="fade" cx="0.32" cy="0.38" r="0.62"><stop offset="0.25" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
<mask id="dotmask"><rect width="1200" height="630" fill="url(#fade)"/></mask>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="1.1" fill="${ink}" fill-opacity="0.09"/></pattern>
<filter id="invert" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0"/></filter>
<clipPath id="avatar"><circle cx="102" cy="198" r="38"/></clipPath>
</defs>
<rect width="1200" height="630" fill="${paper}"/><rect width="1200" height="630" fill="url(#dots)" mask="url(#dotmask)"/><rect width="1200" height="630" fill="url(#glow)"/>
<g font-family="${CARD_FONT}" fill="${ink}">
<g transform="translate(64 50)"><rect width="40" height="40" rx="10" fill="#171717" stroke="${line}"/><path d="M7.5 20.6h5.6l3.8-10.6 6.2 20 3.8-9.4h5.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="116" y="79" font-size="25" font-weight="600" letter-spacing="-0.3">engram</text>
${host ? `<text x="1136" y="77" font-size="18" fill="${muted}" text-anchor="end">${escape(address)}</text>` : ""}
${photo ? `<image href="${photo}" x="64" y="160" width="76" height="76" clip-path="url(#avatar)" preserveAspectRatio="xMidYMid slice"/><circle cx="102" cy="198" r="38" fill="none" stroke="${line}"/>` : ""}
${nameLines.map((text, index) => `<text x="${nameX}" y="${(photo ? 206 : 196) - (nameLines.length - 1 - index) * nameSize * 1.1}" font-size="${nameSize.toFixed(1)}" font-weight="600" letter-spacing="${(-nameSize / 50).toFixed(2)}">${escape(text)}</text>`).join("")}
<text x="${nameX}" y="${photo ? 238 : 234}" font-size="20" fill="${muted}">@${escape(profile.slug)}</text>
${bio.map((text, index) => `<text x="64" y="${(photo ? 290 : 282) + index * 30}" font-size="21" fill="${muted}">${escape(text)}</text>`).join("")}
${statsSvg}
${crewSvg}
<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="16" fill="${raised}" stroke="${hairline}"/>
<text x="${card.x + pad}" y="${card.y + 46}" font-size="20" font-weight="600">Shipping rhythm</text>
<text x="${card.x + card.w - pad}" y="${card.y + 46}" font-size="16" fill="${muted}" text-anchor="end">Last 12 weeks</text>
${factsSvg}
</g>${cells}
</svg>`;
}

export async function renderShowcasePng(activity: PublicActivity, options: { origin?: string; photo?: Uint8Array | null } = {}): Promise<Buffer> {
  const image = await renderAsync(renderShowcaseCard(activity, options), {
    font: { loadSystemFonts: false, fontDirs: [CARD_FONTS], defaultFontFamily: "Inter Variable Display" },
  });
  return image.asPng();
}
