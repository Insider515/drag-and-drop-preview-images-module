import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDom, uninstallDom, image } from './helpers/fake-dom.js';

/**
 * What a host actually imports: the built bundle named in `exports`, not the
 * source entry. A rename inside the module is invisible until somebody imports
 * the name that is gone, which is what these cases stand in for.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const built = path.join(here, '..', pkg.exports['.'].import);
const hasBuild = fs.existsSync(built);

before(() => installDom());
after(uninstallDom);

const entry = hasBuild ? await import(built) : null;

describe('the published entry', { skip: hasBuild ? false : 'dist/ is not built yet' }, () => {
  test('it loads in plain node, with no bundler underneath', () => {
    assert.ok(entry, 'importing the built entry threw');
  });

  test('everything the README tells a host to import is exported', () => {
    const expected = [
      'DropPreview', 'default', 'DEFAULTS', 'createDropPreview',
      'DEFAULT_LOCALE', 'LOCALES', 'en', 'uk', 'es', 'de', 'fr',
      'PLURAL_RULES', 'createTranslator', 'resolveLocale',
      'COLOR_PROPERTIES', 'METRIC_PROPERTIES', 'buildThemeCss',
      'KNOWN_IMAGE_TYPES', 'SNIFF_BYTES', 'looksLikeSvg', 'readHead', 'sniffImage',
      'DEFAULT_LIMITS', 'fileKey', 'inspectFile',
      'UploadError', 'uploadFiles', 'formatBytes',
    ];
    const missing = expected.filter((name) => entry[name] === undefined);
    assert.deepEqual(missing, [], `missing from the entry: ${missing.join(', ')}`);
  });

  test('the default export is the widget class', () => {
    assert.equal(entry.default, entry.DropPreview);
  });

  test('createDropPreview builds the same thing as new', async () => {
    const host = globalThis.document.querySelector();
    const made = entry.createDropPreview(host, {});
    assert.ok(made instanceof entry.DropPreview);
    await made.add([image('a.png')]);
    assert.deepEqual(made.files.map((f) => f.name), ['a.png']);
    made.destroy();
  });

  test('the stylesheet named in exports is there', () => {
    const css = path.join(here, '..', pkg.exports['./style.css']);
    assert.ok(fs.existsSync(css), `${pkg.exports['./style.css']} is missing`);
    assert.ok(fs.readFileSync(css, 'utf8').includes('.ddp'), 'the stylesheet has no widget rules');
  });
});

describe('the server entry', () => {
  test('is reachable on its own, and brings no DOM with it', async () => {
    const server = await import(path.join(here, '..', pkg.exports['./server'].import));
    for (const name of ['createUploadHandler', 'UploadService', 'UploadError', 'sniffImage', 'assertValidName']) {
      assert.equal(typeof server[name], 'function', `server export: ${name}`);
    }
  });

  test('every path in exports exists on disk', { skip: hasBuild ? false : 'dist/ is not built yet' }, () => {
    // dist/ is a build artifact and is not in the repository, so on a fresh
    // clone there is nothing to check until `npm run build` has run.
    const paths = [];
    const walk = (value) => {
      if (typeof value === 'string') paths.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(pkg.exports);
    const missing = paths.filter((rel) => !fs.existsSync(path.join(here, '..', rel)));
    assert.deepEqual(missing, [], `exports point at files that are not there: ${missing.join(', ')}`);
  });

  test('the only runtime dependency is the multipart parser', () => {
    // A widget people drop into a page should not drag a tree in behind it.
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['busboy']);
  });
});
