/**
 * A tiny static server for the mock console (no dependencies).
 *
 *   node test/mock-console/serve.mjs [port]     serve it by hand
 *   import { serveMock } from './serve.mjs'      -> { url, close() }
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

export function serveMock(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const f = path.join(DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile() || f.endsWith('.mjs')) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: pt } = server.address();
      resolve({ url: `http://127.0.0.1:${pt}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await serveMock(Number(process.argv[2]) || 8090);
  console.log(`mock console at ${url}`);
}
