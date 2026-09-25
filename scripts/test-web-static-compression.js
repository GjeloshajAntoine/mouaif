'use strict';

// Static assets are served brotli/gzip-compressed when the browser asks for
// it, byte-identical after decompression, with Vary set, and compressed once
// (the second request is answered from the in-memory cache).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-compress-home-'));
const { pickEncoding, serveWebFile } = require('../src/server-web-static.js');

// ---- pickEncoding --------------------------------------------------------
const req = (ae) => ({ headers: { 'accept-encoding': ae } });
assert.equal(pickEncoding(req('gzip, deflate, br'), '.js'), 'br');
assert.equal(pickEncoding(req('gzip'), '.css'), 'gzip');
assert.equal(pickEncoding(req('br;q=0, gzip'), '.js'), 'gzip', 'q=0 opts out');
assert.equal(pickEncoding(req('br;q=0.0'), '.js'), null);
assert.equal(pickEncoding(req('identity'), '.js'), null);
assert.equal(pickEncoding(req(''), '.js'), null);
assert.equal(pickEncoding(req('br'), '.png'), null, 'images are not recompressed');
assert.equal(pickEncoding(null, '.js'), null);

// ---- end to end over a real socket --------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-compress-'));
const file = path.join(dir, 'app.js');
const source = Buffer.from('export const x = 1;\n'.repeat(2000));
fs.writeFileSync(file, source);

let reads = 0;
const realReadFile = fs.readFile;
fs.readFile = function (...args) { if (args[0] === file) reads++; return realReadFile.apply(this, args); };

const server = http.createServer((rq, rs) => serveWebFile(rs, file, { allowOutside: true, req: rq }));

function get(ae) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ port, path: '/', headers: ae ? { 'accept-encoding': ae } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

server.listen(0, '127.0.0.1', async () => {
  try {
    const br = await get('gzip, br');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal(Number(br.headers['content-length']), br.body.length);
    assert.ok(br.body.length < source.length / 10, 'brotli shrinks repetitive JS');
    assert.ok(zlib.brotliDecompressSync(br.body).equals(source), 'brotli round-trips');

    const gz = await get('gzip');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(zlib.gunzipSync(gz.body).equals(source), 'gzip round-trips');

    const plain = await get('');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.ok(plain.body.equals(source));

    const readsBefore = reads;
    await get('br');
    await get('gzip');
    assert.equal(reads, readsBefore, 'warm compressed responses come from the cache');

    // A rebuilt file (new mtime/size) is recompressed, never served stale.
    const next = Buffer.from('export const y = 2;\n'.repeat(1500));
    fs.writeFileSync(file, next);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const fresh = await get('br');
    assert.ok(zlib.brotliDecompressSync(fresh.body).equals(next), 'changed file is recompressed');

    console.log('web static compression: assertions passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
