import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DropPreview } from '../src/drop-preview.js';
import { normaliseCompress, targetSize, compressFile, AUTO_QUALITY } from '../src/core/compress.js';
import { installDom, uninstallDom, settled, image } from './helpers/fake-dom.js';

let dom;
before(() => { dom = installDom(); });
after(uninstallDom);
beforeEach(() => dom.reset());

// These cases describe one request carrying the whole batch, which is what
// `filesPerRequest: 0` asks for. The per-file default has its own file.
const mount = (options) => new DropPreview(dom.root, { filesPerRequest: 0, ...options });
const caption = (drop, i = 0) =>
  drop.root.querySelectorAll('.ddp-size')[i]?.textContent;

describe('compress: the size it draws at', () => {
  test('a picture is fitted inside the box, keeping its shape', () => {
    const config = normaliseCompress({ maxWidth: 128, maxHeight: 128 });
    assert.deepEqual(targetSize(4000, 3000, config), { width: 128, height: 96 });
    assert.deepEqual(targetSize(3000, 4000, config), { width: 96, height: 128 });
    assert.deepEqual(targetSize(500, 500, config), { width: 128, height: 128 });
  });

  test('cover fills the box instead of fitting inside it', () => {
    const config = normaliseCompress({ maxWidth: 128, maxHeight: 128, fit: 'cover' });
    assert.deepEqual(targetSize(4000, 3000, config), { width: 171, height: 128 });
  });

  test('one dimension on its own is enough', () => {
    assert.deepEqual(targetSize(4000, 2000, normaliseCompress({ maxWidth: 1000 })), { width: 1000, height: 500 });
    assert.deepEqual(targetSize(4000, 2000, normaliseCompress({ maxHeight: 500 })), { width: 1000, height: 500 });
  });

  test('a picture already inside the box is left at its own size', () => {
    // Enlarging adds bytes and invents detail that was never there.
    const config = normaliseCompress({ maxWidth: 1920, maxHeight: 1080 });
    assert.equal(targetSize(800, 600, config), null);
    assert.equal(targetSize(1920, 1080, config), null);
  });

  test('with no box given there is nothing to resize to', () => {
    assert.equal(targetSize(4000, 3000, normaliseCompress({ quality: 0.7 })), null);
  });

  test('a very small target never collapses to zero', () => {
    const config = normaliseCompress({ maxWidth: 1, maxHeight: 1 });
    assert.deepEqual(targetSize(4000, 10, config), { width: 1, height: 1 });
  });
});

describe('compress: options are checked when the widget is built', () => {
  test('a mistake is a mistake immediately, not at upload time', () => {
    assert.throws(() => mount({ compress: { quality: 1.5 } }), /quality must be/);
    assert.throws(() => mount({ compress: { quality: 0 } }), /quality must be/);
    assert.throws(() => mount({ compress: { quality: 'high' } }), /quality must be/);
    assert.throws(() => mount({ compress: { fit: 'squish' } }), /fit must be/);
    assert.throws(() => mount({ compress: { maxWidth: -10 } }), /maxWidth must be/);
    assert.throws(() => mount({ compress: { format: 'image/gif' } }), /format must be/);
  });

  test('the two words and a number are all accepted', () => {
    for (const quality of ['auto', 'lossless', 0.5, 1]) {
      assert.doesNotThrow(() => normaliseCompress({ quality }));
    }
  });

  test('no block at all means no compression', () => {
    assert.equal(normaliseCompress(undefined), null);
    assert.equal(mount({}).compress, null);
  });
});

describe('compress: off by default', () => {
  test('files are queued exactly as they came', async () => {
    const drop = mount();
    const original = image('photo.png', 4096);
    await drop.add([original]);

    assert.equal(drop.files[0].size, 4096);
    assert.equal(drop.files[0].file, original, 'the file was replaced anyway');
    assert.equal(dom.canvas.calls.length, 0, 'a canvas was used with no compress block');
    drop.destroy();
  });
});

describe('compress: resizing', () => {
  test('a big picture is redrawn at the size asked for', async () => {
    Object.assign(dom.decode, { width: 4000, height: 3000 });
    const drop = mount({ compress: { maxWidth: 128, maxHeight: 128 } });
    await drop.add([image('photo.png', 900_000)]);

    assert.equal(dom.canvas.calls.length, 1);
    assert.equal(dom.canvas.calls[0].width, 128);
    assert.equal(dom.canvas.calls[0].height, 96);
    assert.ok(drop.files[0].size < 900_000, 'the file did not get smaller');
    drop.destroy();
  });

  test('the queue reports what it weighed before', async () => {
    Object.assign(dom.decode, { width: 4000, height: 3000 });
    const drop = mount({ compress: { maxWidth: 128, maxHeight: 128 } });
    await drop.add([image('photo.png', 900_000)]);

    assert.equal(drop.files[0].originalSize, 900_000);
    assert.ok(drop.files[0].size < drop.files[0].originalSize);
    drop.destroy();
  });

  test('the tile shows the new size, not the old one', async () => {
    Object.assign(dom.decode, { width: 4000, height: 3000 });
    const drop = mount({ compress: { maxWidth: 128, maxHeight: 128 } });
    await drop.add([image('photo.png', 900_000)]);

    assert.ok(!caption(drop).includes('879'), `still showing the original size: ${caption(drop)}`);
    drop.destroy();
  });

  test('the hidden input carries the smaller file, so a plain form does too', async () => {
    Object.assign(dom.decode, { width: 4000, height: 3000 });
    const drop = mount({ compress: { maxWidth: 128, maxHeight: 128 } });
    await drop.add([image('photo.png', 900_000)]);

    assert.equal(drop.input.files.length, 1);
    assert.equal(drop.input.files[0], drop.files[0].file);
    assert.ok(drop.input.files[0].size < 900_000);
    drop.destroy();
  });
});

describe('compress: quality', () => {
  test("'auto' asks for 0.85 — fifteen percent off the top", async () => {
    Object.assign(dom.decode, { width: 2000, height: 2000 });
    const drop = mount({ compress: { maxWidth: 500, quality: 'auto' } });
    await drop.add([image('photo.jpg', 900_000)]);

    assert.equal(AUTO_QUALITY, 0.85);
    assert.equal(dom.canvas.calls[0].quality, 0.85);
    drop.destroy();
  });

  test('a number set by the host is passed through untouched', async () => {
    Object.assign(dom.decode, { width: 2000, height: 2000 });
    const drop = mount({ compress: { maxWidth: 500, quality: 0.4 } });
    await drop.add([image('photo.jpg', 900_000)]);
    assert.equal(dom.canvas.calls[0].quality, 0.4);
    drop.destroy();
  });

  test('lower quality really does produce a smaller file', async () => {
    const sizes = [];
    for (const quality of [0.9, 0.5, 0.2]) {
      dom.reset();
      Object.assign(dom.decode, { width: 2000, height: 2000 });
      const drop = mount({ compress: { maxWidth: 500, quality, format: 'image/jpeg' } });
      await drop.add([image('photo.jpg', 900_000)]);
      sizes.push(drop.files[0].size);
      drop.destroy();
    }
    assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], `not monotonic: ${sizes.join(', ')}`);
  });

  test('quality alone does nothing to a PNG — PNG has no quality dial', async () => {
    // The source here sniffs as PNG, and `format: 'auto'` keeps the format.
    // The re-encode is attempted and comes out bigger, because a browser
    // ignores the quality argument for PNG; the original is kept. The way to
    // make a PNG smaller is to resize it or to convert it.
    Object.assign(dom.decode, { width: 300, height: 300 });
    const drop = mount({ compress: { quality: 0.2 } });
    const original = image('flat.png', 4096);
    await drop.add([original]);

    assert.equal(drop.files[0].file, original, 'a bigger PNG was kept');
    assert.equal(drop.files[0].size, 4096);
    drop.destroy();
  });

  test('quality without a size still re-encodes a JPEG', async () => {
    // This is what "compress at 0.3, leave the size alone" has to mean. An
    // earlier version took the metadata-only path here and quietly did nothing.
    Object.assign(dom.decode, { width: 900, height: 900 });
    const drop = mount({ compress: { quality: 0.3, format: 'image/jpeg' } });
    await drop.add([image('photo.jpg', 800_000)]);

    assert.equal(dom.canvas.calls.length, 1, 'nothing was re-encoded');
    assert.equal(dom.canvas.calls[0].quality, 0.3);
    assert.equal(dom.canvas.calls[0].width, 900, 'the picture was resized when no size was asked for');
    assert.ok(drop.files[0].size < 800_000, 'the file did not get smaller');
    drop.destroy();
  });

  test('lossless ignores a size rather than silently re-encoding for it', async () => {
    Object.assign(dom.decode, { width: 4000, height: 3000 });
    const drop = mount({ compress: { quality: 'lossless', maxWidth: 128 } });
    await drop.add([image('photo.png', 4096)]);

    assert.equal(dom.canvas.calls.length, 0, 'the lossless path re-encoded to resize');
    drop.destroy();
  });
});

describe('compress: lossless means lossless', () => {
  test('no canvas is involved at all', async () => {
    // A canvas decodes and re-encodes; for a JPEG that loses a little every
    // time. The lossless path only drops metadata.
    Object.assign(dom.decode, { width: 4000, height: 3000 });
    const drop = mount({ compress: { quality: 'lossless' } });
    await drop.add([image('photo.png', 4096)]);

    assert.equal(dom.canvas.calls.length, 0, 'the lossless path re-encoded the picture');
    drop.destroy();
  });

  test('a file with no metadata to drop is left exactly as it was', async () => {
    const drop = mount({ compress: { quality: 'lossless' } });
    const original = image('photo.png', 4096);
    await drop.add([original]);

    assert.equal(drop.files[0].file, original);
    assert.equal(drop.files[0].size, 4096);
    drop.destroy();
  });
});

describe('compress: it never makes things worse', () => {
  test('a re-encode that comes out bigger is thrown away', async () => {
    // A PNG straight from an optimiser is usually smaller than anything a
    // canvas will produce from the same pixels.
    Object.assign(dom.decode, { width: 200, height: 200 });
    const drop = mount({ compress: { maxWidth: 200, maxHeight: 200, format: 'image/png' } });
    const original = image('tiny.png', 900);
    await drop.add([original]);

    assert.equal(drop.files[0].file, original, 'a bigger file was kept');
    assert.equal(drop.files[0].size, 900);
    drop.destroy();
  });

  test('unless the host says it would rather have the re-encode', async () => {
    Object.assign(dom.decode, { width: 200, height: 200 });
    const drop = mount({
      compress: { maxWidth: 200, maxHeight: 200, format: 'image/png', skipIfLarger: false },
    });
    await drop.add([image('tiny.png', 900)]);
    assert.ok(drop.files[0].size > 900);
    drop.destroy();
  });

  test('a format the browser cannot encode leaves the file alone', async () => {
    // Asked for WebP, handed back a PNG: the original is the safer thing.
    dom.canvas.unsupported.add('image/webp');
    Object.assign(dom.decode, { width: 2000, height: 2000 });
    const drop = mount({ compress: { maxWidth: 500, format: 'image/webp' } });
    const original = image('photo.jpg', 900_000);
    await drop.add([original]);

    assert.equal(drop.files[0].file, original);
    drop.destroy();
  });

  test('a file that failed to decode is never touched', async () => {
    dom.decode.fail = true;
    const drop = mount({ compress: { maxWidth: 128 } });
    await drop.add([image('broken.png', 4096)]);

    assert.equal(dom.canvas.calls.length, 0);
    assert.equal(drop.files[0].status, 'error');
    drop.destroy();
  });

  test('a canvas that throws loses no files, and says so', async () => {
    Object.assign(dom.decode, { width: 2000, height: 2000 });
    const warnings = [];
    const drop = mount({ compress: { maxWidth: 500 } });
    drop.on('warning', (w) => warnings.push(w.code));

    const original = image('photo.jpg', 900_000);
    const realCreate = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => {
      if (String(tag).toLowerCase() === 'canvas') throw new Error('no canvas today');
      return realCreate(tag);
    };
    try {
      await drop.add([original]);
    } finally {
      globalThis.document.createElement = realCreate;
    }

    assert.equal(drop.files[0].file, original, 'the file was lost');
    assert.deepEqual(warnings, ['COMPRESS_FAILED']);
    drop.destroy();
  });
});

describe('compress: the name follows the format', () => {
  test('converting to WebP renames the extension', async () => {
    Object.assign(dom.decode, { width: 2000, height: 2000 });
    const drop = mount({ compress: { maxWidth: 500, format: 'image/webp' } });
    await drop.add([image('holiday.jpg', 900_000)]);

    assert.equal(drop.files[0].name, 'holiday.webp');
    assert.equal(drop.files[0].file.type, 'image/webp');
    drop.destroy();
  });

  test('keeping the format keeps the name', async () => {
    Object.assign(dom.decode, { width: 2000, height: 2000 });
    const drop = mount({ compress: { maxWidth: 500 } });
    await drop.add([image('holiday.png', 900_000)]);
    assert.equal(drop.files[0].name, 'holiday.png');
    drop.destroy();
  });
});

describe('compress: it does not decode anything twice', () => {
  test('the picture already loaded for the preview is the one redrawn', async () => {
    Object.assign(dom.decode, { width: 2000, height: 2000, manual: true });
    const drop = mount({ compress: { maxWidth: 500 } });
    const adding = drop.add([image('a.jpg', 900_000)]);
    await settled();

    assert.equal(dom.decode.pending.length, 1, 'more than one decode was started');
    dom.decode.pending.shift()();
    await adding;

    assert.equal(dom.canvas.calls.length, 1);
    drop.destroy();
  });

  test('the decoded picture is released once it has been used', async () => {
    // It is several times the size of the file itself; holding a hundred of
    // them is how a long queue runs a tab out of memory.
    Object.assign(dom.decode, { width: 2000, height: 2000 });
    const drop = mount({ compress: { maxWidth: 500 } });
    await drop.add([image('a.jpg', 900_000), image('b.jpg', 900_000)]);

    for (const item of drop.files) {
      assert.equal(item.file.image, undefined);
    }
    drop.destroy();
  });
});

describe('compress: an upload started while a batch is still being prepared', () => {
  test('waits, and sends the shrunk files rather than the originals', async () => {
    const { FakeXHR } = await import('./helpers/fake-dom.js');
    Object.assign(dom.decode, { width: 2000, height: 2000, manual: true });

    const drop = mount({
      endpoint: '/upload',
      compress: { maxWidth: 200, format: 'image/jpeg' },
    });
    const adding = drop.add([image('a.jpg', 900_000), image('b.jpg', 900_000)]);
    await settled();

    // The files are on screen and in the hidden input already, but neither has
    // been decoded — let alone shrunk. Pressing Upload now must not send them.
    assert.equal(drop.files.length, 2);
    const sending = drop.upload();
    await settled();
    assert.equal(FakeXHR.last, null, 'the originals went out before compression finished');

    while (dom.decode.pending.length || drop.files.some((f) => f.size === 900_000)) {
      dom.decode.pending.shift()?.();
      await settled();
    }
    await adding;
    await settled();

    assert.ok(FakeXHR.last, 'the upload never started');
    const sent = FakeXHR.last.sent.entries.map(([, file]) => file.size);
    assert.deepEqual(sent.filter((size) => size === 900_000), [], 'an original slipped through');
    assert.equal(sent.length, 2);

    FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    await sending;
    drop.destroy();
  });

  test('an upload with nothing queued still returns null rather than hanging', async () => {
    const drop = mount({ endpoint: '/upload', compress: { maxWidth: 200 } });
    assert.equal(await drop.upload(), null);
    drop.destroy();
  });
});
