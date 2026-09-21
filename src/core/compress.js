/**
 * Shrinking pictures in the browser, before they are uploaded.
 *
 * All of this happens on the page, with the canvas every browser already has.
 * Nothing is added to the bundle, and the bytes that never leave the visitor's
 * machine cost nobody anything — not their connection, not your disk.
 *
 * Two honest limits, because they decide what you can expect:
 *
 *   1. **There is no lossless re-encoding here.** A canvas decodes a picture
 *      to pixels and encodes it again; for JPEG that loses a little every time,
 *      even at quality 1. The only genuinely lossless saving available without
 *      a dependency is dropping metadata, which is what `quality: 'lossless'`
 *      does — see metadata.js. Real lossless recompression (mozjpeg, oxipng)
 *      needs a codec, and a codec is a dependency.
 *
 *   2. **`quality` is the encoder's dial, not a measured loss.** `'auto'` sets
 *      it to 0.85 — fifteen percent below the maximum, which is what "no more
 *      than 15%" can honestly mean without something to compare against.
 */
import { extensionOf } from './format.js';
import { stripMetadata } from './metadata.js';

/** Fifteen percent below the top of the scale. */
export const AUTO_QUALITY = 0.85;

/** What a canvas can be asked to produce. */
const ENCODABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Read the `compress` block, or null when the host did not ask for it.
 */
export function normaliseCompress(raw) {
  if (!raw) return null;

  const quality = raw.quality ?? 'auto';
  if (quality !== 'auto' && quality !== 'lossless') {
    if (typeof quality !== 'number' || !(quality > 0) || quality > 1) {
      throw new Error("compress.quality must be 'auto', 'lossless', or a number above 0 and up to 1");
    }
  }

  const fit = raw.fit ?? 'contain';
  if (fit !== 'contain' && fit !== 'cover') {
    throw new Error("compress.fit must be 'contain' or 'cover'");
  }

  for (const key of ['maxWidth', 'maxHeight']) {
    const value = raw[key];
    if (value !== undefined && value !== null && !(Number.isFinite(value) && value > 0)) {
      throw new Error(`compress.${key} must be a positive number`);
    }
  }

  const format = raw.format ?? 'auto';
  if (format !== 'auto' && !ENCODABLE.has(format)) {
    throw new Error(`compress.format must be 'auto' or one of ${[...ENCODABLE].join(', ')}`);
  }

  return {
    maxWidth: raw.maxWidth ?? null,
    maxHeight: raw.maxHeight ?? null,
    fit,
    quality,
    format,
    stripMetadata: raw.stripMetadata ?? true,
    skipIfLarger: raw.skipIfLarger ?? true,
  };
}

/**
 * The size to draw at.
 *
 * Never larger than the original: enlarging a small picture to fill a box adds
 * bytes and invents detail that was never there.
 */
export function targetSize(width, height, config) {
  const maxW = config.maxWidth ?? Infinity;
  const maxH = config.maxHeight ?? Infinity;
  if (!Number.isFinite(maxW) && !Number.isFinite(maxH)) return null;
  if (width <= maxW && height <= maxH) return null; // already inside the box

  const scale = config.fit === 'cover'
    ? Math.max(maxW / width, maxH / height)
    : Math.min(maxW / width, maxH / height);
  const capped = Math.min(scale, 1);

  return {
    width: Math.max(1, Math.round(width * capped)),
    height: Math.max(1, Math.round(height * capped)),
  };
}

/** What the re-encoded file should be called and be. */
function outputType(sourceType, config) {
  if (config.format !== 'auto') return config.format;
  // Keeping the format is the least surprising thing to do: turning a PNG with
  // transparency into a JPEG fills every transparent pixel with black.
  return ENCODABLE.has(sourceType) ? sourceType : 'image/jpeg';
}

function renamed(name, type) {
  const wanted = EXTENSIONS[type];
  if (!wanted || extensionOf(name) === wanted) return name;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${wanted}`;
}

/** Wrap a canvas in a promise, since toBlob is a callback. */
function encode(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Produce a smaller version of one file, or the original when that is better.
 *
 * @param {File} file
 * @param {{image: object, type: string, width: number, height: number}} decoded
 *   the picture as already loaded for its preview — so nothing is decoded twice
 * @param {object} config from {@link normaliseCompress}
 * @returns {Promise<{file: File, changed: boolean}>}
 */
export async function compressFile(file, decoded, config) {
  const size = targetSize(decoded.width, decoded.height, config);
  const lossless = config.quality === 'lossless';

  // The lossless path never touches a canvas, so there is nothing it can do
  // but drop metadata — a size asked for alongside it cannot be honoured,
  // because resizing means re-encoding.
  if (lossless) {
    if (!config.stripMetadata) return { file, changed: false };
    const stripped = await stripOnly(file, decoded.type);
    return stripped ? { file: stripped, changed: true } : { file, changed: false };
  }

  const type = outputType(decoded.type, config);
  const quality = config.quality === 'auto' ? AUTO_QUALITY
    : (lossless ? undefined : config.quality);

  const canvas = document.createElement('canvas');
  canvas.width = size ? size.width : decoded.width;
  canvas.height = size ? size.height : decoded.height;

  const context = canvas.getContext('2d');
  if (!context) return { file, changed: false };
  // A picture with transparency drawn onto a format that has none would come
  // out on a black field; white is what every image editor uses instead.
  if (type === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);

  const blob = await encode(canvas, type, quality);
  // An encoder that cannot produce this type returns null, or quietly gives
  // back a PNG. Either way the original is the safer thing to send.
  if (!blob || (config.format !== 'auto' && blob.type !== type)) {
    return { file, changed: false };
  }
  if (config.skipIfLarger && blob.size >= file.size) {
    return { file, changed: false };
  }

  return {
    file: new File([blob], renamed(file.name, blob.type || type), {
      type: blob.type || type,
      lastModified: file.lastModified,
    }),
    changed: true,
  };
}

/** The lossless path: same pixels, fewer bytes. */
async function stripOnly(file, type) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const stripped = stripMetadata(bytes, type);
  if (!stripped) return null;
  return new File([stripped], file.name, { type: file.type, lastModified: file.lastModified });
}
