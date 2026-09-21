/**
 * Removing metadata without touching a single pixel.
 *
 * This is the one kind of "compression without loss of quality" that is
 * genuinely available with no dependency and no re-encoding: a JPEG is a
 * sequence of segments and a PNG is a sequence of chunks, so the ones carrying
 * EXIF, XMP, IPTC, comments and timestamps can be dropped and the rest copied
 * byte for byte. The image data that comes out is bit-identical to what went
 * in.
 *
 * It is worth doing on its own. A photograph off a phone routinely carries a
 * kilobyte of GPS and camera settings, and often an embedded thumbnail that
 * runs to tens of kilobytes — all of it invisible, all of it uploaded, and
 * some of it (where the picture was taken) nobody meant to publish.
 *
 * What is deliberately *not* dropped:
 *
 *   - the JFIF segment, which says how to interpret the pixel density;
 *   - the ICC colour profile, because dropping it visibly changes colours;
 *   - EXIF that carries an orientation other than "upright", because browsers
 *     rotate by it, and removing it turns every phone photo on its side.
 */

/** Markers that stand alone — no length, no payload. */
const STANDALONE = new Set([0xd8, 0xd9, 0x01]);

/**
 * JPEG segments worth dropping.
 *
 * APP0 is JFIF and APP2 is the colour profile, so both stay. APP1 is EXIF or
 * XMP, APP13 is the Photoshop/IPTC block, and FE is a plain comment.
 */
const DROPPABLE_APP = (marker) =>
  (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2) || marker === 0xfe;

/**
 * Which way up the camera was held, from an APP1 payload.
 *
 * @returns {number} the EXIF orientation, 1 when upright or unreadable
 */
export function readExifOrientation(view, start, end) {
  // "Exif\0\0", then a TIFF header that says its own byte order.
  const isExif = view[start] === 0x45 && view[start + 1] === 0x78
    && view[start + 2] === 0x69 && view[start + 3] === 0x66;
  if (!isExif) return 1;

  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const little = view[tiff] === 0x49 && view[tiff + 1] === 0x49;
  const big = view[tiff] === 0x4d && view[tiff + 1] === 0x4d;
  if (!little && !big) return 1;

  const u16 = (at) => (little ? view[at] | (view[at + 1] << 8) : (view[at] << 8) | view[at + 1]);
  const u32 = (at) => (little
    ? (view[at] | (view[at + 1] << 8) | (view[at + 2] << 16) | (view[at + 3] << 24)) >>> 0
    : ((view[at] << 24) | (view[at + 1] << 16) | (view[at + 2] << 8) | view[at + 3]) >>> 0);

  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);

  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * Drop metadata segments from a JPEG.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null} null when there was nothing to drop
 */
function stripJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const keep = [[0, 2]];
  let at = 2;
  let dropped = 0;

  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) break; // not where a marker should be; leave it alone
    const marker = bytes[at + 1];

    if (STANDALONE.has(marker) || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push([at, at + 2]);
      at += 2;
      continue;
    }

    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2 || at + 2 + length > bytes.length) return null; // malformed
    const end = at + 2 + length;

    if (marker === 0xda) {
      // Start of scan: everything from here to the end is compressed pixels.
      keep.push([at, bytes.length]);
      at = bytes.length;
      break;
    }

    const isExifWithRotation = marker === 0xe1
      && readExifOrientation(bytes, at + 4, end) !== 1;

    if (DROPPABLE_APP(marker) && !isExifWithRotation) {
      dropped += end - at;
    } else {
      keep.push([at, end]);
    }
    at = end;
  }

  if (dropped === 0) return null;
  if (at < bytes.length) keep.push([at, bytes.length]);

  const out = new Uint8Array(bytes.length - dropped);
  let written = 0;
  for (const [from, to] of keep) {
    out.set(bytes.subarray(from, to), written);
    written += to - from;
  }
  return out.subarray(0, written);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Text, timestamps — none of it affects a single pixel. */
const DROPPABLE_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME']);

/**
 * Drop metadata chunks from a PNG.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null} null when there was nothing to drop
 */
function stripPng(bytes) {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  const keep = [[0, 8]];
  let at = 8;
  let dropped = 0;

  while (at + 8 <= bytes.length) {
    const length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const end = at + 12 + length; // length + type + data + crc
    if (end > bytes.length) return null; // malformed

    const isExifWithRotation = type === 'eXIf'
      && readExifOrientation(bytes, at + 8, end) !== 1;

    if ((DROPPABLE_CHUNKS.has(type) || (type === 'eXIf' && !isExifWithRotation))) {
      dropped += end - at;
    } else {
      keep.push([at, end]);
    }

    at = end;
    if (type === 'IEND') break;
  }

  if (dropped === 0) return null;
  if (at < bytes.length) keep.push([at, bytes.length]);

  const out = new Uint8Array(bytes.length - dropped);
  let written = 0;
  for (const [from, to] of keep) {
    out.set(bytes.subarray(from, to), written);
    written += to - from;
  }
  return out.subarray(0, written);
}

/**
 * Strip what carries no picture.
 *
 * @param {ArrayBuffer|Uint8Array} buffer the whole file
 * @param {string} type the sniffed MIME type
 * @returns {Uint8Array|null} the smaller file, or null when nothing was dropped
 */
export function stripMetadata(buffer, type) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  // Every other format here keeps its metadata in a container this would have
  // to understand in full to edit safely. Not worth guessing at.
  return null;
}
