/**
 * What one client may upload over a stretch of time.
 *
 * `maxFiles` and `maxRequestSize` are limits on a single request, and that is
 * all they have ever been. It stopped being enough the moment the widget began
 * sending one file per request so that an interruption would not cost a whole
 * batch: with one file to a request, a per-request cap of twenty files caps
 * nothing a person would recognise as twenty files. Measured before this
 * existed — limits of three files and 20 KB, and ten files totalling 80 KB
 * went through without a word.
 *
 * So the tally has to span requests, and it has to be keyed on something the
 * client cannot simply change. A form field would not do: whoever is uploading
 * writes those.
 *
 * It lives in this process's memory. Behind two instances each keeps its own
 * count, and the real ceiling is what it says multiplied by however many are
 * running — which is worth knowing before choosing the number.
 */

/** Read the `perClient` block, or null when the host did not ask for one. */
export function normaliseQuota(raw) {
  if (!raw) return null;

  const windowMs = raw.windowMs ?? 60_000;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('limits.perClient.windowMs must be a positive number of milliseconds');
  }
  for (const key of ['files', 'bytes']) {
    const value = raw[key];
    if (value !== undefined && value !== null
      && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`limits.perClient.${key} must be a positive number`);
    }
  }
  if (!raw.files && !raw.bytes) {
    throw new Error('limits.perClient needs files, bytes, or both');
  }
  return { files: raw.files ?? 0, bytes: raw.bytes ?? 0, windowMs };
}

/**
 * A tally per client, pruned as it goes.
 *
 * @param {object} config from {@link normaliseQuota}
 * @param {() => number} [now] for tests, which cannot wait a minute
 */
export function createQuota(config, now = Date.now) {
  /** key -> [{ at, bytes }] */
  const seen = new Map();

  const prune = (key) => {
    const cutoff = now() - config.windowMs;
    const events = seen.get(key);
    if (!events) return [];
    // The array cannot grow without bound: the limits themselves cap how many
    // entries a window can hold, and an empty one is dropped outright.
    const kept = events.filter((event) => event.at > cutoff);
    if (kept.length) seen.set(key, kept);
    else seen.delete(key);
    return kept;
  };

  return {
    /** What this client has spent in the window that matters. */
    spent(key) {
      const events = prune(key);
      return {
        files: events.length,
        bytes: events.reduce((sum, event) => sum + event.bytes, 0),
      };
    },

    /** Whether one more file of this size fits. */
    allows(key, bytes) {
      const spent = this.spent(key);
      if (config.files && spent.files + 1 > config.files) return false;
      if (config.bytes && spent.bytes + bytes > config.bytes) return false;
      return true;
    },

    /** Record one that did. */
    take(key, bytes) {
      const events = seen.get(key) ?? [];
      events.push({ at: now(), bytes });
      seen.set(key, events);
    },

    /** How many clients are being tracked; for a host that wants to watch. */
    get size() {
      return seen.size;
    },

    /** Forget everyone whose window has passed. */
    sweep() {
      for (const key of [...seen.keys()]) prune(key);
      return seen.size;
    },
  };
}

/**
 * Who this request is, for the purpose of counting.
 *
 * The session when there is one, because that is what the host already uses to
 * tell people apart. Otherwise the address the connection came from — coarse
 * behind a shared network, and the honest best available without asking the
 * client to identify itself, which it would then get to lie about.
 */
export function clientKey(req, identity) {
  if (identity) return `session:${identity}`;
  const address = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? 'unknown';
  return `address:${address}`;
}
