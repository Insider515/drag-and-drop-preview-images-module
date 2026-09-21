/**
 * A development server for the demo. Not part of the npm package.
 *
 * It has no authentication of any kind and listens on 127.0.0.1 by default.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUploadHandler } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : true;
};

const port = Number(arg('port', 5173));
const host = String(arg('host', '127.0.0.1'));
const root = path.resolve(String(arg('root', path.join(here, '..', 'uploads'))));
const useVite = arg('vite', false) === true;

const upload = createUploadHandler({
  root,
  basePath: '/api/upload',
  allowSvg: arg('svg', false) === true,
  onWarning: (message, detail) => console.warn(message, detail ?? ''),
});

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}));

const demoDir = path.join(here, '..', 'demo-dist');

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  // The static half of a dev server still has to stay inside its directory.
  const absolute = path.resolve(demoDir, relative);
  if (absolute !== demoDir && !absolute.startsWith(demoDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await fs.readFile(absolute);
    res.writeHead(200, { 'content-type': TYPES.get(path.extname(absolute)) ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

let vite = null;
if (useVite) {
  const { createServer } = await import('vite');
  vite = await createServer({
    server: { middlewareMode: true },
    root: path.join(here, '..', 'demo'),
    appType: 'spa',
  });
}

const server = http.createServer(async (req, res) => {
  if ((req.url ?? '').startsWith('/api/upload')) {
    await upload(req, res);
    return;
  }
  if (vite) {
    vite.middlewares(req, res);
    return;
  }
  await serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`drag-and-drop-preview-images-module: http://${host}:${port}`);
  console.log(`  uploads   : ${root}`);
  console.log(`  mode      : ${vite ? 'vite (hot reload)' : 'static demo-dist/'}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn('  WARNING   : this server has no authentication and is reachable on the network');
  }
});
