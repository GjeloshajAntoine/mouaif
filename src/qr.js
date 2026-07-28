'use strict';

// Small dependency-free QR encoder for setup URLs. Byte mode, EC level L,
// versions 1–10 (enough for normal mouaif origins and setup codes).

const BLOCKS_L = [
  null,
  [[1, 26, 19]], [[1, 44, 34]], [[1, 70, 55]], [[1, 100, 80]],
  [[1, 134, 108]], [[2, 86, 68]], [[2, 98, 78]], [[2, 121, 97]],
  [[2, 146, 116]], [[2, 86, 68], [2, 87, 69]]
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EXP = new Array(512);
const LOG = new Array(256);
let value = 1;
for (let i = 0; i < 255; i++) { EXP[i] = value; LOG[value] = i; value <<= 1; if (value & 0x100) value ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

function append(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function multiplyPoly(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    if (a[i] && b[j]) out[i + j] ^= EXP[LOG[a[i]] + LOG[b[j]]];
  }
  return out;
}

function errorCodewords(data, count) {
  let generator = [1];
  for (let i = 0; i < count; i++) generator = multiplyPoly(generator, [1, EXP[i]]);
  const work = data.concat(new Array(count).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = work[i];
    if (!factor) continue;
    const log = LOG[factor];
    for (let j = 0; j < generator.length; j++) if (generator[j]) work[i + j] ^= EXP[LOG[generator[j]] + log];
  }
  return work.slice(data.length);
}

function blocksFor(version) {
  const out = [];
  for (const [count, total, data] of BLOCKS_L[version]) for (let i = 0; i < count; i++) out.push({ total, data });
  return out;
}

function codewords(text, version) {
  const bytes = Buffer.from(String(text), 'utf8');
  const blocks = blocksFor(version);
  const dataCount = blocks.reduce((sum, block) => sum + block.data, 0);
  const bits = [];
  append(bits, 4, 4); // byte mode
  append(bits, bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(bits, byte, 8);
  if (bits.length + 4 <= dataCount * 8) append(bits, 0, 4);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  for (let pad = 0; data.length < dataCount; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const chunks = [];
  const errors = [];
  let offset = 0;
  for (const block of blocks) {
    const chunk = data.slice(offset, offset + block.data);
    offset += block.data;
    chunks.push(chunk);
    errors.push(errorCodewords(chunk, block.total - block.data));
  }
  const out = [];
  const maxData = Math.max(...chunks.map((chunk) => chunk.length));
  const maxError = Math.max(...errors.map((chunk) => chunk.length));
  for (let i = 0; i < maxData; i++) for (const chunk of chunks) if (i < chunk.length) out.push(chunk[i]);
  for (let i = 0; i < maxError; i++) for (const chunk of errors) if (i < chunk.length) out.push(chunk[i]);
  return out;
}

function bch(value, polynomial) {
  let shifted = value;
  const degree = (number) => 31 - Math.clz32(number);
  while (degree(shifted) >= degree(polynomial)) shifted ^= polynomial << (degree(shifted) - degree(polynomial));
  return shifted;
}

function finder(matrix, row, col) {
  const size = matrix.length;
  for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
    if (row + r < 0 || row + r >= size || col + c < 0 || col + c >= size) continue;
    matrix[row + r][col + c] = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
  }
}

function makeMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = 1;
  while (version <= 10) {
    const dataCount = blocksFor(version).reduce((sum, block) => sum + block.data, 0);
    const lengthBits = version < 10 ? 8 : 16;
    if (4 + lengthBits + bytes.length * 8 <= dataCount * 8) break;
    version++;
  }
  if (version > 10) throw new Error('QR content is too long');
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  finder(matrix, 0, 0); finder(matrix, size - 7, 0); finder(matrix, 0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0;
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0;
  }
  for (const row of ALIGN[version]) for (const col of ALIGN[version]) {
    if (matrix[row][col] !== null) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) matrix[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
  }
  if (version >= 7) {
    const bits = (version << 12) | bch(version << 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1;
      matrix[Math.floor(i / 3)][i % 3 + size - 11] = bit;
      matrix[i % 3 + size - 11][Math.floor(i / 3)] = bit;
    }
  }
  // Error correction L has format bits 01. Use mask pattern 0.
  const format = ((1 << 3) | 0) << 10;
  const formatBits = (format | bch(format, 0x537)) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const bit = ((formatBits >> i) & 1) === 1;
    if (i < 6) matrix[i][8] = bit;
    else if (i < 8) matrix[i + 1][8] = bit;
    else matrix[size - 15 + i][8] = bit;
    if (i < 8) matrix[8][size - i - 1] = bit;
    else if (i === 8) matrix[8][7] = bit;
    else matrix[8][15 - i - 1] = bit;
  }
  matrix[size - 8][8] = true;
  const data = codewords(text, version);
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let side = 0; side < 2; side++) {
        const col = right - side;
        if (matrix[row][col] !== null) continue;
        const byte = data[Math.floor(bitIndex / 8)] || 0;
        let bit = ((byte >>> (7 - (bitIndex % 8))) & 1) === 1;
        if ((row + col) % 2 === 0) bit = !bit; // mask 0
        matrix[row][col] = bit;
        bitIndex++;
      }
    }
    upward = !upward;
  }
  return matrix;
}

function svg(text, options = {}) {
  const matrix = makeMatrix(text);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  let path = '';
  for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) if (matrix[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const px = Number(options.size) || 256;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" role="img" aria-label="Setup QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000" shape-rendering="crispEdges"/></svg>`;
}

function terminal(text) {
  const matrix = makeMatrix(text);
  const quiet = 2;
  const rows = [];
  const width = matrix.length + quiet * 2;
  const white = new Array(width).fill(false);
  const padded = [white, white, ...matrix.map((row) => [...new Array(quiet).fill(false), ...row, ...new Array(quiet).fill(false)]), white, white];
  // Force a white cell background and black modules rather than relying on
  // the terminal theme (a light foreground on a dark terminal inverts QR).
  for (let y = 0; y < padded.length; y += 2) {
    let line = '\x1b[30;47m';
    const top = padded[y];
    const bottom = padded[y + 1] || white;
    for (let x = 0; x < width; x++) line += top[x] ? (bottom[x] ? '\x1b[40m \x1b[47m' : '▀') : (bottom[x] ? '▄' : ' ');
    rows.push(line + '\x1b[0m');
  }
  return rows.join('\n');
}

module.exports = { makeMatrix, svg, terminal };
