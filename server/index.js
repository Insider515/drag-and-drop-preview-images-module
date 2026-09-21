/**
 * Server entry point for `drag-and-drop-preview-images-module/server`.
 *
 * One handler, no framework. `createUploadHandler` returns a plain
 * `(req, res)` function over node's own request and response, so it mounts
 * wherever those are reachable:
 *
 *   app.use('/api/upload', createUploadHandler({ root: './uploads' }));   // Express
 *   http.createServer(createUploadHandler({ root: './uploads' }));        // node:http
 *
 * `UploadService` is the storing half on its own, for a framework that parses
 * the multipart body itself.
 */
export { createUploadHandler, default } from './handler.js';
export { UploadService, DEFAULT_LIMITS, TEMP_PREFIX } from './upload-service.js';
export { UploadError } from './errors.js';
export { createScanner, screen } from './scan.js';
export { createS3Storage } from './storage/s3.js';
export { canonicalRequest, encodePath, signRequest } from './sign-v4.js';
export { DIMENSION_BYTES, readDimensions, readDimensionsWithSeek } from './dimensions.js';
export {
  IMAGE_SIGNATURES,
  KNOWN_IMAGE_TYPES,
  SNIFF_BYTES,
  looksLikeSvg,
  sniffImage,
} from './sniff.js';
export { assertValidName, baseName, resolveInside, withSuffix } from './safe-name.js';
export { createRouter, parseQuery, parseSize } from './http.js';
