const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { request } = require('../engine/network.cjs');

function response(options) {
  return new Promise((resolve, reject) => {
    const req = request(options);
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
}
test('engine downloads follow redirects and preserve byte-for-byte streaming', async t => {
  const binary = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 256));
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: './binary' }).end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }).end(); return; }
    if (req.url === '/binary') {
      assert.equal(req.headers['user-agent'], 'SOCL-test');
      res.writeHead(200, { 'content-length': binary.length });
      res.end(binary); return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const scratch = path.resolve(__dirname, '../.dev-tools/tests');
  fs.mkdirSync(scratch, { recursive: true });
  const file = path.join(fs.mkdtempSync(path.join(scratch, 'download-')), 'engine.zip');
  const req = request({ url: base + '/redirect', method: 'GET' });
  req.setHeader('User-Agent', 'SOCL-test');
  await new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', incoming => {
      assert.equal(incoming.statusCode, 200);
      assert.equal(Number(incoming.headers['content-length']), binary.length);
      pipeline(incoming, fs.createWriteStream(file)).then(resolve, reject);
    });
    req.end();
  });
  assert.deepEqual(fs.readFileSync(file), binary);
  await new Promise((resolve, reject) => {
    const manual = request({ url: base + '/redirect', redirect: 'manual' });
    manual.on('response', () => reject(new Error('Manual redirects must not emit response')));
    manual.on('error', reject);
    manual.on('redirect', (status, method, url) => {
      assert.equal(status, 302); assert.equal(method, 'GET'); assert.equal(url, base + '/binary');
      manual.abort(); resolve();
    });
    manual.end();
  });
  await assert.rejects(response(base + '/loop'), /Too many download redirects/);
  const missing = await response(base + '/missing');
  assert.equal(missing.statusCode, 404); missing.resume();
  await assert.rejects(response('file:///private/file'), /Only HTTP/);
});
