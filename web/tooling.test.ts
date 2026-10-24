import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentSources, agentVisual, brandIcon, toolCatalog, toolVisual, visualIcon } from "./tooling.js";

class TestElement {
  attributes: Record<string, string> = {};
  children: TestElement[] = [];
  src = ""; alt = ""; className = ""; width = 0; height = 0; draggable = true;
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  getAttribute(name: string) { return this.attributes[name]; }
  append(...nodes: TestElement[]) { this.children.push(...nodes); }
  set innerHTML(_value: string) { throw new Error("Logo rendering must use DOM nodes, not HTML"); }
}
function withDocument(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (name: string) => new TestElement(name),
    createElementNS: (_namespace: string, name: string) => new TestElement(name),
  } });
  try { run(); } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete (globalThis as any).document;
  }
}

describe("local tooling identity", () => {
  test("recognizes explicit tool providers and normalized MCP namespaces", () => {
    expect(toolVisual("github.create_pull_request")).toEqual({ label: "GitHub", icon: "code", brand: "github" });
    expect(toolVisual("mcp__github__get_issue").brand).toBe("github");
    expect(toolVisual("mcp__github__get__issue").brand).toBe("github");
    expect(toolVisual("git.commit").brand).toBe("git");
    expect(toolVisual("figma.get_design").brand).toBe("figma");
    expect(toolVisual("docker.build").brand).toBe("docker");
    expect(toolVisual("slack.post")).toEqual({ label: "Slack", icon: "hash", brand: "slack" });
    for (const [namespace, brand] of [
      ["slack", "slack"], ["notion", "notion"], ["linear", "linear"], ["figma", "figma"],
      ["gdrive", "googledrive"], ["google_drive", "googledrive"], ["google-calendar", "googlecalendar"],
      ["gmail", "gmail"], ["gdocs", "googledocs"], ["google_sheets", "googlesheets"],
      ["playwright", "playwright"], ["puppeteer", "puppeteer"], ["chrome", "googlechrome"],
      ["outlook", "microsoftoutlook"], ["dropbox", "dropbox"], ["supabase", "supabase"],
    ]) expect(toolVisual(`mcp__${namespace}__read`).brand).toBe(brand);
  });

  test("generic tools do not imply an unreported product", () => {
    expect(toolVisual("calendar.create")).toMatchObject({ label: "Calendar", brand: null });
    expect(toolVisual("gcal.create").brand).toBe("googlecalendar");
    expect(toolVisual("mail.send")).toMatchObject({ label: "Email", brand: null });
    expect(toolVisual("gmail.send").brand).toBe("gmail");
    expect(toolVisual("browser.navigate")).toMatchObject({ label: "Browser", icon: "globe", brand: null });
    expect(toolVisual("drive.read")).toMatchObject({ label: "Files", brand: null });
    expect(toolVisual("database.query")).toMatchObject({ label: "Database", brand: null });
  });

  test("uses namespace boundaries instead of incidental substrings or resource URLs", () => {
    for (const name of [
      "mygithubtracker.run", "githubish.run", "calendarize.run", "shellfish.read", "figmatic.write",
      "slackware.post", "notional.read", "linearity.run", "my.tools.github", "tools.slack.post",
      "mcp__github-personal__get_issue", "mcp__github_lookalike__read", "mcp__evil__github_get_issue",
      "mcp__tools__slack_post", "https://github.com/example/project", "https://notion.so/page",
    ]) {
      expect(toolVisual(name).brand).toBeNull();
      expect(toolVisual(name).icon).toBe("plug");
    }
    expect(toolVisual("web.search").icon).toBe("globe");
    expect(toolVisual("search").icon).toBe("brain");
    expect(toolVisual("exec_command").icon).toBe("terminal");
    expect(toolVisual("read_file").icon).toBe("file-text");
    expect(toolVisual("postgres.query")).toMatchObject({ icon: "database", brand: "postgresql" });
  });

  test("rejects malformed MCP identifiers and markup without deriving a brand", () => {
    for (const name of [
      "mcp__github", "mcp__github__", "mcp____github__read", "mcp__github__<img src=x>",
      "mcp__github__read\u0000", "mcp__github__read?source=slack", "mcp__github%2fslack__read",
      "mcp__gіthub__read", "github.<svg onload=alert(1)>", "github." + "x".repeat(300),
    ]) expect(toolVisual(name)).toMatchObject({ icon: "plug", brand: null });
    expect(toolVisual({ tool: "github.read" })).toEqual({ label: "Tool", icon: "plug", brand: null });
  });

  test("catalog aliases are deterministic, local and immutable", () => {
    expect(Object.isFrozen(toolCatalog)).toBe(true);
    const aliases = new Set<string>();
    for (const entry of toolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.namespaces)).toBe(true);
      for (const namespace of entry.namespaces) {
        expect(namespace).toMatch(/^[a-z0-9_-]+$/);
        expect(aliases.has(namespace)).toBe(false); aliases.add(namespace);
        expect(toolVisual(`mcp__${namespace}__read`)).toEqual({ label: entry.label, icon: entry.icon, brand: entry.brand });
      }
    }
  });

  test("recognizes named agent products without verifying arbitrary names", () => {
    expect(agentVisual("claude-code-work")).toMatchObject({ label: "Claude Code", brand: "claude" });
    expect(agentVisual("cursor")).toMatchObject({ label: "Cursor", brand: "cursor" });
    expect(agentVisual("oauth:subject:https%3A%2F%2Fclaude.ai%2Fclient.json").brand).toBe("claude");
    expect(agentVisual("codex")).toMatchObject({ label: "Codex", brand: "codex", initials: "CX" });
    expect(agentVisual("grokbot")).toMatchObject({ label: "Grok Bot", brand: "grok-bot" });
    expect(agentVisual("openclaw-work")).toMatchObject({ label: "OpenClaw", brand: "openclaw" });
    expect(agentVisual("Hermes Agent")).toMatchObject({ label: "Hermes Agent", brand: "hermesagent" });
    for (const name of ["grokbotter", "Claudette", "cursorial-agent", "openclawish", "Hermes delivery"]) expect(agentVisual(name).brand).toBeNull();
    expect(agentVisual("Ada Lovelace")).toMatchObject({ label: "Ada Lovelace", initials: "AL", brand: null });
    expect(agentVisual("🤖").initials).toBe("🤖");
  });

  test("explicit sources brand custom names without changing their identity", () => {
    expect(agentVisual("Research assistant", { harness: "grok-bot" })).toMatchObject({ label: "Grok Bot", brand: "grok-bot", initials: "RA" });
    expect(agentVisual("Research assistant", { harness: "claude-code" })).toMatchObject({ label: "Claude Code", brand: "claude" });
    expect(agentVisual("Wednesday", { harness: "openclaw" })).toMatchObject({ label: "OpenClaw", brand: "openclaw", initials: "WE" });
    for (const harness of ["hermes", "hermes-agent"]) expect(agentVisual("Milo", { harness })).toMatchObject({ label: "Hermes Agent", brand: "hermesagent", initials: "MI" });
    expect(agentVisual("Wednesday", { harness: "openclaw", sourceLabel: "Home runner" })).toMatchObject({ label: "Home runner", brand: "openclaw", initials: "WE" });
    expect(agentVisual("codex", { harness: "other", sourceLabel: "My runner" })).toMatchObject({ label: "My runner", brand: null });
    for (const harness of ["not-a-known-provider", "__proto__", "constructor"]) expect(agentVisual("codex", { harness })).toMatchObject({ label: "Custom agent", brand: null });
    expect(agentSources.some(([id]) => id === "openclaw")).toBe(true);
    expect(agentSources.some(([id]) => id === "hermes")).toBe(true);
  });

  test("empty identifiers have useful generic fallbacks", () => {
    expect(toolVisual(null)).toEqual({ label: "Tool", icon: "plug", brand: null });
    expect(agentVisual(null)).toMatchObject({ label: "Agent", icon: "bot", brand: null });
    expect(agentVisual("oauth:subject:%malformed").brand).toBeNull();
  });

  test("brand rendering uses fixed local paths and DOM-safe labels", () => withDocument(() => {
    const malicious = '\"><img src=x onerror=alert(1)>';
    const known = brandIcon("slack", { size: 13, label: malicious, class: "tool-mark" }) as unknown as TestElement;
    expect(known.tagName).toBe("img"); expect(known.src).toBe("/vendor/brands/slack.svg");
    expect(known.alt).toBe(malicious); expect(known.width).toBe(13); expect(known.height).toBe(13);
    expect(known.getAttribute("onerror")).toBeUndefined(); expect(known.children).toHaveLength(0);
    const inline = brandIcon("github", { label: malicious }) as unknown as TestElement;
    expect(inline.tagName).toBe("svg"); expect(inline.getAttribute("aria-label")).toBe(malicious);
    expect(inline.children).toHaveLength(1); expect(inline.children[0].tagName).toBe("path");
    for (const brand of ["__proto__", "constructor", "../../secret", "https://example.test/logo.svg", "javascript:alert(1)", malicious]) {
      const unknown = brandIcon(brand) as unknown as TestElement;
      expect(unknown.tagName).toBe("svg"); expect(unknown.src).toBe(""); expect(unknown.getAttribute("data-icon")).toBe("plug");
    }
    expect((visualIcon({ icon: "brain", brand: null }) as unknown as TestElement).getAttribute("data-icon")).toBe("brain");
    for (const entry of toolCatalog.filter(entry => entry.brand)) {
      const mark = visualIcon(entry) as unknown as TestElement;
      if (mark.tagName === "img") {
        expect(mark.src).toMatch(/^\/vendor\/brands\/[a-z0-9-]+\.svg$/);
        expect(readFileSync(new URL(`.${mark.src}`, import.meta.url), "utf8")).toContain("<svg");
      }
    }
  }));

  test("vendored additions match their provenance and contain only monochrome local SVG", () => {
    const sources = JSON.parse(readFileSync(new URL("./vendor/brands/catalog-sources.json", import.meta.url), "utf8"));
    expect(sources.assets).toHaveLength(18);
    for (const asset of sources.assets) {
      const svg = readFileSync(new URL(`./vendor/brands/${asset.file}`, import.meta.url), "utf8");
      expect(createHash("sha256").update(svg).digest("hex")).toBe(asset.sha256);
      expect(asset.gitHead).toMatch(/^[a-f0-9]{40}$/); expect(asset.integrity).toStartWith("sha512-");
      expect(svg).toContain('fill="currentColor"');
      expect(svg).not.toMatch(/<(?:script|foreignObject|image)\b|\bon[a-z]+\s*=|\bhref\s*=/i);
      for (const reference of svg.matchAll(/url\(([^)]+)\)/g)) expect(reference[1]).toMatch(/^#[a-z0-9_-]+$/i);
      for (const fill of svg.matchAll(/\bfill="([^"]+)"/g)) expect(["currentColor", "none"]).toContain(fill[1]);
    }
  });
});
