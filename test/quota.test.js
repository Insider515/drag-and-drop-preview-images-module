import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createUploadHandler } from '../server/handler.js';
import { clientKey, createQuota, normaliseQuota } from '../server/quota.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 1024) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - 8), 0x41)]);

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function endpoint(options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quota-')));
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
  return { base, root, count: async () => (await fs.readdir(root)).filter((n) => !n.startsWith('.')).length };
}

/** One file in one request, the way the widget sends them. */
async function upload(base, name, size = 1024, headers = {}) {
  const form = new FormData();
  form.append('images[]', new Blob([png(size)]), name);
  const response = await fetch(base, { method: 'POST', body: form, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe('quota: the tally itself', () => {
  test('it counts files and bytes inside the window', () => {
    let clock = 1000;
    const quota = createQuota(normaliseQuota({ files: 3, bytes: 10_000, windowMs: 1000 }), () => clock);

    quota.take('anna', 4000);
    quota.take('anna', 4000);
    assert.deepEqual(quota.spent('anna'), { files: 2, bytes: 8000 });
    assert.equal(quota.allows('anna', 1000), true);
    assert.equal(quota.allows('anna', 5000), false, 'bytes were not counted');

    quota.take('anna', 1000);
    assert.equal(quota.allows('anna', 1), false, 'the file count was not counted');
  });

  test('what falls out of the window stops counting', () => {
    let clock = 1000;
    const quota = createQuota(normaliseQuota({ files: 1, windowMs: 1000 }), () => clock);

    quota.take('anna', 10);
    assert.equal(quota.allows('anna', 10), false);

    clock += 1001;
    assert.equal(quota.allows('anna', 10), true, 'the window never moved');
    assert.deepEqual(quota.spent('anna'), { files: 0, bytes: 0 });
  });

  test('one client’s tally is not another’s', () => {
    const quota = createQuota(normaliseQuota({ files: 1 }));
    quota.take('anna', 10);
    assert.equal(quota.allows('anna', 10), false);
    assert.equal(quota.allows('borys', 10), true);
  });

  test('it forgets people rather than growing for ever', () => {
    let clock = 1000;
    const quota = createQuota(normaliseQuota({ files: 5, windowMs: 100 }), () => clock);
    for (let i = 0; i < 50; i += 1) quota.take(`visitor-${i}`, 10);
    assert.equal(quota.size, 50);

    clock += 200;
    assert.equal(quota.sweep(), 0, 'the tally kept people whose window had passed');
    assert.equal(quota.size, 0);
  });

  test('a block that limits nothing is refused', () => {
    assert.throws(() => normaliseQuota({}), /needs files, bytes, or both/);
    assert.throws(() => normaliseQuota({ files: -1 }), /files must be/);
    assert.throws(() => normaliseQuota({ bytes: 'lots' }), /bytes must be/);
    assert.throws(() => normaliseQuota({ files: 1, windowMs: 0 }), /windowMs/);
    assert.equal(normaliseQuota(null), null);
  });

  test('the key is the session when there is one, the address otherwise', () => {
    const req = { socket: { remoteAddress: '203.0.113.7' } };
    assert.equal(clientKey(req, 'anna'), 'session:anna');
    assert.equal(clientKey(req, null), 'address:203.0.113.7');
    assert.equal(clientKey({}, null), 'address:unknown');
  });
});

describe('quota: over HTTP, one file to a request', () => {
  test('a file cap spans requests, which is the whole point', async () => {
    // Measured before this existed: limits of three files and 20 KB let ten
    // files totalling 80 KB through, because each request carried one file.
    const { base, count } = await endpoint({ limits: { perClient: { files: 3 } } });

    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await upload(base, `f${i}.png`));

    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 429, 429, 429]);
    assert.equal(results[3].body.code, 'QUOTA');
    assert.equal(await count(), 3, 'more files reached the disk than the cap allows');
  });

  test('a byte cap does the same', async () => {
    const { base, count } = await endpoint({ limits: { perClient: { bytes: 5 * 1024 } } });

    const first = await upload(base, 'a.png', 4 * 1024);
    const second = await upload(base, 'b.png', 4 * 1024);

    assert.equal(first.status, 200);
    assert.equal(second.status, 429, 'the byte budget was not enforced');
    assert.equal(await count(), 1);
  });

  test('the refusal says when to come back', async () => {
    const { base } = await endpoint({ limits: { perClient: { files: 1, windowMs: 30_000 } } });
    await upload(base, 'a.png');

    const form = new FormData();
    form.append('images[]', new Blob([png()]), 'b.png');
    const response = await fetch(base, { method: 'POST', body: form });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '30');
  });

  test('the body is not read once the budget is gone', async () => {
    // Refusing after taking a megabyte would be a strange sort of limit.
    const { base } = await endpoint({ limits: { perClient: { files: 1 } } });
    await upload(base, 'a.png');

    let bytesSeen = 0;
    const stalling = new ReadableStream({
      start(c) {
        c.enqueue(Buffer.from('--x\r\nContent-Disposition: form-data; name="images[]"; filename="b.png"\r\n\r\n'));
        bytesSeen += 1;
      },
    });
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: stalling,
      duplex: 'half',
    });
    assert.equal(response.status, 429, 'it waited for a body it was going to refuse');
  });

  test('a batch that runs out part-way keeps what landed and explains the rest', async () => {
    const { base, count } = await endpoint({ limits: { perClient: { files: 2 }, maxFiles: 10 } });

    const form = new FormData();
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png']) {
      form.append('images[]', new Blob([png()]), name);
    }
    const answer = await (await fetch(base, { method: 'POST', body: form })).json();

    assert.deepEqual(answer.uploaded.map((u) => u.original), ['a.png', 'b.png']);
    assert.deepEqual(answer.failures.map((f) => f.code), ['QUOTA', 'QUOTA']);
    assert.equal(await count(), 2);
  });

  test('two visitors do not spend each other’s budget', async () => {
    const sessions = new Map([['sid=anna', 'anna'], ['sid=borys', 'borys']]);
    const { base } = await endpoint({
      limits: { perClient: { files: 1 } },
      sessions: { identify: (req) => sessions.get(req.headers.cookie ?? '') ?? null },
    });

    assert.equal((await upload(base, 'a.png', 1024, { cookie: 'sid=anna' })).status, 200);
    assert.equal((await upload(base, 'b.png', 1024, { cookie: 'sid=anna' })).status, 429);
    assert.equal((await upload(base, 'c.png', 1024, { cookie: 'sid=borys' })).status, 200,
      'one visitor spent another’s budget');
  });

  test('without the block nothing is counted', async () => {
    const { base, count } = await endpoint({ limits: { maxFiles: 10 } });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await upload(base, `f${i}.png`)).status, 200);
    }
    assert.equal(await count(), 5);
  });
});
