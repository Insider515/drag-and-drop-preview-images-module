import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createUploadHandler } from '../server/handler.js';
import { UploadService, TEMP_PREFIX } from '../server/upload-service.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 256) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - 8), 0x41)]);

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function endpoint(options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-sess-')));
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
  const tree = async () => (await fs.readdir(root, { recursive: true })).sort();
  return { base, root, tree };
}

/** Upload one file, carrying whatever cookie the test wants to present. */
async function upload(base, { cookie, name = 'photo.png', bytes = 256 } = {}) {
  const form = new FormData();
  form.append('images[]', new Blob([png(bytes)]), name);
  const response = await fetch(base, {
    method: 'POST',
    body: form,
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** The host's own session lookup — the module never does this itself. */
const SESSIONS = new Map([['sid=anna', 'anna'], ['sid=borys', 'borys']]);
const identify = (req) => SESSIONS.get(req.headers.cookie ?? '') ?? null;

describe('sessions: off unless the host asks for them', () => {
  test('with no sessions block nothing changes', async () => {
    const { base, tree } = await endpoint();
    const first = await upload(base, { cookie: 'sid=anna' });
    const second = await upload(base, { cookie: 'sid=borys' });

    assert.equal(first.status, 200);
    assert.equal(first.body.uploaded[0].owner, undefined, 'an owner appeared unasked');
    assert.equal(first.body.owner, undefined);

    // One flat directory, and the second upload of the same name is renamed
    // around the first — the behaviour the module has always had.
    assert.deepEqual(await tree(), ['photo (2).png', 'photo.png']);
    assert.equal(second.status, 200);
  });
});

describe('sessions: a directory each', () => {
  test('two visitors uploading the same name do not meet', async () => {
    const { base, tree } = await endpoint({ sessions: { identify } });

    const anna = await upload(base, { cookie: 'sid=anna' });
    const borys = await upload(base, { cookie: 'sid=borys' });

    assert.equal(anna.body.uploaded[0].name, 'photo.png');
    assert.equal(borys.body.uploaded[0].name, 'photo.png', 'the second was renamed around the first');
    assert.deepEqual(await tree(), ['anna', 'anna/photo.png', 'borys', 'borys/photo.png']);
  });

  test('the answer says who it was filed under', async () => {
    const { base } = await endpoint({ sessions: { identify } });
    const { body } = await upload(base, { cookie: 'sid=anna' });

    assert.equal(body.owner, 'anna');
    assert.equal(body.uploaded[0].owner, 'anna');
  });

  test('the same visitor twice keeps both files, in their own folder', async () => {
    const { base, tree } = await endpoint({ sessions: { identify } });
    await upload(base, { cookie: 'sid=anna' });
    await upload(base, { cookie: 'sid=anna' });

    assert.deepEqual(await tree(), ['anna', 'anna/photo (2).png', 'anna/photo.png']);
  });

  test('a visitor cannot reach another folder through their session id', async () => {
    // The id reaches this from a cookie, so it is the client's to forge.
    const hostile = new Map([
      ['sid=a', '../escape'],
      ['sid=b', '..'],
      ['sid=c', '/etc'],
      ['sid=d', 'a/b'],
      ['sid=e', 'CON'],
      ['sid=f', 'x\u0000y'],
    ]);
    const { base, root, tree } = await endpoint({
      sessions: { identify: (req) => hostile.get(req.headers.cookie ?? '') ?? null },
    });

    for (const cookie of [...hostile.keys()]) {
      const { status, body } = await upload(base, { cookie });
      assert.equal(status, 400, `${hostile.get(cookie)} was accepted`);
      assert.equal(body.code, 'INVALID_SESSION');
    }
    assert.deepEqual(await tree(), [], 'something was written anyway');
    assert.ok(!(await fs.readdir(path.dirname(root))).includes('escape'));
  });
});

describe('sessions: a label only', () => {
  test('files stay in one directory and the answer names the owner', async () => {
    const { base, tree } = await endpoint({ sessions: { identify, scope: 'label' } });

    const anna = await upload(base, { cookie: 'sid=anna' });
    const borys = await upload(base, { cookie: 'sid=borys' });

    assert.deepEqual(await tree(), ['photo (2).png', 'photo.png'], 'subdirectories were made');
    assert.equal(anna.body.uploaded[0].owner, 'anna');
    assert.equal(borys.body.uploaded[0].owner, 'borys');
  });

  test('an id no filesystem would take is still a usable label', async () => {
    // Nothing goes on disk under it, so it does not have to be a valid name.
    const { base } = await endpoint({
      sessions: { identify: () => 'user/42+ok', scope: 'label' },
    });
    const { status, body } = await upload(base);
    assert.equal(status, 200);
    assert.equal(body.uploaded[0].owner, 'user/42+ok');
  });
});

describe('sessions: a visitor with no session', () => {
  test('is refused by default', async () => {
    const { base, tree } = await endpoint({ sessions: { identify } });
    const { status, body } = await upload(base, { cookie: 'sid=nobody' });

    assert.equal(status, 403);
    assert.equal(body.code, 'NO_SESSION');
    assert.deepEqual(await tree(), [], 'the body was stored despite the refusal');
  });

  test('falls back to the shared root when the host allows it', async () => {
    const { base, tree } = await endpoint({ sessions: { identify, required: false } });

    await upload(base, { cookie: 'sid=nobody' });
    await upload(base, { cookie: 'sid=anna' });

    assert.deepEqual(await tree(), ['anna', 'anna/photo.png', 'photo.png']);
  });

  test('the refusal comes before the body is read', async () => {
    const { base } = await endpoint({ sessions: { identify } });

    // A body that starts and then never finishes. If the answer only came
    // after reading it, this would hang instead of returning — which is the
    // point: a visitor with nowhere to put files should not get to stream
    // megabytes at the disk first.
    const boundary = '----stall';
    const body = new ReadableStream({
      start(c) {
        c.enqueue(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="a.png"\r\n` +
          'Content-Type: image/png\r\n\r\n'
        ));
        c.enqueue(png(4096));
        // No closing boundary, ever.
      },
    });

    const answered = fetch(base, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: 'sid=nobody' },
      body,
      duplex: 'half',
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve('hung'), 5000));
    const response = await Promise.race([answered, timeout]);

    assert.notEqual(response, 'hung', 'the server waited for a body it was going to refuse');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'NO_SESSION');
  });
});

describe('sessions: a hook that misbehaves', () => {
  test('one that throws is a 500, not a crash', async () => {
    const { base } = await endpoint({
      sessions: { identify: () => { throw new Error('session store is down'); } },
    });
    const { status, body } = await upload(base);
    assert.equal(status, 500);
    assert.equal(body.code, 'INTERNAL');
    assert.ok(!JSON.stringify(body).includes('session store is down'), 'the internal message leaked');
  });

  test('an async one is awaited', async () => {
    const { base, tree } = await endpoint({
      sessions: { identify: async (req) => { await new Promise((r) => setTimeout(r, 5)); return identify(req); } },
    });
    await upload(base, { cookie: 'sid=anna' });
    assert.deepEqual(await tree(), ['anna', 'anna/photo.png']);
  });

  test('a misconfigured block is refused at mount time, not at request time', () => {
    const root = os.tmpdir();
    assert.throws(() => createUploadHandler({ root, sessions: {} }), /identify must be a function/);
    assert.throws(
      () => createUploadHandler({ root, sessions: { identify: () => 'x', scope: 'nonsense' } }),
      /scope must be/
    );
  });
});

describe('sessions: housekeeping', () => {
  test('rename() is told which session it is naming a file for', async () => {
    const seen = [];
    const { base, tree } = await endpoint({
      sessions: { identify },
      rename: (name, meta) => {
        seen.push(meta.identity);
        return `${meta.identity}-${name}`;
      },
    });
    await upload(base, { cookie: 'sid=anna' });

    assert.deepEqual(seen, ['anna']);
    assert.deepEqual(await tree(), ['anna', 'anna/anna-photo.png']);
  });

  test('the temp sweep reaches into session folders', async () => {
    // Abandoned temp files live one level down once sessions are on; a sweep
    // that only looked at the root would report nothing to do.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-sweep-')));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'anna'), { recursive: true });
    await fs.writeFile(path.join(root, `${TEMP_PREFIX}old`), 'x');
    await fs.writeFile(path.join(root, 'anna', `${TEMP_PREFIX}old`), 'x');
    await fs.writeFile(path.join(root, 'anna', 'keep.png'), 'x');

    const service = new UploadService({ root });
    assert.equal(await service.sweepTemp(-1), 2);
    assert.deepEqual((await fs.readdir(root, { recursive: true })).sort(), ['anna', 'anna/keep.png']);
  });
});
