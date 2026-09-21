import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { uploadFiles, UploadError } from '../src/core/uploader.js';

/**
 * A stand-in for XMLHttpRequest that records what was sent and lets a test
 * decide when — and how — the request finishes. The point of these cases is
 * the wiring between the request and the callbacks, so the transport is the
 * one thing that must not be real.
 */
class FakeXHR {
  static last = null;

  constructor() {
    this.headers = {};
    this.withCredentials = false;
    this.status = 0;
    this.responseText = '';
    this.responseHeaders = { 'content-type': 'application/json' };
    this.aborted = false;
    this.sent = null;
    this.listeners = new Map();
    this.upload = {
      listeners: new Map(),
      addEventListener: (type, handler) => {
        if (!this.upload.listeners.has(type)) this.upload.listeners.set(type, []);
        this.upload.listeners.get(type).push(handler);
      },
      fire: (type, event) => {
        for (const h of this.upload.listeners.get(type) ?? []) h(event);
      },
    };
    FakeXHR.last = this;
  }

  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getResponseHeader(name) { return this.responseHeaders[name.toLowerCase()] ?? null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  fire(type) { for (const h of this.listeners.get(type) ?? []) h({}); }
  send(body) { this.sent = body; }
  abort() { this.aborted = true; this.fire('abort'); }

  /** Answer with a status and a JSON body. */
  respond(status, payload, contentType = 'application/json') {
    this.status = status;
    this.responseHeaders['content-type'] = contentType;
    this.responseText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.fire('load');
  }
}

class FakeFormData {
  constructor() { this.entries = []; }
  append(...args) { this.entries.push(args); }
}

beforeEach(() => {
  globalThis.XMLHttpRequest = FakeXHR;
  globalThis.FormData = FakeFormData;
  FakeXHR.last = null;
});
after(() => {
  delete globalThis.XMLHttpRequest;
  delete globalThis.FormData;
});

const file = (name, size = 10) => ({ name, size, type: 'image/png' });
const send = (extra = {}) => uploadFiles({
  endpoint: '/upload',
  items: [{ file: file('a.png') }],
  ...extra,
});

describe('uploader: what goes out', () => {
  test('files are posted under the field name, keeping their own names', async () => {
    const done = send({
      field: 'images[]',
      items: [{ file: file('a.png') }, { file: file('b.png') }],
    });
    const xhr = FakeXHR.last;
    assert.equal(xhr.method, 'POST');
    assert.equal(xhr.url, '/upload');
    assert.deepEqual(
      xhr.sent.entries.map(([name, value, filename]) => [name, value.name, filename]),
      [['images[]', 'a.png', 'a.png'], ['images[]', 'b.png', 'b.png']]
    );
    xhr.respond(200, { uploaded: [] });
    await done;
  });

  test('extra fields are sent alongside', async () => {
    const done = send({ fields: { _csrf: 'tok', album: '7' } });
    const xhr = FakeXHR.last;
    assert.deepEqual(xhr.sent.entries.slice(0, 2), [['_csrf', 'tok'], ['album', '7']]);
    xhr.respond(200, {});
    await done;
  });

  test('Content-Type is never set by hand', async () => {
    // Setting it drops the multipart boundary the browser generates, and the
    // server then cannot parse a single part.
    const done = send({ headers: { 'Content-Type': 'multipart/form-data', 'X-Token': 'a' } });
    const xhr = FakeXHR.last;
    xhr.respond(200, {});
    await done;
    assert.equal(xhr.headers['x-token'], 'a');
    assert.equal(xhr.headers['content-type'], 'multipart/form-data',
      'the caller asked for this header explicitly');
    assert.equal(Object.keys(xhr.headers).length, 2, 'a header was added on its own');
  });

  test('headers can be a function, called per request', async () => {
    let calls = 0;
    const headers = () => ({ 'X-Csrf': `token-${++calls}` });
    for (const expected of ['token-1', 'token-2']) {
      const done = send({ headers });
      FakeXHR.last.respond(200, {});
      await done;
      assert.equal(FakeXHR.last.headers['x-csrf'], expected);
    }
  });

  test('a header with no value is left out rather than sent as "null"', async () => {
    const done = send({ headers: { 'X-A': null, 'X-B': undefined, 'X-C': 0 } });
    const xhr = FakeXHR.last;
    xhr.respond(200, {});
    await done;
    assert.deepEqual(xhr.headers, { 'x-c': '0' });
  });

  test('cookies travel only when the caller asks for it', async () => {
    for (const [credentials, expected] of [[undefined, false], ['same-origin', false], ['omit', false], ['include', true]]) {
      const done = send({ credentials });
      assert.equal(FakeXHR.last.withCredentials, expected, `credentials: ${credentials}`);
      FakeXHR.last.respond(200, {});
      await done;
    }
  });
});

describe('uploader: progress', () => {
  test('progress is reported as the body goes out', async () => {
    const seen = [];
    const done = send({ onProgress: (sent, total) => seen.push([sent, total]) });
    const xhr = FakeXHR.last;

    xhr.upload.fire('progress', { lengthComputable: true, loaded: 0, total: 1000 });
    xhr.upload.fire('progress', { lengthComputable: true, loaded: 250, total: 1000 });
    xhr.upload.fire('progress', { lengthComputable: true, loaded: 900, total: 1000 });
    xhr.respond(200, {});
    await done;

    assert.deepEqual(seen, [[0, 1000], [250, 1000], [900, 1000], [1, 1]]);
  });

  test('an event with no known total is ignored, not reported as zero', async () => {
    // loaded/total on such an event is meaningless; passing it on would make
    // the bar jump backwards.
    const seen = [];
    const done = send({ onProgress: (sent, total) => seen.push([sent, total]) });
    const xhr = FakeXHR.last;
    xhr.upload.fire('progress', { lengthComputable: false, loaded: 400, total: 0 });
    xhr.respond(200, {});
    await done;
    assert.deepEqual(seen, [[1, 1]]);
  });

  test('a finished upload ends at full, even if the last event never came', async () => {
    const seen = [];
    const done = send({ onProgress: (sent, total) => seen.push(sent / total) });
    FakeXHR.last.upload.fire('progress', { lengthComputable: true, loaded: 10, total: 100 });
    FakeXHR.last.respond(200, {});
    await done;
    assert.equal(seen.at(-1), 1);
  });

  test('no progress callback is not an error', async () => {
    const done = send();
    FakeXHR.last.upload.fire('progress', { lengthComputable: true, loaded: 1, total: 2 });
    FakeXHR.last.respond(200, {});
    await done;
  });
});

describe('uploader: what comes back', () => {
  test("the server's answer is handed back as it stands", async () => {
    const answer = { uploaded: [{ name: 'a.png', url: '/u/a.png' }], failures: [] };
    const done = send();
    FakeXHR.last.respond(200, answer);
    assert.deepEqual(await done, answer);
  });

  test('a 2xx that is not JSON still resolves, with an empty result', async () => {
    const done = send();
    FakeXHR.last.respond(204, '', 'text/plain');
    assert.deepEqual(await done, { uploaded: [], failures: [] });
  });

  test('a 2xx with broken JSON resolves rather than throwing a parse error', async () => {
    const done = send();
    FakeXHR.last.respond(200, '{not json', 'application/json');
    assert.deepEqual(await done, { uploaded: [], failures: [] });
  });

  test("a refusal carries the server's own code, status and values", async () => {
    const done = send();
    FakeXHR.last.respond(413, { code: 'TOO_LARGE', error: 'Larger than allowed', params: { limit: 1024 } });

    const err = await done.then(() => null, (e) => e);
    assert.ok(err instanceof UploadError);
    assert.equal(err.code, 'TOO_LARGE');
    assert.equal(err.status, 413);
    assert.deepEqual(err.params, { limit: 1024 });
    assert.equal(err.message, 'Larger than allowed');
  });

  test('a refusal with no body still names the status', async () => {
    const done = send();
    FakeXHR.last.respond(500, '<html>oops</html>', 'text/html');
    const err = await done.then(() => null, (e) => e);
    assert.equal(err.code, 'HTTP_ERROR');
    assert.equal(err.status, 500);
    assert.equal(err.message, 'Error 500');
  });

  test('an unreachable server is NETWORK, not a silent hang', async () => {
    const done = send();
    FakeXHR.last.fire('error');
    const err = await done.then(() => null, (e) => e);
    assert.equal(err.code, 'NETWORK');
    assert.equal(err.status, 0);
  });
});

describe('uploader: cancelling', () => {
  test('a signal already aborted never opens a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await send({ signal: controller.signal }).then(() => null, (e) => e);
    assert.equal(err.code, 'ABORTED');
    assert.equal(FakeXHR.last, null, 'a request went out after cancelling');
  });

  test('aborting mid-flight stops the request and rejects', async () => {
    const controller = new AbortController();
    const done = send({ signal: controller.signal });
    controller.abort();

    assert.equal(FakeXHR.last.aborted, true, 'the request was left running');
    const err = await done.then(() => null, (e) => e);
    assert.equal(err.code, 'ABORTED');
  });

  test('a finished upload stops listening to its signal', async () => {
    // A widget reuses one controller per upload; a listener left behind would
    // abort a request that has already been answered.
    const controller = new AbortController();
    const done = send({ signal: controller.signal });
    const xhr = FakeXHR.last;
    xhr.respond(200, {});
    await done;

    controller.abort();
    assert.equal(xhr.aborted, false, 'a settled request was aborted afterwards');
  });

  test('a failed upload stops listening too', async () => {
    const controller = new AbortController();
    const done = send({ signal: controller.signal });
    const xhr = FakeXHR.last;
    xhr.fire('error');
    await done.catch(() => {});

    controller.abort();
    assert.equal(xhr.aborted, false);
  });
});
