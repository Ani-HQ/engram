import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

// External ordinary hyperlinks are allowed. Network-loaded code, styles,
// fonts/media, preconnect hints and direct external JS transports are not.
export function remoteRuntimeReferences(source: string, extension: string): string[] {
  const reasons: string[] = [];
  const remote = /^(?:https?:)?\/\//i;
  if (extension === ".html") {
    for (const [tag] of source.matchAll(/<(?:script|link|img|iframe|video|audio|source|embed|object)\b[^>]*>/gi)) {
      const name = tag.match(/^<([a-z]+)/i)?.[1].toLowerCase();
      const attr = (key: string) => {
        const match = tag.match(new RegExp(`\\b${key}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, "i"));
        return (match?.[1] ?? match?.[2] ?? "").trim();
      };
      const rel = attr("rel").toLowerCase().split(/\s+/);
      const runtimeLink = name !== "link" || rel.some(value => ["stylesheet", "preload", "modulepreload", "icon", "preconnect", "dns-prefetch", "manifest"].includes(value));
      if (runtimeLink && [attr("src"), attr("href"), attr("data"), ...attr("srcset").split(",").map(value => value.trim())].some(value => remote.test(value))) reasons.push("remote HTML runtime asset");
    }
  }
  if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(source) || /@import\s*["']\s*(?:https?:)?\/\//i.test(source)) reasons.push("remote CSS asset");
  if (extension === ".js" || extension === ".mjs") {
    if (/\b(?:fetch|import|importScripts|Worker|SharedWorker|WebSocket|EventSource)\s*\(\s*["'`](?:https?:|wss?:)?\/\//i.test(source) || /\b(?:import|export)[^;\n]*\bfrom\s*["'](?:https?:)?\/\//i.test(source) || /\bimport\s*["'](?:https?:)?\/\//i.test(source) || /\.src\s*=\s*["'`](?:https?:)?\/\//i.test(source)) reasons.push("remote JavaScript runtime dependency");
  }
  return [...new Set(reasons)];
}

if (import.meta.main) {
  let checked = 0;
  const failures: string[] = [];
  function inspect(path: string) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, item.name);
      if (item.isDirectory()) { inspect(target); continue; }
      const extension = extname(item.name);
      if (![".html", ".css", ".js", ".mjs"].includes(extension) || item.name.endsWith(".test.js")) continue;
      checked++;
      for (const reason of remoteRuntimeReferences(readFileSync(target, "utf8"), extension)) failures.push(`${target}: ${reason}`);
    }
  }
  inspect("web");
  if (failures.length) { process.stderr.write(failures.join("\n") + "\n"); process.exitCode = 1; }
  else process.stdout.write(`Runtime asset privacy gate passed (${checked} files).\n`);
}
