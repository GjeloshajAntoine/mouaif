// Quick smoke test: confirm the generated PNGs are well-formed
// (PNG signature, single IDAT, IHDR dimensions match filename).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunk(buf, off) {
  const len = buf.readUInt32BE(off);
  const type = buf.slice(off + 4, off + 8).toString('ascii');
  const data = buf.slice(off + 8, off + 8 + len);
  return { type, len, data, next: off + 12 + len };
}

function check(file, expectedSize) {
  const buf = fs.readFileSync(file);
  if (!buf.slice(0, 8).equals(SIG)) throw new Error(file + ': bad PNG signature');
  const ihdr = readChunk(buf, 8);
  if (ihdr.type !== 'IHDR') throw new Error(file + ': first chunk not IHDR');
  const w = ihdr.data.readUInt32BE(0);
  const h = ihdr.data.readUInt32BE(4);
  if (w !== expectedSize || h !== expectedSize) {
    throw new Error(file + ': expected ' + expectedSize + 'x' + expectedSize + ' got ' + w + 'x' + h);
  }
  if (ihdr.data[8] !== 8 || ihdr.data[9] !== 6) throw new Error(file + ': expected 8-bit RGBA');
  console.log('OK', file, '(' + w + 'x' + h + ',', buf.length, 'bytes)');
}

const dir = path.resolve(__dirname, '..', 'public', 'icons');
check(path.join(dir, 'icon-192.png'), 192);
check(path.join(dir, 'icon-512.png'), 512);
check(path.join(dir, 'icon-maskable-512.png'), 512);
check(path.join(dir, 'icon-180-apple.png'), 180);
check(path.join(dir, 'favicon-32.png'), 32);
console.log('icons: all OK');
