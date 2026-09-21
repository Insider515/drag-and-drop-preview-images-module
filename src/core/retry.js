/**
 * Deciding what is worth sending again.
 *
 * A failed upload divides into two kinds, and treating them alike is what
 * makes a retry button either useless or annoying:
 *
 *   The connection dropped, the server was busy, a gateway answered 502. None
 *   of that is about the file. Sending it again a second later often works,
 *   and it is exactly the case where a person otherwise has to pick their
 *   photographs all over again.
 *
 *   The file is too large, it is not an image, the server refused the name,
 *   a scanner reported it as malware. Sending it again produces the same
 *   refusal, more slowly. Retrying it wastes the person's bandwidth and their
 *   patience, and buries the reason under a spinner.
 *
 * So only the first kind is repeated, and the second is left alone with its
 * explanation on the tile.
 */

/** Failures that are about the moment rather than about the file. */
const TRANSIENT = new Set([
  'NETWORK',      // the request never reached the server
  'INTERNAL',     // something broke on the far side
  'BUSY',         // too many uploads in flight; that passes
  'SCAN_FAILED',  // the malware check was unreachable
  'NO_SPACE',     // the disk was full when we asked
]);

/**
 * Is this failure worth another attempt?
 *
 * @param {string} code the code from the server or the uploader
 * @param {number} [status] the HTTP status, where there was one
 */
export function isRetryable(code, status = 0) {
  if (TRANSIENT.has(code)) return true;
  // A generic HTTP failure is judged by its status: 5xx is the server having a
  // bad moment, 4xx is it telling us something that will not change.
  if (code === 'HTTP_ERROR') return status >= 500;
  return false;
}

/** Read the `retry` block, or null when the host did not ask for retries. */
export function normaliseRetry(raw) {
  if (!raw) return null;

  const attempts = raw.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('retry.attempts must be a whole number of 1 or more');
  }
  const delay = raw.delay ?? 1000;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error('retry.delay must be a number of milliseconds');
  }
  const backoff = raw.backoff ?? 2;
  if (!Number.isFinite(backoff) || backoff < 1) {
    throw new Error('retry.backoff must be 1 or more');
  }
  const maxDelay = raw.maxDelay ?? 30000;
  if (!Number.isFinite(maxDelay) || maxDelay < 0) {
    throw new Error('retry.maxDelay must be a number of milliseconds');
  }
  return { attempts, delay, backoff, maxDelay };
}

/**
 * How long to wait before attempt number `attempt`.
 *
 * Each wait is longer than the last. A server that is down stays down for a
 * moment, and hammering it at a fixed interval is how a crowd of browsers
 * turns one server's bad minute into a longer one.
 *
 * @param {object} config from {@link normaliseRetry}
 * @param {number} attempt the attempt about to be made; the first retry is 2
 */
export function delayBefore(config, attempt) {
  const steps = Math.max(0, attempt - 2);
  return Math.min(config.maxDelay, Math.round(config.delay * config.backoff ** steps));
}
