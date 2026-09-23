/**
 * Finding busboy, and saying so plainly when it is not there.
 *
 * Multipart parsing is busboy's job and it is the only runtime dependency the
 * package has. It is an optional peer dependency rather than an ordinary one,
 * because most of what this package does happens in a browser: a page that
 * posts to a backend written in something else, or a widget inside a plain
 * form, never reaches this file. Installing a server-side parser for those is
 * a tax on the common case.
 *
 * The cost of that choice is this file. Without it, a missing busboy showed up
 * as a plain 500 on the first upload a real person tried — measured — with the
 * reason reaching the host only if it had wired `onWarning`. An error at the
 * moment the handler is built, naming the one command that fixes it, is the
 * trade worth making.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Held after a successful load, so the resolution happens once. */
let cached = null;

/**
 * @param {(id: string) => unknown} [load] how to resolve it; the tests pass a
 *   failing one, since the only interesting case is the module being absent
 * @returns {Function} busboy itself
 */
export function loadBusboy(load) {
  // A caller that brought its own resolver is asking about that resolver, not
  // about whatever this process happened to load earlier.
  if (!load && cached) return cached;

  let loaded;
  try {
    loaded = (load ?? require)('busboy');
  } catch (err) {
    const error = new Error(
      'The upload handler needs busboy, which is an optional peer dependency '
      + 'of this package. Install it with: npm install busboy'
    );
    error.code = 'BUSBOY_MISSING';
    error.cause = err;
    throw error;
  }

  if (!load) cached = loaded;
  return loaded;
}
