import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';

import { UploadError } from './errors.js';
import { createScanner, screen } from './scan.js';
import { DIMENSION_BYTES, readDimensions, readDimensionsWithSeek } from './dimensions.js';
import { KNOWN_IMAGE_TYPES, SNIFF_BYTES, looksLikeSvg, sniffImage } from './sniff.js';
import { assertValidName, resolveInside, withSuffix } from './safe-name.js';

/** Prefix for in-flight uploads, so a partial file is recognisable. */
export const TEMP_PREFIX = '.ddp-upload-';

export const DEFAULT_LIMITS = {
  /** Bytes per file. */
  maxFileSize: 10 * 1024 * 1024,
  /** Files in one request. */
  maxFiles: 20,
  /** Bytes for the whole request, all files together. */
  maxRequestSize: 100 * 1024 * 1024,
  /** Refuse an upload when the disk has less than this free. */
  minFreeSpace: 64 * 1024 * 1024,
  /**
   * Pixels a picture may declare. The client refuses these too, but the client
   * is not what an attacker uses: a 30 KB PNG can say 40000×40000, and curl
   * will post one past a check that is not running.
   */
  maxPixels: 50 * 1024 * 1024,
  /**
   * Bytes a second one upload may take. 0 is no limit, which is the default.
   *
   * There is no way to do this from the page: a browser gives JavaScript no
   * control over how fast it sends a request body, and the one mechanism that
   * would — a stream as the body — needs HTTP/2 and exists in two browsers of
   * three. Reading slowly here does the same job by the only route that works
   * everywhere: the window fills, and the sender has to wait.
   */
  maxBytesPerSecond: 0,
};

/**
 * Writing uploaded images to a directory.
 *
 * Knows nothing about HTTP, which is what makes it testable without a server
 * and reusable from a framework that wants to do its own request handling.
 */
export class UploadService {
  /** Session directories already created, so each one costs one mkdir. */
  #madeDirs;

  /**
   * @param {object} options
   * @param {string} options.root the one directory files may land in
   * @param {string[]} [options.accept] MIME types allowed; empty means every
   *   image format the sniffer knows
   * @param {boolean} [options.allowSvg] SVG can carry script; off by default
   * @param {'rename'|'refuse'|'overwrite'} [options.onConflict]
   * @param {object} [options.limits]
   * @param {(name: string, meta: object) => string} [options.rename] choose the
   *   stored name yourself, e.g. to use a uuid instead of what the user called it
   */
  constructor(options = {}) {
    if (!options.root) throw new Error('UploadService requires a root directory');
    this.rootInput = path.resolve(options.root);
    this.root = null; // resolved in init()
    this.accept = options.accept ?? [];
    this.allowSvg = options.allowSvg ?? false;
    this.onConflict = options.onConflict ?? 'rename';
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    const rate = this.limits.maxBytesPerSecond;
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error('limits.maxBytesPerSecond must be a number of bytes, 0 for no limit');
    }
    this.renameHook = options.rename ?? null;
    this.scanner = createScanner(options.scan);
    this.warn = options.onWarning ?? (() => {});
    this.#madeDirs = new Set();
  }

  /**
   * Create the directory and resolve it once.
   *
   * `realpath` matters: the root itself may be reached through a symlink, and
   * every containment check afterwards compares against the resolved form. A
   * root compared in its unresolved spelling lets a path that resolves
   * elsewhere look like it is inside.
   */
  async init() {
    if (this.root) return this;
    await fs.mkdir(this.rootInput, { recursive: true });
    this.root = await fs.realpath(this.rootInput);
    return this;
  }

  /** What this instance will accept, for a `/config` route. */
  capabilities() {
    return {
      accept: this.accept.length ? this.accept : KNOWN_IMAGE_TYPES,
      allowSvg: this.allowSvg,
      limits: { ...this.limits },
    };
  }

  /**
   * Store one file.
   *
   * The stream is consumed as it arrives; nothing is buffered whole. Three
   * things are checked while it runs, and each one stops it:
   *
   *   - the first bytes must be an image the host accepts. A file that is not
   *     is abandoned after {@link SNIFF_BYTES} bytes rather than after however
   *     many the sender felt like;
   *   - the size cap, counted from bytes actually received. `Content-Length` is
   *     the sender's claim and a chunked request has none at all;
   *   - the free space, checked before the write begins.
   *
   * @param {string} rawName what the client called it
   * @param {import('node:stream').Readable} stream
   * @param {object} [options]
   * @param {number} [options.maxBytes] a tighter cap than the per-file limit,
   *   used to spend a budget shared by the whole request. Without it the total
   *   could only be noticed after the file was already on disk.
   * @returns {Promise<{name: string, size: number, type: string, path: string}>}
   */
  async store(rawName, stream, options = {}) {
    await this.init();
    const name = assertValidName(rawName);
    await this.#assertSpace();

    // Everything for this file — the temp copy included — happens inside the
    // directory it is going to, so the rename that finishes it is a move
    // within one directory rather than across the tree.
    const dir = await this.#directoryFor(options.subdir ?? null);
    const temp = path.join(dir, `${TEMP_PREFIX}${crypto.randomUUID()}`);
    const cap = Math.min(this.limits.maxFileSize, options.maxBytes ?? Infinity);

    let outcome;
    try {
      outcome = await this.#drain(stream, temp, cap);
    } catch (err) {
      // A part that ends in an error — a client that hung up mid-file is the
      // ordinary case — skips the cleanup below. Left alone its temp file
      // stays, and a client aborting in a loop fills the disk with them.
      await fs.rm(temp, { force: true });
      throw err;
    }

    if (outcome.failure) {
      await fs.rm(temp, { force: true });
      throw outcome.failure;
    }
    if (outcome.size === 0) {
      await fs.rm(temp, { force: true });
      throw new UploadError(400, 'EMPTY', 'The file is empty');
    }

    // A TIFF keeps its directory after the pixels, and a JPEG with a big
    // embedded thumbnail can push its frame header past any header we held.
    // Both are answerable exactly now that the whole file is on disk.
    if (this.limits.maxPixels && !outcome.dimensions) {
      const measured = await this.#measure(temp, outcome.type);
      if (measured && measured.width * measured.height > this.limits.maxPixels) {
        await fs.rm(temp, { force: true });
        throw this.#pixelRefusal(measured);
      }
    }

    // Screened while it is still a temp file with a random name: a file that
    // is refused here never existed under a name anything would serve.
    if (this.scanner) {
      try {
        await screen(this.scanner, {
          sha256: outcome.sha256,
          name,
          type: outcome.type,
          size: outcome.size,
        }, this.warn);
      } catch (err) {
        await fs.rm(temp, { force: true });
        throw err;
      }
    }

    const stored = await this.#claim(temp, dir, name, outcome.type, options.identity ?? null);
    return {
      name: stored.name,
      size: outcome.size,
      type: outcome.type,
      path: stored.absolute,
      directory: dir,
      sha256: outcome.sha256,
    };
  }

  /**
   * Read the part to its end, writing it out until something disqualifies it.
   *
   * Once a file is disqualified the source keeps being read and the bytes are
   * thrown away, rather than the stream being abandoned. That is not politeness:
   * a multipart body is one stream, and busboy cannot reach the next part until
   * this one is consumed. Destroying it — which is what `pipeline` does, and
   * what an aborted `for await` does — stalls the whole request, so a single
   * refused file takes the rest of the batch with it.
   */
  #drain(stream, temp, cap) {
    return new Promise((resolve, reject) => {
      const out = fsc.createWriteStream(temp, { flags: 'wx', mode: 0o644 });
      let head = Buffer.alloc(0);
      let size = 0;
      let type = null;
      let dimensions = null;
      // Computed as the file goes by, so screening it afterwards costs no
      // second pass over the bytes.
      const digest = crypto.createHash('sha256');
      let failure = null;
      /** Set when the part itself went wrong, as opposed to being refused. */
      let broken = null;

      const disqualify = (err) => {
        if (!failure) failure = err;
        out.end();
      };

      // Two different reasons to stop reading, and each has to wait for the
      // other: a disk that catches up must not undo a pause the rate asked
      // for, and a rate timer must not undo one the disk asked for.
      const rate = this.limits.maxBytesPerSecond || 0;
      const startedAt = Date.now();
      let pausedForDisk = false;
      let rateTimer = null;

      const readAgain = () => {
        if (pausedForDisk || rateTimer) return;
        stream.resume();
      };

      /**
       * Hold the stream back to the rate asked for.
       *
       * Measured against the whole transfer rather than the last chunk, so a
       * pause that overshoots is made up afterwards instead of compounding.
       */
      const holdBack = () => {
        if (!rate || rateTimer) return;
        const owed = (size / rate) * 1000 - (Date.now() - startedAt);
        // Below a few milliseconds a timer costs more than it saves.
        if (owed < 5) return;
        stream.pause();
        rateTimer = setTimeout(() => {
          rateTimer = null;
          readAgain();
        }, owed);
      };

      const stopWaiting = () => {
        clearTimeout(rateTimer);
        rateTimer = null;
      };

      stream.on('data', (chunk) => {
        if (failure) return; // still draining, no longer storing
        size += chunk.length;
        if (size > cap) {
          // Which limit was hit decides which sentence the user sees.
          disqualify(
            cap < this.limits.maxFileSize
              ? new UploadError(413, 'TOTAL_TOO_LARGE', 'The request is over the size limit')
              : new UploadError(413, 'TOO_LARGE', 'Larger than the server allows', {
                  limit: this.limits.maxFileSize,
                })
          );
          return;
        }
        // The header is kept past the point the type is known, because the
        // size a picture declares can sit much further in than its signature.
        // Capped exactly: a single chunk can be the whole file, and holding an
        // arbitrary amount of it per upload in flight is not a header, it is a
        // memory leak with a limit set by whoever is uploading.
        if (head.length < DIMENSION_BYTES && !dimensions) {
          const room = DIMENSION_BYTES - head.length;
          const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
          head = head.length ? Buffer.concat([head, piece]) : Buffer.from(piece);
        }
        if (!type && head.length >= SNIFF_BYTES) {
          const verdict = this.#identify(head);
          if (verdict.error) {
            disqualify(verdict.error);
            return;
          }
          type = verdict.type;
        }
        if (type && !dimensions) {
          dimensions = readDimensions(head, type);
          const tooMany = dimensions && this.limits.maxPixels
            && dimensions.width * dimensions.height > this.limits.maxPixels;
          if (tooMany) {
            // Refused while it is still streaming: there is no reason to take
            // the rest of a file that is going to be thrown away.
            disqualify(this.#pixelRefusal(dimensions));
            return;
          }
        }
        digest.update(chunk);
        if (!out.write(chunk)) {
          pausedForDisk = true;
          stream.pause();
        }
        holdBack();
      });

      out.on('drain', () => {
        pausedForDisk = false;
        readAgain();
      });
      // busboy truncates at its own fileSize limit and says so here.
      stream.on('limit', () =>
        disqualify(new UploadError(413, 'TOO_LARGE', 'Larger than the server allows', {
          limit: this.limits.maxFileSize,
        })));
      stream.on('error', () => {
        // Settled from 'close' below rather than here: the temp file has to be
        // finished and closed before the caller can delete it, or the delete
        // races the open and leaves the file behind.
        stopWaiting();
        broken = new UploadError(400, 'ABORTED', 'The upload was interrupted');
        disqualify(broken);
      });
      stream.on('end', () => {
        stopWaiting();
        // A file shorter than the sniff window never reached the check above.
        if (!failure && !type) {
          const verdict = this.#identify(head);
          if (verdict.error) failure = verdict.error;
          else type = verdict.type;
        }
        out.end();
      });
      out.on('error', () => {
        broken = broken ?? new UploadError(500, 'INTERNAL', 'Could not store the file');
      });
      out.on('close', () => {
        stopWaiting();
        if (broken) reject(broken);
        else resolve({ size, type, failure, dimensions, sha256: digest.digest('hex') });
      });

      // Every listener is attached; the caller may have paused the stream
      // until exactly this point.
      stream.resume();
    });
  }

  /**
   * Read the declared size from a file already written, where seeking is free.
   *
   * A failure here is not a refusal: a format this cannot measure is let
   * through rather than turning a missing parser into a broken endpoint.
   */
  async #measure(absolute, type) {
    let handle;
    try {
      handle = await fs.open(absolute, 'r');
      return await readDimensionsWithSeek(async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      }, type);
    } catch (err) {
      this.warn('Could not read the image dimensions', err);
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * The refusal for a picture that declares more pixels than are allowed.
   *
   * The numbers travel with it, because "too large" without them tells the
   * person nothing they can act on.
   */
  #pixelRefusal(dimensions) {
    return new UploadError(
      413,
      'TOO_MANY_PIXELS',
      `The image declares ${dimensions.width}×${dimensions.height}, more than the server allows`,
      { limit: this.limits.maxPixels, width: dimensions.width, height: dimensions.height }
    );
  }

  /** Decide what the leading bytes are, and whether they are welcome. */
  #identify(head) {
    const sniffed = sniffImage(head);
    if (!sniffed) {
      if (looksLikeSvg(head)) {
        return this.allowSvg
          ? { type: 'image/svg+xml' }
          : {
              error: new UploadError(415, 'TYPE_NOT_ALLOWED', 'SVG is not accepted here', {
                type: 'image/svg+xml',
              }),
            };
      }
      return {
        error: new UploadError(415, 'NOT_AN_IMAGE', 'The file is not a recognised image'),
      };
    }
    if (this.accept.length > 0 && !this.accept.includes(sniffed.type)) {
      return {
        error: new UploadError(415, 'TYPE_NOT_ALLOWED', `${sniffed.type} is not accepted here`, {
          type: sniffed.type,
        }),
      };
    }
    return { type: sniffed.type };
  }

  /**
   * Move the finished temp file to its final name.
   *
   * The name is claimed with `wx`, which creates the file only if it does not
   * exist — one operation rather than "check, then create". Between a check and
   * a create, a second request uploading the same name would pass the check
   * too, and one of the two files would be lost.
   */
  async #claim(temp, dir, name, type, identity) {
    const chosen = this.renameHook
      ? assertValidName(this.renameHook(name, { type, identity }))
      : name;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? chosen : withSuffix(chosen, attempt + 1);
      const absolute = resolveInside(dir, candidate);

      if (this.onConflict === 'overwrite') {
        await fs.rename(temp, absolute);
        return { name: candidate, absolute };
      }
      try {
        const handle = await fs.open(absolute, 'wx', 0o644);
        await handle.close();
        await fs.rename(temp, absolute);
        return { name: candidate, absolute };
      } catch (err) {
        if (err.code !== 'EEXIST') {
          await fs.rm(temp, { force: true });
          throw new UploadError(500, 'INTERNAL', 'Could not store the file');
        }
        if (this.onConflict === 'refuse') {
          await fs.rm(temp, { force: true });
          throw new UploadError(409, 'EXISTS', `“${candidate}” already exists`, { name: candidate });
        }
      }
    }
    await fs.rm(temp, { force: true });
    throw new UploadError(409, 'EXISTS', `Could not find a free name for “${chosen}”`);
  }

  /**
   * The directory one upload goes into: the root, or a subdirectory of it.
   *
   * The name comes from whatever the host calls a session, so it is checked
   * exactly as strictly as a file name and then checked again after resolving
   * — a symlink planted in the upload directory is the case the second check
   * exists for. It is created on demand and remembered, so a busy session does
   * not pay for an mkdir per file.
   */
  async #directoryFor(subdir) {
    if (!subdir) return this.root;

    const segment = assertValidName(subdir);
    const absolute = resolveInside(this.root, segment);
    if (this.#madeDirs.has(absolute)) return absolute;

    await fs.mkdir(absolute, { recursive: true, mode: 0o755 });
    // Resolved after creating it: a symlink already sitting at that name would
    // otherwise pass the lexical check above and put the files somewhere else.
    const real = await fs.realpath(absolute);
    resolveInside(this.root, path.relative(this.root, real) || '.');
    this.#madeDirs.add(absolute);
    return absolute;
  }

  async #assertSpace() {
    if (!this.limits.minFreeSpace) return;
    try {
      const stats = await fs.statfs(this.root);
      if (stats.bsize * stats.bavail < this.limits.minFreeSpace) {
        throw new UploadError(507, 'NO_SPACE', 'No space left on the server');
      }
    } catch (err) {
      // statfs is missing on some platforms; a check that cannot run must not
      // turn into a refusal of every upload.
      if (err instanceof UploadError) throw err;
    }
  }

  /**
   * Remove any temp files left by an interrupted process.
   *
   * Session directories are swept too: with `sessions` turned on the files —
   * and so anything abandoned — live one level down, and a sweep that only
   * looked at the root would quietly find nothing to do.
   */
  async sweepTemp(olderThanMs = 60 * 60 * 1000) {
    await this.init();
    const now = Date.now();
    let removed = 0;

    const sweep = async (dir, descend) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (descend) await sweep(absolute, false);
          continue;
        }
        if (!entry.name.startsWith(TEMP_PREFIX)) continue;
        const stats = await fs.stat(absolute).catch(() => null);
        if (stats && now - stats.mtimeMs > olderThanMs) {
          await fs.rm(absolute, { force: true });
          removed += 1;
        }
      }
    };

    await sweep(this.root, true);
    return removed;
  }
}
