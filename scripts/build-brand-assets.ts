// Keep every client-facing icon derived from the same small, local vector.
// Run `bun scripts/build-brand-assets.ts` after changing the mark.
import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const web = new URL("../web/", import.meta.url);
const source = await readFile(new URL("brand/engram-mark.svg", web), "utf8");
await mkdir(new URL("brand/", web), { recursive: true });

function png(size: number): Buffer {
  return Buffer.from(new Resvg(source, { font: { loadSystemFonts: false }, fitTo: { mode: "width", value: size } }).render().asPng());
}

// PNG is the interoperable MCP icon. SVG remains available to scalable clients.
for (const [path, size] of [["brand/engram-mark.png", 512], ["brand/engram-192.png", 192], ["apple-touch-icon.png", 180]] as const) {
  await writeFile(new URL(path, web), png(size));
}
await writeFile(new URL("favicon.svg", web), source);

// A normal multi-resolution ICO, with local PNG payloads and no extra dependency.
const sizes = [16, 32, 48];
const images = sizes.map(png);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
await writeFile(new URL("favicon.ico", web), Buffer.concat([header, ...images]));
console.log(`Generated Engram connector icons in ${fileURLToPath(web)}`);
