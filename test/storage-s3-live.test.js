/**
 * The S3 backend against a real server, rather than a stubbed `fetch`.
 *
 * Everything else about S3 is tested by handing it a fake `fetch` and reading
 * what it was about to send. That proves the request is the one intended; it
 * cannot prove a real server agrees, and request signing is exactly the kind
 * of thing that looks right until something at the far end says 403.
 *
 * So these tests need a server. Anything that speaks the S3 API will do —
 * MinIO is the easy one, and the CI workflow starts one:
 *
 *   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=user \
 *     -e MINIO_ROOT_PASSWORD=password123 quay.io/minio/minio server /data
 *
 * then run the suite with the four variables set:
 *
 *   S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=uploads \
 *     S3_KEY=user S3_SECRET=password123 npm test
 *
 * Without them the whole file is skipped, so `npm test` on a laptop with no
 * Docker stays a single command.
 *
 * Objects are written under a prefix unique to the run, so a second run does
 * not trip over the first one's files.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createS3Storage } from '../server/storage/s3.js';
import { createUploadHandler } from '../server/handler.js';
import { TEMP_PREFIX } from '../server/upload-service.js';

const config = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_KEY,
  secretAccessKey: process.env.S3_SECRET,
  region: process.env.S3_REGION ?? 'us-east-1',
};

const missing = Object.entries(config)
  .filter(([, value]) => !value)
  .map(([name]) => name);

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** A real PNG — signature, IHDR, one IDAT, IEND — so the header parses. */
function png(mark = 'x') {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(3, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = zlib.deflateSync(
    Buffer.concat([Buffer.alloc(1), Buffer.from(mark.padEnd(36, '.'))]),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Read an object back, signed here rather than by the code under test.
 *
 * Asking our own signing to confirm our own signing proves nothing: a request
 * signed wrong and read back wrong the same way still agrees with itself. This
 * is a second implementation, and the server is the judge of both.
 */
async function readBack(key) {
  // Every character but the unreserved set, which is where signing usually
  // goes wrong: `~` stays, `!'()*` do not, and a URL object disagrees on both.
  const encode = (part) => encodeURIComponent(part)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const uri = `/${[config.bucket, ...key.split('/')].map(encode).join('/')}`;
  const host = new URL(config.endpoint).host;

  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const canonical = [
    'GET', uri, '',
    `host:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${date}\n`,
    'host;x-amz-content-sha256;x-amz-date', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha(Buffer.from(canonical))].join('\n');

  let key256 = crypto.createHmac('sha256', `AWS4${config.secretAccessKey}`).update(day).digest();
  for (const part of [config.region, 's3', 'aws4_request']) {
    key256 = crypto.createHmac('sha256', key256).update(part).digest();
  }
  const signature = crypto.createHmac('sha256', key256).update(toSign).digest('hex');

  return fetch(config.endpoint + uri, {
    headers: {
      host,
      'x-amz-date': date,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, `
        + 'SignedHeaders=host;x-amz-content-sha256;x-amz-date, '
        + `Signature=${signature}`,
    },
  });
}

describe('s3: against a real server', {
  skip: missing.length
    ? `needs a running S3 server: set S3_ENDPOINT, S3_BUCKET, S3_KEY and S3_SECRET`
    : false,
}, () => {
  let store;
  let run;
  let tmp;
  const servers = [];
  const roots = [];

  /** A handler storing into the bucket, and the URL to post to. */
  async function endpoint(storage) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-s3-root-')));
    const server = http.createServer(createUploadHandler({ root, storage }));
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    servers.push(server);
    roots.push(root);
    return { root, base: `http://127.0.0.1:${server.address().port}` };
  }

  before(async () => {
    run = `live-${crypto.randomUUID().slice(0, 8)}`;
    store = createS3Storage({ ...config, prefix: run });
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-s3-')));
  });

  after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { server.close(resolve); });
    }
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Write bytes to a temp file, the way a finished upload reaches storage. */
  async function staged(name, bytes) {
    const file = path.join(tmp, name);
    await fs.writeFile(file, bytes);
    return file;
  }

  test('a file goes up and comes back byte for byte', async () => {
    const bytes = png('plain');
    assert.equal(await store.exists('plain.png'), false, 'something is already there');

    const stored = await store.put('plain.png', await staged('a.png', bytes), {
      type: 'image/png',
      size: bytes.length,
    });
    assert.equal(stored.key, `${run}/plain.png`);
    assert.ok(stored.etag, 'the server gave no etag');

    assert.equal(await store.exists('plain.png'), true);

    const back = await readBack(`${run}/plain.png`);
    assert.equal(back.status, 200);
    assert.equal(sha(Buffer.from(await back.arrayBuffer())), sha(bytes));
    assert.equal(back.headers.get('content-type'), 'image/png');
  });

  test("a name with spaces, cyrillic and +!~'*() is signed the way it is sent", async () => {
    // The characters AWS percent-encodes and a URL object does not. Signing the
    // one and sending the other is a 403 that only shows up against a server.
    const name = "фото (1)+копія!~'*.png";
    const bytes = png('awkward');

    const stored = await store.put(name, await staged('b.png', bytes), {
      type: 'image/png',
      size: bytes.length,
    });
    assert.equal(stored.key, `${run}/${name}`);
    assert.equal(await store.exists(name), true);

    const back = await readBack(`${run}/${name}`);
    assert.equal(back.status, 200, `reading it back answered ${back.status}`);
    assert.equal(sha(Buffer.from(await back.arrayBuffer())), sha(bytes));
  });

  test('prefix puts the file in a folder inside the bucket', async () => {
    const nested = createS3Storage({ ...config, prefix: `${run}/inbox/2026` });
    const bytes = png('nested');

    const stored = await nested.put('deep.png', await staged('c.png', bytes), {
      type: 'image/png',
      size: bytes.length,
    });
    assert.equal(stored.key, `${run}/inbox/2026/deep.png`);
    assert.equal(await nested.exists('deep.png'), true);
    assert.equal((await readBack(`${run}/inbox/2026/deep.png`)).status, 200);
  });

  test('a bucket that refuses says so without handing S3’s reply to the client', async () => {
    const wrong = createS3Storage({ ...config, bucket: 'no-such-bucket-here' });
    const file = await staged('d.png', png('nope'));

    await assert.rejects(
      () => wrong.put('x.png', file, { type: 'image/png', size: 64 }),
      (error) => {
        assert.equal(error.message, 'The file could not be stored');
        assert.match(error.detail ?? '', /S3 answered \d{3}/);
        return true;
      },
    );
  });

  test('a storage service that is not there is reported as unreachable', async () => {
    const dead = createS3Storage({ ...config, endpoint: 'http://127.0.0.1:9' });
    const file = await staged('e.png', png('dead'));

    await assert.rejects(
      () => dead.put('x.png', file, { type: 'image/png', size: 64 }),
      (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.message, 'The storage service could not be reached');
        return true;
      },
    );
  });

  test('an upload posted to the handler lands in the bucket and not on disk', async () => {
    const { base, root } = await endpoint(store);
    const bytes = png('through the handler');

    const body = new FormData();
    body.append('images[]', new Blob([bytes]), 'through.png');
    const response = await fetch(base, { method: 'POST', body });
    const json = await response.json();

    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json.uploaded?.length, 1, JSON.stringify(json));

    const back = await readBack(`${run}/${json.uploaded[0].name}`);
    assert.equal(back.status, 200, `the bucket does not have it: ${back.status}`);
    assert.equal(sha(Buffer.from(await back.arrayBuffer())), sha(bytes));

    const left = await fs.readdir(root);
    assert.deepEqual(left, [], `the local root kept ${left.join(', ')}`);
  });

  test('a name already in the bucket is given a suffix, not written over', async () => {
    const { base } = await endpoint(store);
    const names = [];

    for (const mark of ['first', 'second']) {
      const body = new FormData();
      body.append('images[]', new Blob([png(mark)]), 'twice.png');
      // eslint-disable-next-line no-await-in-loop
      const json = await (await fetch(base, { method: 'POST', body })).json();
      names.push(json.uploaded?.[0]?.name);
    }

    assert.equal(names[0], 'twice.png');
    assert.equal(names[1], 'twice (2).png', `the second upload was called ${names[1]}`);

    const first = await readBack(`${run}/twice.png`);
    assert.equal(sha(Buffer.from(await first.arrayBuffer())), sha(png('first')),
      'the first file was written over');
  });

  test('a storage failure leaves nothing behind on local disk', async () => {
    const broken = createS3Storage({ ...config, bucket: 'no-such-bucket-here' });
    const { base, root } = await endpoint(broken);

    const body = new FormData();
    body.append('images[]', new Blob([png('doomed')]), 'doomed.png');
    const response = await fetch(base, { method: 'POST', body });
    const json = await response.json();

    assert.ok(response.status >= 400 || json.failures?.length === 1, JSON.stringify(json));
    const left = (await fs.readdir(root)).filter((name) => name.startsWith(TEMP_PREFIX));
    assert.deepEqual(left, [], `temp files were left: ${left.join(', ')}`);
  });
});
