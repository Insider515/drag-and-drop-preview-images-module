/**
 * Sending the queue to a server.
 *
 * XMLHttpRequest rather than fetch, for one reason that matters here: fetch
 * still cannot report how much of a request body has gone out. Without upload
 * progress a large photo set looks frozen, and the user's only move is to press
 * the button again.
 */

/** A failure with a code the widget can translate. */
export class UploadError extends Error {
  /**
   * @param {string} code stable, machine-readable
   * @param {string} message English text, shown when there is no translation
   * @param {number} [status] HTTP status, 0 when the request never landed
   * @param {object|null} [params] values the server interpolated
   */
  constructor(code, message, status = 0, params = null) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = status;
    this.params = params;
  }
}

/**
 * Post files as multipart/form-data.
 *
 * @param {object} config
 * @param {string} config.endpoint
 * @param {Array<{file: File}>} config.items
 * @param {string} [config.field] form field name; `files[]` by default
 * @param {object|(() => object)} [config.headers] extra headers, e.g. a token
 * @param {string} [config.credentials] 'same-origin' | 'include' | 'omit'
 * @param {object} [config.fields] extra form fields sent alongside
 * @param {(sent: number, total: number) => void} [config.onProgress]
 * @param {AbortSignal} [config.signal]
 * @returns {Promise<object>} whatever the server answered
 */
export function uploadFiles(config) {
  const {
    endpoint,
    items,
    field = 'files[]',
    headers,
    credentials = 'same-origin',
    fields,
    onProgress,
    signal,
  } = config;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError('ABORTED', 'Upload cancelled'));
      return;
    }

    const body = new FormData();
    for (const [key, value] of Object.entries(fields ?? {})) body.append(key, value);
    // The name is sent as the user's file name; the server is what decides
    // what it is finally called on disk.
    for (const item of items) body.append(field, item.file, item.file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint, true);
    xhr.withCredentials = credentials === 'include';
    // Content-Type is deliberately not set: the browser has to add the
    // multipart boundary, and setting it by hand drops that.
    const extra = typeof headers === 'function' ? headers() : headers;
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value !== null && value !== undefined) xhr.setRequestHeader(key, String(value));
    }

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => signal?.removeEventListener('abort', onAbort);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    });

    xhr.addEventListener('load', () => {
      finish();
      let payload = null;
      const type = xhr.getResponseHeader('content-type') ?? '';
      if (type.includes('application/json')) {
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1, 1);
        resolve(payload ?? { uploaded: [], failures: [] });
        return;
      }
      reject(
        new UploadError(
          payload?.code ?? 'HTTP_ERROR',
          payload?.error ?? `Error ${xhr.status}`,
          xhr.status,
          payload?.params ?? null
        )
      );
    });

    xhr.addEventListener('error', () => {
      finish();
      reject(new UploadError('NETWORK', 'Could not reach the server'));
    });

    xhr.addEventListener('abort', () => {
      finish();
      reject(new UploadError('ABORTED', 'Upload cancelled'));
    });

    xhr.send(body);
  });
}
