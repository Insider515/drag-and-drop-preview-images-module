import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

  test('installing it brings nothing else with it', () => {
    // A widget people drop into a page should not drag a tree in behind it —
    // and most of what this package does happens in a browser, so even the one
    // server-side parser is not installed for everybody.
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  test('the multipart parser is an optional peer, not a dependency', () => {
    // Optional, or npm installs it anyway and the front-end-only case is back
    // to paying for a server it never runs.
    assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), ['busboy']);
    assert.equal(pkg.peerDependenciesMeta?.busboy?.optional, true);
  });

  test('it is a dev dependency, so the server half is tested here', () => {
    assert.ok(pkg.devDependencies?.busboy, 'the server tests would have nothing to parse with');
  });
});

describe('the name and the version, as the outside world sees them', () => {
  const readmes = ['README.md', 'README.uk.md'];
  const read = (name) => fs.readFileSync(path.join(here, '..', name), 'utf8');

  test('both READMEs tell people to install the name the package actually has', () => {
    // A rename is a dozen files, and the one that matters most is the line
    // somebody copies. Getting it wrong sends them to a package that is not
    // there, or — worse, once a name is free — to somebody else's.
    for (const name of readmes) {
      assert.match(read(name), new RegExp(`npm install ${pkg.name}(\\s|$)`, 'm'),
        `${name} does not tell anyone to install ${pkg.name}`);
    }
  });

  test('every import example uses that same name', () => {
    // The sub-path exports are the giveaway: `/server` and `/style.css` can
    // only belong to this package, so whatever precedes them must be its name.
    for (const name of readmes) {
      const specifiers = [...read(name).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      const ours = specifiers.filter((id) => id.endsWith('/server') || id.endsWith('/style.css'));
      assert.ok(ours.length, `${name} has no import examples to check`);
      const wrong = ours.filter((id) => !id.startsWith(`${pkg.name}/`));
      assert.deepEqual(wrong, [], `${name} still imports from: ${wrong.join(', ')}`);
    }
  });

  test('the type-checking paths point at the same name', () => {
    // These are what let the consumer file under test/types resolve the
    // package by name rather than by a relative path; a rename that misses
    // them turns that check into one that silently tests nothing.
    const tsconfig = fs.readFileSync(path.join(here, '..', 'tsconfig.json'), 'utf8');
    for (const key of [pkg.name, `${pkg.name}/server`]) {
      assert.ok(tsconfig.includes(`"${key}"`), `tsconfig.json has no path for ${key}`);
    }
  });

  test('the changelog names this version at the top', () => {
    // A release whose notes still say "Unreleased" is a release nobody can
    // read, and one that names a different number is worse than none.
    const changelog = fs.readFileSync(path.join(here, '..', 'CHANGELOG.md'), 'utf8');
    const first = changelog.split('\n').find((line) => line.startsWith('## '));
    assert.ok(first, 'the changelog has no versions in it at all');
    assert.match(first, new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}( |$)`),
      `the changelog opens with "${first}" while the package says ${pkg.version}`);
  });
});

describe('the size the README promises', { skip: hasBuild ? false : 'dist/ is not built yet' }, () => {
  const gzipped = (file) =>
    zlib.gzipSync(fs.readFileSync(path.join(here, '..', file)), { level: 9 }).length;
  const kb = (bytes) => Math.round(bytes / 1024);

  /** The figure both READMEs put in their opening paragraph. */
  const claimed = (readme, pattern) => {
    const text = fs.readFileSync(path.join(here, '..', readme), 'utf8');
    const match = pattern.exec(text);
    assert.ok(match, `${readme} no longer states a size at all`);
    return { js: Number(match[1]), css: Number(match[2]) };
  };

  test('is the size it actually is', () => {
    // It said 13 KB for months after it stopped being 13 KB: true when the
    // package was written, then compression, sessions, screening, retries,
    // reordering and a quota were added and nobody went back to the sentence.
    // The first thing anyone reads should not be the thing most likely to rot.
    const real = { js: kb(gzipped(pkg.exports['.'].import)), css: kb(gzipped(pkg.exports['./style.css'])) };
    const english = claimed('README.md', /(\d+) KB of JS and (\d+) KB of CSS gzipped/);

    assert.deepEqual(english, real,
      `README.md says ${english.js} KB + ${english.css} KB, the build is ${real.js} KB + ${real.css} KB`);
  });

  test('and both languages say the same number', () => {
    const english = claimed('README.md', /(\d+) KB of JS and (\d+) KB of CSS gzipped/);
    const ukrainian = claimed('README.uk.md', /(\d+) КБ JS і (\d+) КБ CSS у gzip/);
    assert.deepEqual(ukrainian, english);
  });

  test('the ES bundle is minified, not merely renamed', () => {
    // Vite shortens the identifiers in library mode but leaves the ES output
    // laid out over its lines. For anyone loading it from a script tag rather
    // than through a bundler, that was six kilobytes of gzip for whitespace.
    const code = fs.readFileSync(path.join(here, '..', pkg.exports['.'].import), 'utf8');
    const lines = code.split('\n').length;
    assert.ok(lines < 50, `the bundle is spread over ${lines} lines`);
  });
});
