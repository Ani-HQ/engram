import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INDEXABLE_PAGE_PATHS, PUBLIC_PAGE_FILES } from "../gateway/src/site-routes";

const web = new URL("../web/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file.replace(/^\//, ""), web), "utf8");

test("public pages have distinct canonical metadata and local design-system assets", () => {
  const titles = new Set<string>();
  for (const path of INDEXABLE_PAGE_PATHS) {
    const html = read(PUBLIC_PAGE_FILES[path]);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    expect(title).toBeTruthy();
    expect(titles.has(title!)).toBe(false); titles.add(title!);
    expect((html.match(/<h1(?:\s|>)/g) ?? []).length).toBe(1);
    expect(html).toContain(`rel="canonical" href="https://engram.ani.computer${path}"`);
    expect(html).toContain('data-design-system="signal"');
    expect(html).toContain('href="/design-system.css"');
    expect(html).toContain('name="description"');
    expect(html).toContain('property="og:image"');
    expect(html).toContain('/brand/engram-social.png');
    expect(html).not.toMatch(/<meta name="robots" content="noindex/);
  }
});

test("sitemap contains only canonical public pages while private app stays noindex", () => {
  const locations = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  expect(locations).toEqual(INDEXABLE_PAGE_PATHS.map(path => `https://engram.ani.computer${path}`));
  expect(read("robots.txt")).toContain("Sitemap: https://engram.ani.computer/sitemap.xml");
  expect(read("index.html")).toContain('name="robots" content="noindex, noarchive"');
  expect(read("design-system.html")).toContain('name="robots" content="noindex');
});

test("every public invitation request names the supplied X destination", () => {
  for (const path of INDEXABLE_PAGE_PATHS) {
    const anchors = [...read(PUBLIC_PAGE_FILES[path]).matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    for (const [, href, label] of anchors) {
      if (/ask[^<]*for an invite|ask for an invite on X/i.test(label)) expect(href).toBe("https://x.com/anirudh_twt");
    }
  }
});

// The owner's plain-design rules (docs/DESIGN-SYSTEM.md "Do not use").
test("public pages use no tags, kickers, highlighted words, dividers, diagrams or section numbering", () => {
  const pages = [...new Set([...INDEXABLE_PAGE_PATHS.map(path => PUBLIC_PAGE_FILES[path]), "not-found.html", "changelog.html"])];
  for (const file of pages) {
    const html = read(file);
    expect(html).not.toMatch(/class="[^"]*\b(?:ds-badge|ds-sticker|ds-eyebrow|ds-editorial|m-editorial|ds-divider|ds-card|ds-panel|ds-context-flow|ds-logo-ticker|ds-product-logo-frame)(?![\w-])/);
    expect(html).not.toMatch(/<hr\b|<(?:em|i)>|data-marketing-stream|data-context-flow|data-logo-ticker|marketing\.js/);
    expect(html).not.toMatch(/>\s*0\d\s*(?:\/|—)/);
    expect(html).not.toMatch(/serif/i);
  }
});

test("shared and public stylesheets never tighten letter-spacing, italicize or load a serif", () => {
  for (const file of ["design-system.css", "marketing.css"]) {
    const css = read(file);
    expect(css).not.toMatch(/letter-spacing:\s*-/);
    expect(css).not.toMatch(/font-style:\s*italic/);
    expect(css).not.toMatch(/Instrument|font-family:[^;]*\bserif\b(?![-])/i);
  }
});

test("the homepage keeps every agent logo as a plain list item", () => {
  const html = read("home.html");
  const items = [...html.matchAll(/<li data-agent-product="([^"]+)"><img class="ds-product-logo"[^>]*alt=""[^>]*><span>([^<]+)<\/span><\/li>/g)];
  expect(items.length).toBe(21);
});
