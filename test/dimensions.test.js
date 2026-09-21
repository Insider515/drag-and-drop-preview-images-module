import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  DIMENSION_BYTES,
  readDimensions,
  readDimensionsWithSeek,
  tiffDirectoryOffset,
} from '../server/dimensions.js';

/*
 * The builders below were checked against files produced by the operating
 * system's own encoder at 457×123 — PNG, JPEG, GIF, TIFF and BMP — and every
 * reader agreed with it. What is built here is the same shape, so that the
 * cases can say what they mean instead of carrying binary fixtures.
 */

// ------------------------------------------------------------------ PNG

function png(width, height) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------- JPEG

function jpegSegment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A JPEG whose frame header sits after `padding` bytes of metadata. */
function jpeg(width, height, { marker = 0xc0, padding = 0 } = {}) {
  const frame = Buffer.alloc(6);
  frame[0] = 8;                       // precision
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 3;                       // components
  const before = padding ? [jpegSegment(0xe1, Buffer.alloc(padding, 0x41))] : [];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...before,
    jpegSegment(marker, frame),
    jpegSegment(0xda, Buffer.from([1, 1, 0])),
    Buffer.alloc(32, 0x7f),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ------------------------------------------------------------------ rest

function gif(width, height) {
  const b = Buffer.alloc(14);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function bmp(width, height) {
  const b = Buffer.alloc(54);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  return b;
}

function webpLossy(width, height) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpExtended(width, height) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** A TIFF whose directory sits wherever `at` says. */
function tiff(width, height, { at = 8, little = true } = {}) {
  const entries = [[0x0100, width], [0x0101, height], [0x0102, 8]];
  const b = Buffer.alloc(at + 2 + entries.length * 12 + 4);
  if (little) {
    b.write('II', 0, 'latin1');
    b.writeUInt16LE(42, 2);
    b.writeUInt32LE(at, 4);
    b.writeUInt16LE(entries.length, at);
    entries.forEach(([tag, value], i) => {
      const e = at + 2 + i * 12;
      b.writeUInt16LE(tag, e);
      b.writeUInt16LE(4, e + 2);      // LONG
      b.writeUInt32LE(1, e + 4);
      b.writeUInt32LE(value, e + 8);
    });
  } else {
    b.write('MM', 0, 'latin1');
    b.writeUInt16BE(42, 2);
    b.writeUInt32BE(at, 4);
    b.writeUInt16BE(entries.length, at);
    entries.forEach(([tag, value], i) => {
      const e = at + 2 + i * 12;
      b.writeUInt16BE(tag, e);
      b.writeUInt16BE(3, e + 2);      // SHORT
      b.writeUInt32BE(1, e + 4);
      b.writeUInt16BE(value, e + 8);
    });
  }
  return b;
}

function ico(sizes) {
  const b = Buffer.alloc(6 + sizes.length * 16);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(sizes.length, 4);
  sizes.forEach(([w, h], i) => {
    b[6 + i * 16] = w === 256 ? 0 : w;
    b[6 + i * 16 + 1] = h === 256 ? 0 : h;
  });
  return b;
}

/** An ISOBMFF file with an `ispe` box nested where a real one puts it. */
function heif(width, height) {
  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0);
  ispe.write('ispe', 4, 'latin1');
  ispe.writeUInt32BE(width, 12);
  ispe.writeUInt32BE(height, 16);
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('heic', 8, 'latin1');
  return Buffer.concat([ftyp, Buffer.alloc(60, 0x11), ispe, Buffer.alloc(16, 0x22)]);
}

// ----------------------------------------------------------------- cases

describe('dimensions: every format the sniffer knows', () => {
  test('PNG', () => {
    assert.deepEqual(readDimensions(png(457, 123), 'image/png'), { width: 457, height: 123 });
    assert.deepEqual(readDimensions(png(1, 1), 'image/png'), { width: 1, height: 1 });
  });

  test('JPEG, from whichever frame marker the encoder used', () => {
    // Baseline, progressive and the rest all carry the size the same way.
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcf]) {
      assert.deepEqual(readDimensions(jpeg(457, 123, { marker }), 'image/jpeg'),
        { width: 457, height: 123 }, `marker ${marker.toString(16)}`);
    }
  });

  test('JPEG, with the frame header pushed in by metadata', () => {
    // A camera's embedded thumbnail routinely does this.
    assert.deepEqual(readDimensions(jpeg(457, 123, { padding: 40_000 }), 'image/jpeg'),
      { width: 457, height: 123 });
  });

  test('JPEG: markers that are not frame headers are not read as one', () => {
    // C4 is a Huffman table, C8 is reserved, CC is arithmetic coding.
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      const bytes = jpeg(457, 123, { marker });
      assert.equal(readDimensions(bytes, 'image/jpeg'), null, `marker ${marker.toString(16)}`);
    }
  });

  test('GIF', () => {
    assert.deepEqual(readDimensions(gif(457, 123), 'image/gif'), { width: 457, height: 123 });
  });

  test('BMP, including the negative height that means top-down', () => {
    assert.deepEqual(readDimensions(bmp(457, 123), 'image/bmp'), { width: 457, height: 123 });
    assert.deepEqual(readDimensions(bmp(457, -123), 'image/bmp'), { width: 457, height: 123 });
  });

  test('WebP, lossy and extended', () => {
    assert.deepEqual(readDimensions(webpLossy(457, 123), 'image/webp'), { width: 457, height: 123 });
    assert.deepEqual(readDimensions(webpExtended(457, 123), 'image/webp'), { width: 457, height: 123 });
  });

  test('TIFF, in both byte orders', () => {
    assert.deepEqual(readDimensions(tiff(457, 123, { little: true }), 'image/tiff'),
      { width: 457, height: 123 });
    assert.deepEqual(readDimensions(tiff(457, 123, { little: false }), 'image/tiff'),
      { width: 457, height: 123 });
  });

  test('ICO reports the largest image in the file', () => {
    assert.deepEqual(readDimensions(ico([[16, 16], [48, 48], [32, 32]]), 'image/x-icon'),
      { width: 48, height: 48 });
    // Zero means 256 — the format has one byte per dimension.
    assert.deepEqual(readDimensions(ico([[256, 256]]), 'image/x-icon'),
      { width: 256, height: 256 });
  });

  test('HEIC, HEIF and AVIF through the ispe box', () => {
    for (const type of ['image/heic', 'image/heif', 'image/avif']) {
      assert.deepEqual(readDimensions(heif(457, 123), type), { width: 457, height: 123 }, type);
    }
  });
});

describe('dimensions: when it cannot tell', () => {
  test('it says so rather than guessing', () => {
    // A format with no reader, and a header that is not what it claims.
    assert.equal(readDimensions(Buffer.alloc(64, 1), 'image/svg+xml'), null);
    assert.equal(readDimensions(Buffer.alloc(64, 1), 'image/png'), null);
    assert.equal(readDimensions(Buffer.alloc(0), 'image/jpeg'), null);
  });

  test('a truncated header is not read as a tiny image', () => {
    for (const [type, bytes] of [
      ['image/png', png(457, 123).subarray(0, 18)],
      ['image/gif', gif(457, 123).subarray(0, 7)],
      ['image/bmp', bmp(457, 123).subarray(0, 20)],
      ['image/tiff', tiff(457, 123).subarray(0, 10)],
    ]) {
      assert.equal(readDimensions(bytes, type), null, type);
    }
  });

  test('zero or absurd values are refused rather than passed on', () => {
    assert.equal(readDimensions(png(0, 123), 'image/png'), null);
    assert.equal(readDimensions(gif(457, 0), 'image/gif'), null);
  });

  test('a JPEG that ends before its frame header gives nothing', () => {
    const cut = jpeg(457, 123, { padding: 1000 }).subarray(0, 200);
    assert.equal(readDimensions(cut, 'image/jpeg'), null);
  });
});

describe('dimensions: a header the reader has to seek for', () => {
  /** Serve a buffer the way a file handle would. */
  const seeker = (buffer) => async (offset, length) => buffer.subarray(offset, offset + length);

  test("TIFF's directory is fetched from wherever it says it is", async () => {
    // Which is, for any real photograph, after the pixels — far past anything
    // a streaming reader would still be holding.
    const far = tiff(457, 123, { at: 200_000 });
    assert.equal(readDimensions(far.subarray(0, DIMENSION_BYTES), 'image/tiff'), null,
      'the streaming pass should not have found it');
    assert.deepEqual(await readDimensionsWithSeek(seeker(far), 'image/tiff'),
      { width: 457, height: 123 });
  });

  test('the offset it reports is the one in the header', () => {
    assert.deepEqual(tiffDirectoryOffset(tiff(1, 1, { at: 12345 })), { offset: 12345, little: true });
    assert.equal(tiffDirectoryOffset(Buffer.from('not a tiff at all')), null);
  });

  test('a directory pointing past the end of the file gives nothing', async () => {
    const lying = tiff(457, 123, { at: 8 });
    lying.writeUInt32LE(5_000_000, 4);
    assert.equal(await readDimensionsWithSeek(seeker(lying), 'image/tiff'), null);
  });

  test('formats that keep the size at the front need no second read', async () => {
    let reads = 0;
    const counted = (buffer) => async (offset, length) => {
      reads += 1;
      return buffer.subarray(offset, offset + length);
    };
    assert.deepEqual(await readDimensionsWithSeek(counted(png(457, 123)), 'image/png'),
      { width: 457, height: 123 });
    assert.equal(reads, 1);
  });
});
