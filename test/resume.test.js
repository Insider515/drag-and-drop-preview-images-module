import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DropPreview } from '../src/drop-preview.js';
import { installDom, uninstallDom, settled, image, FakeXHR } from './helpers/fake-dom.js';

let dom;
before(() => { dom = installDom(); });
after(uninstallDom);
beforeEach(() => dom.reset());

const mount = (options) => new DropPreview(dom.root, { endpoint: '/upload', ...options });
const tiles = (drop) => drop.root.querySelectorAll('.ddp-tile');
const statuses = (drop) => tiles(drop).map((t) => t.dataset.status);

async function ready(count, options) {
  const drop = mount(options);
  await drop.add(Array.from({ length: count }, (_, i) => image(`img-${i}.png`, 1024)));
  return drop;
}

/** Wait for the widget to open its next request, then answer it. */
async function answer(status, body) {
  const before = FakeXHR.last;
  for (let i = 0; i < 20 && FakeXHR.last === before; i += 1) await settled();
  assert.notEqual(FakeXHR.last, before, 'no further request was made');
  FakeXHR.last.respond(status, body);
}

/** The file names carried by the request in flight. */
const carrying = () => FakeXHR.last.sent.entries.map(([, file]) => file.name);

describe('mass upload: one file per request by default', () => {
  test('each file travels on its own', async () => {
    const drop = await ready(3);
    const done = drop.upload();

    await settled();
    assert.deepEqual(carrying(), ['img-0.png']);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });

    await answer(200, { uploaded: [{ name: 'img-1.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-2.png' }], failures: [] });

    const result = await done;
    assert.equal(result.uploaded.length, 3);
    assert.deepEqual(statuses(drop), ['done', 'done', 'done']);
    drop.destroy();
  });

  test('a group carries as many as the host asked for', async () => {
    const drop = await ready(5, { filesPerRequest: 2 });
    const done = drop.upload();

    await settled();
    assert.deepEqual(carrying(), ['img-0.png', 'img-1.png']);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }, { name: 'img-1.png' }], failures: [] });
    await settled();
    assert.deepEqual(carrying(), ['img-2.png', 'img-3.png']);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-2.png' }, { name: 'img-3.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-4.png' }], failures: [] });

    assert.equal((await done).uploaded.length, 5);
    drop.destroy();
  });

  test('zero puts the whole queue in one request, the way it used to', async () => {
    const drop = await ready(4, { filesPerRequest: 0 });
    const done = drop.upload();
    await settled();

    assert.deepEqual(carrying(), ['img-0.png', 'img-1.png', 'img-2.png', 'img-3.png']);
    FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });

  test('a nonsensical value is refused when the widget is built', () => {
    assert.throws(() => mount({ filesPerRequest: -1 }), /filesPerRequest/);
    assert.throws(() => mount({ filesPerRequest: 1.5 }), /filesPerRequest/);
    assert.throws(() => mount({ filesPerRequest: 'all' }), /filesPerRequest/);
  });
});

describe('mass upload: an interruption does not undo what landed', () => {
  test('the files already sent are not sent again', async () => {
    // This is the whole point. Twenty photographs in one request and a
    // connection that drops on the nineteenth loses all twenty — and the ones
    // the server had already written stay there, so sending the batch again
    // leaves duplicates of them.
    const drop = await ready(5);
    const first = drop.upload();

    await settled();
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-1.png' }], failures: [] });

    // Then the connection goes.
    for (let i = 0; i < 20 && FakeXHR.last.sent.entries[0][1].name !== 'img-2.png'; i += 1) await settled();
    FakeXHR.last.fire('error');
    await first;

    assert.deepEqual(statuses(drop), ['done', 'done', 'error', 'ready', 'ready']);

    // Sending again picks up exactly where it stopped.
    const second = drop.retry();
    await settled();
    assert.deepEqual(carrying(), ['img-2.png'], 'it started over from the first file');

    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-2.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-3.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-4.png' }], failures: [] });
    await second;

    assert.deepEqual(statuses(drop), ['done', 'done', 'done', 'done', 'done']);
    drop.destroy();
  });

  test('pressing Upload again never re-sends what already arrived', async () => {
    const drop = await ready(3);
    const first = drop.upload();
    await settled();
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await settled();
    FakeXHR.last.fire('error');
    await first;

    // Upload carries on with the files that were never tried; the one that
    // failed is what the Retry button is for.
    const second = drop.upload();
    await settled();
    assert.deepEqual(carrying(), ['img-2.png'], 'a file that had landed was sent again');
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-2.png' }], failures: [] });
    await second;

    assert.deepEqual(statuses(drop), ['done', 'error', 'done']);
    assert.equal(drop.retryable, true, 'the failed file has no way back');
    drop.destroy();
  });

  test('a dropped connection stops the walk instead of failing forty times', async () => {
    // Every remaining file would fail the same way, slowly, for nothing.
    const drop = await ready(10);
    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');
    await done;

    const sent = statuses(drop);
    assert.equal(sent[0], 'error');
    assert.deepEqual(sent.slice(1), Array(9).fill('ready'), 'it carried on after the line went dead');
    drop.destroy();
  });

  test('but a refusal of one file does not stop the others', async () => {
    // That the third is not an image says nothing about the fourth.
    const drop = await ready(4);
    const done = drop.upload();

    await settled();
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-1.png' }], failures: [] });
    await answer(415, { code: 'NOT_AN_IMAGE', error: 'Not an image' });
    await answer(200, { uploaded: [{ name: 'img-3.png' }], failures: [] });

    const result = await done;
    assert.deepEqual(statuses(drop), ['done', 'done', 'error', 'done']);
    assert.equal(result.uploaded.length, 3);
    assert.equal(result.failures.length, 1);
    drop.destroy();
  });

  test('cancelling stops the walk and keeps what already arrived', async () => {
    const drop = await ready(5);
    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await settled();

    drop.cancel();
    await done;

    assert.equal(statuses(drop)[0], 'done', 'a file that landed was undone by cancelling');
    assert.equal(drop.busy, false);
    drop.destroy();
  });
});

describe('mass upload: what the person sees', () => {
  test('the bar measures the whole queue, not the request in flight', async () => {
    // With a file per request it would otherwise snap back to nothing on each.
    const drop = await ready(4);
    const done = drop.upload();
    await settled();

    const widths = [];
    FakeXHR.last.progress(500, 1000);
    widths.push(drop.progressBar.style.width);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await settled();
    widths.push(drop.progressBar.style.width);
    FakeXHR.last.progress(500, 1000);
    widths.push(drop.progressBar.style.width);

    const numbers = widths.map((w) => Number.parseInt(w, 10));
    assert.ok(numbers[0] > 0 && numbers[0] < 25, `first request: ${widths[0]}`);
    assert.ok(numbers[1] >= 25, `after one file of four: ${widths[1]}`);
    assert.ok(numbers[2] > numbers[1], `it went backwards: ${widths.join(' -> ')}`);

    FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    await answer(200, { uploaded: [], failures: [] });
    await answer(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });

  test('the status line counts the files, not the requests', async () => {
    const drop = await ready(3, { locale: 'uk' });
    const done = drop.upload();
    await settled();
    assert.match(drop.status.textContent, /1.*3/, drop.status.textContent);

    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await settled();
    assert.match(drop.status.textContent, /2.*3/, drop.status.textContent);

    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-1.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-2.png' }], failures: [] });
    await done;
    drop.destroy();
  });

  test('a single file says nothing about counts', async () => {
    const drop = await ready(1);
    const done = drop.upload();
    await settled();
    assert.notEqual(drop.status.textContent, drop.t('status.uploading', { done: 1, total: 1 }));
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await done;
    drop.destroy();
  });
});

describe('mass upload: retries apply to the file, not the batch', () => {
  test('one file is retried while the others wait their turn', async () => {
    const drop = await ready(3, { retry: { attempts: 2, delay: 0 } });
    const retries = [];
    drop.on('retry', (e) => retries.push(e.code));

    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');                     // img-0 fails once
    await answer(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });  // and succeeds
    await answer(200, { uploaded: [{ name: 'img-1.png' }], failures: [] });
    await answer(200, { uploaded: [{ name: 'img-2.png' }], failures: [] });

    assert.deepEqual(retries, ['NETWORK']);
    assert.deepEqual(statuses(drop), ['done', 'done', 'done']);
    await done;
    drop.destroy();
  });
});
