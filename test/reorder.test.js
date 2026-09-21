import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DropPreview } from '../src/drop-preview.js';
import { installDom, uninstallDom, settled, image } from './helpers/fake-dom.js';

let dom;
before(() => { dom = installDom(); });
after(uninstallDom);
beforeEach(() => dom.reset());

const mount = (options) => new DropPreview(dom.root, options);
const order = (drop) => drop.files.map((f) => f.name);
const shown = (drop) =>
  drop.root.querySelectorAll('.ddp-tile').map((t) => t.querySelector('.ddp-name').textContent);
const inInput = (drop) => drop.input.files.map((f) => f.name);

async function ready(names = ['a.png', 'b.png', 'c.png', 'd.png'], options) {
  const drop = mount(options);
  await drop.add(names.map((n) => image(n)));
  return drop;
}

/** An Alt+arrow press on one tile. */
function press(drop, index, key, { alt = true } = {}) {
  let prevented = false;
  drop.root.querySelectorAll('.ddp-tile')[index].fire('keydown', {
    key,
    altKey: alt,
    preventDefault: () => { prevented = true; },
  });
  return prevented;
}

describe('reorder: moving a file in the queue', () => {
  test('to the front, to the back, and to the middle', async () => {
    const drop = await ready();

    drop.move(drop.files[3].id, 0);
    assert.deepEqual(order(drop), ['d.png', 'a.png', 'b.png', 'c.png']);

    drop.move(drop.files[0].id, 3);
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);

    drop.move(drop.files[0].id, 2);
    assert.deepEqual(order(drop), ['b.png', 'c.png', 'a.png', 'd.png']);
    drop.destroy();
  });

  test('the index means where it ends up, not where it was counted from', async () => {
    // Counting in the old queue is what produces the off-by-one when a file
    // moves forwards; "put this third" has to mean third afterwards.
    const drop = await ready();
    drop.move(drop.files[0].id, 2);
    assert.equal(order(drop)[2], 'a.png');
    drop.destroy();
  });

  test('what is on screen matches the queue', async () => {
    const drop = await ready();
    drop.move(drop.files[2].id, 0);
    assert.deepEqual(shown(drop), order(drop));
    drop.destroy();
  });

  test('the hidden input carries the new order, so a plain form does too', async () => {
    // Otherwise the page shows one order and sends another.
    const drop = await ready();
    drop.move(drop.files[3].id, 0);
    assert.deepEqual(inInput(drop), ['d.png', 'a.png', 'b.png', 'c.png']);
    drop.destroy();
  });

  test('an index past either end lands at that end', async () => {
    const drop = await ready();
    drop.move(drop.files[0].id, 99);
    assert.equal(order(drop).at(-1), 'a.png');
    drop.move(drop.files[3].id, -5);
    assert.equal(order(drop)[0], 'a.png');
    drop.destroy();
  });

  test('a move that changes nothing reports as much and stays quiet', async () => {
    const drop = await ready();
    const events = [];
    drop.on('reorder', () => events.push('reorder'));
    drop.on('change', () => events.push('change'));

    assert.equal(drop.move(drop.files[1].id, 1), false);
    assert.equal(drop.move('not-a-file', 0), false);
    assert.deepEqual(events, []);
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    drop.destroy();
  });

  test('a move says what moved and where', async () => {
    const drop = await ready();
    const seen = [];
    drop.on('reorder', (e) => seen.push([e.from, e.to, e.files.map((f) => f.name)]));

    drop.move(drop.files[3].id, 1);
    assert.deepEqual(seen, [[3, 1, ['a.png', 'd.png', 'b.png', 'c.png']]]);
    drop.destroy();
  });

  test('change fires too, because the queue did change', async () => {
    const drop = await ready();
    let changes = 0;
    drop.on('change', () => { changes += 1; });
    drop.move(drop.files[0].id, 1);
    assert.equal(changes, 1);
    drop.destroy();
  });
});

describe('reorder: from the keyboard', () => {
  test('Alt and an arrow move the tile', async () => {
    const drop = await ready();

    press(drop, 0, 'ArrowRight');
    assert.deepEqual(order(drop), ['b.png', 'a.png', 'c.png', 'd.png']);

    press(drop, 1, 'ArrowLeft');
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    drop.destroy();
  });

  test('up and down mean the same as left and right', async () => {
    const drop = await ready();
    press(drop, 0, 'ArrowDown');
    assert.deepEqual(order(drop), ['b.png', 'a.png', 'c.png', 'd.png']);
    press(drop, 1, 'ArrowUp');
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    drop.destroy();
  });

  test('a bare arrow is left to the browser', async () => {
    // On a focused item a bare arrow is expected to move the focus, not the
    // thing under it.
    const drop = await ready();
    const prevented = press(drop, 0, 'ArrowRight', { alt: false });
    assert.equal(prevented, false);
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    drop.destroy();
  });

  test('other keys are left alone', async () => {
    const drop = await ready();
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) {
      assert.equal(press(drop, 0, key), false, key);
    }
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    drop.destroy();
  });

  test('a tile at the end does not fall off it', async () => {
    const drop = await ready();
    press(drop, 0, 'ArrowLeft');
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    press(drop, 3, 'ArrowRight');
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    drop.destroy();
  });

  test('the tiles are reachable by keyboard at all', async () => {
    const drop = await ready();
    const tiles = drop.root.querySelectorAll('.ddp-tile');
    assert.equal(tiles[0].getAttribute('tabindex'), '0');
    assert.match(tiles[0].getAttribute('aria-keyshortcuts'), /Alt\+Arrow/);
    drop.destroy();
  });
});

describe('reorder: turned off', () => {
  test('the model refuses nothing — it is the interaction that goes', async () => {
    // A host with its own list UI can still call move(); what `reorder: false`
    // removes is the widget's own handling.
    const drop = await ready(undefined, { reorder: false });
    assert.equal(drop.move(drop.files[0].id, 2), true);
    assert.deepEqual(order(drop), ['b.png', 'c.png', 'a.png', 'd.png']);
    drop.destroy();
  });

  test('tiles are not focusable and arrows do nothing', async () => {
    const drop = await ready(undefined, { reorder: false });
    const tiles = drop.root.querySelectorAll('.ddp-tile');
    assert.equal(tiles[0].getAttribute('tabindex'), null);

    press(drop, 0, 'ArrowRight');
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png', 'd.png']);
    drop.destroy();
  });

  test('a value that is not a yes or a no is refused when the widget is built', () => {
    assert.throws(() => mount({ reorder: 'drag' }), /reorder must be/);
    assert.throws(() => mount({ reorder: 1 }), /reorder must be/);
  });
});

describe('reorder: it does not disturb the rest', () => {
  test('previews and errors travel with their file', async () => {
    dom.decode.fail = true;
    const drop = mount();
    await drop.add([image('broken.png')]);
    dom.decode.fail = false;
    await drop.add([image('good.png')]);

    drop.move(drop.files[0].id, 1);
    const tiles = drop.root.querySelectorAll('.ddp-tile');
    assert.deepEqual(tiles.map((t) => t.dataset.status), ['ready', 'error']);
    assert.equal(tiles[1].querySelector('.ddp-name').textContent, 'broken.png');
    drop.destroy();
  });

  test('removing after a move takes the right file', async () => {
    const drop = await ready();
    drop.move(drop.files[3].id, 0);
    drop.remove(drop.files[0].id);
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png']);
    drop.destroy();
  });

  test('a file added later goes to the end, wherever the others are', async () => {
    const drop = await ready();
    drop.move(drop.files[3].id, 0);
    await drop.add([image('late.png')]);
    assert.equal(order(drop).at(-1), 'late.png');
    drop.destroy();
  });

  test('no object URL is lost or duplicated by moving', async () => {
    const drop = await ready();
    const before = dom.urls.size;
    drop.move(drop.files[0].id, 3);
    drop.move(drop.files[2].id, 0);
    assert.equal(dom.urls.size, before);
    drop.destroy();
    assert.equal(dom.urls.size, 0);
  });
});

describe('reorder: the grip a finger needs', () => {
  test('every tile has one while reordering is on', async () => {
    const drop = await ready();
    assert.equal(drop.root.querySelectorAll('.ddp-grip').length, 4);
    drop.destroy();
  });

  test('and none when it is off', async () => {
    const drop = await ready(undefined, { reorder: false });
    assert.equal(drop.root.querySelectorAll('.ddp-grip').length, 0);
    drop.destroy();
  });

  test('it is hidden from a screen reader, which has Alt+arrow instead', async () => {
    const drop = await ready();
    assert.equal(drop.root.querySelectorAll('.ddp-grip')[0].getAttribute('aria-hidden'), 'true');
    drop.destroy();
  });

  test('a finger may only start a drag on it', async () => {
    // Everywhere else has to stay scrollable: until a drag has begun the
    // browser reads a moving touch as a scroll and cancels the pointer, so a
    // tile that was all grip would be a queue nobody could scroll past.
    const drop = await ready();
    const tile = drop.root.querySelectorAll('.ddp-tile')[0];
    const grip = tile.querySelector('.ddp-grip');
    const thumb = tile.querySelector('.ddp-thumb');

    // Held on the picture for longer than the hold, which is what would pick
    // a tile up if the grip were not required.
    drop.previews.fire('pointerdown', {
      target: thumb, pointerType: 'touch', button: 0, clientX: 0, clientY: 0,
      preventDefault() {}, });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(drop.previews.classList.contains('is-reordering'), false,
      'a touch on the picture started a drag');
    drop.previews.fire('pointerup', {});

    // The same gesture from the grip is a drag, once it has been held.
    drop.previews.fire('pointerdown', {
      target: grip, pointerType: 'touch', button: 0, clientX: 0, clientY: 0,
      preventDefault() {}, });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(drop.previews.classList.contains('is-reordering'), true,
      'holding the grip did not pick the tile up');

    drop.previews.fire('pointerup', {});
    assert.equal(drop.previews.classList.contains('is-reordering'), false);
    drop.destroy();
  });

  test('a mouse may start anywhere on the tile', async () => {
    // There is nothing to scroll away from with a pointer that has a cursor.
    const drop = await ready();
    const thumb = drop.root.querySelectorAll('.ddp-tile')[0].querySelector('.ddp-thumb');

    drop.previews.fire('pointerdown', {
      target: thumb, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0,
      preventDefault() {}, });
    drop.previews.fire('pointermove', {
      target: thumb, pointerType: 'mouse', clientX: 40, clientY: 0, preventDefault() {}, });

    assert.equal(drop.previews.classList.contains('is-reordering'), true);
    drop.previews.fire('pointerup', {});
    drop.destroy();
  });

  test('a press on the remove button is not a drag', async () => {
    const drop = await ready();
    const remove = drop.root.querySelectorAll('.ddp-tile')[0].querySelector('.ddp-remove');

    drop.previews.fire('pointerdown', {
      target: remove, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0,
      preventDefault() {}, });
    drop.previews.fire('pointermove', {
      target: remove, pointerType: 'mouse', clientX: 40, clientY: 0, preventDefault() {}, });

    assert.equal(drop.previews.classList.contains('is-reordering'), false);
    drop.destroy();
  });

  test('a right-click starts nothing', async () => {
    const drop = await ready();
    const thumb = drop.root.querySelectorAll('.ddp-tile')[0].querySelector('.ddp-thumb');
    drop.previews.fire('pointerdown', {
      target: thumb, pointerType: 'mouse', button: 2, clientX: 0, clientY: 0,
      preventDefault() {}, });
    drop.previews.fire('pointermove', {
      target: thumb, pointerType: 'mouse', clientX: 40, clientY: 0, preventDefault() {}, });
    assert.equal(drop.previews.classList.contains('is-reordering'), false);
    drop.destroy();
  });
});

describe('reorder: while an upload is running', () => {
  test('move() answers the same as the interface does', async () => {
    // The drag and the keyboard both refuse while busy. Letting the method
    // through would drift the order on screen away from the order the files
    // are going out in, for no gain: what is in flight is in flight either way.
    const { FakeXHR } = await import('./helpers/fake-dom.js');
    const drop = await ready(['a.png', 'b.png', 'c.png'], { endpoint: '/upload' });

    const sending = drop.upload();
    await settled();
    assert.equal(drop.busy, true);

    assert.equal(drop.move(drop.files[2].id, 0), false);
    assert.deepEqual(order(drop), ['a.png', 'b.png', 'c.png']);

    FakeXHR.last.respond(200, { uploaded: [{ name: 'a.png' }], failures: [] });
    for (let i = 0; i < 20 && drop.busy; i += 1) {
      await settled();
      if (FakeXHR.last) FakeXHR.last.respond(200, { uploaded: [], failures: [] });
    }
    await sending;

    // And works again the moment it is over.
    assert.equal(drop.move(drop.files[2].id, 0), true);
    drop.destroy();
  });
});
