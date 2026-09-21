import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { stripMetadata, readExifOrientation } from '../src/core/metadata.js';

// ---------------------------------------------------------------- builders

/** A JPEG segment: FF, marker, big-endian length, payload. */
function segment(marker, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** An APP1 payload holding an EXIF block with the given orientation. */
function exif(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0);            // little-endian
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);       // IFD0 right after the header
  tiff.writeUInt16LE(1, 8);       // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12);      // SHORT
  tiff.writeUInt32LE(1, 14);      // count
  tiff.writeUInt16LE(orientation, 18);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

/** A whole JPEG: SOI, the segments given, SOS, some scan bytes, EOI. */
function jpeg(segments, scan = Buffer.alloc(64, 0x7f)) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segments,
    segment(0xda, Buffer.from([0x01, 0x01, 0x00])),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32
    ? zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]))
    : 0x12345678, 0);
  return Buffer.concat([head, data, crc]);
}

const png = (chunks) => Buffer.concat([
  PNG_SIGNATURE,
  chunk('IHDR', Buffer.alloc(13)),
  ...chunks,
  chunk('IDAT', Buffer.alloc(32, 0x5a)),
  chunk('IEND'),
]);

const out = (result) => (result ? Buffer.from(result) : null);

// ------------------------------------------------------------------ JPEG

describe('metadata: JPEG', () => {
  test('EXIF is dropped and the pixels are byte-identical', () => {
    const scan = Buffer.alloc(200, 0x33);
    const original = jpeg([segment(0xe0, Buffer.from('JFIF\0')), segment(0xe1, exif(1))], scan);
    const stripped = out(stripMetadata(original, 'image/jpeg'));

    assert.ok(stripped.length < original.length, 'nothing was saved');
    // The compressed picture itself is the tail: SOS header, scan, EOI.
    assert.ok(stripped.includes(scan), 'the scan data was altered');
    assert.deepEqual(stripped.subarray(-2), Buffer.from([0xff, 0xd9]));
    assert.deepEqual(stripped.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  });

  test('an embedded thumbnail goes with it — that is most of the saving', () => {
    const fat = Buffer.concat([exif(1), Buffer.alloc(30 * 1024, 0x6b)]);
    const original = jpeg([segment(0xe1, fat)]);
    const stripped = out(stripMetadata(original, 'image/jpeg'));
    assert.ok(original.length - stripped.length > 30 * 1024);
  });

  test('the JFIF segment stays — it says how to read pixel density', () => {
    const original = jpeg([segment(0xe0, Buffer.from('JFIF\0\x01\x02')), segment(0xfe, Buffer.from('a comment'))]);
    const stripped = out(stripMetadata(original, 'image/jpeg'));
    assert.ok(stripped.includes(Buffer.from('JFIF')), 'JFIF was dropped');
    assert.ok(!stripped.includes(Buffer.from('a comment')), 'the comment survived');
  });

  test('the colour profile stays — dropping it changes the colours', () => {
    const icc = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(500, 0x11)]);
    const original = jpeg([segment(0xe2, icc), segment(0xe1, exif(1))]);
    const stripped = out(stripMetadata(original, 'image/jpeg'));
    assert.ok(stripped.includes(Buffer.from('ICC_PROFILE', 'latin1')), 'the ICC profile was dropped');
  });

  test('EXIF that says the photo is rotated is kept', () => {
    // Browsers turn the picture by this tag. Dropping it lays every phone
    // photograph on its side, which is not "no loss of quality".
    for (const orientation of [3, 6, 8]) {
      const original = jpeg([segment(0xe1, exif(orientation))]);
      assert.equal(stripMetadata(original, 'image/jpeg'), null, `orientation ${orientation} was dropped`);
    }
  });

  test('EXIF that says upright is dropped like any other metadata', () => {
    const original = jpeg([segment(0xe1, exif(1))]);
    assert.ok(stripMetadata(original, 'image/jpeg'), 'an upright EXIF block was kept');
  });

  test('a file with nothing to drop is left exactly alone', () => {
    const original = jpeg([segment(0xe0, Buffer.from('JFIF\0'))]);
    assert.equal(stripMetadata(original, 'image/jpeg'), null);
  });

  test('a truncated or malformed file is refused rather than mangled', () => {
    const good = jpeg([segment(0xe1, exif(1))]);
    assert.equal(stripMetadata(good.subarray(0, 12), 'image/jpeg'), null);

    const lying = Buffer.from(good);
    lying.writeUInt16BE(0xfffe, 4); // a length that runs past the end
    assert.equal(stripMetadata(lying, 'image/jpeg'), null);

    assert.equal(stripMetadata(Buffer.from([0x00, 0x01, 0x02]), 'image/jpeg'), null);
    assert.equal(stripMetadata(Buffer.alloc(0), 'image/jpeg'), null);
  });

  test('restart markers inside the scan are not mistaken for segments', () => {
    const scan = Buffer.concat([Buffer.alloc(20, 1), Buffer.from([0xff, 0xd0]), Buffer.alloc(20, 2)]);
    const original = jpeg([segment(0xe1, exif(1))], scan);
    const stripped = out(stripMetadata(original, 'image/jpeg'));
    assert.ok(stripped.includes(scan), 'the scan was cut at a restart marker');
  });
});

describe('metadata: EXIF orientation', () => {
  test('it is read in both byte orders', () => {
    const little = exif(6);
    assert.equal(readExifOrientation(little, 0, little.length), 6);

    const big = Buffer.from(little);
    big.write('MM', 6);
    big.writeUInt16BE(42, 8);
    big.writeUInt32BE(8, 10);
    big.writeUInt16BE(1, 14);
    big.writeUInt16BE(0x0112, 16);
    big.writeUInt16BE(3, 18);
    big.writeUInt32BE(1, 20);
    big.writeUInt16BE(6, 24);
    assert.equal(readExifOrientation(big, 0, big.length), 6);
  });

  test('anything unreadable counts as upright rather than as a guess', () => {
    assert.equal(readExifOrientation(Buffer.from('not exif at all'), 0, 15), 1);
    assert.equal(readExifOrientation(Buffer.from('Exif\0\0'), 0, 6), 1);
    const nonsense = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from([0x99, 0x99, 0, 0, 0, 0, 0, 0])]);
    assert.equal(readExifOrientation(nonsense, 0, nonsense.length), 1);
  });

  test('an out-of-range value is not passed through', () => {
    const wild = exif(99);
    assert.equal(readExifOrientation(wild, 0, wild.length), 1);
  });
});

// ------------------------------------------------------------------- PNG

describe('metadata: PNG', () => {
  test('text and timestamp chunks are dropped, pixels are not', () => {
    const original = png([
      chunk('tEXt', Buffer.from('Software\0Photoshop', 'latin1')),
      chunk('tIME', Buffer.alloc(7)),
      chunk('iTXt', Buffer.alloc(200, 0x41)),
    ]);
    const stripped = out(stripMetadata(original, 'image/png'));

    assert.ok(stripped.length < original.length);
    assert.ok(!stripped.includes(Buffer.from('Photoshop', 'latin1')));
    assert.ok(stripped.includes(Buffer.alloc(32, 0x5a)), 'the image data was altered');
    assert.deepEqual(stripped.subarray(0, 8), PNG_SIGNATURE);
    assert.ok(stripped.includes(Buffer.from('IEND', 'latin1')));
  });

  test('chunks that affect the picture are kept', () => {
    const original = png([
      chunk('PLTE', Buffer.alloc(9, 0x77)),
      chunk('gAMA', Buffer.alloc(4)),
      chunk('tEXt', Buffer.from('drop me', 'latin1')),
    ]);
    const stripped = out(stripMetadata(original, 'image/png'));
    assert.ok(stripped.includes(Buffer.from('PLTE', 'latin1')));
    assert.ok(stripped.includes(Buffer.from('gAMA', 'latin1')));
    assert.ok(!stripped.includes(Buffer.from('drop me', 'latin1')));
  });

  test('a PNG with nothing to drop is left alone', () => {
    assert.equal(stripMetadata(png([]), 'image/png'), null);
  });

  test('a malformed file is refused rather than mangled', () => {
    const good = png([chunk('tEXt', Buffer.from('x', 'latin1'))]);
    assert.equal(stripMetadata(good.subarray(0, 20), 'image/png'), null);
    assert.equal(stripMetadata(Buffer.from('not a png at all'), 'image/png'), null);
  });
});

describe('metadata: formats it does not understand', () => {
  test('are returned untouched rather than guessed at', () => {
    for (const type of ['image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/tiff']) {
      assert.equal(stripMetadata(Buffer.alloc(64, 1), type), null, type);
    }
  });
});
