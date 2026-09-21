import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes, extensionOf } from '../src/core/format.js';
import { createTranslator, resolveLocale } from '../src/core/i18n.js';
import { LOCALES, DEFAULT_LOCALE } from '../src/locales/index.js';

describe('formatBytes', () => {
  test('bytes stay whole, larger units get one decimal below ten', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(10 * 1024), '10 KB');
    assert.equal(formatBytes(1024 ** 2), '1.0 MB');
    assert.equal(formatBytes(1.5 * 1024 ** 2), '1.5 MB');
    assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  });

  test('it stops at GB rather than inventing a unit', () => {
    assert.match(formatBytes(5 * 1024 ** 4), /GB$/);
  });

  test('nothing to show is an empty string, not "NaN" or "undefined"', () => {
    for (const bad of [null, undefined, NaN, Infinity, -1, 'lots']) {
      assert.equal(formatBytes(bad), '', `formatBytes(${String(bad)})`);
    }
  });

  test('the unit name comes from the active language', () => {
    // `1.5 Ko` in French is not decoration: it is what the number means there.
    const seen = new Set();
    for (const id of Object.keys(LOCALES)) {
      const t = createTranslator(resolveLocale(id, LOCALES, DEFAULT_LOCALE), DEFAULT_LOCALE);
      const text = formatBytes(1536, t);
      assert.match(text, /^1\.5 /, `${id}: ${text}`);
      seen.add(text);
    }
    assert.ok(seen.size > 1, 'every language showed the same unit name');
  });
});

describe('extensionOf', () => {
  test('the part after the last dot, lowercased', () => {
    assert.equal(extensionOf('photo.JPEG'), 'jpeg');
    assert.equal(extensionOf('archive.tar.gz'), 'gz');
  });

  test('a name with no usable extension gives nothing', () => {
    assert.equal(extensionOf('README'), '');
    assert.equal(extensionOf('.gitignore'), '', 'a dotfile is not an extension');
    assert.equal(extensionOf('trailing.'), '');
    assert.equal(extensionOf(''), '');
  });
});
