import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_SIGNATURES,
  KNOWN_IMAGE_TYPES,
  SNIFF_BYTES,
  looksLikeSvg,
  sniffImage,
} from '../server/sniff.js';
import * as browser from '../src/core/files.js';

/** A buffer whose leading bytes are `head` and the rest zeros. */
const withHead = (head, length = 64) => {
  const buffer = Buffer.alloc(length);
  Buffer.from(head).copy(buffer, 0);
  return buffer;
};

/** Real leading bytes for each format, as a file on disk would start. */
const SAMPLES = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/gif': [...Buffer.from('GIF89a')],
  'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
  'image/avif': [0, 0, 0, 0x20, ...Buffer.from('ftypavif')],
  'image/heic': [0, 0, 0, 0x18, ...Buffer.from('ftypheic')],
  'image/heif': [0, 0, 0, 0x18, ...Buffer.from('ftypmif1')],
  'image/bmp': [...Buffer.from('BM'), 0x36, 0, 0, 0],
  'image/tiff': [0x49, 0x49, 0x2a, 0x00],
  'image/x-icon': [0x00, 0x00, 0x01, 0x00, 0x01, 0x00],
};

describe('sniff: the bytes decide, not the name', () => {
  test('every known format is recognised from its own header', () => {
    for (const [type, head] of Object.entries(SAMPLES)) {
      assert.equal(sniffImage(withHead(head))?.type, type, `${type} was not recognised`);
    }
  });

  test('every type the table claims has a sample here', () => {
    // Otherwise a format could be added and never actually exercised.
    assert.deepEqual(KNOWN_IMAGE_TYPES.sort(), Object.keys(SAMPLES).sort());
  });

  test('a renamed executable is not an image', () => {
    // The case the whole check exists for: the browser reports image/png for
    // this because the name ends in .png.
    const elf = withHead([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
    assert.equal(sniffImage(elf), null);

    const script = withHead([...Buffer.from('#!/bin/sh\nrm -rf /')]);
    assert.equal(sniffImage(script), null);

    const zip = withHead([0x50, 0x4b, 0x03, 0x04]);
    assert.equal(sniffImage(zip), null);
  });

  test('a file shorter than one signature does not crash the sniffer', () => {
    for (const length of [0, 1, 2, 3]) {
      assert.doesNotThrow(() => sniffImage(Buffer.alloc(length)));
    }
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
  });

  test('a PNG header one byte off is refused', () => {
    const almost = withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
    assert.equal(sniffImage(almost), null);
  });
});

describe('sniff: SVG', () => {
  const svgs = [
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<?xml version="1.0"?><svg></svg>',
    '  \n<svg>',
    '<!-- a comment --><svg>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">',
  ];

  test('the spellings a real file uses are all detected', () => {
    for (const text of svgs) {
      assert.ok(looksLikeSvg(Buffer.from(text)), `not detected: ${text.slice(0, 24)}`);
    }
  });

  test('HTML that merely mentions svg is not SVG', () => {
    assert.equal(looksLikeSvg(Buffer.from('<html><body>svg</body></html>')), false);
    assert.equal(looksLikeSvg(Buffer.from('not markup at all')), false);
  });

  test('SVG never comes back from the binary sniffer', () => {
    // It must stay opt-in, and it gets there through looksLikeSvg alone.
    for (const text of svgs) assert.equal(sniffImage(Buffer.from(text)), null);
  });
});

describe('sniff: the browser and server tables agree', () => {
  test('the same formats are known on both sides', () => {
    assert.deepEqual(
      [...browser.KNOWN_IMAGE_TYPES].sort(),
      [...KNOWN_IMAGE_TYPES].sort()
    );
  });

  test('the same bytes give the same answer on both sides', () => {
    for (const [type, head] of Object.entries(SAMPLES)) {
      const buffer = withHead(head);
      assert.equal(
        browser.sniffImage(new Uint8Array(buffer))?.type,
        sniffImage(buffer)?.type,
        `${type} differs between the browser and the server`
      );
    }
  });

  test('both read the same number of leading bytes', () => {
    assert.equal(browser.SNIFF_BYTES, SNIFF_BYTES);
  });

  test('the longest signature fits inside the window both read', () => {
    const longest = Math.max(
      ...IMAGE_SIGNATURES.map((s) => s.offset + (s.ascii?.length ?? s.bytes.length))
    );
    assert.ok(longest <= SNIFF_BYTES, `a signature needs ${longest} bytes`);
  });
});
