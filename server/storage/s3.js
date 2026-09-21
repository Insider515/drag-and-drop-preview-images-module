/**
 * Putting finished uploads in S3, or anything that speaks its API.
 *
 * No SDK. The request is a PUT with a signature computed from `node:crypto`,
 * which is all the protocol actually asks for — see sign-v4.js. That keeps a
 * module whose point is having no dependencies from acquiring a tree of them
 * for one HTTP request.
 *
 * The file reaches here already written to local disk and already checked:
 * the type read from its bytes, the dimensions it declares, the size, the
 * malware screening. Buffering through a temp file rather than streaming
 * straight through is deliberate — none of those checks can be made on bytes
 * that have already left, and a file refused after it is in the bucket is a
 * file somebody has to go and delete.
 */
import fs from 'node:fs/promises';

import { UploadError } from '../errors.js';
import { EMPTY_BODY_SHA256, encodePath, sha256, signRequest } from '../sign-v4.js';

/**
 * @param {object} options
 * @param {string} options.bucket
 * @param {string} options.region
 * @param {string} options.accessKeyId
 * @param {string} options.secretAccessKey
 * @param {string} [options.sessionToken] for temporary credentials
 * @param {string} [options.endpoint] for anything S3-compatible: R2, MinIO,
 *   Spaces. Left out, the bucket's AWS endpoint is used.
 * @param {string} [options.prefix] a folder inside the bucket
 * @param {string} [options.acl] e.g. 'public-read'; left out, the bucket decides
 * @param {(name: string) => string} [options.publicUrl] how to build the URL
 *   handed back to the client, for a bucket served through a CDN
 */
export function createS3Storage(options = {}) {
  for (const required of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
    if (!options[required]) throw new Error(`s3 storage needs ${required}`);
  }

  const {
    bucket, region, accessKeyId, secretAccessKey, sessionToken,
    prefix = '', acl, publicUrl,
  } = options;

  const base = options.endpoint
    ? String(options.endpoint).replace(/\/+$/, '')
    : `https://${bucket}.s3.${region}.amazonaws.com`;
  // A custom endpoint may or may not already name the bucket; putting it in
  // the path is what every S3-compatible service accepts.
  const inPath = Boolean(options.endpoint);
  const folder = prefix ? `${String(prefix).replace(/^\/+|\/+$/g, '')}/` : '';

  return {
    /** What a stored file is called from the outside. */
    describe: (name) => `${folder}${name}`,

    /**
     * Send one finished file.
     *
     * @param {string} name the name it was given
     * @param {string} from the temp file holding it
     * @param {{type: string, size: number}} about
     */
    async put(name, from, about) {
      const body = await fs.readFile(from);
      const key = `${folder}${name}`;
      // Encoded once, here, and used for both the request and the signature.
      // A URL object leaves characters alone that this algorithm encodes, so
      // letting it do the job would sign a path the request does not carry.
      const path = encodePath(inPath ? `/${bucket}/${key}` : `/${key}`);
      const url = new URL(base + path);

      const signed = signRequest({
        method: 'PUT',
        path,
        headers: {
          host: url.host,
          'content-type': about.type || 'application/octet-stream',
          'content-length': String(body.length),
          ...(acl ? { 'x-amz-acl': acl } : {}),
        },
        bodyHash: sha256(body),
        accessKeyId,
        secretAccessKey,
        sessionToken,
        region,
        service: 's3',
      });

      let response;
      try {
        response = await fetch(url, { method: 'PUT', headers: signed.headers, body });
      } catch (err) {
        // The far end being unreachable is a failure of the moment, and the
        // code says so: the widget repeats those and leaves the rest alone.
        throw new UploadError(502, 'INTERNAL', 'The storage service could not be reached');
      }

      if (!response.ok) {
        // The body is XML with a reason in it, and it can name the bucket and
        // the key. It goes to the log, never to whoever is uploading.
        const detail = await response.text().catch(() => '');
        const error = new UploadError(
          response.status >= 500 ? 502 : 500,
          'INTERNAL',
          'The file could not be stored'
        );
        error.detail = `S3 answered ${response.status}: ${detail.slice(0, 300)}`;
        throw error;
      }

      return {
        key,
        url: publicUrl ? publicUrl(key) : url.toString(),
        etag: response.headers.get('etag') ?? null,
      };
    },

    /** Whether something is already there, so a name is not taken twice. */
    async exists(name) {
      const key = `${folder}${name}`;
      // Encoded once, here, and used for both the request and the signature.
      // A URL object leaves characters alone that this algorithm encodes, so
      // letting it do the job would sign a path the request does not carry.
      const path = encodePath(inPath ? `/${bucket}/${key}` : `/${key}`);
      const url = new URL(base + path);

      const signed = signRequest({
        method: 'HEAD',
        path: url.pathname,
        headers: { host: url.host },
        bodyHash: EMPTY_BODY_SHA256,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        region,
        service: 's3',
      });

      try {
        const response = await fetch(url, { method: 'HEAD', headers: signed.headers });
        return response.status === 200;
      } catch {
        // Unreachable is not "free": claiming a name on a guess is how two
        // uploads end up writing over one another.
        throw new UploadError(502, 'INTERNAL', 'The storage service could not be reached');
      }
    },
  };
}
