import { readHead, looksLikeSvg, sniffImage } from './files.js';

/**
 * Whether a picked file may join the queue.
 *
 * Every refusal carries a `code`, never a sentence: the widget turns the code
 * into text in whatever language it was given, and a host reading the
 * `rejected` event gets something it can branch on rather than parse.
 */

/** Ceilings a host can raise or lower. Each is a limit, not a hint. */
export const DEFAULT_LIMITS = {
  /** Bytes per file. */
  maxFileSize: 10 * 1024 * 1024,
  /** Files in the queue at once. */
  maxFiles: 20,
  /** Bytes for the whole queue. */
  maxTotalSize: 100 * 1024 * 1024,
  /**
   * Pixels a preview may decode.
   *
   * A 30 KB PNG can declare 40000×40000 and cost ~6 GB once decoded — the
   * browser tab dies before anything is uploaded. The dimensions are read from
   * the decoded image and the file is dropped if it goes past this.
   */
  maxPixels: 50 * 1024 * 1024,
};

/**
 * Check one file.
 *
 * @param {File} file
 * @param {object} context
 * @param {string[]} context.accept MIME types allowed; empty means every image
 * @param {boolean} context.allowSvg
 * @param {object} context.limits
 * @param {number} context.queuedCount files already accepted
 * @param {number} context.queuedBytes bytes already accepted
 * @param {Set<string>} context.seen keys of files already accepted
 * @returns {Promise<{ok: true, type: string} | {ok: false, code: string, detail?: object}>}
 */
export async function inspectFile(file, context) {
  const { accept, allowSvg, limits, queuedCount, queuedBytes, seen } = context;

  if (file.size === 0) return { ok: false, code: 'EMPTY' };
  if (file.size > limits.maxFileSize) {
    return { ok: false, code: 'TOO_LARGE', detail: { limit: limits.maxFileSize } };
  }
  if (queuedCount >= limits.maxFiles) {
    return { ok: false, code: 'TOO_MANY', detail: { limit: limits.maxFiles } };
  }
  if (queuedBytes + file.size > limits.maxTotalSize) {
    return { ok: false, code: 'TOTAL_TOO_LARGE', detail: { limit: limits.maxTotalSize } };
  }
  // Name, size and modification time together: the same photo picked twice
  // really is the same file, while two different photos that happen to share a
  // name are not collapsed into one.
  if (seen.has(fileKey(file))) return { ok: false, code: 'DUPLICATE' };

  const head = await readHead(file);
  const sniffed = sniffImage(head);

  if (!sniffed) {
    // SVG is checked only after the binary formats have all missed, and only
    // when the host asked for it: it is XML that can carry script, so it is
    // the one image type that is opt-in rather than opt-out.
    if (looksLikeSvg(head)) {
      return allowSvg
        ? { ok: true, type: 'image/svg+xml' }
        : { ok: false, code: 'SVG_REFUSED' };
    }
    return { ok: false, code: 'NOT_AN_IMAGE' };
  }

  if (accept.length > 0 && !accept.includes(sniffed.type)) {
    return { ok: false, code: 'TYPE_NOT_ALLOWED', detail: { type: sniffed.type } };
  }
  return { ok: true, type: sniffed.type };
}

/**
 * Identity of a picked file.
 *
 * There is no id on a File, so this is the closest thing: what the user
 * chose, how big it is, and when it was last written.
 */
export function fileKey(file) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}
