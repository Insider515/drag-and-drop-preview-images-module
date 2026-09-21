import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DropPreview } from '../src/drop-preview.js';
import { installDom, uninstallDom, settled, image } from './helpers/fake-dom.js';

let dom;
before(() => { dom = installDom(); });
after(uninstallDom);
beforeEach(() => dom.reset());

const mount = (options) => new DropPreview(dom.root, options);
const tiles = (drop) => drop.root.querySelectorAll('.ddp-tile');
const names = (drop) => drop.files.map((f) => f.name);

/** A drop event carrying files, as the browser would deliver it. */
function dropEvent(files) {
  let prevented = false;
  return {
    preventDefault: () => { prevented = true; },
    dataTransfer: { files, dropEffect: null },
    get prevented() { return prevented; },
  };
}

describe('queue: drag and drop', () => {
  test('a drop adds the files it carries', async () => {
    const drop = mount();
    drop.zone.fire('drop', dropEvent([image('a.png'), image('b.png')]));
    await settled();
    assert.deepEqual(names(drop), ['a.png', 'b.png']);
    drop.destroy();
  });

  test('a drop cancels the browser default, or the page navigates away', async () => {
    const drop = mount();
    const event = dropEvent([image('a.png')]);
    drop.zone.fire('drop', event);
    assert.equal(event.prevented, true);
    await settled();
    drop.destroy();
  });

  test('dragover cancels the default and asks for a copy cursor', () => {
    const drop = mount();
    const event = dropEvent([]);
    drop.zone.fire('dragover', event);
    assert.equal(event.prevented, true);
    assert.equal(event.dataTransfer.dropEffect, 'copy');
    drop.destroy();
  });

  test('a drop with nothing in it is not an error', async () => {
    const drop = mount();
    assert.doesNotThrow(() => drop.zone.fire('drop', dropEvent([])));
    drop.zone.fire('drop', { preventDefault() {} });
    await settled();
    assert.deepEqual(names(drop), []);
    drop.destroy();
  });

  test('the highlight survives the pointer crossing child elements', () => {
    // dragenter/dragleave fire for every child under the cursor; a single
    // flag makes the zone flicker as the pointer moves across its own text.
    const drop = mount();
    const active = () => drop.zone.classList.contains('is-active');

    drop.zone.fire('dragenter', dropEvent([]));
    assert.equal(active(), true);
    drop.zone.fire('dragenter', dropEvent([]));  // over a child
    drop.zone.fire('dragleave', {});             // leaving that child
    assert.equal(active(), true, 'the highlight dropped while still inside');

    drop.zone.fire('dragleave', {});             // leaving the zone
    assert.equal(active(), false);
    drop.destroy();
  });

  test('a drop clears the highlight even after uneven enter and leave counts', () => {
    const drop = mount();
    drop.zone.fire('dragenter', dropEvent([]));
    drop.zone.fire('dragenter', dropEvent([]));
    drop.zone.fire('drop', dropEvent([]));
    assert.equal(drop.zone.classList.contains('is-active'), false);
    drop.destroy();
  });

  test('extra dragleave events cannot push the counter negative', () => {
    const drop = mount();
    drop.zone.fire('dragleave', {});
    drop.zone.fire('dragleave', {});
    drop.zone.fire('dragenter', dropEvent([]));
    assert.equal(drop.zone.classList.contains('is-active'), true,
      'the zone stopped responding to drags');
    drop.destroy();
  });

  test('focus shows the zone as active, for keyboard users', () => {
    const drop = mount();
    drop.input.fire('focus', {});
    assert.equal(drop.zone.classList.contains('is-active'), true);
    drop.input.fire('blur', {});
    assert.equal(drop.zone.classList.contains('is-active'), false);
    drop.destroy();
  });
});

describe('queue: the file picker', () => {
  test('choosing files adds them', async () => {
    const drop = mount();
    drop.input.files = [image('a.png')];
    drop.input.fire('change', {});
    await settled();
    assert.deepEqual(names(drop), ['a.png']);
    drop.destroy();
  });

  test('the input is emptied after every batch', async () => {
    // Left in place, the browser's own selection would be added a second time
    // on the next pick, and a form submit would carry each file twice.
    const drop = mount();
    await drop.add([image('a.png')]);
    assert.deepEqual(drop.input.files.map((f) => f.name), ['a.png'],
      'the input holds the queue, not the last pick');

    await drop.add([image('b.png')]);
    assert.deepEqual(drop.input.files.map((f) => f.name), ['a.png', 'b.png']);
    drop.destroy();
  });
});

describe('queue: what is refused, and how the host hears about it', () => {
  test('a rejected file is reported with a code, not silently dropped', async () => {
    const heard = [];
    const drop = mount();
    drop.on('rejected', ({ rejected }) => heard.push(...rejected.map((r) => [r.file.name, r.code])));

    const result = await drop.add([new File(['plain text'], 'note.txt', { type: 'text/plain' })]);

    assert.deepEqual(heard, [['note.txt', 'NOT_AN_IMAGE']]);
    assert.deepEqual(result.rejected.map((r) => r.code), ['NOT_AN_IMAGE']);
    assert.deepEqual(names(drop), [], 'a refused file reached the queue');
    drop.destroy();
  });

  test('the good files in a mixed batch still get in', async () => {
    const drop = mount();
    const result = await drop.add([
      image('good.png'),
      new File(['#!/bin/sh\necho hi'], 'evil.png', { type: 'image/png' }),
      image('also-good.png'),
    ]);

    assert.deepEqual(names(drop), ['good.png', 'also-good.png']);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].file.name, 'evil.png');
    drop.destroy();
  });

  test('the same file picked twice is refused the second time', async () => {
    const drop = mount();
    await drop.add([image('a.png', 600)]);
    const result = await drop.add([image('a.png', 600)]);

    assert.deepEqual(names(drop), ['a.png']);
    assert.equal(result.rejected[0].code, 'DUPLICATE');
    drop.destroy();
  });

  test('a duplicate inside one batch is caught too', async () => {
    const drop = mount();
    const result = await drop.add([image('a.png', 600), image('a.png', 600)]);
    assert.equal(tiles(drop).length, 1);
    assert.equal(result.rejected[0].code, 'DUPLICATE');
    drop.destroy();
  });

  test('the count limit is counted against what is already queued', async () => {
    const drop = mount({ limits: { maxFiles: 2 } });
    await drop.add([image('a.png'), image('b.png')]);
    const result = await drop.add([image('c.png')]);

    assert.deepEqual(names(drop), ['a.png', 'b.png']);
    assert.equal(result.rejected[0].code, 'TOO_MANY');
    assert.deepEqual(result.rejected[0].detail, { limit: 2 });
    drop.destroy();
  });

  test('a file over the size limit says what the limit is', async () => {
    const drop = mount({ limits: { maxFileSize: 1024 } });
    const result = await drop.add([image('big.png', 4096)]);
    assert.equal(result.rejected[0].code, 'TOO_LARGE');
    assert.equal(result.rejected[0].detail.limit, 1024);
    drop.destroy();
  });

  test('SVG is refused unless the host asked for it', async () => {
    const svg = () => new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      'x.svg', { type: 'image/svg+xml' });

    const strict = mount();
    assert.equal((await strict.add([svg()])).rejected[0].code, 'SVG_REFUSED');
    strict.destroy();

    const permissive = mount({ allowSvg: true });
    assert.deepEqual((await permissive.add([svg()])).accepted.map((f) => f.name), ['x.svg']);
    permissive.destroy();
  });

  test('the accept list is matched against the bytes, not the extension', async () => {
    const drop = mount({ accept: ['image/jpeg'] });
    const result = await drop.add([image('photo.jpg')]); // PNG bytes, .jpg name
    assert.equal(result.rejected[0].code, 'TYPE_NOT_ALLOWED');
    assert.equal(result.rejected[0].detail.type, 'image/png');
    assert.deepEqual(names(drop), []);
    drop.destroy();
  });

  test('a refusal is spelled out in the active language', async () => {
    const drop = mount({ locale: 'uk' });
    const result = await drop.add([new File(['x'], 'note.txt', { type: 'text/plain' })]);
    const text = drop.describeError(result.rejected[0].code, result.rejected[0].detail);
    assert.ok(text.length > 0);
    assert.ok(/[а-яіїєґ]/i.test(text), `not Ukrainian: ${text}`);
    drop.destroy();
  });
});

describe('queue: change events', () => {
  test('change fires once per batch that added something', async () => {
    const counts = [];
    const drop = mount();
    drop.on('change', ({ files }) => counts.push(files.length));

    await drop.add([image('a.png'), image('b.png')]);
    await drop.add([new File(['x'], 'note.txt', { type: 'text/plain' })]);
    drop.remove(drop.files[0].id);
    drop.clear();

    // add(2) -> 2, the refused batch changes nothing, remove -> 1, clear -> 0
    assert.deepEqual(counts, [2, 1, 0]);
    drop.destroy();
  });

  test('clearing an empty queue is not a change', async () => {
    let fired = 0;
    const drop = mount();
    drop.on('change', () => { fired += 1; });
    drop.clear();
    assert.equal(fired, 0);
    drop.destroy();
  });

  test('a handler can unsubscribe itself', async () => {
    let fired = 0;
    const drop = mount();
    const off = drop.on('change', () => { fired += 1; });
    await drop.add([image('a.png')]);
    off();
    await drop.add([image('b.png')]);
    assert.equal(fired, 1);
    drop.destroy();
  });

  test('a destroyed widget stops calling its handlers', async () => {
    let fired = 0;
    const drop = mount();
    drop.on('change', () => { fired += 1; });
    drop.destroy();
    await drop.add([image('a.png')]);
    assert.equal(fired, 0);
  });
});
