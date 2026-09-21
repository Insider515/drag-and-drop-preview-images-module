/**
 * A refusal the client is allowed to see.
 *
 * Three things travel together: the HTTP status, a stable `code`, and the
 * English sentence. The code is what lets a widget in another language build
 * its own sentence; `params` carries the values that sentence interpolates, so
 * it can say *which* limit was exceeded rather than just that one was.
 *
 * Nothing else about the server goes out. A raw node error message embeds the
 * absolute path it failed on, which is why those are replaced wholesale.
 */
export class UploadError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message English, shown when the client cannot translate
   * @param {object|null} [params]
   */
  constructor(status, code, message, params = null) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.code = code;
    this.params = params;
  }
}
