import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { DropPreview } from '../src/drop-preview.js';
import { installDom, uninstallDom, settled, image } from './helpers/fake-dom.js';

let dom;
before(() => { dom = installDom(); });
after(() => {
  delete globalThis.matchMedia;
  uninstallDom();
});
beforeEach(() => {
  dom.reset();
  // A desktop, unless a case says otherwise.
  globalThis.matchMedia = (query) => ({ matches: false, media: query });
});

const mount = (options) => new DropPreview(dom.root, options);
const names = (drop) => drop.files.map((f) => f.name);

/** A paste event carrying files, as the browser delivers one. */
function pasteEvent(files, target) {
  let prevented = false;
  return {
    target,
    clipboardData: { files },
    preventDefault: () => { prevented = true; },
    get prevented() { return prevented; },
  };
}

describe('paste: on unless the host turns it off', () => {
  test('a pasted picture joins the queue', async () => {
    const drop = mount();
    drop.root.fire('paste', pasteEvent([image('screenshot.png')], drop.root));
    await settled();

    assert.deepEqual(names(drop), ['screenshot.png']);
    drop.destroy();
  });

  test('the browser is stopped from doing its own thing with it', async () => {
    const drop = mount();
    const event = pasteEvent([image('a.png')], drop.root);
    drop.root.fire('paste', event);
    await settled();

    assert.equal(event.prevented, true);
    drop.destroy();
  });

  test('a paste with no files at all is left alone', async () => {
    // Text pasted anywhere near the widget is not an upload.
    const drop = mount();
    const event = pasteEvent([], drop.root);
    drop.root.fire('paste', event);
    await settled();

    assert.equal(event.prevented, false, 'a text paste was swallowed');
    assert.deepEqual(names(drop), []);
    drop.destroy();
  });

  test('several pictures at once all arrive', async () => {
    const drop = mount();
    drop.root.fire('paste', pasteEvent([image('a.png'), image('b.png')], drop.root));
    await settled();
    assert.deepEqual(names(drop), ['a.png', 'b.png']);
    drop.destroy();
  });

  test('what is pasted is checked like anything else', async () => {
    const drop = mount();
    const rejected = [];
    drop.on('rejected', ({ rejected: list }) => rejected.push(...list.map((r) => r.code)));

    drop.root.fire('paste', pasteEvent([new File(['plain'], 'note.txt', { type: 'text/plain' })], drop.root));
    await settled();

    assert.deepEqual(names(drop), []);
    assert.deepEqual(rejected, ['NOT_AN_IMAGE']);
    drop.destroy();
  });

  test('turning it off means nothing listens', async () => {
    const drop = mount({ paste: false });
    const event = pasteEvent([image('a.png')], drop.root);
    drop.root.fire('paste', event);
    await settled();

    assert.deepEqual(names(drop), []);
    assert.equal(event.prevented, false);
    drop.destroy();
  });

  test('a value that is neither is refused when the widget is built', () => {
    assert.throws(() => mount({ paste: 'sometimes' }), /paste must be/);
    assert.throws(() => mount({ paste: 1 }), /paste must be/);
  });
});

describe('paste: whose paste it is', () => {
  test('by default it listens to itself, not to the page', async () => {
    // Two of these on one screen would otherwise both take the same paste,
    // and the module registers nothing globally by design.
    const drop = mount();
    assert.equal(globalThis.document.listenerCount('paste'), 0,
      'it attached itself to the whole page');
    drop.destroy();
  });

  test('two widgets do not both take one paste', async () => {
    const first = mount();
    const second = mount();

    first.root.fire('paste', pasteEvent([image('a.png')], first.root));
    await settled();

    assert.deepEqual(names(first), ['a.png']);
    assert.deepEqual(names(second), [], 'the other widget took it too');
    first.destroy();
    second.destroy();
  });

  test("'document' listens to the whole page, and stops when destroyed", async () => {
    const drop = mount({ paste: 'document' });
    assert.equal(globalThis.document.listenerCount('paste'), 1);

    globalThis.document.fire('paste', pasteEvent([image('anywhere.png')], drop.root));
    await settled();
    assert.deepEqual(names(drop), ['anywhere.png']);

    // A page-level listener outliving its widget would go on adding files to
    // a queue nobody can see.
    drop.destroy();
    assert.equal(globalThis.document.listenerCount('paste'), 0);
  });

  test('a paste into a text field is that field’s, not the widget’s', async () => {
    const drop = mount({ paste: 'document' });
    const field = globalThis.document.createElement('textarea');

    globalThis.document.fire('paste', pasteEvent([image('a.png')], field));
    await settled();
    assert.deepEqual(names(drop), [], 'it stole a paste meant for a text field');

    const editable = globalThis.document.createElement('div');
    editable.isContentEditable = true;
    globalThis.document.fire('paste', pasteEvent([image('b.png')], editable));
    await settled();
    assert.deepEqual(names(drop), []);
    drop.destroy();
  });
});

describe('camera: the button', () => {
  test('a phone gets one', () => {
    globalThis.matchMedia = (query) => ({ matches: query.includes('coarse'), media: query });
    const drop = mount();
    assert.ok(drop.cameraButton, 'no camera button on a touch device');
    assert.equal(drop.cameraButton.textContent, 'Take a photo');
    drop.destroy();
  });

  test('a desktop does not', () => {
    // There it would open the same file dialog as the button beside it.
    const drop = mount();
    assert.equal(drop.cameraButton, undefined);
    assert.deepEqual(drop.sources.children, []);
    drop.destroy();
  });

  test('the host can insist either way', () => {
    const forced = mount({ camera: true });
    assert.ok(forced.cameraButton, 'camera: true was ignored on a desktop');
    forced.destroy();

    globalThis.matchMedia = (query) => ({ matches: true, media: query });
    const refused = mount({ camera: false });
    assert.equal(refused.cameraButton, undefined, 'camera: false was ignored on a phone');
    refused.destroy();
  });

  test('a browser too old to be asked is treated as a desktop', () => {
    delete globalThis.matchMedia;
    const drop = mount();
    assert.equal(drop.cameraButton, undefined);
    drop.destroy();
  });

  test('it is labelled in the active language', () => {
    const drop = mount({ camera: true, locale: 'uk' });
    assert.equal(drop.cameraButton.textContent, 'Зробити фото');
    drop.destroy();
  });

  test('a nonsensical setting is refused when the widget is built', () => {
    assert.throws(() => mount({ camera: 'maybe' }), /camera must be/);
    assert.throws(() => mount({ capture: 'front' }), /capture must be/);
  });
});

describe('camera: the input behind it', () => {
  test('it asks for the camera, and for one photograph', () => {
    // A browser that honours `capture` ignores `multiple`: a camera returns
    // one picture. Putting this on the main input would mean giving up
    // choosing from the gallery, which is what most uploads are.
    const drop = mount({ camera: true });
    assert.equal(drop.cameraInput.getAttribute('capture'), 'environment');
    assert.equal(drop.cameraInput.getAttribute('accept'), 'image/*');
    assert.notEqual(drop.cameraInput.multiple, true);

    // The main input is untouched, and still takes several from the gallery.
    assert.equal(drop.input.getAttribute('capture'), null);
    assert.equal(drop.input.multiple, true);
    drop.destroy();
  });

  test('the front camera is a setting', () => {
    const drop = mount({ camera: true, capture: 'user' });
    assert.equal(drop.cameraInput.getAttribute('capture'), 'user');
    drop.destroy();
  });

  test('a photograph taken joins the queue', async () => {
    const drop = mount({ camera: true });
    drop.cameraInput.files = [image('IMG_0001.jpg')];
    drop.cameraInput.fire('change', {});
    await settled();

    assert.deepEqual(names(drop), ['IMG_0001.jpg']);
    drop.destroy();
  });

  test('the input is emptied, so the same shot can be taken twice', async () => {
    // Left in place, a browser decides nothing changed and fires nothing.
    const drop = mount({ camera: true });
    drop.cameraInput.files = [image('IMG_0001.jpg')];
    drop.cameraInput.fire('change', {});
    await settled();

    assert.equal(drop.cameraInput.value, '');
    drop.destroy();
  });

  test('a photograph is checked like anything else', async () => {
    const drop = mount({ camera: true });
    const rejected = [];
    drop.on('rejected', ({ rejected: list }) => rejected.push(...list.map((r) => r.code)));

    drop.cameraInput.files = [new File(['not a picture'], 'IMG_0002.jpg', { type: 'image/jpeg' })];
    drop.cameraInput.fire('change', {});
    await settled();

    assert.deepEqual(names(drop), []);
    assert.deepEqual(rejected, ['NOT_AN_IMAGE']);
    drop.destroy();
  });

  test('the camera row is outside the action row, which hides when empty', () => {
    // Taking a photograph is exactly what somebody does with an empty queue.
    const drop = mount({ camera: true });
    assert.equal(drop.files.length, 0);
    assert.ok(drop.sources.children.includes(drop.cameraButton));
    assert.ok(!drop.actions.children.includes(drop.cameraButton));
    drop.destroy();
  });
});
