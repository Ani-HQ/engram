// Static brand exports use the same source palette as the interface.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { designColor as color } from "../gateway/src/design-tokens";

const root = resolve(import.meta.dir, "..");
const paper = color("paper"), ink = color("ink"), surface = color("surface"), line = color("line"), muted = color("muted"), accent = color("accent"), accentMuted = color("accent-muted");
const mark = readFileSync(resolve(root, "web/brand/engram-mark.svg"), "utf8")
  .replace('width="64" height="64"', 'x="64" y="48" width="36" height="36"');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<title>Engram — Your agents. Same drive.</title>
<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${line}" stroke-opacity=".45"/></pattern></defs>
<rect width="1200" height="630" fill="${paper}"/><rect x="660" y="113" width="540" height="440" fill="url(#grid)"/>
${mark}
<g font-family="Inter,Arial,sans-serif">
<text x="111" y="75" fill="${ink}" font-size="29" font-weight="600" letter-spacing="-1.2">engram</text>
<text x="64" y="186" fill="${muted}" font-family="monospace" font-size="13" letter-spacing="1.4">SHARED MEMORY FOR AI AGENTS</text>
<text x="60" y="278" fill="${ink}" font-size="72" font-weight="550" letter-spacing="-3.6">Your agents.</text>
<text x="60" y="362" fill="${accent}" font-size="72" font-weight="550" letter-spacing="-3.6">Same drive.</text>
<text x="64" y="417" fill="${muted}" font-size="20">Carry context between agents.</text>
<text x="64" y="449" fill="${muted}" font-size="20">Share selected memories with your team.</text>
<g fill="none" stroke="${line}" stroke-width="1.5"><path d="M839 208v65m-63 50H720v88h119m63-88h176v88H965"/><path d="M839 240h239v61"/></g>
<rect x="754" y="153" width="170" height="55" rx="6" fill="${surface}" stroke="${line}"/><text x="839" y="186" fill="${ink}" font-size="16" text-anchor="middle">Your agents</text>
<rect x="754" y="273" width="170" height="100" rx="8" fill="${accentMuted}" stroke="${accent}" stroke-opacity=".65"/><text x="839" y="316" fill="${accent}" font-size="18" text-anchor="middle" font-weight="550">Shared memory</text><text x="839" y="343" fill="${muted}" font-family="monospace" font-size="12" text-anchor="middle">remember / recall</text>
<rect x="994" y="301" width="142" height="44" rx="6" fill="${surface}" stroke="${line}"/><text x="1065" y="328" fill="${ink}" font-size="14" text-anchor="middle">Project context</text>
<rect x="776" y="411" width="126" height="44" rx="6" fill="${surface}" stroke="${line}"/><text x="839" y="438" fill="${ink}" font-size="14" text-anchor="middle">Decisions</text>
<circle cx="839" cy="240" r="3" fill="${accent}"/>
<path d="M64 547h1072" stroke="${line}"/><text x="64" y="585" fill="${muted}" font-family="monospace" font-size="13">MANY AGENTS. ONE THREAD.</text><text x="1136" y="585" text-anchor="end" fill="${muted}" font-family="monospace" font-size="13">engram.ani.computer</text>
</g>
</svg>`;
writeFileSync(resolve(root, "web/brand/engram-social.svg"), svg + "\n");
writeFileSync(resolve(root, "web/brand/engram-social.png"), new Resvg(svg, { font: { loadSystemFonts: false, fontDirs: [resolve(root, "web/vendor")], defaultFontFamily: "Inter" } }).render().asPng());
console.log("Generated 1200×630 social SVG and PNG from shared design tokens.");
