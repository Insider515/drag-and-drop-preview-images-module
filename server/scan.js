/**
 * Optional malware screening, before a file is given its real name.
 *
 * This is off unless a host asks for it, and it is deliberately built on a
 * *hash lookup* rather than on sending files anywhere: the only thing that
 * leaves the server is a SHA-256, which is not the file and cannot be turned
 * back into it. That choice decides what this can and cannot do, and the
 * limitation is the important part:
 *
 *   it recognises malware somebody has already reported. It does not
 *   examine the file, and a brand-new sample is unknown to it.
 *
 * So it is worth having — known samples are most of what actually arrives —
 * and it is not a substitute for a scanner that reads the bytes. A host that
 * wants one can pass `check` and talk to ClamAV, an internal service, or
 * anything else.
 *
 * No dependency is added for any of this: the lookup uses the global `fetch`
 * that Node has had since 18.
 */
import { UploadError } from './errors.js';

/** What a check may answer. Anything else is treated as a broken scanner. */
const VERDICTS = new Set(['clean', 'malicious', 'unknown']);

/**
 * VirusTotal's file report, by hash.
 *
 * A 404 means "not in the database", which is the ordinary answer for an
 * ordinary holiday photo — not a problem, and not a verdict.
 */
function virusTotal(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('scan.apiKey is required for the virustotal service');
  }

  return async function check({ sha256 }, signal) {
    const response = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
      headers: { 'x-apikey': apiKey, accept: 'application/json' },
      signal,
    });

    if (response.status === 404) return { verdict: 'unknown' };
    if (response.status === 401 || response.status === 403) {
      throw new Error('VirusTotal rejected the API key');
    }
    if (response.status === 429) {
      // The free tier allows four lookups a minute. Worth naming exactly,
      // because it is the failure a host will actually hit.
      throw new Error('VirusTotal rate limit reached');
    }
    if (!response.ok) {
      throw new Error(`VirusTotal answered ${response.status}`);
    }

    const payload = await response.json();
    const stats = payload?.data?.attributes?.last_analysis_stats ?? {};
    const malicious = Number(stats.malicious ?? 0);
    const suspicious = Number(stats.suspicious ?? 0);

    return {
      verdict: malicious + suspicious > 0 ? 'malicious' : 'clean',
      detail: { malicious, suspicious },
    };
  };
}

const SERVICES = { virustotal: virusTotal };

/**
 * Read the `scan` block into something the upload service can call, or null
 * when the host did not ask for screening.
 *
 * Both `onUnknown` and `onError` default the way they do for a reason:
 *
 *   `onUnknown: 'accept'` — almost nothing an ordinary person uploads has ever
 *   been seen by a malware database. Rejecting the unknown would reject nearly
 *   every real photo.
 *
 *   `onError: 'reject'` — if you asked for screening and the screening did not
 *   happen, accepting anyway means believing you are protected while you are
 *   not. That failure is invisible, which is what makes it the worse one. A
 *   host that would rather keep uploading through an outage can say so.
 */
export function createScanner(raw) {
  if (!raw) return null;

  const onUnknown = raw.onUnknown ?? 'accept';
  const onError = raw.onError ?? 'reject';
  for (const [name, value] of [['onUnknown', onUnknown], ['onError', onError]]) {
    if (value !== 'accept' && value !== 'reject') {
      throw new Error(`scan.${name} must be 'accept' or 'reject'`);
    }
  }

  const timeoutMs = raw.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('scan.timeoutMs must be a positive number');
  }

  let check;
  if (typeof raw.check === 'function') {
    check = raw.check;
  } else if (raw.service) {
    const build = SERVICES[raw.service];
    if (!build) {
      throw new Error(`Unknown scan.service “${raw.service}”; known: ${Object.keys(SERVICES).join(', ')}`);
    }
    check = build(raw.apiKey);
  } else {
    throw new Error('scan needs either a service or a check function');
  }

  return { check, onUnknown, onError, timeoutMs };
}

/**
 * Screen one file. Returns nothing when it may be kept, throws when it may not.
 *
 * @param {object} scanner from {@link createScanner}
 * @param {{sha256: string, name: string, type: string, size: number}} file
 * @param {(message: string, detail?: unknown) => void} warn
 */
export async function screen(scanner, file, warn) {
  let answer;
  try {
    // AbortSignal.timeout, so a scanner that never answers cannot hold an
    // upload — and with it a connection and a temp file — open indefinitely.
    answer = await scanner.check(file, AbortSignal.timeout(scanner.timeoutMs));
  } catch (err) {
    warn('Malware screening failed', err);
    if (scanner.onError === 'reject') {
      throw new UploadError(503, 'SCAN_FAILED', 'The file could not be screened, try again');
    }
    return;
  }

  const verdict = answer?.verdict;
  if (!VERDICTS.has(verdict)) {
    warn('Malware screening returned an unusable verdict', verdict);
    if (scanner.onError === 'reject') {
      throw new UploadError(503, 'SCAN_FAILED', 'The file could not be screened, try again');
    }
    return;
  }

  if (verdict === 'malicious') {
    throw new UploadError(422, 'INFECTED', 'The file was reported as malware', answer.detail ?? null);
  }
  if (verdict === 'unknown' && scanner.onUnknown === 'reject') {
    throw new UploadError(422, 'NOT_SCREENED', 'The file is not known to the malware database');
  }
}
