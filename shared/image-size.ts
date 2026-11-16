/**
 * An image's size in pixels, read from the first bytes of the file,
 * so an embed's box can take its final shape before the
 * image itself arrives. PNG, GIF, WebP (VP8, VP8L, VP8X) and JPEG; a JPEG's
 * EXIF orientation 5-8 swaps width and height, as the image is drawn.
 *
 * shared/: the backend (/resolve-embed), the folder source and the app's
 * download check read sizes alike. Plain TypeScript, no imports (see
 * shared/fences.ts).
 */

/** The most of a file `imageSize` looks at; a JPEG whose frame header is further in gets null. */
export const IMAGE_HEADER_BYTES = 256 * 1024;

export interface ImageSize {
  width: number;
  height: number;
}

/** The size of the image `bytes` starts with, or null if it isn't one of the formats above or is cut off. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const b = bytes.length > IMAGE_HEADER_BYTES ? bytes.subarray(0, IMAGE_HEADER_BYTES) : bytes;
  const size = startsWith(b, 0, PNG) ? png(b) : startsWith(b, 0, "GIF8") ? gif(b) : riffWebp(b) ? webp(b) : jpeg(b);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

const PNG = "\x89PNG\r\n\x1a\n";

function startsWith(b: Uint8Array, at: number, s: string): boolean {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const be32 = (b: Uint8Array, i: number) => be16(b, i) * 0x10000 + be16(b, i + 2);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

// The IHDR chunk always comes first, right after the signature.
function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || !startsWith(b, 12, "IHDR")) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

// The logical screen size, for a still or an animated GIF.
function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !(startsWith(b, 0, "GIF87a") || startsWith(b, 0, "GIF89a"))) return null;
  return { width: le16(b, 6), height: le16(b, 8) };
}

function riffWebp(b: Uint8Array): boolean {
  return startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP");
}

// The first chunk: a lossy frame (VP8), a lossless one (VP8L), or the
// extended header with the canvas size (VP8X: animation, alpha, metadata).
function webp(b: Uint8Array): ImageSize | null {
  if (startsWith(b, 12, "VP8 ")) {
    // A 3-byte frame tag, then the key frame start code; 14-bit sizes, 2 bits of scale above them.
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (startsWith(b, 12, "VP8L")) {
    // The signature byte 0x2f, then width-1 and height-1 in 14 bits each, little-endian.
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (startsWith(b, 12, "VP8X")) {
    // 4 bytes of flags, then canvas width-1 and height-1 in 24 bits each.
    if (b.length < 30) return null;
    return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

// Walks the segments up to the first frame header (SOFn), noting the
// orientation of an EXIF block on the way. Gives up at the scan (SOS) or
// the end: a frame header comes before both in any valid file.
function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Markers without a length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = be16(b, i + 2);
    if (length < 2) return null;
    if (isFrameHeader(marker)) {
      if (length < 7 || i + 9 > b.length) return null;
      const height = be16(b, i + 5);
      const width = be16(b, i + 7);
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b, i + 4, Math.min(i + 2 + length, b.length));
    i += 2 + length;
  }
  return null;
}

// SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// The Orientation tag (0x0112) of IFD0 in an APP1 "Exif\0\0" block that
// runs from `start` to `end`; 1 (as stored) when it's absent or unreadable.
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (!startsWith(b, start, "Exif\0\0")) return 1;
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const little = startsWith(b, tiff, "II");
  if (!little && !startsWith(b, tiff, "MM")) return 1;
  const u16 = (i: number) => (little ? le16(b, i) : be16(b, i));
  const u32 = (i: number) => (little ? u16(i) + u16(i + 2) * 0x10000 : u16(i) * 0x10000 + u16(i + 2));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) return 1;
    // A SHORT (type 3) holds its value in the first 2 bytes of the value field.
    if (u16(entry) === 0x0112) return u16(entry + 2) === 3 ? u16(entry + 8) : 1;
  }
  return 1;
}
