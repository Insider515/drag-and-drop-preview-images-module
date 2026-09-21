import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';

import { createUploadHandler } from '../server/handler.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 512) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - 8), 0x41)]);

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

/** A live endpoint with the given options, torn down at the end of the file. */
async function endpoint(options = {}) {
  const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-guard-'));
  const server = http.createServer(createUploadHandler({ root, ...options }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { base, root };
}

/** Post one file, optionally with browser headers a hostile page would send. */
async function post(base, headers = {}, { name = 'a.png', bytes = 512 } = {}) {
  const form = new FormData();
  form.append('images[]', new Blob([png(bytes)]), name);
  const response = await fetch(base, { method: 'POST', body: form, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe('allowedOrigins: a list', () => {
  test('an origin on the list is let in, one beside it is not', async () => {
    const { base } = await endpoint({ allowedOrigins: ['https://app.example'] });

    assert.equal((await post(base, { origin: 'https://app.example' })).status, 200);

    const refused = await post(base, { origin: 'https://app.example.evil' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'CROSS_ORIGIN');
  });

  test('a sandboxed iframe posting "null" is refused, not read as absent', async () => {
    // Sandboxed frames and some redirect chains send the literal string; an
    // Origin check that treats it as missing lets exactly those through.
    const { base } = await endpoint({ allowedOrigins: ['https://app.example'] });
    const refused = await post(base, { origin: 'null' });
    assert.equal(refused.status, 403);
  });
});

describe('allowedOrigins: a function', () => {
  test('the host decides, and sees the request', async () => {
    const seen = [];
    const { base } = await endpoint({
      allowedOrigins: (origin, req) => {
        seen.push([origin, req.method]);
        return origin.endsWith('.trusted.example');
      },
    });

    assert.equal((await post(base, { origin: 'https://a.trusted.example' })).status, 200);
    assert.equal((await post(base, { origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(seen.map(([o]) => o), ['https://a.trusted.example', 'https://evil.example']);
  });
});

describe('allowedOrigins: turned off', () => {
  test('false lets a cross-origin post through, for a host that checks elsewhere', async () => {
    const { base } = await endpoint({ allowedOrigins: false });
    assert.equal((await post(base, { origin: 'https://anywhere.example' })).status, 200);
  });
});

describe('maxConcurrent', () => {
  test('uploads past the limit are refused with 503, not queued for ever', async () => {
    const { base } = await endpoint({ maxConcurrent: 1 });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post(base, {}, { name: `f${i}.png`, bytes: 400 * 1024 }))
    );
    const codes = results.map((r) => r.status);

    assert.ok(codes.includes(200), 'no upload got through at all');
    assert.ok(codes.every((c) => c === 200 || c === 503), `unexpected statuses: ${codes.join(', ')}`);
    for (const refused of results.filter((r) => r.status === 503)) {
      assert.equal(refused.body.code, 'BUSY');
    }
  });

  test('the slots are given back, so the endpoint works again afterwards', async () => {
    const { base } = await endpoint({ maxConcurrent: 1 });
    await Promise.all(Array.from({ length: 4 }, (_, i) => post(base, {}, { name: `x${i}.png` })));
    assert.equal((await post(base, {}, { name: 'later.png' })).status, 200);
  });
});

describe('an upload directory that cannot be used', () => {
  test('answers 500 with a code rather than crashing the process', async () => {
    // A path that is a file, not a directory: nothing can be written into it.
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-bad-')), 'not-a-dir');
    await fs.writeFile(file, 'x');

    const { base } = await endpoint({ root: file });
    const result = await post(base);

    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'INTERNAL');
    assert.ok(!JSON.stringify(result.body).includes(file), 'the path on disk was handed to the client');
  });

  test('and keeps answering that way, rather than failing differently each time', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-bad2-')), 'not-a-dir');
    await fs.writeFile(file, 'x');
    const { base } = await endpoint({ root: file });

    const first = await post(base);
    const second = await post(base);
    assert.deepEqual([first.status, second.status], [500, 500]);
    assert.equal(second.body.code, 'INTERNAL');
  });
});

describe('more files than the limit allows', () => {
  test('the extras are reported by name, not dropped in silence', async () => {
    const { base, root } = await endpoint({ limits: { maxFiles: 2 } });

    const form = new FormData();
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png']) {
      form.append('images[]', new Blob([png(256)]), name);
    }
    const response = await fetch(base, { method: 'POST', body: form });
    const answer = await response.json();

    assert.deepEqual(answer.uploaded.map((u) => u.original), ['a.png', 'b.png']);
    assert.ok(answer.failures.length >= 1);
    assert.equal(answer.failures[0].code, 'TOO_MANY');
    assert.deepEqual(answer.failures[0].params, { limit: 2 });
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.png', 'b.png']);
  });
});

describe('fields that are not files', () => {
  test('travel with the upload and come back', async () => {
    const { base } = await endpoint();
    const form = new FormData();
    form.append('album', 'holiday');
    form.append('images[]', new Blob([png()]), 'a.png');
    const answer = await (await fetch(base, { method: 'POST', body: form })).json();
    assert.equal(answer.fields.album, 'holiday');
  });

  test('a file under a field name this endpoint does not read is ignored', async () => {
    // It still has to be drained, or the parser stalls on it.
    const { base, root } = await endpoint();
    const form = new FormData();
    form.append('avatar', new Blob([png(2048)]), 'other.png');
    form.append('images[]', new Blob([png()]), 'a.png');
    const answer = await (await fetch(base, { method: 'POST', body: form })).json();

    assert.deepEqual(answer.uploaded.map((u) => u.original), ['a.png']);
    assert.deepEqual(await fs.readdir(root), ['a.png']);
  });
});

describe('a decompression bomb over HTTP', () => {
  /** A tiny PNG claiming to be enormous. */
  function bomb(width, height) {
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
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  test('is refused by the server, not only by the browser', async () => {
    // curl does not run the client's checks, which is the whole point of
    // having this one.
    const { base, root } = await endpoint();
    const form = new FormData();
    form.append('images[]', new Blob([bomb(40000, 40000)]), 'bomb.png');
    const response = await fetch(base, { method: 'POST', body: form });
    const answer = await response.json();

    assert.equal(response.status, 400);
    assert.equal(answer.uploaded.length, 0);
    assert.equal(answer.failures[0].code, 'TOO_MANY_PIXELS');
    assert.deepEqual(answer.failures[0].params, {
      limit: 50 * 1024 * 1024, width: 40000, height: 40000,
    });
    assert.deepEqual(await fs.readdir(root), [], 'the bomb reached the disk');
  });

  test('the good files in the same request still land', async () => {
    const { base, root } = await endpoint();
    const form = new FormData();
    form.append('images[]', new Blob([bomb(40000, 40000)]), 'bomb.png');
    form.append('images[]', new Blob([bomb(200, 200)]), 'fine.png');
    const answer = await (await fetch(base, { method: 'POST', body: form })).json();

    assert.deepEqual(answer.uploaded.map((u) => u.original), ['fine.png']);
    assert.deepEqual(answer.failures.map((f) => f.code), ['TOO_MANY_PIXELS']);
    assert.deepEqual(await fs.readdir(root), ['fine.png']);
  });
});
