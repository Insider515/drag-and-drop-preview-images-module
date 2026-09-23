/**
 * The multipart parser is an optional peer dependency, and the whole point of
 * that choice is what happens when it is not installed.
 *
 * Measured before this: the handler was built without complaint, the app
 * started, looked healthy, and answered the first real upload with a plain
 * `500 {"error":"Internal server error"}`. The reason — `Cannot find module
 * 'busboy'` — reached the host only if it had wired `onWarning`, and only
 * after somebody's upload had already failed.
 *
 * The failure belongs at the moment the handler is built instead, and it has
 * to name the command that fixes it. The message is what these tests hold on
 * to; that `createUploadHandler` asks for the module up front was checked by
 * taking busboy out of `node_modules` and watching the handler refuse to be
 * built, which no test can do to itself.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadBusboy } from '../server/busboy.js';

/** `assert.throws` hands back nothing, and the error itself is the subject. */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('nothing was thrown');
}

/** What `require` throws for a module that is not installed. */
const absent = () => {
  throw Object.assign(new Error("Cannot find module 'busboy'"), { code: 'MODULE_NOT_FOUND' });
};

describe('busboy: an optional peer, and what happens without it', () => {
  test('a missing parser names the one command that fixes it', () => {
    const error = caught(() => loadBusboy(absent));

    assert.equal(error.code, 'BUSBOY_MISSING');
    assert.match(error.message, /npm install busboy/,
      'the message does not say what to do about it');
    assert.match(error.message, /optional peer dependency/,
      'the message does not say why it is not already there');
  });

  test('the original failure is kept, rather than replaced', () => {
    // A host debugging this wants to see that it was a resolution failure and
    // not, say, a broken install of the module itself.
    const error = caught(() => loadBusboy(absent));

    assert.equal(error.cause?.code, 'MODULE_NOT_FOUND');
  });

  test('it is there in this project, and loads', () => {
    // The package itself keeps busboy as a dev dependency: the server half is
    // tested here even though installing the package does not bring it.
    assert.equal(typeof loadBusboy(), 'function');
  });

  test('a caller with its own resolver is not answered from the cache', () => {
    // The line above resolved the real module. A test asking about a failing
    // resolver is asking about that resolver, and a cache that answered anyway
    // would make every check here pass for the wrong reason.
    assert.throws(() => loadBusboy(absent), { code: 'BUSBOY_MISSING' });
  });
});
