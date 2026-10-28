#!/usr/bin/env bun
// Public changelog. Entries live in docs/changelog.json, one per commit on
// main, timestamped when the change landed. This script renders them into
// web/changelog.html so the page stays static and readable without JavaScript.
//
//   bun scripts/changelog.ts render    rewrite the generated part of the page
//   bun scripts/changelog.ts missing   list commits on main with no entry yet,
//                                      skipping commits that only update the changelog
import { readFileSync, writeFileSync } from "node:fs";

export const KINDS = {
  "new": { label: "New", tone: "accent" },
  "improved": { label: "Improved", tone: "lilac" },
  "fixed": { label: "Fixed", tone: "apricot" },
  "security": { label: "Security", tone: "info" },
  "under-the-hood": { label: "Under the hood", tone: "neutral" },
} as const;

export interface ChangelogEntry { sha: string; at: string; kind: keyof typeof KINDS; title: string; summary: string; pr?: number }
export interface Changelog { repository: string; entries: ChangelogEntry[] }

const root = new URL("../", import.meta.url);
const DATA = new URL("docs/changelog.json", root);
const PAGE = new URL("web/changelog.html", root);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
// Summaries may mark a package or command with backticks.
const inline = (text: string) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>");

export function readChangelog(): Changelog {
  return JSON.parse(readFileSync(DATA, "utf8"));
}

function entryHtml(entry: ChangelogEntry, repository: string): string {
  const at = new Date(entry.at);
  const date = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()].slice(0, 3)} ${at.getUTCFullYear()}`;
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
  const kind = KINDS[entry.kind];
  const refs = [
    entry.pr ? `<a href="${repository}/pull/${entry.pr}">PR #${entry.pr}</a>` : "",
    `<a href="${repository}/commit/${entry.sha}"><code>${entry.sha}</code></a>`,
  ].filter(Boolean).join("");
  return `<li class="ds-release-entry" id="change-${entry.sha}"><time class="ds-release-time" datetime="${entry.at}">${date}<span>${time}</span></time>`
    + `<div class="ds-release-content"><span class="ds-badge" data-tone="${kind.tone}">${kind.label}</span>`
    + `<h3 class="ds-release-title">${inline(entry.title)}</h3><p class="ds-release-summary">${inline(entry.summary)}</p>`
    + `<p class="ds-release-refs">${refs}</p></div></li>`;
}

/** The generated table of contents and month sections, newest first. */
export function renderChangelog(log: Changelog): { toc: string; body: string } {
  const entries = [...log.entries].sort((a, b) => b.at.localeCompare(a.at));
  const months = new Map<string, ChangelogEntry[]>();
  for (const entry of entries) {
    const key = entry.at.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), entry]);
  }
  const name = (key: string) => `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
  const toc = [...months.keys()].map(key => `<a href="#${key}">${name(key)}</a>`).join("");
  const body = [...months].map(([key, list]) =>
    `<section id="${key}" aria-labelledby="${key}-title"><h2 id="${key}-title">${name(key)}</h2><ol class="ds-release-log">\n`
    + list.map(entry => entryHtml(entry, log.repository)).join("\n")
    + `\n</ol></section>`).join("\n");
  return { toc, body };
}

export function applyToPage(page: string, rendered: { toc: string; body: string }): string {
  const swap = (text: string, name: string, value: string) => {
    const pattern = new RegExp(`(<!-- changelog:${name}:start -->)[\\s\\S]*?(<!-- changelog:${name}:end -->)`);
    if (!pattern.test(text)) throw new Error(`web/changelog.html is missing the changelog:${name} markers`);
    return text.replace(pattern, (_, start, end) => `${start}\n${value}\n${end}`);
  };
  return swap(swap(page, "toc", rendered.toc), "entries", rendered.body);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "render") {
    writeFileSync(PAGE, applyToPage(readFileSync(PAGE, "utf8"), renderChangelog(readChangelog())));
    console.log("web/changelog.html updated");
  } else if (command === "missing") {
    const known = new Set(readChangelog().entries.map(entry => entry.sha));
    const ref = process.argv[3] ?? "origin/main";
    const log = Bun.spawnSync(["git", "log", ref, "--first-parent", "--format=%h|%cI|%s", "--abbrev=7"], { cwd: root.pathname });
    // A commit that only updates the changelog itself needs no entry.
    const ownFiles = new Set(["docs/changelog.json", "web/changelog.html", "scripts/changelog.ts", "test/changelog.test.ts"]);
    const onlyChangelog = (sha: string) => {
      const files = Bun.spawnSync(["git", "show", "--name-only", "--format=", sha], { cwd: root.pathname }).stdout.toString().trim().split("\n").filter(Boolean);
      return files.length > 0 && files.every(file => ownFiles.has(file));
    };
    const missing = log.stdout.toString().trim().split("\n").filter(Boolean).filter(line => !known.has(line.split("|")[0]) && !onlyChangelog(line.split("|")[0]));
    for (const line of missing) {
      const [sha, at, subject] = line.split("|");
      console.log(`${sha}  ${new Date(at).toISOString().replace(".000", "")}  ${subject}`);
    }
    if (!missing.length) console.log("Every commit on main has a changelog entry.");
  } else {
    console.error("Usage: bun scripts/changelog.ts render|missing [ref]");
    process.exit(2);
  }
}
