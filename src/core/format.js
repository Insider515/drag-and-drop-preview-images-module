/**
 * Human-readable file sizes.
 *
 * Binary units, because that is what a file dialog shows. The unit names come
 * from the active language: `1.5 Ko` in French is not a translation detail, it
 * is what the number means there.
 */
const UNIT_KEYS = ['unit.b', 'unit.kb', 'unit.mb', 'unit.gb'];
/** Used when no translator is passed, so this module stands on its own. */
const UNITS_EN = ['B', 'KB', 'MB', 'GB'];

/**
 * @param {number|null|undefined} bytes
 * @param {(key: string) => string} [t] translator; English when omitted
 */
export function formatBytes(bytes, t) {
  if (bytes === null || bytes === undefined) return '';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  const unitName = (index) => (t ? t(UNIT_KEYS[index]) : UNITS_EN[index]);
  if (value < 1024) return `${value} ${unitName(0)}`;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNIT_KEYS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  // One decimal below 10 keeps "1.4 MB" informative without noisy precision.
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${unitName(unit)}`;
}

/** `photo.jpeg` -> `jpeg`. Lowercase, no dot, '' when there is none. */
export function extensionOf(name) {
  const dot = String(name).lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}
