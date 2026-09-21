/**
 * drag-and-drop-preview-images-module — an image drop zone with previews.
 *
 *   import { DropPreview } from 'drag-and-drop-preview-images-module';
 *   import 'drag-and-drop-preview-images-module/style.css';
 *
 *   new DropPreview('#host', { endpoint: '/api/upload' });
 *
 * The stylesheet is imported here so bundler users get it automatically; hosts
 * that tree-shake aggressively should import it by path as shown above.
 */
import './styles.css';
import { DropPreview } from './drop-preview.js';

export { DropPreview, DEFAULTS, DropPreview as default } from './drop-preview.js';

// Language. `locale` takes one of the shipped ids, or a dictionary of your
// own. English is the default and the fallback for anything a translation
// leaves out.
export { DEFAULT_LOCALE, LOCALES, de, en, es, fr, uk } from './locales/index.js';
export { PLURAL_RULES, createTranslator, resolveLocale } from './core/i18n.js';

// Colours, fonts and metrics. `theme` on the widget takes the same shape.
export { COLOR_PROPERTIES, METRIC_PROPERTIES, buildThemeCss } from './core/theme.js';

// The checks, for a host that wants to run them somewhere else.
export { KNOWN_IMAGE_TYPES, SNIFF_BYTES, looksLikeSvg, readHead, sniffImage } from './core/files.js';
export { DEFAULT_LIMITS, fileKey, inspectFile } from './core/validate.js';
export { UploadError, uploadFiles } from './core/uploader.js';
export { formatBytes } from './core/format.js';

/**
 * Convenience factory.
 *
 * @param {HTMLElement|string} target
 * @param {object} [options]
 * @returns {DropPreview}
 */
export function createDropPreview(target, options) {
  return new DropPreview(target, options);
}
