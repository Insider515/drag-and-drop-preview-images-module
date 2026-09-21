import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsc from 'node:fs';
import path from 'node:path';

import { UploadError } from './errors.js';
import { createScanner, screen } from './scan.js';
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
        if (!type) {
          head = head.length ? Buffer.concat([head, chunk]) : Buffer.from(chunk);
          if (head.length >= SNIFF_BYTES) {
            const verdict = this.#identify(head);
            if (verdict.error) {
              disqualify(verdict.error);
              return;
            }
            type = verdict.type;
          }
        }
        digest.update(chunk);
        if (!out.write(chunk)) stream.pause();
      });

      out.on('drain', () => stream.resume());
      // busboy truncates at its own fileSize limit and says so here.
      stream.on('limit', () =>
        disqualify(new UploadError(413, 'TOO_LARGE', 'Larger than the server allows', {
          limit: this.limits.maxFileSize,
        })));
      stream.on('error', () => {
        // Settled from 'close' below rather than here: the temp file has to be
        // finished and closed before the caller can delete it, or the delete
        // races the open and leaves the file behind.
        broken = new UploadError(400, 'ABORTED', 'The upload was interrupted');
        disqualify(broken);
      });
      stream.on('end', () => {
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
      out.on('close', () =>
        (broken ? reject(broken) : resolve({ size, type, failure, sha256: digest.digest('hex') })));

      // Every listener is attached; the caller may have paused the stream
      // until exactly this point.
      stream.resume();
    });
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
