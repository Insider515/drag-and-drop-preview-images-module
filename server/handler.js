import { UploadError } from './errors.js';
import { createRouter } from './http.js';
import { DEFAULT_LIMITS, UploadService } from './upload-service.js';
import { assertValidName } from './safe-name.js';
import { clientKey, createQuota, normaliseQuota } from './quota.js';
import { loadBusboy } from './busboy.js';

function selfOrigin(req) {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : null;
}

/**
 * Reject a state-changing request that a foreign page sent on the user's behalf.
 *
 * This matters more here than almost anywhere: `multipart/form-data` is a
 * *simple* request, so it is not preflighted. A plain `<form>` on any site can
 * post files into this endpoint under the user's session cookie, and the
 * browser will send it without asking. Checking Origin is what closes that.
 *
 * A request with neither Origin nor Sec-Fetch-Site is not a browser form — it
 * is curl, a server-to-server call, or a test — and is allowed through.
 */
function assertSameOrigin(req, allowedOrigins) {
  if (allowedOrigins === false) return;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;

  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new UploadError(403, 'CROSS_ORIGIN', 'Cross-origin request rejected');
  }

  const origin = req.get('origin');
  if (!origin) return;

  const allowed =
    typeof allowedOrigins === 'function'
      ? allowedOrigins(origin, req)
      : Array.isArray(allowedOrigins)
        ? allowedOrigins.includes(origin)
        : origin === selfOrigin(req);

  if (!allowed) {
    // "null" arrives from sandboxed iframes and some redirect chains; it is
    // not same-origin and must not be mistaken for absent.
    throw new UploadError(403, 'CROSS_ORIGIN', 'Cross-origin request rejected');
  }
}

/**
 * Build the upload endpoint.
 *
 * The result is a plain `(req, res, next)` function over node's own objects —
 * which is exactly what Express takes as middleware, and what any Node
 * framework can hand its raw objects to:
 *
 *   app.use('/api/upload', createUploadHandler({ root: './uploads' }))
 *
 *   // AdonisJS, Fastify, Nest, bare node:http — same function
 *   const files = createUploadHandler({ root: './uploads', basePath: '/api/upload' })
 *   router.any('/api/upload/*', ({ request, response }) =>
 *     files(request.request, response.response))
 *
 * @param {object} options
 * @param {string} options.root the one directory files may land in
 * @param {string} [options.basePath] prefix to strip when the host does not
 *   rewrite `req.url` itself (Express does; Adonis and node:http do not)
 * @param {string} [options.field] form field to read; `images[]` by default —
 *   the same name the widget posts under
 * @param {string[]} [options.accept] MIME types allowed
 * @param {boolean} [options.allowSvg]
 * @param {'rename'|'refuse'|'overwrite'} [options.onConflict]
 * @param {object} [options.limits] see DEFAULT_LIMITS
 * @param {number} [options.maxConcurrent] uploads in flight; beyond that, 503
 * @param {string[]|((origin: string, req: object) => boolean)|false} [options.allowedOrigins]
 * @param {(req: object, context: object) => (boolean|Promise<boolean>)} [options.authorize]
 * @param {object} [options.sessions] leave it out and the endpoint knows
 *   nothing about who is uploading, which is how it behaves by default. Pass
 *   it and every upload is filed under whatever your application already uses
 *   to tell one visitor from another — a login, or a cookie an anonymous
 *   visitor carries.
 * @param {(req: object) => (string|null|Promise<string|null>)} options.sessions.identify
 *   the id, read from the request your framework has already prepared.
 * @param {'directory'|'label'} [options.sessions.scope] `directory` (the
 *   default) gives each session its own subdirectory of `root`, so two people
 *   uploading `photo.png` do not meet; `label` keeps one flat directory and
 *   only reports who uploaded what, for a host that records ownership itself.
 * @param {boolean} [options.sessions.required] `true` by default: a request
 *   with no session is refused. Set it to `false` to let those fall back to
 *   the shared root.
 * @param {(name: string, meta: object) => string} [options.rename]
 * @param {(message: string, detail?: unknown) => void} [options.onWarning]
 * @returns {(req: object, res: object, next?: Function) => Promise<boolean>}
 */
/** Read the `sessions` block, or null when the host did not ask for sessions. */
function normaliseSessions(raw) {
  if (!raw) return null;
  if (typeof raw.identify !== 'function') {
    throw new Error('sessions.identify must be a function');
  }
  const scope = raw.scope ?? 'directory';
  if (scope !== 'directory' && scope !== 'label') {
    throw new Error("sessions.scope must be 'directory' or 'label'");
  }
  return { identify: raw.identify, scope, required: raw.required ?? true };
}

export function createUploadHandler(options = {}) {
  // Resolved here rather than at the first upload. Importing this module still
  // needs nothing — `UploadService` on its own is for a framework that parses
  // the body itself — but a handler that cannot parse a body is not a handler,
  // and finding that out from the first person who tries to upload something
  // is finding it out from the worst possible place.
  loadBusboy();

  const service = new UploadService(options);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  // The same default the widget posts under. They were different, and the
  // two halves of one package then did not work together out of the box:
  // the widget sent `images[]`, the handler read `files[]`, drained it and
  // answered "no files were sent" after the whole body had gone over the wire.
  const field = options.field ?? 'images[]';
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 8);
  const { allowedOrigins, authorize } = options;
  const sessions = normaliseSessions(options.sessions);
  // Spans requests, unlike maxFiles and maxRequestSize, which is the point:
  // one file to a request makes a per-request cap on files meaningless.
  const quotaConfig = normaliseQuota(limits.perClient);

  /**
   * What a finished batch answers with.
   *
   * A batch nothing landed in is a refusal, and which refusal it is matters:
   * the budget running out is answered 429 with a Retry-After whether it was
   * noticed before the body was read or while it was being read. Measured
   * before this: one request in sixty of eight sent at once was told 400,
   * because the early check and the per-file claim reported the same refusal
   * in two different ways — and 400 tells the widget its request was malformed
   * rather than that it should wait.
   */
  const statusFor = (result, res) => {
    if (result.uploaded.length > 0 || result.failures.length === 0) return 200;
    if (!quotaConfig || !result.failures.every((failure) => failure.code === 'QUOTA')) return 400;
    res.setHeader('Retry-After', String(Math.ceil(quotaConfig.windowMs / 1000)));
    return 429;
  };

  const quota = quotaConfig ? createQuota(quotaConfig, options.now) : null;
  const warn = (message, detail) => options.onWarning?.(message, detail);

  // Started here so the directory exists before the first request, but its
  // rejection is caught: an unhandled one takes the whole process down, and a
  // root that cannot be created should fail the requests that need it, not
  // everything else the host is doing.
  let readyError = null;
  const ready = service.init().catch((err) => {
    readyError = err;
    warn('Could not prepare the upload directory', err);
  });
  let inFlight = 0;

  const router = createRouter({ basePath: options.basePath ?? '' });

  router.use(async (req, _res, next) => {
    await ready;
    if (readyError) {
      throw new UploadError(500, 'INTERNAL', 'The upload directory is not available');
    }
    assertSameOrigin(req, allowedOrigins);
    next();
  });

  router.get('/config', async (_req, res) => {
    res.json(service.capabilities());
  });

  router.post('/', (req, res) => handleUpload(req, res));
  router.post('/upload', (req, res) => handleUpload(req, res));

  async function handleUpload(req, res) {
    if (inFlight >= maxConcurrent) {
      throw new UploadError(503, 'BUSY', 'The server is busy with other uploads, try again');
    }
    const type = String(req.headers['content-type'] ?? '');
    if (!type.includes('multipart/form-data')) {
      throw new UploadError(400, 'NOT_MULTIPART', 'multipart/form-data was expected');
    }
    // Asked before the body is read, so a forbidden upload is refused without
    // streaming megabytes to a server that will reject them.
    if (authorize && !(await authorize(req, { route: '/upload' }))) {
      throw new UploadError(403, 'DENIED', 'Uploading is not allowed');
    }

    // Asked before the body is read, for the same reason `authorize` is: a
    // request with nowhere to put its files should not be streamed first.
    const identity = sessions ? await resolveIdentity(req) : null;

    const budgetKey = quota ? clientKey(req, identity) : null;
    // Claimed now, not once the files are stored. Checking and then recording
    // later is a race, and not a theoretical one: eight requests sent at once
    // all passed a limit of three, because each looked before any had written.
    //
    // Content-Length is the client's own claim, so it is only the size of the
    // claim: under-reporting gets them a smaller reservation, and the budget
    // is enforced again while the bytes are actually read.
    if (quota) {
      // A cheap early answer, so a body that has no budget to land in is not
      // read at all. Content-Length is the client's own claim, so this is only
      // the early answer — the place is claimed per file below, which is where
      // it has to be if the count is to hold under requests sent at once.
      const declared = Number(req.headers['content-length']);
      const asking = Number.isFinite(declared) && declared > 0 ? declared : 0;
      if (!quota.allows(budgetKey, asking)) {
        res.setHeader('Retry-After', String(Math.ceil(quotaConfig.windowMs / 1000)));
        throw new UploadError(429, 'QUOTA', 'You have uploaded too much for now, try again later');
      }
    }

    inFlight += 1;
    try {
      const result = await readMultipart(req, identity, budgetKey);
      res.status(statusFor(result, res)).json(result);
    } finally {
      inFlight -= 1;
    }
  }

  /**
   * Turn whatever `sessions.identify` returns into something safe on disk.
   *
   * The value usually comes from a cookie, which is to say from the client, so
   * it is checked as strictly as a file name rather than trusted.
   */
  async function resolveIdentity(req) {
    let value;
    try {
      value = await sessions.identify(req);
    } catch (err) {
      warn('sessions.identify() threw', err);
      throw new UploadError(500, 'INTERNAL', 'Could not establish who is uploading');
    }

    if (value === null || value === undefined || value === '') {
      if (!sessions.required) return null;
      // Falling back to the shared root here would put one visitor's files
      // where another can reach them, and it would do it silently — exactly
      // when a session hook has quietly broken.
      throw new UploadError(403, 'NO_SESSION', 'No session to file this upload under');
    }

    const text = String(value);
    if (sessions.scope === 'label') return text.slice(0, 200);

    // `assertValidName` is built for file names, where keeping only the last
    // segment is right — a directory upload legitimately sends `a/b/c.png`.
    // For a session id it is not: `/etc` would become `etc` and `a/b` would
    // become `b`, so two different sessions could quietly land in one folder.
    // Here the id has to already be a single usable segment, or it is refused.
    try {
      if (assertValidName(text) !== text) throw new Error('not a single segment');
      return text;
    } catch {
      // Deliberately not repaired. A session id that is not a usable folder
      // name is the host's to hash or encode; guessing here is what would map
      // two sessions onto one directory.
      throw new UploadError(400, 'INVALID_SESSION', 'The session id cannot be used as a folder name');
    }
  }

  /**
   * Read the body, storing each file as it arrives.
   *
   * Files are stored one at a time on purpose. Parsing them in parallel would
   * hold several whole uploads in flight against the same disk and the same
   * free-space check, and the limit that matters — the total for the request —
   * could only be enforced after the fact.
   */
  function readMultipart(req, identity, budgetKey) {
    const Busboy = loadBusboy();
    return new Promise((resolve, reject) => {
      const uploaded = [];
      const failures = [];
      const fields = {};
      let total = 0;
      let count = 0;
      let settled = false;
      let pending = Promise.resolve();
      /** Parts still being read, so an abort can put an end to them. */
      const live = new Set();

      const bus = Busboy({
        headers: req.headers,
        limits: {
          files: limits.maxFiles + 1, // one over, so the extra can be reported
          // One byte over our own cap, so our check refuses the file with a
          // reason before busboy silently truncates it. Busboy's limit stays
          // as the backstop for a stream that gets past us somehow.
          fileSize: limits.maxFileSize + 1,
          fields: 32,
        },
      });

      const settle = (err) => {
        if (settled) return;
        settled = true;
        req.unpipe?.(bus);
        if (err) {
          // A request that dies mid-part leaves busboy silent: the part stream
          // gets no 'end', no 'error' and no 'close'. Whoever is storing it
          // then waits for ever, holding an open file its temp copy is
          // written to — one abandoned file per aborted upload, which a client
          // can repeat until the disk is full. Ending the part here is what
          // lets the storing half notice and clean up after itself.
          for (const part of live) part.destroy(err);
          live.clear();
          reject(err);
        } else {
          resolve({ uploaded, failures, fields, ...(identity === null ? {} : { owner: identity }) });
        }
      };

      req.on('aborted', () => settle(new UploadError(400, 'ABORTED', 'The upload was aborted')));

      bus.on('field', (name, value) => {
        if (typeof value === 'string' && value.length <= 4096) fields[name] = value;
      });

      bus.on('file', (name, stream, info) => {
        // A field this endpoint was not asked to read is drained rather than
        // stored: leaving it unread stalls the parser.
        if (name !== field) {
          stream.resume();
          return;
        }
        // Stopped the instant it is handed over. Storing happens one file at
        // a time, so this part may wait a while for its turn — and a flowing
        // stream with nobody reading it loses its leading bytes, which is how
        // an over-sized file arrived truncated and counted as stored.
        stream.pause();
        live.add(stream);
        stream.once('close', () => live.delete(stream));

        count += 1;
        if (count > limits.maxFiles) {
          failures.push({
            name: info.filename,
            code: 'TOO_MANY',
            error: `At most ${limits.maxFiles} files`,
            params: { limit: limits.maxFiles },
          });
          stream.resume();
          return;
        }

        pending = pending.then(async () => {
          if (settled) {
            stream.resume();
            return;
          }
          // Claimed here, at the moment this file is about to be stored, and
          // synchronously — checking and recording later is a race, and not a
          // theoretical one: eight requests sent at once all passed a limit of
          // three, because each looked before any had written anything.
          const slot = quota ? quota.reserve(budgetKey, 0) : null;
          if (quota && !slot) {
            // The budget ran out, possibly part-way through this batch. The
            // files that already landed stay; the rest are told why rather
            // than being dropped without a word.
            failures.push({
              name: info.filename,
              code: 'QUOTA',
              error: 'You have uploaded too much for now, try again later',
              params: null,
            });
            stream.resume();
            return;
          }
          try {
            // The budget left for the whole request is handed down, so a file
            // that would exceed it is stopped while it streams. Checking the
            // total afterwards looked equivalent and was not: the file that
            // went over had already been renamed into place, and the limit
            // refused it while leaving it on disk.
            // The budget left is a ceiling on this file too, so one file
            // cannot run far past it before anything notices.
            const leftInBudget = quota && quotaConfig.bytes
              ? Math.max(0, quotaConfig.bytes - quota.spent(budgetKey).bytes)
              : Infinity;
            const stored = await service.store(info.filename, stream, {
              maxBytes: Math.min(Math.max(0, limits.maxRequestSize - total), leftInBudget),
              subdir: sessions?.scope === 'directory' ? identity : null,
              identity,
            });
            // Counted after the fact rather than before: the size is only
            // known once the file has been read, and refusing on a guess
            // would mean refusing on the Content-Length the client claimed.
            // Corrected to what the file actually weighed; the claim above
            // could not know it.
            if (quota) quota.settle(slot, stored.size);
            total += stored.size;
            uploaded.push({
              name: stored.name,
              original: info.filename,
              size: stored.size,
              type: stored.type,
              // Where it went, when that is somewhere the client can be told
              // about. A local root is not: the answer would be a path on your
              // filesystem. A bucket is the opposite — the key and the URL are
              // the whole point of having sent it there, and dropping them left
              // the host to guess at a name it had already been given.
              ...(stored.key === undefined ? {} : {
                key: stored.key,
                path: stored.path,
                etag: stored.etag ?? null,
              }),
              // Who it was filed under, so the host can record ownership
              // without working it out from the request a second time.
              ...(identity === null ? {} : { owner: identity }),
            });
          } catch (err) {
            // A file that did not land gives its place back rather than
            // spending somebody's budget on a refusal.
            if (quota) quota.release(slot);
            // One bad file does not fail the batch: the client is told which
            // ones did not make it, and why, and keeps the rest.
            const known = err instanceof UploadError;
            if (!known) warn('Upload failed', err);
            failures.push({
              name: info.filename,
              code: known ? err.code : 'INTERNAL',
              error: known ? err.message : 'Could not store the file',
              params: known ? err.params : null,
            });
            stream.resume();
          }
        });
      });

      bus.on('error', (err) => settle(err instanceof UploadError ? err : new UploadError(400, 'INVALID_BODY', 'The request body could not be read')));
      bus.on('close', () => {
        pending.then(() => {
          if (uploaded.length === 0 && failures.length === 0) {
            settle(new UploadError(400, 'NO_FILES', 'No files were sent'));
            return;
          }
          settle(null);
        }, settle);
      });

      req.pipe(bus);
    });
  }

  // Keeps FsError-shaped messages, hides everything else behind a generic one.
  router.use((err, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy?.();
      return;
    }
    if (err instanceof UploadError) {
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        ...(err.params ? { params: err.params } : {}),
      });
      return;
    }
    warn('Unhandled upload error', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  });

  router.service = service;
  router.quota = quota;
  return router;
}

export default createUploadHandler;
