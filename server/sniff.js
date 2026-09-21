/**
 * What a file actually is, decided on the server.
 *
 * The client runs the same check, and that is not redundant: the client's copy
 * gives the user an immediate reason, and this one is the check that counts,
 * because anything reachable over HTTP can be sent with curl and no browser at
 * all. A server that trusts the client's `Content-Type` is a server that
 * accepts `photo.png` containing a shell script.
 *
 * The table is deliberately a separate copy from the browser's — the two
 * modules have different lives — and `test/sniff.test.js` asserts they agree,
 * so a format added to one and not the other fails the suite rather than
 * quietly differing.
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

/** Every type this recognises, for `/config` and for the tests. */
export const KNOWN_IMAGE_TYPES = [...new Set(SIGNATURES.map((s) => s.type))];

/** The raw table, so the browser copy can be compared against it in a test. */
export const IMAGE_SIGNATURES = SIGNATURES;

/**
 * @param {Buffer|Uint8Array} head the first {@link SNIFF_BYTES} bytes
 * @returns {{type: string, ext: string}|null}
 */
export function sniffImage(head) {
  const view = Buffer.isBuffer(head) ? head : Buffer.from(head);
  for (const signature of SIGNATURES) {
    const { offset } = signature;
    if (signature.ascii) {
      if (offset + signature.ascii.length > view.length) continue;
      if (view.toString('latin1', offset, offset + signature.ascii.length) === signature.ascii) {
        return { type: signature.type, ext: signature.ext };
      }
    } else {
      const { bytes } = signature;
      if (offset + bytes.length > view.length) continue;
      if (bytes.every((byte, i) => view[offset + i] === byte)) {
        return { type: signature.type, ext: signature.ext };
      }
    }
  }
  return null;
}

/**
 * Does this look like SVG?
 *
 * SVG has no magic number — it is XML, and may open with a declaration, a
 * doctype, a comment or the root element. It is also the one image format that
 * can carry script, so accepting it is opt-in.
 */
export function looksLikeSvg(head) {
  const view = Buffer.isBuffer(head) ? head : Buffer.from(head);
  const text = view.toString('utf8').trimStart();
  return /^<(\?xml|!--|!doctype\s+svg|svg)[\s>]/i.test(text);
}
