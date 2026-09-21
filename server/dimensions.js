/**
 * How large a picture says it is, read from its header.
 *
 * This closes a gap the client alone cannot: the browser refuses an image
 * whose decoded size is absurd, but the browser is not what an attacker uses.
 * A 30 KB PNG can declare 40000×40000 — thirty kilobytes on the wire, six
 * gigabytes once something decodes it — and `curl` will happily post one past
 * a client-side check that is not running.
 *
 * Nothing here decodes anything. Every format states its dimensions in the
 * first bytes, and those bytes are what a decoder would believe, so they are
 * the right thing to check. A file that lies about them in a way that makes it
 * *smaller* than claimed is not a problem; the danger is only ever the other
 * way round.
 *
 * Where the answer cannot be found, null comes back and the caller lets the
 * file through. Refusing everything unrecognised would turn a missing parser
 * into a broken upload endpoint.
 */

/**
 * How much of the file may be needed to find the answer.
 *
 * JPEG is the reason this is not a few dozen bytes: its size lives in a frame
 * header that sits after the metadata, and a camera's embedded thumbnail can
 * push that tens of kilobytes in.
 */
export const DIMENSION_BYTES = 64 * 1024;

const u16be = (b, at) => (b[at] << 8) | b[at + 1];
const u16le = (b, at) => b[at] | (b[at + 1] << 8);
const u32be = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const ascii = (b, at, text) => {
  for (let i = 0; i < text.length; i += 1) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** PNG: the IHDR chunk is first, and always in the same place. */
function png(b) {
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/**
 * JPEG: walk the segments to the frame header.
 *
 * SOF0 through SOF15 all carry the size in the same place; C4, C8 and CC are
 * not frame headers despite sitting in that range.
 */
function jpeg(b) {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // reached the pixels
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // length, precision, then height and width — in that order.
      return { width: u16be(b, at + 7), height: u16be(b, at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

/** GIF: straight after the six-byte signature. */
function gif(b) {
  if (b.length < 10) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

/** BMP: in the DIB header, and signed, because a negative height is legal. */
function bmp(b) {
  if (b.length < 26) return null;
  const width = u32le(b, 18) | 0;
  const height = u32le(b, 22) | 0;
  return { width: Math.abs(width), height: Math.abs(height) };
}

/** WebP: three different chunk layouts under one RIFF container. */
function webp(b) {
  if (b.length < 30 || !ascii(b, 12, 'VP8')) return null;
  const kind = b[15];

  if (kind === 0x20) { // 'VP8 ' — lossy
    // A three-byte start code follows the frame tag.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (kind === 0x4c) { // 'VP8L' — lossless: 14 bits each, packed
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 0x58) { // 'VP8X' — extended: 24-bit values, one less than real
    const width = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const height = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width, height };
  }
  return null;
}

/**
 * Where a TIFF keeps its directory, and how big the file says it is.
 *
 * Unlike every other format here, a TIFF's dimensions are not near the front:
 * the directory usually sits *after* the image data, so for anything but a
 * tiny file the offset points past any reasonable header. `tiffDirectory`
 * exists so a caller that can seek is able to go and fetch it.
 */
export function tiffDirectoryOffset(b) {
  if (b.length < 8) return null;
  const little = b[0] === 0x49 && b[1] === 0x49;
  const big = b[0] === 0x4d && b[1] === 0x4d;
  if (!little && !big) return null;
  return { offset: little ? u32le(b, 4) : u32be(b, 4), little };
}

/** The two tags, from a directory that starts at `at` within `b`. */
export function tiffDirectory(b, at, little) {
  const u16 = (o) => (little ? u16le(b, o) : u16be(b, o));
  const u32 = (o) => (little ? u32le(b, o) : u32be(b, o));
  if (at + 2 > b.length) return null;

  const count = u16(at);
  let width = null;
  let height = null;

  for (let i = 0; i < count; i += 1) {
    const entry = at + 2 + i * 12;
    if (entry + 12 > b.length) break;
    const tag = u16(entry);
    if (tag !== 0x0100 && tag !== 0x0101) continue;
    // SHORT or LONG, and the value sits inline for both.
    const value = u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8);
    if (tag === 0x0100) width = value;
    else height = value;
  }
  return width && height ? { width, height } : null;
}

/** TIFF, when the directory happens to be inside the bytes we hold. */
function tiff(b) {
  const head = tiffDirectoryOffset(b);
  if (!head) return null;
  return tiffDirectory(b, head.offset, head.little);
}

/** ICO: the largest image in the directory; 0 means 256. */
function ico(b) {
  if (b.length < 8) return null;
  const count = u16le(b, 4);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    if (entry + 2 > b.length) break;
    const width = b[entry] === 0 ? 256 : b[entry];
    const height = b[entry + 1] === 0 ? 256 : b[entry + 1];
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/**
 * AVIF, HEIC, HEIF: the `ispe` box, wherever it is in the box tree.
 *
 * The container nests, and the box holding the size can be several levels
 * down. Scanning for the four bytes is cruder than walking the tree and is
 * enough for this: `ispe` is followed by a version, flags, and the two numbers.
 */
function isobmff(b) {
  for (let at = 4; at + 20 < b.length; at += 1) {
    if (!ascii(b, at, 'ispe')) continue;
    const width = u32be(b, at + 8);
    const height = u32be(b, at + 12);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

const READERS = {
  'image/png': png,
  'image/jpeg': jpeg,
  'image/gif': gif,
  'image/bmp': bmp,
  'image/webp': webp,
  'image/tiff': tiff,
  'image/x-icon': ico,
  'image/avif': isobmff,
  'image/heic': isobmff,
  'image/heif': isobmff,
};

/**
 * What the file says its size is.
 *
 * @param {Buffer|Uint8Array} head the leading bytes, up to {@link DIMENSION_BYTES}
 * @param {string} type the sniffed MIME type
 * @returns {{width: number, height: number}|null} null when it cannot be told
 */
export function readDimensions(head, type) {
  const reader = READERS[type];
  if (!reader) return null;
  try {
    const size = reader(head);
    if (!size) return null;
    const { width, height } = size;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    // A malformed header is not worth a stack trace; it simply cannot be read.
    return null;
  }
}

/**
 * The same question, for a caller that can seek.
 *
 * Two formats need this. A TIFF keeps its directory after the pixels, which
 * for any real photograph is far past the header. A JPEG with a large embedded
 * thumbnail can push its frame header past it too. Both are answerable exactly
 * once the file is on disk, and a second read of a few hundred bytes is a
 * cheap price for not having to guess.
 *
 * @param {(offset: number, length: number) => Promise<Buffer>} read
 * @param {string} type the sniffed MIME type
 */
export async function readDimensionsWithSeek(read, type) {
  const head = await read(0, DIMENSION_BYTES);
  const found = readDimensions(head, type);
  if (found) return found;

  if (type === 'image/tiff') {
    const where = tiffDirectoryOffset(head);
    if (!where || where.offset < head.length) return null;
    // 16 entries is what a photograph writes; 400 covers a generous directory.
    const directory = await read(where.offset, 2 + 400 * 12);
    if (!directory || directory.length < 2) return null;
    return tiffDirectory(directory, 0, where.little);
  }
  return null;
}
