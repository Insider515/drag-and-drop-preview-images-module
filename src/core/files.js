/**
 * What a file actually is, and whether it is allowed in.
 *
 * The rule throughout: **the file's own bytes decide**. A browser fills
 * `File.type` from the operating system's extension mapping, so renaming
 * `payload.exe` to `photo.png` is enough to make it claim `image/png`. Reading
 * the first bytes is the only check that cannot be arranged by whoever picked
 * the file, and it costs one slice of the file.
 *
 * This is a client-side gate: it keeps honest mistakes and casual abuse out of
 * the queue and gives the user a reason. It is not a substitute for the server
 * doing the same thing — anything reachable over HTTP can be sent without a
 * browser at all, which is why `server/` repeats every one of these checks.
 */

/**
 * Magic numbers, most specific first.
 *
 * `offset` is where the signature starts; WebP and the ISO-BMFF family
 * (AVIF, HEIC) carry theirs after a leading length or RIFF header.
 */
const SIGNATURES = [
  { type: 'image/jpeg', ext: 'jpg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', ext: 'png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/gif', ext: 'gif', offset: 0, ascii: 'GIF87a' },
  { type: 'image/gif', ext: 'gif', offset: 0, ascii: 'GIF89a' },
  { type: 'image/webp', ext: 'webp', offset: 8, ascii: 'WEBP' },
  { type: 'image/avif', ext: 'avif', offset: 4, ascii: 'ftypavif' },
  { type: 'image/avif', ext: 'avif', offset: 4, ascii: 'ftypavis' },
  { type: 'image/heic', ext: 'heic', offset: 4, ascii: 'ftypheic' },
  { type: 'image/heic', ext: 'heic', offset: 4, ascii: 'ftypheix' },
  { type: 'image/heif', ext: 'heif', offset: 4, ascii: 'ftypmif1' },
  { type: 'image/heif', ext: 'heif', offset: 4, ascii: 'ftypmsf1' },
  { type: 'image/bmp', ext: 'bmp', offset: 0, ascii: 'BM' },
  { type: 'image/tiff', ext: 'tiff', offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { type: 'image/tiff', ext: 'tiff', offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { type: 'image/x-icon', ext: 'ico', offset: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
];

/** Enough for every signature above, with room to spare. */
export const SNIFF_BYTES = 32;

const asciiAt = (view, offset, text) => {
  if (offset + text.length > view.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (view[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const bytesAt = (view, offset, expected) => {
  if (offset + expected.length > view.length) return false;
  return expected.every((byte, i) => view[offset + i] === byte);
};

/**
 * Identify a file from its leading bytes.
 *
 * @param {Uint8Array} head the first {@link SNIFF_BYTES} bytes
 * @returns {{type: string, ext: string}|null} null when nothing matched
 */
export function sniffImage(head) {
  const view = head instanceof Uint8Array ? head : new Uint8Array(head);
  for (const signature of SIGNATURES) {
    const hit = signature.ascii
      ? asciiAt(view, signature.offset, signature.ascii)
      : bytesAt(view, signature.offset, signature.bytes);
    if (hit) return { type: signature.type, ext: signature.ext };
  }
  return null;
}

/**
 * Does this look like SVG?
 *
 * Kept apart from the table above because SVG has no magic number — it is XML,
 * and it may open with a declaration, a doctype, a comment or the root element.
 * It is also the one image format that can carry script, so a caller that
 * accepts it is opting into something the others do not bring.
 */
export function looksLikeSvg(head) {
  const view = head instanceof Uint8Array ? head : new Uint8Array(head);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(view).trimStart();
  return /^<(\?xml|!--|!doctype\s+svg|svg)[\s>]/i.test(text);
}

/** Every type the sniffer can name, for a host listing what it will take. */
export const KNOWN_IMAGE_TYPES = [...new Set(SIGNATURES.map((s) => s.type))];

/** Read the first bytes of a Blob without pulling the whole file into memory. */
export async function readHead(file, length = SNIFF_BYTES) {
  const slice = file.slice(0, length);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
}
