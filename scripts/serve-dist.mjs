// serve-dist.mjs — a deliberately dumb static server for the production build,
// used by the CI smoke gate (and local prod smokes).  Serves dist/ under the
// same /orbital/ base GitHub Pages uses.  Exists because `vite preview` was
// observed 404-ing real assets when the request carried browser Accept-Encoding
// headers (falling back to the SPA index), which broke headless runs; this does
// nothing clever: read file, set MIME, send bytes.
//
//   node scripts/serve-dist.mjs [port]     (default 4173)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(fileURLToPath(import.meta.url), '..', '..', 'dist');
const BASE = '/orbital/';
const PORT = Number(process.argv[2] || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm', '.tle': 'text/plain', '.csv': 'text/csv', '.txt': 'text/plain',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(BASE)) { res.writeHead(302, { location: BASE }); res.end(); return; }
    path = path.slice(BASE.length);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }   // no traversal
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => console.log(`dist served at http://localhost:${PORT}${BASE}`));
