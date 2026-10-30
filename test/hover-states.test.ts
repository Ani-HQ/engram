import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// Buttons, rows and tabs show hover with a tint, never an underline. Inline
// prose links keep their underline at rest; hover only firms its color.
const dir = new URL("../web/", import.meta.url);
const sheets = readdirSync(dir).filter(name => name.endsWith(".css"));

describe("interaction states", () => {
  test("no stylesheet adds an underline on hover", () => {
    const offenders: string[] = [];
    for (const name of sheets) {
      const css = readFileSync(new URL(name, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selector, body] of css.matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/g)) {
        if (/text-decoration(?:-line)?\s*:\s*[^;]*underline/.test(body)) offenders.push(`${name}: ${selector.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("generic button hover never switches to a bright ink border", () => {
    const css = readFileSync(new URL("design-system.css", dir), "utf8");
    expect(css).not.toMatch(/button[^{}]*:hover[^{}]*\{[^{}]*border-color:\s*var\(--ds-ink\)/);
    for (const token of ["--ds-hover-bg", "--ds-press-bg", "--ds-selected-bg", "--ds-hover-border"]) expect(css).toContain(`${token}:`);
  });
});
