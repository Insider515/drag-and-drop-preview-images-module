/**
 * Signing a request the way S3 expects, with nothing but node's own crypto.
 *
 * Signature Version 4 is a published algorithm, not a protocol that needs a
 * client library: hash the request in a canonical form, sign that hash with a
 * key derived from the date, the region and the service, and put the result in
 * a header. Writing it out here is what keeps an SDK — and the tree of
 * packages behind it — out of a module whose whole point is not having one.
 *
 * The failure mode is worth knowing: a signature computed wrongly is refused
 * by the far end. It cannot open a hole, only a door that will not open.
 */
import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** The empty body's hash, which S3 asks for by name often enough to keep here. */
export const EMPTY_BODY_SHA256 = sha256('');

/** `2024-03-01T12:00:00Z` -> `20240301T120000Z` and `20240301`. */
export function stamp(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long: iso, short: iso.slice(0, 8) };
}

/**
 * Percent-encode for a URI path, the way the algorithm asks.
 *
 * `encodeURIComponent` leaves `!'()*` alone and S3 does not, and the slashes
 * between path segments have to survive, so neither built-in does this job.
 */
export function encodePath(path) {
  return String(path)
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (c) =>
        `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/**
 * The request as the algorithm wants to see it before hashing.
 *
 * Exported because it is the step that goes wrong, and a test that can see it
 * says which part disagrees rather than only that the signature did.
 */
export function canonicalRequest({ method, path, query = '', headers, bodyHash }) {
  // `path` arrives already encoded, and is used exactly as given. Encoding it
  // here as well would sign something other than what the request carries —
  // and a URL object does not encode every character this algorithm does, so
  // the two have to be produced by the same code. See encodePath.

  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lines = names.map((name) => {
    const value = Object.entries(headers).find(([h]) => h.toLowerCase() === name)[1];
    return `${name}:${String(value).trim().replace(/\s+/g, ' ')}`;
  });
  return {
    text: [
      method,
      path,
      query,
      `${lines.join('\n')}\n`,
      names.join(';'),
      bodyHash,
    ].join('\n'),
    signedHeaders: names.join(';'),
  };
}

/**
 * Sign one request.
 *
 * @returns {{authorization: string, headers: object}} what to send
 */
export function signRequest({
  method,
  path,
  query = '',
  headers,
  bodyHash,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region,
  service = 's3',
  date = new Date(),
}) {
  const { long, short } = stamp(date);
  const full = {
    ...headers,
    // S3 wants the body hash in a header of its own; the algorithm in general
    // does not, and adding it everywhere would put this out of step with the
    // published test vectors it is checked against.
    ...(service === 's3' ? { 'x-amz-content-sha256': bodyHash } : {}),
    'x-amz-date': long,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };

  const canonical = canonicalRequest({ method, path, query, headers: full, bodyHash });
  const scope = `${short}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', long, scope, sha256(canonical.text)].join('\n');

  // The key is derived step by step from the date outwards, so a leaked
  // signing key is useless for another day, region or service.
  let key = hmac(`AWS4${secretAccessKey}`, short);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = hmac(key, toSign).toString('hex');

  return {
    signature,
    canonical: canonical.text,
    stringToSign: toSign,
    headers: {
      ...full,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
        + `SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
    },
  };
}

export { sha256 };
