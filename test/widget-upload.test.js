import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DropPreview } from '../src/drop-preview.js';
import { installDom, uninstallDom, settled, image, FakeXHR } from './helpers/fake-dom.js';

let dom;
before(() => { dom = installDom(); });
after(uninstallDom);
beforeEach(() => dom.reset());

const mount = (options) => new DropPreview(dom.root, { endpoint: '/api/upload', ...options });
const tiles = (drop) => drop.root.querySelectorAll('.ddp-tile');
const statuses = (drop) => tiles(drop).map((t) => t.dataset.status);

/** Mount, queue some files and wait for their previews. */
async function ready(names = ['a.png'], options) {
  const drop = mount(options);
  await drop.add(names.map((n) => image(n)));
  return drop;
}

describe('upload: the progress bar', () => {
  test('it is hidden until an upload starts', async () => {
    const drop = await ready();
    assert.equal(drop.progress.hidden, true);
    assert.equal(drop.progressBar.style.width || '0%', '0%');
    drop.destroy();
  });

  test('it tracks the bytes that have gone out', async () => {
    const drop = await ready(['a.png', 'b.png']);
    const done = drop.upload();
    await settled();

    assert.equal(drop.progress.hidden, false, 'the bar stayed hidden during an upload');

    const xhr = FakeXHR.last;
    for (const [loaded, expected] of [[0, '0%'], [250, '25%'], [500, '50%'], [999, '100%']]) {
      xhr.progress(loaded, 1000);
      assert.equal(drop.progressBar.style.width, expected, `at ${loaded} bytes`);
      assert.equal(drop.progress.getAttribute('aria-valuenow'), expected.replace('%', ''));
    }

    xhr.respond(200, { uploaded: [], failures: [] });
    await done;
    drop.destroy();
  });

  test('it never runs past the end', async () => {
    // A server that counts the multipart overhead differently can report more
    // sent than the browser believes it is sending.
    const drop = await ready();
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(5000, 1000);
    assert.equal(drop.progressBar.style.width, '100%');
    FakeXHR.last.respond(200, {});
    await done;
    drop.destroy();
  });

  test('it is put away and reset when the upload ends', async () => {
    const drop = await ready();
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(500, 1000);
    FakeXHR.last.respond(200, {});
    await done;

    // Left at 50%, the next upload would appear to start half finished.
    assert.equal(drop.progress.hidden, true);
    assert.equal(drop.progressBar.style.width, '0%');
    drop.destroy();
  });

  test('it is put away after a failure too', async () => {
    const drop = await ready();
    const done = drop.upload();
    await settled();
    FakeXHR.last.progress(500, 1000);
    FakeXHR.last.fire('error');
    await done;

    assert.equal(drop.progress.hidden, true);
    assert.equal(drop.progressBar.style.width, '0%');
    drop.destroy();
  });
});

describe('upload: the controls', () => {
  test('cancel replaces upload while a request is in flight', async () => {
    const drop = await ready();
    assert.equal(drop.uploadButton.hidden, false);
    assert.equal(drop.cancelButton.hidden, true);

    const done = drop.upload();
    await settled();
    assert.equal(drop.uploadButton.hidden, true);
    assert.equal(drop.cancelButton.hidden, false);
    assert.equal(drop.input.disabled, true, 'more files could be added mid-flight');
    assert.equal(drop.clearButton.disabled, true);

    FakeXHR.last.respond(200, {});
    await done;
    assert.equal(drop.uploadButton.hidden, false);
    assert.equal(drop.cancelButton.hidden, true);
    assert.equal(drop.input.disabled, false);
    drop.destroy();
  });

  test('the buttons come back even when the upload failed', async () => {
    const drop = await ready();
    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');
    await done;

    assert.equal(drop.uploadButton.hidden, false);
    assert.equal(drop.input.disabled, false, 'the widget was left unusable after a failure');
    assert.equal(drop.busy, false);
    drop.destroy();
  });

  test('the upload button sends the queue', async () => {
    const drop = await ready();
    drop.uploadButton.fire('click');
    await settled();
    assert.ok(FakeXHR.last, 'clicking upload sent nothing');
    FakeXHR.last.respond(200, {});
    drop.destroy();
  });
});

describe('upload: what is sent', () => {
  test('only files that are still good are sent', async () => {
    dom.decode.fail = true;
    const drop = mount();
    await drop.add([image('broken.png')]);
    dom.decode.fail = false;
    await drop.add([image('good.png')]);

    const done = drop.upload();
    await settled();
    assert.deepEqual(
      FakeXHR.last.sent.entries.map(([, file]) => file.name),
      ['good.png'],
      'a file that already failed was sent anyway'
    );
    FakeXHR.last.respond(200, {});
    await done;
    drop.destroy();
  });

  test('a queue where everything failed is not sent at all', async () => {
    dom.decode.fail = true;
    const drop = mount();
    await drop.add([image('broken.png')]);

    const events = [];
    drop.on('error', (e) => events.push(e.code));
    const answer = await drop.upload();

    assert.equal(answer, null);
    assert.equal(FakeXHR.last, null, 'an empty request went to the server');
    assert.deepEqual(events, ['NOTHING_TO_UPLOAD']);
    assert.equal(drop.busy, false);
    assert.equal(drop.progress.hidden, true);
    drop.destroy();
  });

  test('a second upload while one is in flight is refused', async () => {
    const drop = await ready();
    const first = drop.upload();
    await settled();
    const inFlight = FakeXHR.last;

    assert.equal(await drop.upload(), null);
    assert.equal(FakeXHR.last, inFlight, 'a second request went out at the same time');

    inFlight.respond(200, {});
    await first;
    drop.destroy();
  });

  test('with no endpoint there is nothing to send', async () => {
    const drop = new DropPreview(dom.root, {});
    await drop.add([image('a.png')]);
    assert.equal(await drop.upload(), null);
    assert.equal(FakeXHR.last, null);
    drop.destroy();
  });

  test('an empty queue is not sent', async () => {
    const drop = mount();
    assert.equal(await drop.upload(), null);
    assert.equal(FakeXHR.last, null);
    drop.destroy();
  });
});

describe('upload: what comes back', () => {
  test('the files the server kept are marked done', async () => {
    const drop = await ready(['a.png', 'b.png']);
    const seen = [];
    drop.on('uploaded', ({ answer }) => seen.push(answer));

    const done = drop.upload();
    await settled();
    assert.deepEqual(statuses(drop), ['uploading', 'uploading']);
    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }, { name: 'b.png' }], failures: [] });
    await done;

    assert.deepEqual(statuses(drop), ['done', 'done']);
    assert.equal(seen.length, 1);
    drop.destroy();
  });

  test('a file the server refused is marked on its own tile, in words', async () => {
    const drop = await ready(['ok.png', 'huge.png']);
    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(200, {
      uploaded: [{ name: 'ok.png' }],
      failures: [{ name: 'huge.png', code: 'TOO_LARGE', params: { limit: 1024 } }],
    });
    await done;

    assert.deepEqual(statuses(drop), ['done', 'error']);
    const caption = tiles(drop)[1].querySelector('.ddp-size');
    assert.match(caption.textContent, /1\.0 KB/, 'the limit was not spelled out');
    assert.equal(caption.classList.contains('is-error'), true);
    assert.equal(drop.files[1].error.code, 'TOO_LARGE');
    drop.destroy();
  });

  test('a refusal the widget has no wording for still says something', async () => {
    const drop = await ready();
    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(200, { uploaded: [], failures: [{ name: 'a.png', code: 'WEIRD_CODE' }] });
    await done;

    const caption = tiles(drop)[0].querySelector('.ddp-size').textContent;
    assert.ok(caption.length > 0);
    assert.match(caption, /WEIRD_CODE/, 'an unknown code left the tile blank');
    drop.destroy();
  });

  test('a rejected request marks every file it was carrying', async () => {
    const drop = await ready(['a.png', 'b.png']);
    const errors = [];
    drop.on('error', (e) => errors.push(e.code));

    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(413, { code: 'TOTAL_TOO_LARGE', error: 'The request is over the size limit' });
    assert.equal(await done, null);

    assert.deepEqual(statuses(drop), ['error', 'error']);
    assert.deepEqual(errors, ['TOTAL_TOO_LARGE']);
    drop.destroy();
  });

  test('an unreachable server says so rather than looking successful', async () => {
    const drop = await ready();
    const errors = [];
    drop.on('error', (e) => errors.push([e.code, e.message]));
    const done = drop.upload();
    await settled();
    FakeXHR.last.fire('error');
    await done;

    assert.equal(errors[0][0], 'NETWORK');
    assert.ok(errors[0][1].length > 0);
    assert.deepEqual(statuses(drop), ['error']);
    drop.destroy();
  });
});

describe('upload: cancelling', () => {
  test('cancel stops the request in flight', async () => {
    const drop = await ready();
    const errors = [];
    drop.on('error', (e) => errors.push(e.code));

    const done = drop.upload();
    await settled();
    drop.cancel();
    await done;

    assert.equal(FakeXHR.last.aborted, true);
    assert.deepEqual(errors, ['ABORTED']);
    assert.equal(drop.busy, false);
    assert.equal(drop.progress.hidden, true);
    drop.destroy();
  });

  test('the cancel button does the same', async () => {
    const drop = await ready();
    const done = drop.upload();
    await settled();
    drop.cancelButton.fire('click');
    await done;
    assert.equal(FakeXHR.last.aborted, true);
    drop.destroy();
  });

  test('a cancelled file is not a failed file', async () => {
    const drop = await ready(['a.png', 'b.png']);
    const first = drop.upload();
    await settled();
    drop.cancel();
    await first;

    // Nothing is wrong with these files; the user simply changed their mind.
    assert.deepEqual(statuses(drop), ['ready', 'ready']);
    assert.deepEqual(drop.files.map((f) => f.error), [null, null]);
    drop.destroy();
  });

  test('after cancelling, the same queue can be sent again', async () => {
    const drop = await ready();
    const first = drop.upload();
    await settled();
    const abandoned = FakeXHR.last;
    drop.cancel();
    await first;

    const second = drop.upload();
    await settled();
    assert.notEqual(FakeXHR.last, abandoned, 'pressing Upload again did nothing');
    assert.equal(FakeXHR.last.aborted, false, 'the new request inherited the old cancellation');
    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }], failures: [] });
    assert.ok(await second);
    assert.deepEqual(statuses(drop), ['done']);
    drop.destroy();
  });

  test('destroying the widget mid-upload stops the request', async () => {
    const drop = await ready();
    const done = drop.upload();
    await settled();
    const xhr = FakeXHR.last;
    drop.destroy();
    await done;

    assert.equal(xhr.aborted, true, 'a destroyed widget left a request running');
    assert.equal(dom.urls.size, 0);
  });

  test('cancel with nothing in flight is not an error', async () => {
    const drop = await ready();
    assert.doesNotThrow(() => drop.cancel());
    drop.destroy();
  });
});

describe('upload: a host listener that throws', () => {
  test('does not take the upload down with it', async () => {
    const drop = await ready();
    drop.on('uploaded', () => { throw new Error('host bug'); });

    const done = drop.upload();
    await settled();
    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }], failures: [] });
    const answer = await done;

    assert.ok(answer, 'the upload was reported as failed because a listener threw');
    assert.equal(drop.busy, false);
    assert.deepEqual(statuses(drop), ['done']);
    drop.destroy();
  });
});

describe('upload: autoUpload', () => {
  test('files are sent as soon as they are chosen', async () => {
    const drop = mount({ autoUpload: true });
    const adding = drop.add([image('a.png')]);
    await settled();

    assert.ok(FakeXHR.last, 'nothing was sent although autoUpload is on');
    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }], failures: [] });
    await adding;
    assert.deepEqual(statuses(drop), ['done']);
    drop.destroy();
  });

  test('without an endpoint it stays a plain form field', async () => {
    const drop = new DropPreview(dom.root, { autoUpload: true });
    await drop.add([image('a.png')]);
    assert.equal(FakeXHR.last, null);
    assert.deepEqual(drop.input.files.map((f) => f.name), ['a.png']);
    drop.destroy();
  });

  test('a batch where everything was refused sends nothing', async () => {
    const drop = mount({ autoUpload: true });
    await drop.add([new File(['plain'], 'note.txt', { type: 'text/plain' })]);
    assert.equal(FakeXHR.last, null, 'an empty request went out');
    drop.destroy();
  });
});
