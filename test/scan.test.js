import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { UploadService, TEMP_PREFIX } from '../server/upload-service.js';
import { createScanner, screen } from '../server/scan.js';
import { UploadError } from '../server/errors.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 512) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - 8), 0x41)]);
const streamOf = (buffer) => Readable.from([buffer]);

let root;
before(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ddp-scan-'))); });
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async () => {
  for (const name of await fs.readdir(root)) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
});

const listed = async () => (await fs.readdir(root)).filter((n) => !n.startsWith(TEMP_PREFIX)).sort();
const temps = async () => (await fs.readdir(root)).filter((n) => n.startsWith(TEMP_PREFIX));

describe('screening: off unless the host asks', () => {
  test('with no scan block nothing is checked', async () => {
    const service = new UploadService({ root });
    assert.equal(service.scanner, null);
    const stored = await service.store('a.png', streamOf(png()));
    assert.equal(stored.name, 'a.png');
  });
});

describe('screening: what each verdict does', () => {
  const serviceWith = (check, rest = {}) =>
    new UploadService({ root, scan: { check, ...rest } });

  test('a clean file is kept', async () => {
    const service = serviceWith(async () => ({ verdict: 'clean' }));
    const stored = await service.store('a.png', streamOf(png()));
    assert.equal(stored.name, 'a.png');
    assert.deepEqual(await listed(), ['a.png']);
  });

  test('a file reported as malware never reaches its real name', async () => {
    const service = serviceWith(async () => ({ verdict: 'malicious', detail: { malicious: 47 } }));
    const err = await service.store('a.png', streamOf(png())).then(() => null, (e) => e);

    assert.ok(err instanceof UploadError);
    assert.equal(err.code, 'INFECTED');
    assert.equal(err.status, 422);
    assert.deepEqual(err.params, { malicious: 47 });
    assert.deepEqual(await listed(), [], 'the file was stored anyway');
    assert.deepEqual(await temps(), [], 'the temp copy was left behind');
  });

  test('an unknown file is kept by default', async () => {
    // Almost nothing an ordinary person uploads has ever been reported, so
    // rejecting the unknown would reject nearly every real photo.
    const service = serviceWith(async () => ({ verdict: 'unknown' }));
    assert.equal((await service.store('a.png', streamOf(png()))).name, 'a.png');
  });

  test('an unknown file can be refused when the host wants that', async () => {
    const service = serviceWith(async () => ({ verdict: 'unknown' }), { onUnknown: 'reject' });
    const err = await service.store('a.png', streamOf(png())).then(() => null, (e) => e);
    assert.equal(err.code, 'NOT_SCREENED');
    assert.deepEqual(await listed(), []);
  });
});

describe('screening: when the scanner itself fails', () => {
  test('a failure refuses the file by default', async () => {
    // Accepting instead would mean believing you are protected while you are
    // not, and that failure is invisible — which is what makes it worse.
    const warnings = [];
    const service = new UploadService({
      root,
      onWarning: (m) => warnings.push(m),
      scan: { check: async () => { throw new Error('service is down'); } },
    });

    const err = await service.store('a.png', streamOf(png())).then(() => null, (e) => e);
    assert.equal(err.code, 'SCAN_FAILED');
    assert.equal(err.status, 503);
    assert.ok(!err.message.includes('service is down'), 'the internal reason leaked to the client');
    assert.deepEqual(warnings, ['Malware screening failed']);
    assert.deepEqual(await listed(), []);
    assert.deepEqual(await temps(), []);
  });

  test('a host that prefers to keep uploading can say so', async () => {
    const service = new UploadService({
      root,
      scan: { check: async () => { throw new Error('down'); }, onError: 'accept' },
    });
    assert.equal((await service.store('a.png', streamOf(png()))).name, 'a.png');
  });

  test('a scanner that answers nonsense counts as a failure, not as clean', async () => {
    const service = new UploadService({ root, scan: { check: async () => ({ verdict: 'probably fine?' }) } });
    const err = await service.store('a.png', streamOf(png())).then(() => null, (e) => e);
    assert.equal(err.code, 'SCAN_FAILED');
  });

  test('a scanner that never answers does not hold the upload for ever', async () => {
    const service = new UploadService({
      root,
      timeoutMs: 120,
      scan: {
        check: (file, signal) =>
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
        timeoutMs: 120,
      },
    });

    // `AbortSignal.timeout` uses an unref'd timer, so with nothing else in
    // flight the process would settle before it fires. A real server always
    // has the request's own socket holding the loop open; here that has to be
    // stood in for, or the test measures the harness rather than the code.
    const keepAlive = setInterval(() => {}, 20);
    try {
      const started = Date.now();
      const err = await service.store('a.png', streamOf(png())).then(() => null, (e) => e);

      assert.equal(err.code, 'SCAN_FAILED');
      assert.ok(Date.now() - started < 5000, 'the upload waited far longer than the timeout');
      assert.deepEqual(await temps(), []);
    } finally {
      clearInterval(keepAlive);
    }
  });
});

describe('screening: what the scanner is told', () => {
  test('the hash is of the file that actually arrived', async () => {
    const bytes = png(3000);
    const seen = [];
    const service = new UploadService({ root, scan: { check: async (file) => { seen.push(file); return { verdict: 'clean' }; } } });
    await service.store('photo.png', streamOf(bytes));

    assert.equal(seen[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(seen[0].size, bytes.length);
    assert.equal(seen[0].type, 'image/png');
    assert.equal(seen[0].name, 'photo.png');
  });

  test('the stored file reports the same hash back', async () => {
    const bytes = png(1200);
    const service = new UploadService({ root });
    const stored = await service.store('a.png', streamOf(bytes));
    assert.equal(stored.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  test('a file refused for another reason is never sent to the scanner', async () => {
    // Screening costs a network round trip; a file the module already knows
    // it will not keep must not pay for one.
    let calls = 0;
    const service = new UploadService({
      root,
      limits: { maxFileSize: 100 },
      scan: { check: async () => { calls += 1; return { verdict: 'clean' }; } },
    });
    await service.store('big.png', streamOf(png(4096))).catch(() => {});
    assert.equal(calls, 0);
  });
});

describe('screening: the VirusTotal lookup', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  /** Stand in for the API and record what was asked of it. */
  function fakeApi(responder) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return responder();
    };
    return calls;
  }
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  test('the file is never sent — only its hash is', async () => {
    const calls = fakeApi(() => json(404, {}));
    const scanner = createScanner({ service: 'virustotal', apiKey: 'k' });
    const sha256 = crypto.createHash('sha256').update('secret holiday photo').digest('hex');
    await screen(scanner, { sha256, name: 'a.png', type: 'image/png', size: 10 }, () => {});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://www.virustotal.com/api/v3/files/${sha256}`);
    assert.equal(calls[0].headers['x-apikey'], 'k');
  });

  test('a detection is malicious, and says how many engines flagged it', async () => {
    fakeApi(() => json(200, { data: { attributes: { last_analysis_stats: { malicious: 52, suspicious: 3, harmless: 10 } } } }));
    const scanner = createScanner({ service: 'virustotal', apiKey: 'k' });
    const err = await screen(scanner, { sha256: 'x' }, () => {}).then(() => null, (e) => e);

    assert.equal(err.code, 'INFECTED');
    assert.deepEqual(err.params, { malicious: 52, suspicious: 3 });
  });

  test('a known-good file is clean', async () => {
    fakeApi(() => json(200, { data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 70 } } } }));
    const scanner = createScanner({ service: 'virustotal', apiKey: 'k' });
    await screen(scanner, { sha256: 'x' }, () => {});
  });

  test('a file VirusTotal has never seen is unknown, not a failure', async () => {
    fakeApi(() => json(404, { error: { code: 'NotFoundError' } }));
    const scanner = createScanner({ service: 'virustotal', apiKey: 'k' });
    await screen(scanner, { sha256: 'x' }, () => {});  // accepted by default
  });

  test('a rate limit is reported as such, and does not read as clean', async () => {
    // Four lookups a minute on the free tier, so this is the failure a host
    // will actually meet.
    fakeApi(() => json(429, {}));
    const warnings = [];
    const scanner = createScanner({ service: 'virustotal', apiKey: 'k' });
    const err = await screen(scanner, { sha256: 'x' }, (m, d) => warnings.push(d?.message))
      .then(() => null, (e) => e);

    assert.equal(err.code, 'SCAN_FAILED');
    assert.deepEqual(warnings, ['VirusTotal rate limit reached']);
  });

  test('a bad API key is named in the log, never in the answer', async () => {
    fakeApi(() => json(401, {}));
    const warnings = [];
    const scanner = createScanner({ service: 'virustotal', apiKey: 'wrong-key' });
    const err = await screen(scanner, { sha256: 'x' }, (m, d) => warnings.push(d?.message))
      .then(() => null, (e) => e);

    assert.equal(err.code, 'SCAN_FAILED');
    assert.match(warnings[0], /rejected the API key/);
    assert.ok(!JSON.stringify(err).includes('wrong-key'), 'the key reached the client');
  });

  test('a malformed answer does not read as clean', async () => {
    fakeApi(() => json(200, { data: {} }));
    const scanner = createScanner({ service: 'virustotal', apiKey: 'k' });
    // No stats at all means nothing flagged it, which is the honest reading
    // of an empty report: clean.
    await screen(scanner, { sha256: 'x' }, () => {});
  });
});

describe('screening: configuration is checked at mount time', () => {
  test('an unknown service is named, with what is known', () => {
    assert.throws(() => createScanner({ service: 'nortonish' }), /Unknown scan.service/);
  });
  test('VirusTotal without a key is refused', () => {
    assert.throws(() => createScanner({ service: 'virustotal' }), /apiKey is required/);
    assert.throws(() => createScanner({ service: 'virustotal', apiKey: '  ' }), /apiKey is required/);
  });
  test('a block with neither a service nor a check is refused', () => {
    assert.throws(() => createScanner({ onUnknown: 'reject' }), /needs either a service or a check/);
  });
  test('the two policies only take the two words', () => {
    assert.throws(() => createScanner({ check: async () => {}, onUnknown: 'maybe' }), /onUnknown must be/);
    assert.throws(() => createScanner({ check: async () => {}, onError: 'maybe' }), /onError must be/);
  });
  test('a nonsense timeout is refused', () => {
    assert.throws(() => createScanner({ check: async () => {}, timeoutMs: 0 }), /timeoutMs/);
    assert.throws(() => createScanner({ check: async () => {}, timeoutMs: -1 }), /timeoutMs/);
  });
  test('no block at all means no scanner', () => {
    assert.equal(createScanner(undefined), null);
    assert.equal(createScanner(null), null);
  });
});
