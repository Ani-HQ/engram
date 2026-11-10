import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// GitHub Actions may be unavailable; scripts/ci.sh must run every command the workflow runs.
test("bun run ci runs every command in the GitHub workflow", () => {
  const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  const script = readFileSync(new URL("../scripts/ci.sh", import.meta.url), "utf8");
  const commands: string[] = [];
  const lines = workflow.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-?\s*run:\s*(.*)$/);
    if (!m) continue;
    if (m[1].trim() === "|") {
      const indent = lines[i].search(/\S/);
      for (i++; i < lines.length && (lines[i].trim() === "" || lines[i].search(/\S/) > indent); i++) {
        if (lines[i].trim()) commands.push(lines[i].trim());
      }
      i--;
    } else commands.push(m[1].trim());
  }
  expect(commands.length).toBeGreaterThan(10);
  for (const command of commands) expect(script).toContain(command);
  expect(workflow).toContain("pgvector/pgvector:pg16");
  expect(script).toContain("pgvector/pgvector:pg16");
});
