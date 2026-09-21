import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createUploadHandler } from '../server/handler.js';
import { TEMP_PREFIX } from '../server/upload-service.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - 8), 0x41)]);

let root;
let server;
let base;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-abort-'));
  server = http.createServer(createUploadHandler({ root }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  await fs.rm(root, { recursive: true, force: true });
});

const listing = async () => (await fs.readdir(root)).sort();
const temps = async () => (await listing()).filter((n) => n.startsWith(TEMP_PREFIX));

/**
 * Start an upload and cut the connection part-way through the file, the way a
 * closed tab or a lost signal does.
 */
async function abortMidUpload({ bytes = 64 * 1024, afterMs = 40 } = {}) {
  const boundary = '----abort';
  const controller = new AbortController();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="a.png"\r\n` +
        'Content-Type: image/png\r\n\r\n'
      ));
      c.enqueue(png(bytes));
      // No closing boundary is ever sent: the request simply stops.
      setTimeout(() => controller.abort(), afterMs);
    },
  });

  await fetch(base, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: 'half',
    signal: controller.signal,
  }).catch(() => {});

  // Let the server finish reacting to the dead socket.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe('a request that dies part-way through', () => {
  test('leaves no half-written file behind', async () => {
    await abortMidUpload();
    assert.deepEqual(await temps(), [], 'a temp file was abandoned');
    assert.deepEqual(await listing(), [], 'a partial upload was kept as if it had finished');
  });

  test('is still clean after many of them', async () => {
    // One leaked file per abort is a disk a client can fill on purpose.
    for (let i = 0; i < 6; i += 1) await abortMidUpload({ afterMs: 20 + i * 10 });
    assert.deepEqual(await temps(), []);
    assert.deepEqual(await listing(), []);
  });

  test('does not stop the next upload from working', async () => {
    await abortMidUpload();

    const form = new FormData();
    form.append('images[]', new Blob([png(512)]), 'after.png');
    const response = await fetch(base, { method: 'POST', body: form });
    const answer = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(answer.uploaded.map((u) => u.name), ['after.png']);
    assert.deepEqual(await temps(), []);

    await fs.rm(path.join(root, 'after.png'), { force: true });
  });
});
