import path from 'node:path';
import { UploadError } from './errors.js';

/**
 * Turning a name the browser sent into a name on disk.
 *
 * The rule is **refuse, do not repair** wherever a name could only be hostile,
 * and sanitise only where a browser legitimately produces something awkward.
 * A name that has to be rewritten to become safe usually belongs to an attempt,
 * and quietly substituting it hides that.
 */

/** Windows reserved device names, which are reserved with any extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Characters that are illegal in a name on at least one supported platform. */
const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f]/;

/** Anything that is only ever an attempt to leave the directory. */
const TRAVERSAL = /(^|[/\\])\.\.([/\\]|$)/;

/**
 * The last segment of whatever the browser called the file.
 *
 * A directory upload sends `photos/2026/a.jpg` as the name, and some clients
 * send a full Windows path. Only the final segment can be meant, so the rest is
 * dropped — before any check, so a traversal cannot hide behind a directory
 * part that was going to be discarded anyway.
 */
export function baseName(raw) {
  return path.basename(String(raw ?? '').replace(/\\/g, '/'));
}

/**
 * Validate a name the client chose.
 *
 * @param {string} raw
 * @returns {string} the name to use
 * @throws {UploadError} when it cannot be used at all
 */
export function assertValidName(raw) {
  const name = baseName(raw);

  if (!name || name === '.' || name === '..') {
    throw new UploadError(400, 'INVALID_NAME', 'The file has no usable name');
  }
  if (TRAVERSAL.test(String(raw)) || String(raw).includes('\u0000')) {
    throw new UploadError(400, 'INVALID_NAME', 'The file name is not allowed');
  }
  if (ILLEGAL.test(name)) {
    throw new UploadError(400, 'INVALID_NAME', 'The file name contains illegal characters');
  }
  if (/[. ]$/.test(name)) {
    // Windows silently strips these, so a file written here would come back
    // under a different name after a round trip.
    throw new UploadError(400, 'INVALID_NAME', 'The file name cannot end with a dot or a space');
  }
  if (RESERVED.test(name)) {
    throw new UploadError(400, 'INVALID_NAME', `“${name}” is a reserved system name`);
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new UploadError(400, 'INVALID_NAME', 'The file name is too long');
  }
  return name;
}

/**
 * Where a file may be written.
 *
 * Both checks are needed and neither is enough alone: the lexical one catches
 * a name that climbs out, and the resolved one catches a symlink inside the
 * directory that points anywhere else. Skipping the second is how an upload
 * directory containing a planted symlink becomes a write to `/etc`.
 *
 * @param {string} root an already-resolved absolute directory
 * @param {string} name a name that passed {@link assertValidName}
 * @returns {string} the absolute path to write
 */
export function resolveInside(root, name) {
  const target = path.resolve(root, name);
  const withSeparator = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(withSeparator)) {
    throw new UploadError(400, 'OUTSIDE_ROOT', 'The path leaves the upload directory');
  }
  return target;
}

/**
 * `photo.jpg` -> `photo (2).jpg`.
 *
 * Used only when the host asked for collisions to be renamed rather than
 * refused; the caller still claims the name atomically, because between
 * choosing a free one and creating it another request can take it.
 */
export function withSuffix(name, n) {
  const ext = path.extname(name);
  return `${path.basename(name, ext)} (${n})${ext}`;
}
