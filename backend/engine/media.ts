import http = require('node:http');
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { fileURLToPath } from 'node:url';

export function createMediaServer() {
  const token = crypto.randomBytes(32).toString('hex');
  const files = new Set<string>(), roots = new Set<string>();
  function grant(input: unknown, root = false): void {
    if (typeof input !== 'string') return;
    try {
      const filePath = input.startsWith('file:') ? fileURLToPath(input) : input;
      if (!path.isAbsolute(filePath)) return;
      const real = fs.realpathSync(filePath);
      if (root && fs.statSync(real).isDirectory()) roots.add(real); else if (fs.statSync(real).isFile()) files.add(real);
    } catch {}
  }
  function grantValue(value: unknown, depth = 0): void {
    if (depth > 12 || value == null) return;
    if (typeof value === 'string') grant(value, true);
    else if (typeof value === 'object') for (const item of Object.values(value)) grantValue(item, depth + 1);
  }
  const types = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405).end(); return; }
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/' + token) { res.writeHead(403).end(); return; }
      const real = fs.realpathSync(url.searchParams.get('path') || '');
      const permitted = files.has(real) || [...roots].some(root => real.startsWith(root + path.sep));
      if (!permitted) { res.writeHead(403).end(); return; }
      const stat = fs.statSync(real);
      if (!stat.isFile()) { res.writeHead(404).end(); return; }
      const size = stat.size;
      let start = 0, end = size - 1, partial = false;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        partial = true;
      }
      const headers: http.OutgoingHttpHeaders = { 'Accept-Ranges': 'bytes', 'Content-Type': types[path.extname(real).toLowerCase() as keyof typeof types] || 'application/octet-stream', 'Content-Length': Math.max(0, end - start + 1) };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(partial ? 206 : 200, headers);
      if (req.method === 'HEAD' || !size) { res.end(); return; }
      const stream = fs.createReadStream(real, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  return {
    grant, grantValue, close: () => server.close(),
    listen: () => new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Media server address unavailable')); return; }
        resolve(`http://127.0.0.1:${address.port}/${token}`);
      });
    }),
  };
}
module.exports = { createMediaServer };
