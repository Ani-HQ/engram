// Static brand exports use the same source palette as the interface.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const css = readFileSync(resolve(root, "web/design-system.css"), "utf8");
function color(name: string) {
  const value = css.match(new RegExp(`--ds-${name}:\\s*(#[a-f0-9]{6})\\s*;`, "i"))?.[1];
  if (!value) throw new Error(`Missing design token ${name}`);
  return value;
}
const paper = color("paper"), ink = color("ink"), lime = color("lime"), lilac = color("lilac"), apricot = color("apricot");
const mark = readFileSync(resolve(root, "web/brand/engram-mark.svg"), "utf8")
  .replace('width="64" height="64"', 'x="60" y="53" width="43" height="43"');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<title>Engram — Your agents. Same drive.</title>
<defs><pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${ink}" opacity=".13"/></pattern></defs>
<rect width="1200" height="630" fill="${paper}"/><rect x="700" width="500" height="630" fill="url(#dots)"/>
${mark}
<text x="117" y="84" fill="${ink}" font-family="Arial,sans-serif" font-size="34" font-weight="700" letter-spacing="-1.6">engram</text>
<text x="62" y="205" fill="${ink}" font-family="Arial,sans-serif" font-size="69" font-weight="700" letter-spacing="-3">Your agents.</text>
<text x="60" y="300" fill="${ink}" font-family="Georgia,serif" font-style="italic" font-size="86" letter-spacing="-4">Same drive.</text>
<text x="64" y="365" fill="${ink}" font-family="Arial,sans-serif" font-size="22">Shared context for every agent. Your team, when you choose.</text>
<rect x="63" y="450" width="254" height="48" rx="24" fill="${lime}" stroke="${ink}"/><text x="190" y="480" text-anchor="middle" fill="${ink}" font-family="monospace" font-size="14">SHARED MEMORY FOR AGENTS</text>
<g transform="translate(915 297)"><ellipse rx="208" ry="102" transform="rotate(-25)" fill="none" stroke="${ink}" stroke-width="1.5"/><ellipse rx="146" ry="181" transform="rotate(25)" fill="none" stroke="${ink}" stroke-dasharray="4 8"/><circle r="96" fill="${lilac}" stroke="${ink}" stroke-width="2"/><path d="M-48 4h20l14-34L3 36 19-8h27" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="-160" cy="100" r="24" fill="${lime}" stroke="${ink}" stroke-width="2"/><rect x="91" y="-130" width="103" height="54" rx="12" fill="${apricot}" stroke="${ink}" stroke-width="2"/><text x="143" y="-97" text-anchor="middle" fill="${ink}" font-family="monospace" font-size="14">remember</text><circle cx="-123" cy="-110" r="9" fill="${ink}"/><path d="M160 123v24m-12-12h24M-200-22v20m-10-10h20" stroke="${ink}" stroke-width="2"/></g>
<path d="M62 551h1076" stroke="${ink}" stroke-width="1"/><text x="64" y="585" fill="${ink}" font-family="monospace" font-size="15">MANY AGENTS. ONE THREAD.</text><text x="1137" y="585" text-anchor="end" fill="${ink}" font-family="monospace" font-size="15">engram.ani.computer</text>
</svg>`;
writeFileSync(resolve(root, "web/brand/engram-social.svg"), svg + "\n");
writeFileSync(resolve(root, "web/brand/engram-social.png"), new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
console.log("Generated 1200×630 social SVG and PNG from shared design tokens.");
