import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { assertValidName, baseName, resolveInside, withSuffix } from '../server/safe-name.js';
import { UploadError } from '../server/errors.js';

const refuses = (raw, because) =>
  assert.throws(() => assertValidName(raw), UploadError, because ?? `should refuse: ${raw}`);

describe('names: what a browser legitimately sends', () => {
  test('a directory upload sends a path; only the last segment is meant', () => {
    assert.equal(assertValidName('photos/2026/a.jpg'), 'a.jpg');
    assert.equal(assertValidName('photos\\2026\\a.jpg'), 'a.jpg');
    assert.equal(assertValidName('C:\\Users\\mika\\a.jpg'), 'a.jpg');
  });

  test('ordinary names pass through untouched', () => {
    for (const name of ['photo.jpg', 'Звіт 2026.png', '照片.webp', 'a-b_c.2.gif']) {
      assert.equal(assertValidName(name), name);
    }
  });

  test('baseName is what does the trimming', () => {
    assert.equal(baseName('a/b/c.png'), 'c.png');
    assert.equal(baseName('c.png'), 'c.png');
  });
});

describe('names: what is refused outright', () => {
  test('traversal in every spelling', () => {
    for (const raw of ['../evil.png', '..\\evil.png', 'a/../../evil.png', '..']) refuses(raw);
  });

  test('a NUL byte', () => {
    // Truncates the name in a C string, so `a.png\0.sh` can be written as one
    // thing and executed as another.
    refuses('a.png\u0000.sh');
  });

  test('characters no filesystem agrees on', () => {
    for (const raw of ['a:b.png', 'a*b.png', 'a?b.png', 'a"b.png', 'a<b.png', 'a|b.png']) {
      refuses(raw);
    }
    refuses('a\u0001b.png');
  });

  test('a trailing dot or space', () => {
    // Windows drops these silently, so the file would come back renamed.
    refuses('photo.png ');
    refuses('photo.png.');
  });

  test('Windows device names, with or without an extension', () => {
    for (const raw of ['CON', 'con.png', 'NUL', 'lpt1.jpg', 'AUX']) refuses(raw);
    // Not reserved, and must still work.
    assert.equal(assertValidName('console.png'), 'console.png');
  });

  test('an empty or over-long name', () => {
    refuses('');
    refuses('   /   ');
    refuses(`${'a'.repeat(300)}.png`);
  });

  test('the refusal carries a code, not just a sentence', () => {
    try {
      assertValidName('../a.png');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'INVALID_NAME');
      assert.equal(err.status, 400);
    }
  });
});

describe('names: where a file may land', () => {
  const root = path.resolve('/srv/uploads');

  test('a checked name resolves inside the root', () => {
    assert.equal(resolveInside(root, 'a.png'), path.join(root, 'a.png'));
  });

  test('a path that climbs out is refused even if it reaches the root again', () => {
    assert.throws(() => resolveInside(root, '../uploads-evil/a.png'), UploadError);
    assert.throws(() => resolveInside(root, '../../etc/passwd'), UploadError);
  });

  test('a sibling directory sharing the root as a prefix is not inside it', () => {
    // `/srv/uploads-evil` starts with `/srv/uploads`, which is why the check
    // compares against the root plus a separator rather than the bare string.
    assert.throws(() => resolveInside(root, '../uploads-evil'), UploadError);
  });
});

describe('names: collision suffixes', () => {
  test('the number goes before the extension, not after', () => {
    assert.equal(withSuffix('photo.jpg', 2), 'photo (2).jpg');
    assert.equal(withSuffix('archive.tar.gz', 3), 'archive.tar (3).gz');
    assert.equal(withSuffix('noext', 2), 'noext (2)');
  });

  test('a suffixed name is still a valid name', () => {
    assert.equal(assertValidName(withSuffix('photo.jpg', 2)), 'photo (2).jpg');
  });
});
