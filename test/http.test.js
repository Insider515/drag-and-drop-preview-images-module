import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

import { createRouter, parseQuery, parseSize } from '../server/http.js';

describe('parseSize', () => {
  test('reads the units a config file would use', () => {
    assert.equal(parseSize('512b'), 512);
    assert.equal(parseSize('16kb'), 16 * 1024);
    assert.equal(parseSize('10mb'), 10 * 1024 * 1024);
    assert.equal(parseSize('1gb'), 1024 ** 3);
    assert.equal(parseSize('1.5mb'), Math.round(1.5 * 1024 ** 2));
    assert.equal(parseSize(' 2 MB '), 2 * 1024 ** 2);
  });

  test('a plain number is already a size', () => {
    assert.equal(parseSize(4096), 4096);
    assert.equal(parseSize(0), 0);
  });

  test('nonsense falls back instead of becoming NaN', () => {
    // A NaN limit compares false against every size, which would turn a
    // typo in a config file into no limit at all.
    for (const bad of ['', 'lots', '10tb', '-5mb', 'mb', null, undefined, {}, NaN, Infinity]) {
      assert.equal(parseSize(bad, 1234), 1234, `parseSize(${JSON.stringify(bad)})`);
    }
  });
});

describe('parseQuery', () => {
  test('a repeated key arrives as a list, a single key as a string', () => {
    const q = parseQuery(new URLSearchParams('path=/a&tags=x&tags=y'));
    assert.equal(q.path, '/a');
    assert.deepEqual(q.tags, ['x', 'y']);
  });

  test('a query cannot reach Object.prototype', () => {
    // `?__proto__[admin]=1` against a plain object literal is how prototype
    // pollution starts; a null-prototype bag has nothing to pollute.
    const q = parseQuery(new URLSearchParams('__proto__=polluted&constructor=x'));
    assert.equal(Object.getPrototypeOf(q), null);
    assert.equal(q.__proto__, 'polluted');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  test('an empty query is an empty bag', () => {
    assert.deepEqual({ ...parseQuery(new URLSearchParams('')) }, {});
  });
});

/** Run one request through a router over a real socket. */
async function call(handler, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 418;
      res.end('fell through');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body,
      ...(body ? { duplex: 'half' } : {}),
    });
    return { status: response.status, text: await response.text(), response };
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

describe('router: matching', () => {
  test('a registered path is answered', async () => {
    const handler = createRouter();
    handler.get('/config', (req, res) => res.status(200).json({ ok: true, path: req.path }));
    const { status, text } = await call(handler, { path: '/config' });
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, path: '/config' });
  });

  test('the method is part of the match', async () => {
    const handler = createRouter();
    handler.post('/upload', (req, res) => res.status(200).json({ ok: true }));
    const { status } = await call(handler, { method: 'GET', path: '/upload' });
    assert.equal(status, 418, 'a GET was served by a POST route');
  });

  test('HEAD is served by the GET route', async () => {
    const handler = createRouter();
    handler.get('/config', (req, res) => res.status(200).json({ ok: true }));
    const { status } = await call(handler, { method: 'HEAD', path: '/config' });
    assert.equal(status, 200);
  });

  test('an unknown path is handed back to the host', async () => {
    // Mounted inside somebody else's app, a path this router does not own is
    // theirs to answer — swallowing it as a 404 would hide their routes.
    const handler = createRouter();
    handler.get('/config', (req, res) => res.status(200).json({}));
    const { status, text } = await call(handler, { path: '/something-else' });
    assert.equal(status, 418);
    assert.equal(text, 'fell through');
  });

  test('with nobody to fall through to, an unknown path is a 404 with a code', async () => {
    const handler = createRouter();
    handler.get('/config', (req, res) => res.status(200).json({}));

    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    const payload = await response.json();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');

    assert.equal(response.status, 404);
    assert.equal(payload.code, 'NOT_FOUND');
  });

  test('paths() lists what the router owns, for a host that mounts them', async () => {
    const handler = createRouter();
    handler.get('/config', () => {});
    handler.post('/', () => {});
    assert.deepEqual(handler.paths(), [
      { method: 'GET', path: '/config' },
      { method: 'POST', path: '/' },
    ]);
  });
});

describe('router: mounting under a prefix', () => {
  test('basePath is stripped before matching', async () => {
    const handler = createRouter({ basePath: '/api/upload' });
    handler.get('/config', (req, res) => res.status(200).json({ path: req.path }));
    const { status, text } = await call(handler, { path: '/api/upload/config' });
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).path, '/config');
  });

  test('the prefix itself is the root route', async () => {
    const handler = createRouter({ basePath: '/api/upload' });
    handler.get('/', (req, res) => res.status(200).json({ path: req.path }));
    const { text } = await call(handler, { path: '/api/upload' });
    assert.equal(JSON.parse(text).path, '/');
  });

  test('a prefix that the host already stripped is not required twice', async () => {
    // Express rewrites req.url when mounted, so by the time the request
    // arrives the prefix is gone. Insisting on it would break exactly the
    // mounting it exists to support, so the prefix is stripped when present
    // and the path matched as it stands otherwise.
    const handler = createRouter({ basePath: '/api/upload' });
    handler.get('/config', (req, res) => res.status(200).json({ path: req.path }));
    const { status, text } = await call(handler, { path: '/config' });
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).path, '/config');
  });

  test('a query string is not part of the path', async () => {
    const handler = createRouter();
    handler.get('/config', (req, res) => res.status(200).json({ path: req.path, q: { ...req.query } }));
    const { text } = await call(handler, { path: '/config?locale=uk&x=1' });
    assert.deepEqual(JSON.parse(text), { path: '/config', q: { locale: 'uk', x: '1' } });
  });

  test('a path is normalised before it is matched, and never carries ..', async () => {
    const handler = createRouter({ basePath: '/api' });
    handler.get('/config', (req, res) => res.status(200).json({ path: req.path }));
    handler.get('/secret', (req, res) => res.status(200).json({ path: 'secret' }));

    // Matching is a lookup on a fixed name, so a traversal cannot invent a
    // route; what it must also not do is hand a route a path with .. in it.
    for (const attempt of ['/api/x/../config', '/api/./config', '/api//config']) {
      const { text, status } = await call(handler, { path: attempt });
      if (status === 200) assert.ok(!JSON.parse(text).path?.includes('..'), attempt);
    }
    const { status } = await call(handler, { path: '/api/config/../../etc/passwd' });
    assert.equal(status, 418, 'a traversal reached a route that was never registered');
  });
});

describe('router: the chain', () => {
  test('middleware runs before the route, in order', async () => {
    const order = [];
    const handler = createRouter();
    handler.use((req, res, next) => { order.push('a'); next(); });
    handler.use((req, res, next) => { order.push('b'); next(); });
    handler.get('/x', (req, res) => { order.push('route'); res.status(200).json({}); });
    await call(handler, { path: '/x' });
    assert.deepEqual(order, ['a', 'b', 'route']);
  });

  test('middleware that answers stops the chain', async () => {
    let reached = false;
    const handler = createRouter();
    handler.use((req, res) => { res.status(401).json({ code: 'DENIED' }); });
    handler.get('/x', (req, res) => { reached = true; res.status(200).json({}); });

    const { status, text } = await call(handler, { path: '/x' });
    assert.equal(status, 401);
    assert.equal(JSON.parse(text).code, 'DENIED');
    assert.equal(reached, false, 'the route ran after being denied');
  });

  test('a thrown error goes to the error handler, not to the socket', async () => {
    const handler = createRouter();
    handler.get('/x', () => { throw new Error('boom'); });
    handler.use((err, req, res, next) => res.status(400).json({ code: 'CAUGHT', message: err.message }));

    const { status, text } = await call(handler, { path: '/x' });
    assert.equal(status, 400);
    assert.deepEqual(JSON.parse(text), { code: 'CAUGHT', message: 'boom' });
  });

  test('an error nobody handles is a 500, not a hanging request', async () => {
    const handler = createRouter();
    handler.get('/x', async () => { throw new Error('boom'); });
    const { status, text } = await call(handler, { path: '/x' });
    assert.equal(status, 500);
    assert.equal(JSON.parse(text).code, 'INTERNAL');
    assert.ok(!text.includes('boom'), 'the internal message leaked to the client');
  });

  test('an error thrown by the error handler still ends the request', async () => {
    const handler = createRouter();
    handler.get('/x', () => { throw new Error('first'); });
    handler.use((err, req, res, next) => { throw new Error('second'); });
    const { status } = await call(handler, { path: '/x' });
    assert.equal(status, 500);
  });

  test('a rejected promise from middleware is caught like a throw', async () => {
    const handler = createRouter();
    handler.use(async () => { throw new Error('async boom'); });
    handler.get('/x', (req, res) => res.status(200).json({}));
    handler.use((err, req, res, next) => res.status(403).json({ code: 'STOPPED' }));
    const { status, text } = await call(handler, { path: '/x' });
    assert.equal(status, 403);
    assert.equal(JSON.parse(text).code, 'STOPPED');
  });

  test('use() ignores anything that is not a function', () => {
    const handler = createRouter();
    assert.doesNotThrow(() => { handler.use(null); handler.use('nope'); handler.use(undefined); });
  });
});

describe('router: JSON bodies', () => {
  const echo = (limit) => {
    const handler = createRouter({ jsonLimit: () => limit });
    handler.post('/x', (req, res) => res.status(200).json({ body: req.body }));
    handler.use((err, req, res, next) => res.status(err.status ?? 500).json({ code: err.code }));
    return handler;
  };

  test('a JSON body is parsed for the route', async () => {
    const { status, text } = await call(echo(1024), {
      method: 'POST', path: '/x',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'there' }),
    });
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(text).body, { hello: 'there' });
  });

  test('a body that is not JSON is left alone', async () => {
    const { text } = await call(echo(1024), {
      method: 'POST', path: '/x',
      headers: { 'content-type': 'text/plain' },
      body: 'not json at all',
    });
    assert.deepEqual(JSON.parse(text).body, {});
  });

  test('broken JSON is a 400 with a code, not a crash', async () => {
    const { status, text } = await call(echo(1024), {
      method: 'POST', path: '/x',
      headers: { 'content-type': 'application/json' },
      body: '{"a": ',
    });
    assert.equal(status, 400);
    assert.equal(JSON.parse(text).code, 'INVALID_JSON');
  });

  test('a body over the limit is refused', async () => {
    const { status, text } = await call(echo(64), {
      method: 'POST', path: '/x',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 'x'.repeat(500) }),
    });
    assert.equal(status, 413);
    assert.equal(JSON.parse(text).code, 'TOTAL_TOO_LARGE');
  });

  test('a lying Content-Length does not get the body past the limit', async () => {
    // The header is the client's claim. What is counted is what arrives.
    const big = JSON.stringify({ a: 'x'.repeat(2000) });
    const { status, text } = await call(echo(256), {
      method: 'POST', path: '/x',
      headers: { 'content-type': 'application/json' },
      // Chunked: no Content-Length is sent at all.
      body: Readable.toWeb(Readable.from([Buffer.from(big)])),
    });
    assert.equal(status, 413);
    assert.equal(JSON.parse(text).code, 'TOTAL_TOO_LARGE');
  });

  test('an empty body is an empty object, not a parse error', async () => {
    const { status, text } = await call(echo(1024), {
      method: 'POST', path: '/x',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(text).body, {});
  });

  test('a body already parsed by the host is not read twice', async () => {
    const handler = createRouter({ jsonLimit: () => 1024 });
    handler.post('/x', (req, res) => res.status(200).json({ body: req.body }));

    const server = http.createServer((req, res) => {
      // What Express with express.json() mounted ahead of us looks like.
      req.body = { from: 'host' };
      handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'wire' }),
    });
    const payload = await response.json();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');

    assert.deepEqual(payload.body, { from: 'host' });
  });
});

describe('router: host objects', () => {
  test("a host's own res.status and res.json are used, not replaced", async () => {
    const seen = [];
    const handler = createRouter();
    handler.get('/x', (req, res) => res.status(201).json({ ok: true }));

    const server = http.createServer((req, res) => {
      // Express-shaped response: its own helpers, which must survive.
      res.status = (code) => { seen.push(['status', code]); res.statusCode = code; return res; };
      res.json = (payload) => { seen.push(['json', payload]); res.end(JSON.stringify(payload)); return res; };
      handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/x`);
    await response.text();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');

    assert.equal(response.status, 201);
    assert.deepEqual(seen, [['status', 201], ['json', { ok: true }]]);
  });

  test('req.query can be set even where the host defines it as a getter', async () => {
    // Express 5 defines req.query as a getter; assigning to it throws, so the
    // decoration has to go through defineProperty.
    const handler = createRouter();
    handler.get('/x', (req, res) => res.status(200).json({ q: { ...req.query } }));

    const server = http.createServer((req, res) => {
      Object.defineProperty(req, 'query', { get: () => ({ frozen: true }), configurable: true });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/x?a=1`);
    const payload = await response.json();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');

    assert.deepEqual(payload.q, { a: '1' });
  });

  test('req.get reads headers case-insensitively', async () => {
    const handler = createRouter();
    handler.get('/x', (req, res) => res.status(200).json({ origin: req.get('Origin') ?? null }));
    const { text } = await call(handler, { path: '/x', headers: { Origin: 'https://example.test' } });
    assert.equal(JSON.parse(text).origin, 'https://example.test');
  });
});
