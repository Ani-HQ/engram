import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { renderAsync } from "@resvg/resvg-js";
import { ShowcaseError, validShowcaseSlug } from "./showcase-view";

export const PROFILE_PHOTO_SIZE = 256;
export const PROFILE_PHOTO_MAX_BYTES = 512 * 1024;
export const PROFILE_PHOTO_DATA_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(kind: string, content: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind, "ascii"), content]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(content.length, 0); body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), chunk.length - 4);
  return chunk;
}

/** A browser-prepared square PNG only. No SVG, remote URL, or unbounded decode. */
export async function normalizeProfilePhoto(value: string): Promise<{ bytes: Buffer; digest: string; dataUrl: string }> {
  try {
    if (!value.startsWith(PROFILE_PHOTO_DATA_PREFIX)) throw new Error("format");
    const encoded = value.slice(PROFILE_PHOTO_DATA_PREFIX.length);
    if (encoded.length > Math.ceil(PROFILE_PHOTO_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("encoding");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > PROFILE_PHOTO_MAX_BYTES || bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("base64") !== encoded) throw new Error("size");
    const compressed: Buffer[] = [];
    let headerChunk: Buffer | undefined, transparency: Buffer | undefined;
    let offset = 8, header = false, palette = false, ended = false, dataEnded = false, channels = 4;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length || ended) throw new Error("truncated");
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) throw new Error("chunk");
      const kind = bytes.toString("latin1", offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(kind) || kind[2] !== kind[2].toUpperCase() || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error("checksum");
      const content = bytes.subarray(offset + 8, end - 4);
      if (!header && kind !== "IHDR") throw new Error("header");
      if (kind === "IHDR") {
        if (header || length !== 13 || content.readUInt32BE(0) !== PROFILE_PHOTO_SIZE || content.readUInt32BE(4) !== PROFILE_PHOTO_SIZE || content[8] !== 8 || ![2, 6].includes(content[9]) || content[10] || content[11] || content[12]) throw new Error("dimensions");
        header = true; channels = content[9] === 2 ? 3 : 4; headerChunk = bytes.subarray(offset, end);
      } else if (kind === "IDAT") {
        if (dataEnded) throw new Error("data order");
        compressed.push(content);
      } else if (kind === "IEND") {
        if (length || !compressed.length) throw new Error("end");
        ended = true;
      } else {
        if (compressed.length) dataEnded = true;
        // Optional suggested RGB palettes do not affect true-colour pixels.
        // Remove all metadata before handing pixels to the native decoder.
        if (kind[0] === kind[0].toUpperCase() && kind !== "PLTE") throw new Error("critical chunk");
        if (kind === "PLTE") {
          if (palette || transparency || !length || length > 768 || length % 3 || compressed.length) throw new Error("palette");
          palette = true;
        }
        if (kind === "tRNS") {
          if (transparency || channels !== 3 || length !== 6 || compressed.length || [0, 2, 4].some(at => content.readUInt16BE(at) > 255)) throw new Error("transparency");
          transparency = bytes.subarray(offset, end);
        }
      }
      offset = end;
    }
    if (!ended) throw new Error("incomplete");
    const stride = PROFILE_PHOTO_SIZE * channels + 1;
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: PROFILE_PHOTO_SIZE * stride });
    if (raw.length !== PROFILE_PHOTO_SIZE * stride) throw new Error("pixel size");
    for (let row = 0; row < PROFILE_PHOTO_SIZE; row++) if (raw[row * stride] > 4) throw new Error("filter");
    // Feed a canonical, complete PNG to the native decoder. Original chunk
    // metadata, palette hints, compression framing, and duplicate ancillary
    // chunks cannot turn a valid pixel buffer into a silently blank rendering.
    const png = Buffer.concat([PNG_SIGNATURE, headerChunk!, ...(transparency ? [transparency] : []), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
    const rendered = await renderAsync(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><image href="data:image/png;base64,${png}" width="256" height="256"/></svg>`, { font: { loadSystemFonts: false }, logLevel: "off" });
    const normalized = rendered.asPng();
    if (normalized.length > PROFILE_PHOTO_MAX_BYTES) throw new Error("output size");
    return { bytes: normalized, digest: createHash("sha256").update(normalized).digest("hex"), dataUrl: PROFILE_PHOTO_DATA_PREFIX + normalized.toString("base64") };
  } catch {
    throw new ShowcaseError("Choose a valid 256 × 256 PNG profile photo, up to 512 KB");
  }
}

export function showcasePhotoUrl(slug: string, digest: unknown): string | null {
  return validShowcaseSlug(slug) && typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
    ? `/api/public/activity/${slug}/photo.png?v=${digest}` : null;
}
