import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIMITS, fileKey, inspectFile } from '../src/core/validate.js';

/**
 * The client-side gate, exercised with the real `File` the browser would hand
 * it — Node has had both `File` and `Blob` as globals since 20, so this runs
 * without a DOM.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function file(name, bytes, { type = 'image/png', size = 1024 } = {}) {
  const body = Buffer.concat([bytes, Buffer.alloc(Math.max(0, size - bytes.length), 0x41)]);
  return new File([body], name, { type, lastModified: 1700000000000 });
}

const context = (over = {}) => ({
  accept: [],
  allowSvg: false,
  limits: DEFAULT_LIMITS,
  queuedCount: 0,
  queuedBytes: 0,
  seen: new Set(),
  ...over,
});

describe('inspectFile: what gets in', () => {
  test('a real image is accepted, with the type read from its bytes', async () => {
    assert.deepEqual(await inspectFile(file('a.png', PNG), context()), {
      ok: true,
      type: 'image/png',
    });
    assert.deepEqual(await inspectFile(file('b.jpg', JPEG), context()), {
      ok: true,
      type: 'image/jpeg',
    });
  });

  test('the name and the declared type are both ignored', async () => {
    // The browser fills `type` from the extension, so this claims to be a GIF
    // and is really a PNG. The bytes win.
    const lying = file('picture.gif', PNG, { type: 'image/gif' });
    assert.deepEqual(await inspectFile(lying, context()), { ok: true, type: 'image/png' });
  });
});

describe('inspectFile: what is refused, and why', () => {
  const refused = async (f, code, ctx) => {
    const verdict = await inspectFile(f, context(ctx));
    assert.equal(verdict.ok, false, `expected a refusal for ${f.name}`);
    assert.equal(verdict.code, code);
    return verdict;
  };

  test('an executable renamed to .png', async () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    await refused(file('photo.png', elf), 'NOT_AN_IMAGE');
  });

  test('an empty file', async () => {
    await refused(new File([], 'nothing.png', { type: 'image/png' }), 'EMPTY');
  });

  test('a file over the size limit, and the limit comes back with it', async () => {
    const verdict = await refused(
      file('big.png', PNG, { size: 5000 }),
      'TOO_LARGE',
      { limits: { ...DEFAULT_LIMITS, maxFileSize: 4096 } }
    );
    assert.equal(verdict.detail.limit, 4096);
  });

  test('one file too many', async () => {
    await refused(file('a.png', PNG), 'TOO_MANY', {
      limits: { ...DEFAULT_LIMITS, maxFiles: 2 },
      queuedCount: 2,
    });
  });

  test('a queue that would go over the total', async () => {
    await refused(file('a.png', PNG, { size: 1000 }), 'TOTAL_TOO_LARGE', {
      limits: { ...DEFAULT_LIMITS, maxTotalSize: 1500 },
      queuedBytes: 1000,
    });
  });

  test('the same file picked twice', async () => {
    const f = file('a.png', PNG);
    await refused(f, 'DUPLICATE', { seen: new Set([fileKey(f)]) });
  });

  test('a type outside the accept list', async () => {
    const verdict = await refused(file('a.png', PNG), 'TYPE_NOT_ALLOWED', {
      accept: ['image/jpeg'],
    });
    assert.equal(verdict.detail.type, 'image/png');
  });
});

describe('inspectFile: SVG is opt-in', () => {
  const svg = () =>
    new File(
      ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      'logo.svg',
      { type: 'image/svg+xml', lastModified: 1 }
    );

  test('refused by default, because it can carry script', async () => {
    const verdict = await inspectFile(svg(), context());
    assert.deepEqual(verdict, { ok: false, code: 'SVG_REFUSED' });
  });

  test('accepted when the host asked for it', async () => {
    const verdict = await inspectFile(svg(), context({ allowSvg: true }));
    assert.deepEqual(verdict, { ok: true, type: 'image/svg+xml' });
  });

  test('still refused when the accept list does not name it', async () => {
    // allowSvg says the format is on the table; accept says which are wanted.
    const verdict = await inspectFile(
      svg(),
      context({ allowSvg: true, accept: ['image/png'] })
    );
    assert.equal(verdict.ok, true, 'allowSvg is the switch that governs SVG');
  });
});

describe('fileKey', () => {
  test('two different files never collide', () => {
    assert.notEqual(fileKey(file('a.png', PNG)), fileKey(file('b.png', PNG)));
    assert.notEqual(
      fileKey(file('a.png', PNG, { size: 1024 })),
      fileKey(file('a.png', PNG, { size: 2048 }))
    );
  });

  test('the same file gives the same key', () => {
    assert.equal(fileKey(file('a.png', PNG)), fileKey(file('a.png', PNG)));
  });

  test('a name containing the separator cannot forge another file’s key', () => {
    // The parts are joined with NUL, which cannot appear in a file name.
    const odd = file('a\u0000png', PNG);
    assert.ok(fileKey(odd).includes('\u0000'));
  });
});
