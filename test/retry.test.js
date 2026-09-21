import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DropPreview } from '../src/drop-preview.js';
import { delayBefore, isRetryable, normaliseRetry } from '../src/core/retry.js';
import { installDom, uninstallDom, settled, image, FakeXHR } from './helpers/fake-dom.js';

let dom;
before(() => { dom = installDom(); });
after(uninstallDom);
beforeEach(() => dom.reset());

const mount = (options) => new DropPreview(dom.root, { endpoint: '/upload', ...options });
const tiles = (drop) => drop.root.querySelectorAll('.ddp-tile');
const statuses = (drop) => tiles(drop).map((t) => t.dataset.status);

/** Mount with files already queued. */
async function ready(names = ['a.png'], options) {
  const drop = mount(options);
  await drop.add(names.map((n) => image(n)));
  return drop;
}

/** Let the widget work through a wait it scheduled with setTimeout. */
const drain = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await settled();
};

describe('retry: which failures are worth repeating', () => {
  test('the ones that are about the moment, not about the file', () => {
    for (const code of ['NETWORK', 'INTERNAL', 'BUSY', 'SCAN_FAILED', 'NO_SPACE']) {
      assert.equal(isRetryable(code), true, code);
    }
  });

  test('a refusal of the file itself is not repeated', () => {
    // Sending it again produces the same answer, more slowly, and buries the
    // reason under a spinner.
    for (const code of [
      'TOO_LARGE', 'TOTAL_TOO_LARGE', 'TOO_MANY', 'NOT_AN_IMAGE', 'TYPE_NOT_ALLOWED',
      'SVG_REFUSED', 'EMPTY', 'DUPLICATE', 'INVALID_NAME', 'INFECTED', 'NOT_SCREENED',
      'DENIED', 'CROSS_ORIGIN', 'NOT_MULTIPART', 'NO_FILES', 'EXISTS',
      'INVALID_SESSION', 'NO_SESSION', 'ABORTED', 'NOTHING_TO_UPLOAD',
    ]) {
      assert.equal(isRetryable(code), false, code);
    }
  });

  test('a generic HTTP failure is judged by its status', () => {
    assert.equal(isRetryable('HTTP_ERROR', 502), true);
    assert.equal(isRetryable('HTTP_ERROR', 503), true);
    assert.equal(isRetryable('HTTP_ERROR', 500), true);
    assert.equal(isRetryable('HTTP_ERROR', 404), false);
    assert.equal(isRetryable('HTTP_ERROR', 403), false);
    assert.equal(isRetryable('HTTP_ERROR', 0), false);
  });

  test('an unknown code is not repeated on the off-chance', () => {
    assert.equal(isRetryable('SOMETHING_NEW'), false);
    assert.equal(isRetryable(undefined), false);
  });
});

describe('retry: the waiting schedule', () => {
  test('each wait is longer than the last', () => {
    // A server having a bad minute stays down for a moment; a crowd of
    // browsers hammering it at a fixed interval makes the minute longer.
    const config = normaliseRetry({});
    assert.deepEqual([2, 3, 4, 5].map((n) => delayBefore(config, n)), [1000, 2000, 4000, 8000]);
  });

  test('it stops growing at the ceiling', () => {
    const config = normaliseRetry({ delay: 1000, backoff: 10, maxDelay: 5000 });
    assert.deepEqual([2, 3, 4].map((n) => delayBefore(config, n)), [1000, 5000, 5000]);
  });

  test('backoff 1 keeps the interval flat', () => {
    const config = normaliseRetry({ delay: 250, backoff: 1 });
    assert.deepEqual([2, 3, 4].map((n) => delayBefore(config, n)), [250, 250, 250]);
  });

  test('a mistake in the block is an error when the widget is built', () => {
    assert.throws(() => mount({ retry: { attempts: 0 } }), /attempts must be/);
    assert.throws(() => mount({ retry: { attempts: 2.5 } }), /attempts must be/);
    assert.throws(() => mount({ retry: { delay: -1 } }), /delay must be/);
    assert.throws(() => mount({ retry: { backoff: 0.5 } }), /backoff must be/);
    assert.throws(() => mount({ retry: { maxDelay: -1 } }), /maxDelay must be/);
  });

  test('no block means no automatic retries', () => {
    assert.equal(normaliseRetry(undefined), null);
    assert.equal(mount({}).retryPolicy, null);
  });
});

describe('retry: automatic, when the host asked for it', () => {
  test('a dropped connection is sent again and succeeds', async () => {
    const drop = await ready(['a.png'], { retry: { attempts: 3, delay: 0 } });
    const events = [];
    drop.on('retry', (e) => events.push([e.attempt, e.of, e.code]));

    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');          // the connection drops
    await drain();

    assert.deepEqual(events, [[2, 3, 'NETWORK']]);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }], failures: [] });
    const answer = await done;

    assert.ok(answer, 'the second attempt was not made');
    assert.deepEqual(statuses(drop), ['done']);
    drop.destroy();
  });

  test('it gives up after the attempts it was given', async () => {
    const drop = await ready(['a.png'], { retry: { attempts: 3, delay: 0 } });
    const errors = [];
    drop.on('error', (e) => errors.push(e.code));

    const done = drop.upload();
    for (let i = 0; i < 3; i += 1) {
      await drain();
      FakeXHR.last.fire('error');
    }
    await done;

    // Three attempts, then the failure is reported once — not three times.
    assert.deepEqual(errors, ['NETWORK']);
    assert.deepEqual(statuses(drop), ['error']);
    assert.equal(drop.busy, false);
    drop.destroy();
  });

  test('a file the server refused is not sent again', async () => {
    const drop = await ready(['a.png'], { retry: { attempts: 5, delay: 0 } });
    const retries = [];
    drop.on('retry', () => retries.push(1));

    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(413, { code: 'TOO_LARGE', error: 'Too big', params: { limit: 1024 } });
    await done;

    assert.deepEqual(retries, [], 'a permanent refusal was repeated');
    assert.equal(drop.files[0].error.code, 'TOO_LARGE');
    drop.destroy();
  });

  test('a 502 is repeated but a 404 is not', async () => {
    for (const [status, expected] of [[502, 1], [404, 0]]) {
      dom.reset();
      const drop = await ready(['a.png'], { retry: { attempts: 2, delay: 0 } });
      let retried = 0;
      drop.on('retry', () => { retried += 1; });

      const done = drop.upload();
      await settled();
      FakeXHR.last.respond(status, '<html>no</html>', 'text/html');
      await drain();
      if (retried) FakeXHR.last.respond(status, '<html>no</html>', 'text/html');
      await done;

      assert.equal(retried, expected, `status ${status}`);
      drop.destroy();
    }
  });

  test('cancelling during the wait stops it there and then', async () => {
    const drop = await ready(['a.png'], { retry: { attempts: 5, delay: 50_000 } });
    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');
    await settled();

    // A wait of fifty seconds is running. Cancelling must not be ignored for
    // the length of it.
    const abandoned = FakeXHR.last;
    drop.cancel();
    await drain();
    await done;

    assert.equal(FakeXHR.last, abandoned, 'a further attempt went out after cancelling');
    assert.equal(drop.busy, false);
    drop.destroy();
  });

  test('the status line says what is happening during the wait', async () => {
    const drop = await ready(['a.png'], { retry: { attempts: 3, delay: 0 }, locale: 'uk' });
    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');
    await settled();

    assert.match(drop.status.textContent, /2 з 3/, `status said: ${drop.status.textContent}`);
    await drain();
    FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });

  test('without a retry block one failure is the end of it', async () => {
    const drop = await ready(['a.png']);
    const done = drop.upload();
    await settled();
    const only = FakeXHR.last;
    only.fire('error');
    await drain();
    await done;

    assert.equal(FakeXHR.last, only, 'it retried although nothing asked it to');
    assert.deepEqual(statuses(drop), ['error']);
    drop.destroy();
  });
});

describe('retry: by hand, after everything has stopped', () => {
  test('retry() sends the failed files again', async () => {
    const drop = await ready(['a.png', 'b.png']);
    const first = drop.upload();
    await settled();
    FakeXHR.last.fire('error');
    await first;

    assert.deepEqual(statuses(drop), ['error', 'error']);
    assert.equal(drop.retryable, true);

    const second = drop.retry();
    await settled();
    assert.ok(FakeXHR.last, 'nothing was sent again');
    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }, { name: 'b.png' }], failures: [] });
    assert.ok(await second);
    assert.deepEqual(statuses(drop), ['done', 'done']);
    drop.destroy();
  });

  test('it leaves alone what would fail the same way again', async () => {
    const drop = await ready(['ok.png', 'huge.png']);
    const first = drop.upload();
    await settled();
    FakeXHR.last.respond(400, {
      uploaded: [],
      failures: [
        { name: 'ok.png', code: 'INTERNAL' },
        { name: 'huge.png', code: 'TOO_LARGE', params: { limit: 1024 } },
      ],
    });
    await first;

    const second = drop.retry();
    await settled();
    // Only the one worth repeating goes back on the wire.
    assert.deepEqual(FakeXHR.last.sent.entries.map(([, f]) => f.name), ['ok.png']);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'ok.png' }], failures: [] });
    await second;

    assert.deepEqual(statuses(drop), ['done', 'error']);
    assert.equal(drop.files[1].error.code, 'TOO_LARGE');
    drop.destroy();
  });

  test('with nothing worth repeating it does nothing at all', async () => {
    const drop = await ready(['a.png']);
    const first = drop.upload();
    await settled();
    FakeXHR.last.respond(413, { code: 'TOO_LARGE', error: 'Too big' });
    await first;

    const before = FakeXHR.last;
    assert.equal(drop.retryable, false);
    assert.equal(await drop.retry(), null);
    assert.equal(FakeXHR.last, before, 'a request went out anyway');
    drop.destroy();
  });

  test('it is refused while an upload is already running', async () => {
    const drop = await ready(['a.png']);
    const first = drop.upload();
    await settled();
    const inFlight = FakeXHR.last;

    assert.equal(await drop.retry(), null);
    assert.equal(FakeXHR.last, inFlight);

    inFlight.respond(200, {});
    await first;
    drop.destroy();
  });
});

describe('retry: the button', () => {
  test('it appears only once something is worth repeating', async () => {
    const drop = await ready(['a.png']);
    assert.equal(drop.retryButton.hidden, true, 'the button was there before any failure');

    const done = drop.upload();
    await settled();
    assert.equal(drop.retryButton.hidden, true, 'it showed during the upload');
    FakeXHR.last.fire('error');
    await done;

    assert.equal(drop.retryButton.hidden, false);
    drop.destroy();
  });

  test('it stays away when the failure is the file’s own fault', async () => {
    const drop = await ready(['a.png']);
    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(415, { code: 'NOT_AN_IMAGE', error: 'Not an image' });
    await done;

    assert.equal(drop.retryButton.hidden, true);
    drop.destroy();
  });

  test('pressing it sends the batch again, and it goes away on success', async () => {
    const drop = await ready(['a.png']);
    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');
    await done;

    drop.retryButton.fire('click');
    await settled();
    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }], failures: [] });
    await drain();

    assert.deepEqual(statuses(drop), ['done']);
    assert.equal(drop.retryButton.hidden, true);
    drop.destroy();
  });

  test('it is labelled in the active language', async () => {
    const drop = await ready(['a.png'], { locale: 'de' });
    assert.equal(drop.retryButton.textContent, 'Erneut versuchen');
    drop.destroy();
  });
});
