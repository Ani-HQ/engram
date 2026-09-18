import { describe, expect, test } from "bun:test";
import { agentKind, agentMarkSvg } from "./agents.js";

describe("agent marks", () => {
  test("matches the token names agents actually authenticate with", () => {
    // Real names from this brain: the match has to be loose enough that a token
    // called mac-claude and one called fleet-claude both resolve to the same mark.
    expect(agentKind("mac-claude")).toBe("claude");
    expect(agentKind("claude-code")).toBe("claude");
    expect(agentKind("codex")).toBe("codex");
    expect(agentKind("zara-openclaw")).toBe("openclaw");
    expect(agentKind("hermes-baymax")).toBe("hermes");
    expect(agentKind("carolyn")).toBe("hermes");
    expect(agentKind("grok-bot")).toBe("grok");
    expect(agentKind("dum-e")).toBe("grok");
  });

  test("an unknown agent gets a neutral mark rather than a guessed identity", () => {
    expect(agentKind("some-new-agent")).toBe("unknown");
    expect(agentKind("")).toBe("unknown");
    expect(agentKind(null)).toBe("unknown");
    expect(agentMarkSvg(null)).toContain("<svg");
  });

  test("every mark is self-contained svg with no remote reference", () => {
    // The console is served under a strict CSP that forbids fetching anything, so a
    // mark that pulled in an external asset would simply not render.
    for (const name of ["mac-claude", "codex", "zara-openclaw", "carolyn", "grok-bot", "nobody"]) {
      const svg = agentMarkSvg(name, 16);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("currentColor");
      expect(svg).not.toContain("href");
      // The only absolute URL allowed is the SVG namespace, which is an identifier
      // rather than something the browser fetches.
      expect(svg.match(/https?:\/\/[^"'\s>]+/g) ?? []).toEqual(["http://www.w3.org/2000/svg"]);
    }
  });

  test("escapes a name before putting it in the label", () => {
    expect(agentMarkSvg('a"><script>')).not.toContain("<script>");
  });
});
