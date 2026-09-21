import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { el, clear } from '../src/ui/dom.js';
import { installDom, uninstallDom } from './helpers/fake-dom.js';

before(() => installDom());
after(uninstallDom);

describe('el', () => {
  test('the tag string carries the classes', () => {
    const node = el('button.ddp-btn.ddp-btn-primary');
    assert.equal(node.tagName, 'BUTTON');
    assert.equal(node.classList.contains('ddp-btn'), true);
    assert.equal(node.classList.contains('ddp-btn-primary'), true);
  });

  test('an empty tag is a div', () => {
    assert.equal(el('.ddp-thumb').tagName, 'DIV');
  });

  test('text is set as text, never parsed', () => {
    // This is the whole reason the module has no `html:` option: file names
    // come from the user, and the version that concatenated them into
    // innerHTML is exactly where that became a scripting hole.
    const node = el('span', { text: '<img src=x onerror=alert(1)>' });
    assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(node.children.length, 0);
  });

  test('a string child becomes a text node, not markup', () => {
    const node = el('div', {}, ['<b>bold</b>']);
    assert.equal(node.children.length, 1);
    assert.equal(node.children[0].tagName, '#TEXT');
    assert.equal(node.children[0].textContent, '<b>bold</b>');
  });

  test('dataset, style and listeners are wired, not stringified', () => {
    let clicked = 0;
    const node = el('div', {
      dataset: { status: 'ready' },
      style: { backgroundImage: 'url("blob:x")' },
      on: { click: () => { clicked += 1; } },
    });
    assert.equal(node.dataset.status, 'ready');
    assert.equal(node.style.backgroundImage, 'url("blob:x")');
    node.fire('click');
    assert.equal(clicked, 1);
  });

  test('a known property is assigned, an unknown one becomes an attribute', () => {
    const node = el('input', { type: 'file', disabled: true, 'aria-label': 'Choose files' });
    assert.equal(node.disabled, true);
    assert.equal(node.getAttribute('aria-label'), 'Choose files');
    assert.equal(node.getAttribute('type'), 'file');
  });

  test('true becomes a bare attribute, false and null are left off entirely', () => {
    const node = el('div', { hidden: false, title: null, role: true, 'data-x': undefined });
    assert.equal(node.getAttribute('role'), '');
    assert.equal(node.getAttribute('title'), null);
    assert.equal(node.getAttribute('data-x'), null);
  });

  test('a class attribute adds to what the tag string set', () => {
    const node = el('div.a', { class: 'b c' });
    assert.deepEqual([...node.classList.set], ['a', 'b', 'c']);
    assert.deepEqual([...el('div.a', { class: '' }).classList.set], ['a']);
  });

  test('children are flattened, and empty slots skipped', () => {
    const node = el('div', {}, [el('span'), [el('b'), null], undefined, false, el('i')]);
    assert.deepEqual(node.children.map((c) => c.tagName), ['SPAN', 'B', 'I']);
  });
});

describe('clear', () => {
  test('it empties a node and hands it back', () => {
    const node = el('div', {}, [el('span'), el('span')]);
    assert.equal(clear(node), node);
    assert.equal(node.children.length, 0);
  });

  test('clearing an empty node is not an error', () => {
    assert.doesNotThrow(() => clear(el('div')));
  });
});
