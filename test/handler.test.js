import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createUploadHandler } from '../server/handler.js';
import { TEMP_PREFIX } from '../server/upload-service.js';

let server;
let base;
let root;

/**
 * Everything here runs over bare node:http. The handler must work with nothing
 * but node's own request and response — testing it inside Express would hide a
 * dependency on Express having been there.
 */
async function start(options = {}) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-http-')));
  server = http.createServer(createUploadHandler({ root, basePath: '/api/upload', ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/upload`;
}

async function stop() {
  // Node's fetch keeps its sockets alive, and `close()` waits for every one of
  // them — without this the suite hangs between describes rather than moving on.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

function png(size = 1024) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x41)]);
}

/** POST a multipart body built from `[name, bytes]` pairs. */
function send(files, { field = 'images[]', headers = {}, fields = {} } = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  for (const [name, bytes] of files) {
    body.append(field, new Blob([bytes]), name);
  }
  return fetch(base, { method: 'POST', body, headers });
}

const listed = async () =>
  (await fs.readdir(root)).filter((n) => !n.startsWith(TEMP_PREFIX)).sort();

describe('handler: uploading over bare node:http', () => {
  before(() => start());
  after(stop);

  test('a real image is stored and reported back', async () => {
    const response = await send([['photo.png', png()]]);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.uploaded.length, 1);
    assert.equal(body.uploaded[0].name, 'photo.png');
    assert.equal(body.uploaded[0].type, 'image/png');
    assert.deepEqual(body.failures, []);
    assert.ok((await listed()).includes('photo.png'));
  });

  test('several files in one request', async () => {
    const response = await send([['a.png', png()], ['b.png', png(2048)]]);
    const body = await response.json();
    assert.equal(body.uploaded.length, 2);
  });

  test('extra form fields come back', async () => {
    const response = await send([['c.png', png()]], { fields: { album: 'holiday' } });
    assert.equal((await response.json()).fields.album, 'holiday');
  });

  test('/config says what the endpoint accepts', async () => {
    const body = await (await fetch(`${base}/config`)).json();
    assert.ok(body.accept.includes('image/png'));
    assert.equal(body.allowSvg, false);
    assert.ok(body.limits.maxFileSize > 0);
  });

  test('a body that is not multipart is refused', async () => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'NOT_MULTIPART');
  });

  test('a request with no files is refused', async () => {
    const response = await send([]);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'NO_FILES');
  });
});

describe('handler: one bad file does not lose the good ones', () => {
  before(() => start());
  after(stop);

  test('the batch reports what landed and what did not, with codes', async () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(256)]);
    const response = await send([
      ['good.png', png()],
      ['evil.png', elf],
      ['also-good.png', png(2048)],
    ]);

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.uploaded.map((u) => u.name).sort(), ['also-good.png', 'good.png']);
    assert.equal(body.failures.length, 1);
    assert.equal(body.failures[0].name, 'evil.png');
    assert.equal(body.failures[0].code, 'NOT_AN_IMAGE');
    assert.ok(!(await listed()).includes('evil.png'));
  });

});

describe('handler: a failure says which limit it hit', () => {
  // Its own server, because restarting the shared one from inside a describe
  // that already owns it deadlocks the run.
  before(() => start({ limits: { maxFileSize: 2048 } }));
  after(stop);

  test('the params travel with the code', async () => {
    const body = await (await send([['big.png', png(8192)]])).json();
    assert.equal(body.failures[0].code, 'TOO_LARGE');
    assert.deepEqual(body.failures[0].params, { limit: 2048 });
  });
});

describe('handler: limits', () => {
  before(() => start({ limits: { maxFiles: 2 } }));
  after(stop);

  test('files past the count limit are reported, not silently dropped', async () => {
    const body = await (await send([
      ['a.png', png()], ['b.png', png()], ['c.png', png()],
    ])).json();
    assert.equal(body.uploaded.length, 2);
    assert.equal(body.failures.length, 1);
    assert.equal(body.failures[0].code, 'TOO_MANY');
  });
});

describe('handler: the request budget is spent, not checked afterwards', () => {
  before(() => start({ limits: { maxFileSize: 4096, maxRequestSize: 6144, maxFiles: 10 } }));
  after(stop);

  test('a file that would exceed the total never reaches the disk', async () => {
    // The regression this guards: the total used to be compared after the file
    // had been stored, so the one that went over was reported as refused and
    // left on disk anyway — the limit did nothing.
    const body = await (await send([
      ['a.png', png(3072)], ['b.png', png(3072)], ['c.png', png(3072)],
    ])).json();

    assert.deepEqual(body.uploaded.map((u) => u.name), ['a.png', 'b.png']);
    assert.equal(body.failures[0].code, 'TOTAL_TOO_LARGE');
    assert.deepEqual(await listed(), ['a.png', 'b.png']);

    let total = 0;
    for (const name of await listed()) {
      total += (await fs.stat(path.join(root, name))).size;
    }
    assert.ok(total <= 6144, `${total} bytes on disk, budget was 6144`);
  });
});

describe('handler: cross-origin', () => {
  before(() => start());
  after(stop);

  test('a form posted from another site is refused', async () => {
    // multipart/form-data is a *simple* request, so it is not preflighted: a
    // <form> on any site could post here under the user's cookie. This is the
    // check that closes that.
    const response = await send([['x.png', png()]], {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CROSS_ORIGIN');
    assert.deepEqual(await listed(), []);
  });

  test('a same-origin form is allowed', async () => {
    const origin = new URL(base).origin;
    const response = await send([['ok.png', png()]], {
      headers: { origin, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(response.status, 200);
  });

  test('a request with no browser headers at all is allowed', async () => {
    // curl and server-to-server calls, which are not the threat being closed.
    assert.equal((await send([['curl.png', png()]])).status, 200);
  });
});

describe('handler: authorize', () => {
  before(() => start({ authorize: (req) => req.headers['x-token'] === 'let-me-in' }));
  after(stop);

  test('refused before the body is read', async () => {
    const response = await send([['x.png', png()]]);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'DENIED');
    assert.deepEqual(await listed(), []);
  });

  test('allowed with the token', async () => {
    const response = await send([['x.png', png()]], { headers: { 'x-token': 'let-me-in' } });
    assert.equal(response.status, 200);
  });
});

describe('handler: the two halves agree out of the box', () => {
  before(() => start());
  after(stop);

  test('the widget default and the handler default are the same field', async () => {
    // They were not, and nothing worked without configuring one of them: the
    // widget posted `images[]`, the handler read `files[]`, drained it, and
    // answered "no files were sent" after the whole body had crossed the wire.
    const { DEFAULTS } = await import('../src/drop-preview.js');
    const response = await send([['a.png', png()]], { field: DEFAULTS.name });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).uploaded.length, 1);
  });
});

describe('handler: mounting', () => {
  before(() => start());
  after(stop);

  test('the mount prefix is stripped by basePath', async () => {
    // Without it the pathname would be /api/upload and match no route.
    assert.equal((await fetch(`${base}/config`)).status, 200);
  });

  test('an unknown route is a 404 with a code, not a hang', async () => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  });

  test('the service is reachable for a host that wants it', async () => {
    const handler = createUploadHandler({ root });
    // Awaited, or its init outlives the test and trips over the temp directory
    // the teardown has already taken away.
    await handler.service.init();
    assert.equal(typeof handler.service.store, 'function');
  });
});
