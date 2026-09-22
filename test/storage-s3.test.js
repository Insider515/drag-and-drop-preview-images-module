import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createS3Storage } from '../server/storage/s3.js';
import { UploadService } from '../server/upload-service.js';
import { UploadError } from '../server/errors.js';
import { Readable } from 'node:stream';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 512) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - 8), 0x41)]);
const streamOf = (buffer) => Readable.from([buffer]);

/**
 * Something that speaks enough of the S3 API to answer.
 *
 * Checking against a fake rather than a real bucket is what lets these cases
 * say what the request looked like — which is the part that goes wrong.
 */
let server;
let endpoint;
let objects;
let requests;
let answer;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    const forced = answer(req);
    if (forced) {
      res.statusCode = forced.status;
      res.end(forced.body ?? '');
      return;
    }
    if (req.method === 'PUT') {
      objects.set(req.url, body);
      res.setHeader('etag', '"deadbeef"');
      res.statusCode = 200;
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      res.statusCode = objects.has(req.url) ? 200 : 404;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  endpoint = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

beforeEach(() => {
  objects = new Map();
  requests = [];
  answer = () => null;
});

const storage = (extra = {}) => createS3Storage({
  bucket: 'photos',
  region: 'eu-central-1',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  endpoint,
  ...extra,
});

/** A temp file to send, since the backend takes a path rather than bytes. */
async function tempFile(bytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 's3-'));
  const file = path.join(dir, 'temp');
  await fs.writeFile(file, bytes);
  return file;
}

describe('s3: what goes on the wire', () => {
  test('a file is PUT to the key it was given, with its bytes intact', async () => {
    const bytes = png(4096);
    const result = await storage().put('holiday.png', await tempFile(bytes), {
      type: 'image/png', size: bytes.length,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].url, '/photos/holiday.png');
    assert.ok(requests[0].body.equals(bytes), 'the bytes changed on the way');
    assert.equal(result.key, 'holiday.png');
    assert.equal(result.etag, '"deadbeef"');
  });

  test('it is signed, and the signature covers the body', async () => {
    const bytes = png(1024);
    await storage().put('a.png', await tempFile(bytes), { type: 'image/png', size: bytes.length });

    const { headers } = requests[0];
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    assert.match(headers.authorization, /SignedHeaders=[a-z0-9;-]+/);
    assert.match(headers.authorization, /Signature=[0-9a-f]{64}$/);
    // The body hash travels in its own header, and it is the body's.
    const crypto = await import('node:crypto');
    assert.equal(headers['x-amz-content-sha256'],
      crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.match(headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  });

  test('the secret never leaves the process', async () => {
    await storage().put('a.png', await tempFile(png()), { type: 'image/png', size: 512 });
    const seen = JSON.stringify(requests[0].headers) + requests[0].body.toString('latin1');
    assert.ok(!seen.includes('wJalrXUtnFEMI'), 'the secret key was sent');
  });

  test('the content type is the one read from the bytes', async () => {
    await storage().put('a.png', await tempFile(png()), { type: 'image/webp', size: 512 });
    assert.equal(requests[0].headers['content-type'], 'image/webp');
  });

  test('an ACL is sent only when the host asked for one', async () => {
    await storage().put('a.png', await tempFile(png()), { type: 'image/png', size: 512 });
    assert.equal(requests[0].headers['x-amz-acl'], undefined);

    await storage({ acl: 'public-read' }).put('b.png', await tempFile(png()), {
      type: 'image/png', size: 512,
    });
    assert.equal(requests[1].headers['x-amz-acl'], 'public-read');
  });

  test('a prefix becomes a folder inside the bucket', async () => {
    const result = await storage({ prefix: '/uploads/' }).put('a.png', await tempFile(png()), {
      type: 'image/png', size: 512,
    });
    assert.equal(requests[0].url, '/photos/uploads/a.png');
    assert.equal(result.key, 'uploads/a.png');
  });

  test('a name needing encoding survives it', async () => {
    await storage().put('holiday photo (2).png', await tempFile(png()), {
      type: 'image/png', size: 512,
    });
    assert.equal(requests[0].url, '/photos/holiday%20photo%20%282%29.png');
  });

  test('the URL handed back can be the host’s own', async () => {
    const result = await storage({ publicUrl: (key) => `https://cdn.example/${key}` })
      .put('a.png', await tempFile(png()), { type: 'image/png', size: 512 });
    assert.equal(result.url, 'https://cdn.example/a.png');
  });
});

describe('s3: claiming a key rather than asking about it', () => {
  test('the write carries the condition that makes the claim', async () => {
    const bytes = png(512);
    await storage().put('a.png', await tempFile(bytes), { type: 'image/png', size: bytes.length });

    assert.equal(requests.at(-1).headers['if-none-match'], '*');
    // Signed, not merely sent: a header the signature does not cover is a
    // header the service is entitled to ignore.
    assert.match(requests.at(-1).headers.authorization, /SignedHeaders=[^,]*if-none-match/);
  });

  test('a key taken in the meantime comes back as EXISTS, not as a failure', async () => {
    answer = (req) => (req.method === 'PUT' ? { status: 412, body: '' } : null);
    const bytes = png(512);

    const err = await storage()
      .put('a.png', await tempFile(bytes), { type: 'image/png', size: bytes.length })
      .then(() => null, (e) => e);

    assert.equal(err.code, 'EXISTS');
    assert.equal(err.status, 409);
  });

  test('overwrite asks for no condition, because it means what it says', async () => {
    const bytes = png(512);
    await storage().put('a.png', await tempFile(bytes), {
      type: 'image/png', size: bytes.length, overwrite: true,
    });

    assert.equal(requests.at(-1).headers['if-none-match'], undefined);
  });

  test('a service that cannot do it can be told not to be asked', async () => {
    const bytes = png(512);
    await createS3Storage({
      bucket: 'photos',
      region: 'eu-central-1',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      endpoint,
      conditionalWrites: false,
    }).put('a.png', await tempFile(bytes), { type: 'image/png', size: bytes.length });

    assert.equal(requests.at(-1).headers['if-none-match'], undefined);
  });

  test('a service that refuses the condition says which setting turns it off', async () => {
    // Quietly dropping the header would leave the race back in place while the
    // logs said everything was fine.
    answer = (req) => (req.method === 'PUT' ? { status: 501, body: 'NotImplemented' } : null);
    const bytes = png(512);

    const err = await storage()
      .put('a.png', await tempFile(bytes), { type: 'image/png', size: bytes.length })
      .then(() => null, (e) => e);

    assert.equal(err.message, 'The file could not be stored', 'the client learns nothing extra');
    assert.match(err.detail, /conditionalWrites: false/);
  });
});

describe('s3: when it goes wrong', () => {
  test('a refusal does not hand the service’s answer to the client', async () => {
    // That XML names the bucket and the key, which is nobody else's business.
    answer = () => ({ status: 403, body: '<Error><Message>SignatureDoesNotMatch</Message></Error>' });

    const err = await storage().put('a.png', await tempFile(png()), { type: 'image/png', size: 512 })
      .then(() => null, (e) => e);

    assert.ok(err instanceof UploadError);
    assert.equal(err.message, 'The file could not be stored');
    assert.ok(!err.message.includes('SignatureDoesNotMatch'));
    assert.match(err.detail, /S3 answered 403/, 'the reason was not kept for the log either');
  });

  test('an unreachable service is a failure of the moment, and says so', async () => {
    const unreachable = createS3Storage({
      bucket: 'photos', region: 'eu-central-1',
      accessKeyId: 'a', secretAccessKey: 'b',
      endpoint: 'http://127.0.0.1:9',
    });
    const err = await unreachable.put('a.png', await tempFile(png()), { type: 'image/png', size: 512 })
      .then(() => null, (e) => e);

    assert.equal(err.code, 'INTERNAL');
    assert.equal(err.status, 502);
  });

  test('missing credentials are refused when the backend is built', () => {
    for (const missing of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
      const options = {
        bucket: 'b', region: 'r', accessKeyId: 'a', secretAccessKey: 's', [missing]: undefined,
      };
      assert.throws(() => createS3Storage(options), new RegExp(missing));
    }
  });
});

describe('s3: as the upload service uses it', () => {
  let root;
  before(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'svc-'))); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('a stored file goes to the bucket and not to the disk', async () => {
    const service = new UploadService({ root, storage: storage() });
    const stored = await service.store('photo.png', streamOf(png(2048)));

    assert.equal(stored.name, 'photo.png');
    assert.equal(stored.key, 'photo.png');
    assert.match(stored.path, /^http:\/\/127\.0\.0\.1:\d+\/photos\/photo\.png$/);
    assert.deepEqual(await fs.readdir(root), [], 'the temp copy was left on disk');
  });

  test('the checks still run, and a refused file never reaches the bucket', async () => {
    // The whole reason the file goes to a temp copy first: none of these
    // questions can be asked about bytes that have already left.
    const service = new UploadService({ root, storage: storage() });

    const notAnImage = await service.store('evil.png', streamOf(Buffer.from('#!/bin/sh')))
      .then(() => null, (e) => e);
    assert.equal(notAnImage.code, 'NOT_AN_IMAGE');

    assert.equal(requests.length, 0, 'a refused file was sent to the bucket');
    assert.deepEqual(await fs.readdir(root), []);
  });

  test('a name already in the bucket is not written over', async () => {
    const service = new UploadService({ root, storage: storage() });
    const first = await service.store('photo.png', streamOf(png(1024)));
    const second = await service.store('photo.png', streamOf(png(1024)));

    assert.equal(first.key, 'photo.png');
    assert.equal(second.key, 'photo (2).png');
    assert.equal(objects.size, 2);
  });

  test('with overwrite it is written over, and nothing is asked first', async () => {
    const service = new UploadService({ root, storage: storage(), onConflict: 'overwrite' });
    await service.store('same.png', streamOf(png(1024)));
    const heads = requests.filter((r) => r.method === 'HEAD').length;
    await service.store('same.png', streamOf(png(2048)));

    assert.equal(requests.filter((r) => r.method === 'HEAD').length, heads);
    assert.equal(objects.size, 1);
  });

  test('refuse means refuse', async () => {
    const service = new UploadService({ root, storage: storage(), onConflict: 'refuse' });
    await service.store('once.png', streamOf(png(1024)));
    const err = await service.store('once.png', streamOf(png(1024))).then(() => null, (e) => e);

    assert.equal(err.code, 'EXISTS');
    assert.equal(err.status, 409);
  });

  test('the service refusing the key makes the upload service try the next name', async () => {
    // The whole point of the condition: the backend, not a look beforehand,
    // decides whether a name was free.
    let taken = true;
    answer = (req) => {
      if (req.method === 'HEAD') return { status: 404 };   // nothing sees it coming
      if (req.method === 'PUT' && taken) { taken = false; return { status: 412 }; }
      return null;
    };
    const service = new UploadService({ root, storage: storage() });
    const stored = await service.store('a.png', streamOf(png(1024)));

    assert.equal(stored.name, 'a (2).png', 'it wrote over the key the service refused');
    assert.equal(stored.key, 'a (2).png');
  });

  test('a session becomes a folder in the bucket too', async () => {
    // The folder comes from `subdir`, which is what the disk path files under,
    // so `scope: 'label'` — which sets no subdir — stays flat in both places.
    const service = new UploadService({ root, storage: storage() });
    const stored = await service.store('a.png', streamOf(png(1024)), {
      identity: 'anna',
      subdir: 'anna',
    });
    assert.equal(stored.key, 'anna/a.png');
    assert.equal(stored.name, 'a.png', 'the folder belongs to the key, not to the name');
    assert.equal(requests.at(-1).url, '/photos/anna/a.png');
  });

  test('a session that is only a label does not become a folder', async () => {
    // Measured before this: `scope: 'label'` left the disk flat and gave the
    // bucket a folder per session anyway, so the two disagreed about where a
    // file had gone — and an id like `a/b`, which the directory scope refuses
    // outright, quietly made nested keys.
    const service = new UploadService({ root, storage: storage() });
    const stored = await service.store('a.png', streamOf(png(1024)), {
      identity: 'a/b',
      subdir: null,
    });
    assert.equal(stored.key, 'a.png');
    assert.equal(requests.at(-1).url, '/photos/a.png');
  });

  test('a failure to store leaves nothing behind on either side', async () => {
    answer = (req) => (req.method === 'PUT' ? { status: 500, body: 'nope' } : null);
    const service = new UploadService({ root, storage: storage() });

    const err = await service.store('a.png', streamOf(png(1024))).then(() => null, (e) => e);
    assert.equal(err.code, 'INTERNAL');
    assert.deepEqual(await fs.readdir(root), [], 'the temp copy survived the failure');
    assert.equal(objects.size, 0);
  });

  test('without a backend everything still goes to disk', async () => {
    const service = new UploadService({ root });
    const stored = await service.store('local.png', streamOf(png(1024)));

    assert.equal(stored.path, path.join(root, 'local.png'));
    assert.equal(stored.key, undefined);
    assert.deepEqual(await fs.readdir(root), ['local.png']);
    await fs.rm(stored.path);
  });

  test('a backend that is not one is refused at mount time', () => {
    assert.throws(() => new UploadService({ root, storage: {} }), /put\(/);
    assert.throws(() => new UploadService({ root, storage: { put: 'yes' } }), /put\(/);
  });
});
