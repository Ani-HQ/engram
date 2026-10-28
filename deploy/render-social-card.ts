// Static brand exports use the same source palette as the interface.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { designColor as color } from "../gateway/src/design-tokens";

const root = resolve(import.meta.dir, "..");
const paper = color("paper"), ink = color("ink"), muted = color("muted");
const mark = readFileSync(resolve(root, "web/brand/engram-mark.svg"), "utf8")
  .replace('width="64" height="64"', 'x="80" y="72" width="40" height="40"');
// Plain and quiet, like the site: one sans typeface, normal letter-spacing,
// one text color for the headline, no diagram, rules or monospace labels.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<title>Engram — Your agents. Same drive.</title>
<rect width="1200" height="630" fill="${paper}"/>
${mark}
<g font-family="Inter,Arial,sans-serif">
<text x="134" y="102" fill="${ink}" font-size="32" font-weight="600">engram</text>
<text x="80" y="300" fill="${ink}" font-size="80" font-weight="600">Your agents.</text>
<text x="80" y="396" fill="${ink}" font-size="80" font-weight="600">Same drive.</text>
<text x="80" y="470" fill="${muted}" font-size="28">Carry context between agents. Share selected memories with your team.</text>
<text x="80" y="558" fill="${muted}" font-size="22">engram.ani.computer</text>
</g>
</svg>`;
writeFileSync(resolve(root, "web/brand/engram-social.svg"), svg + "\n");
writeFileSync(resolve(root, "web/brand/engram-social.png"), new Resvg(svg, { font: { loadSystemFonts: false, fontDirs: [resolve(root, "web/vendor")], defaultFontFamily: "Inter" } }).render().asPng());
console.log("Generated 1200×630 social SVG and PNG from shared design tokens.");
