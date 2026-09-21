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
const thumbs = (drop) => drop.root.querySelectorAll('.ddp-thumb');
/** How many tiles are showing a picture right now. */
const painted = (drop) => thumbs(drop).filter((t) => t.style.backgroundImage).length;
/** Let the rest of a batch decode, and wait for add() to finish. */
async function release(drop, adding) {
  while (dom.decode.pending.length || !(await Promise.race([adding.then(() => true), settled()]))) {
    dom.decode.pending.shift()?.();
    await settled();
  }
  return adding;
}

describe('previews: tiles fill in one at a time', () => {
  test('the tiles are on screen before any picture has decoded', async () => {
    dom.decode.manual = true;
    const drop = mount();
    const adding = drop.add([image('a.png'), image('b.png'), image('c.png')]);
    await settled();

    // Three empty squares, sized and labelled, while the first decode is
    // still outstanding — the user sees the queue land, not a frozen page.
    assert.equal(tiles(drop).length, 3);
    assert.equal(painted(drop), 0);
    assert.deepEqual(
      tiles(drop).map((t) => t.querySelector('.ddp-name').textContent),
      ['a.png', 'b.png', 'c.png']
    );

    await release(drop, adding);
    drop.destroy();
  });

  test('each picture appears as it decodes, not all at the end', async () => {
    dom.decode.manual = true;
    const drop = mount();
    const adding = drop.add([image('a.png'), image('b.png'), image('c.png')]);
    await settled();

    // Only one decode is in flight: the batch is walked in order, so the
    // first tile can be filled without waiting on the last file.
    assert.equal(dom.decode.pending.length, 1, 'the batch decodes all at once');

    dom.decode.pending.shift()();
    await settled();
    assert.equal(painted(drop), 1, 'the first picture did not appear on its own');
    assert.equal(dom.decode.pending.length, 1, 'the next file did not start');

    dom.decode.pending.shift()();
    await settled();
    assert.equal(painted(drop), 2);

    await release(drop, adding);
    assert.equal(painted(drop), 3);
    drop.destroy();
  });

  test('a preview landing does not disturb the tiles beside it', async () => {
    dom.decode.manual = true;
    const drop = mount();
    const adding = drop.add([image('a.png'), image('b.png'), image('c.png')]);
    await settled();

    // Hold on to the tiles as they were built, before anything decoded.
    const built = tiles(drop);
    await release(drop, adding);

    // Every picture landed in the tile that was already standing there. A
    // version that redraws the list to show a preview hands back different
    // elements, and with them the scroll position and any focus inside.
    assert.deepEqual(tiles(drop), built, 'the tiles were rebuilt');
    assert.equal(painted(drop), 3);
    drop.destroy();
  });

  test('a second batch keeps the pictures already on screen', async () => {
    const drop = mount();
    await drop.add([image('a.png'), image('b.png')]);
    const first = tiles(drop)[0].querySelector('.ddp-thumb').style.backgroundImage;

    await drop.add([image('c.png')]);

    // Adding redraws the list to renumber the counter; what must survive is
    // what the user is looking at, not the element identity.
    assert.equal(tiles(drop).length, 3);
    assert.equal(tiles(drop)[0].querySelector('.ddp-thumb').style.backgroundImage, first);
    assert.equal(dom.urls.size, 3, 'a redraw made a second URL per file');
    drop.destroy();
  });

  test('a file that cannot be decoded says so on its own tile', async () => {
    dom.decode.fail = true;
    const drop = mount();
    await drop.add([image('broken.png')]);

    const [tile] = tiles(drop);
    assert.equal(tile.dataset.status, 'error');
    assert.equal(tile.querySelector('.ddp-thumb').classList.contains('is-error'), true);
    assert.equal(tile.querySelector('.ddp-size').textContent, drop.t('error.DECODE_FAILED'));
    drop.destroy();
  });

  test('an image past the pixel limit is refused, and its URL released', async () => {
    Object.assign(dom.decode, { width: 20000, height: 20000 });
    const drop = mount({ limits: { maxPixels: 1000 } });
    await drop.add([image('bomb.png')]);

    const [tile] = tiles(drop);
    assert.equal(tile.dataset.status, 'error');
    assert.match(tile.querySelector('.ddp-size').textContent, /too many pixels/i);
    assert.equal(dom.urls.size, 0, 'the object URL was not revoked');
    drop.destroy();
  });
});

describe('previews: object URLs are released', () => {
  test('removing one file releases only its own URL', async () => {
    const drop = mount();
    await drop.add([image('a.png'), image('b.png')]);
    assert.equal(dom.urls.size, 2);

    drop.remove(drop.files[0].id);
    assert.equal(dom.urls.size, 1);
    drop.destroy();
  });

  test('clear() releases all of them', async () => {
    const drop = mount();
    await drop.add([image('a.png'), image('b.png'), image('c.png')]);
    drop.clear();
    assert.equal(dom.urls.size, 0);
    drop.destroy();
  });

  test('destroy() releases them even without clear()', async () => {
    const drop = mount();
    await drop.add([image('a.png'), image('b.png')]);
    drop.destroy();
    assert.equal(dom.urls.size, 0);
  });

  test('a queue built and emptied many times leaks nothing', async () => {
    const drop = mount();
    for (let round = 0; round < 20; round += 1) {
      await drop.add([image(`r${round}-a.png`), image(`r${round}-b.png`)]);
      drop.clear();
    }
    assert.equal(dom.urls.size, 0);
    assert.equal(tiles(drop).length, 0);
    drop.destroy();
  });
});

describe('previews: the hidden input tracks the queue', () => {
  test('it holds exactly what is on screen, in order', async () => {
    const drop = mount();
    await drop.add([image('a.png'), image('b.png'), image('c.png')]);
    assert.deepEqual(drop.input.files.map((f) => f.name), ['a.png', 'b.png', 'c.png']);

    drop.remove(drop.files[1].id);
    assert.deepEqual(drop.input.files.map((f) => f.name), ['a.png', 'c.png']);
    drop.destroy();
  });

  test('removing from the middle repeatedly takes the right file each time', async () => {
    // The implementation this replaces deleted by index and took the wrong
    // file from the second removal onwards.
    const drop = mount();
    await drop.add(['a', 'b', 'c', 'd', 'e'].map((n) => image(`${n}.png`)));

    for (const expected of ['b.png', 'c.png', 'd.png']) {
      const target = drop.files[1];
      assert.equal(target.name, expected);
      drop.remove(target.id);
    }
    assert.deepEqual(drop.files.map((f) => f.name), ['a.png', 'e.png']);
    assert.deepEqual(drop.input.files.map((f) => f.name), ['a.png', 'e.png']);
    drop.destroy();
  });
});

describe('previews: names are text, never markup', () => {
  test('a name that looks like an element is set as text', async () => {
    const drop = mount();
    const hostile = '<img src=x onerror=alert(1)>.png';
    await drop.add([image(hostile)]);

    const [tile] = tiles(drop);
    assert.equal(tile.querySelector('.ddp-name').textContent, hostile);
    // Nothing was parsed into elements — the only nodes are the ones built.
    assert.equal(tile.querySelectorAll('IMG').length, 0);
    assert.equal(tile.querySelectorAll('SCRIPT').length, 0);
    drop.destroy();
  });

  test('the remove button labels itself with the name as text', async () => {
    const drop = mount();
    await drop.add([image('</span><script>x</script>.png')]);
    const label = tiles(drop)[0].querySelector('.ddp-remove').getAttribute('aria-label');
    assert.match(label, /<script>/);
    assert.equal(tiles(drop)[0].querySelectorAll('SCRIPT').length, 0);
    drop.destroy();
  });
});
