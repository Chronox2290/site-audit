// Tiny static server for the demo sites.
//   node serve.cjs <dir> <port> [--compress]
// --compress answers text files with brotli or gzip, the way any real host does.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [dir, port] = process.argv.slice(2);
const COMPRESS = process.argv.includes('--compress');
const ROOT = path.resolve(dir);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml', '.woff2': 'font/woff2' };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  let body = fs.readFileSync(file);
  const headers = { 'content-type': type, 'cache-control': 'no-cache' };
  const accept = req.headers['accept-encoding'] || '';
  if (COMPRESS && /text|json|xml|svg|javascript/.test(type) && body.length > 1024) {
    if (/\bbr\b/.test(accept)) { body = zlib.brotliCompressSync(body); headers['content-encoding'] = 'br'; }
    else if (/gzip/.test(accept)) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
    headers.vary = 'accept-encoding';
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(+port, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${port}${COMPRESS ? ' (compressed)' : ''}`));
