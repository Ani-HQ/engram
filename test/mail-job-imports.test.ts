import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The mail and billing jobs run without agent-engine (worker) settings. Loading
// worker-command.ts there throws at startup ("Hosted workspaces require isolated
// workers") and stops every email. Mocked job tests can't see that, so walk the
// real static import graph instead.
const root = fileURLToPath(new URL("..", import.meta.url));
function reachable(entry: string): Set<string> {
  const seen = new Set<string>(), queue = [resolve(root, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']|(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g)) {
      const spec = m[1] ?? m[2]!;
      const base = resolve(dirname(file), spec);
      const target = [base, `${base}.ts`, `${base}.js`, resolve(base, "index.ts")].find(path => existsSync(path) && !path.endsWith("/"));
      if (target) queue.push(target);
    }
  }
  return seen;
}

for (const job of ["gateway/src/jobs/mail.ts", "gateway/src/jobs/billing.ts"]) {
  test(`${job} never loads the agent engine`, () => {
    const files = [...reachable(job)].map(file => file.slice(root.length));
    expect(files).toContain(job);
    expect(files.filter(file => /worker-command\.ts$|\/brain\.ts$/.test(file))).toEqual([]);
  });
}
