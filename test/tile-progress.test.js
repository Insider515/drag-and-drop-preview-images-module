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
const bars = (drop) => drop.root.querySelectorAll('.ddp-tile-progress-bar');
const widths = (drop) => bars(drop).map((b) => b.style.width || '0%');
const percent = (drop) => widths(drop).map((w) => Number.parseInt(w, 10) || 0);

async function ready(count, options) {
  const drop = mount(options);
  await drop.add(Array.from({ length: count }, (_, i) => image(`img-${i}.png`, 1000)));
  return drop;
}

/** Wait for the widget to open its next request. */
async function nextRequest(previous) {
  for (let i = 0; i < 20 && FakeXHR.last === previous; i += 1) await settled();
  assert.notEqual(FakeXHR.last, previous, 'no further request was made');
  return FakeXHR.last;
}

describe('per-file progress: the bar on the tile', () => {
  test('every tile has one, empty, before anything is sent', async () => {
    const drop = await ready(3);
    assert.equal(bars(drop).length, 3);
    assert.deepEqual(percent(drop), [0, 0, 0]);
    drop.destroy();
  });

  test('it fills for the file actually going out', async () => {
    const drop = await ready(3);
    const done = drop.upload();
    await settled();

    FakeXHR.last.progress(400, 1000);
    assert.deepEqual(percent(drop), [40, 0, 0], 'the wrong tile moved');
    FakeXHR.last.progress(900, 1000);
    assert.deepEqual(percent(drop), [90, 0, 0]);

    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    const second = await nextRequest(FakeXHR.last);
    second.progress(500, 1000);
    assert.deepEqual(percent(drop), [100, 50, 0], 'the finished file did not stay full');

    second.respond(200, { uploaded: [{ name: 'img-1.png' }], failures: [] });
    const third = await nextRequest(second);
    third.respond(200, { uploaded: [{ name: 'img-2.png' }], failures: [] });
    await done;

    assert.deepEqual(percent(drop), [100, 100, 100]);
    drop.destroy();
  });

  test('a file that arrived is shown as complete, not as wherever it stopped', async () => {
    const drop = await ready(1);
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(300, 1000);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await done;

    assert.deepEqual(percent(drop), [100]);
    assert.equal(drop.files[0].progress, 1);
    drop.destroy();
  });

  test('a file that failed goes back to empty', async () => {
    // Whatever went out is not coming back; the next attempt starts it again,
    // so leaving the bar part-filled would be a lie.
    const drop = await ready(1);
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(800, 1000);
    assert.deepEqual(percent(drop), [80]);
    FakeXHR.last.fire('error');
    await done;

    assert.deepEqual(percent(drop), [0]);
    assert.equal(drop.files[0].progress, 0);
    drop.destroy();
  });

  test('a retry starts the bar again rather than continuing it', async () => {
    const drop = await ready(1, { retry: { attempts: 2, delay: 0 } });
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(700, 1000);
    FakeXHR.last.fire('error');

    const again = await nextRequest(FakeXHR.last);
    assert.deepEqual(percent(drop), [0], 'the second attempt carried on from the first');
    again.progress(200, 1000);
    assert.deepEqual(percent(drop), [20]);

    again.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await done;
    drop.destroy();
  });

  test('cancelling empties the bar of the file that was in flight', async () => {
    const drop = await ready(2);
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(600, 1000);
    drop.cancel();
    await done;

    assert.deepEqual(percent(drop), [0, 0]);
    drop.destroy();
  });
});

describe('per-file progress: several files in one request', () => {
  test('the bytes are shared out in the order they are sent', async () => {
    // A multipart body sends its parts in order, so the bytes that have gone
    // out belong to the files in order too.
    const drop = await ready(4, { filesPerRequest: 4 });
    const done = drop.upload();
    await settled();

    // A quarter of 4000 bytes is the whole of the first file.
    FakeXHR.last.progress(250, 1000);
    assert.deepEqual(percent(drop), [100, 0, 0, 0]);

    FakeXHR.last.progress(625, 1000);
    assert.deepEqual(percent(drop), [100, 100, 50, 0]);

    FakeXHR.last.progress(1000, 1000);
    assert.deepEqual(percent(drop), [100, 100, 100, 100]);

    FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });

  test('files of different sizes each fill at their own rate', async () => {
    const drop = mount({ filesPerRequest: 2 });
    await drop.add([image('small.png', 1000), image('large.png', 9000)]);
    const done = drop.upload();
    await settled();

    // Half the bytes of a 10 000-byte pair: the small one whole, and a bit
    // more than four ninths of the large one.
    FakeXHR.last.progress(500, 1000);
    const [small, large] = percent(drop);
    assert.equal(small, 100);
    assert.ok(large > 40 && large < 50, `large: ${large}%`);

    FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });
});

describe('per-file progress: it does not disturb anything else', () => {
  test('the bar below the zone still measures the whole queue', async () => {
    const drop = await ready(4);
    const done = drop.upload();
    await settled();

    FakeXHR.last.progress(1000, 1000);
    assert.equal(drop.progressBar.style.width, '25%', 'the queue bar followed one file');

    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    const second = await nextRequest(FakeXHR.last);
    second.progress(1000, 1000);
    assert.equal(drop.progressBar.style.width, '50%');

    second.respond(200, { uploaded: [], failures: [] });
    const third = await nextRequest(second);
    third.respond(200, { uploaded: [], failures: [] });
    const fourth = await nextRequest(third);
    fourth.respond(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });

  test('the caption keeps saying the size, not the progress', async () => {
    const drop = await ready(1);
    const before = tiles(drop)[0].querySelector('.ddp-size').textContent;
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(500, 1000);

    assert.equal(tiles(drop)[0].querySelector('.ddp-size').textContent, before);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await done;
    drop.destroy();
  });

  test('the queue reports each file’s own figure', async () => {
    const drop = await ready(2, { filesPerRequest: 2 });
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(750, 1000);

    assert.deepEqual(drop.files.map((f) => f.progress), [1, 0.5]);
    FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });

  test('a file added later starts empty, not at the last one’s figure', async () => {
    const drop = await ready(1);
    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(200, { uploaded: [{ name: 'img-0.png' }], failures: [] });
    await done;

    await drop.add([image('late.png', 1000)]);
    assert.deepEqual(percent(drop), [100, 0]);
    drop.destroy();
  });
});

describe('per-file progress: a file refused inside a successful request', () => {
  test('its bar empties while the others stay full', async () => {
    // The request succeeded; the server simply would not keep one of the
    // files. The uploader's final "all sent" would otherwise leave the
    // refused one showing a full bar.
    const drop = mount({ filesPerRequest: 3 });
    await drop.add([image('a.png', 1000), image('bad.png', 1000), image('c.png', 1000)]);

    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(200, {
      uploaded: [{ name: 'a.png' }, { name: 'c.png' }],
      failures: [{ name: 'bad.png', code: 'NOT_AN_IMAGE' }],
    });
    await done;

    assert.deepEqual(percent(drop), [100, 0, 100]);
    assert.deepEqual(drop.files.map((f) => f.progress), [1, 0, 1]);
    assert.deepEqual(tiles(drop).map((t) => t.dataset.status), ['done', 'error', 'done']);
    drop.destroy();
  });
});
