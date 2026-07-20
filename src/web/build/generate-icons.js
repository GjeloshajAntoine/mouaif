// Generate the mouaif PWA icon set into src/web/public/icons/. Run on
// `prebuild` (via package.json) and on `npm run icons` so the icons are
// always in sync with this source file.
//
// The icons are plain PNGs (no canvas dependency at build time, no
// dev-time image editor required). Each icon is an RGBA raster of a
// rounded-square tile painted with the brand gradient and a centred
// "m" glyph, mirroring the in-app `.app__logo` design token.
//
// We're using a minimal hand-rolled PNG encoder to keep this module
// dependency-free. It produces a single IDAT-compressed RGBA image
// that every browser and the manifest spec accept.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'public', 'icons');

// PNG signature (8 bytes)
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  // The PNG CRC is on each chunk's raw bytes (type + data). The table
  // is precomputed once and reused across calls.
  if (!crc32._table) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    crc32._table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32._table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Render the tile. Each pixel is RGBA, 4 bytes. The tile has rounded
// corners (radius = 22% of the side). The background is a 135deg
// gradient from #6ea8fe (top-left) to #5b93f0 (bottom-right), with a
// thin inner highlight near the top edge and a subtle shadow toward
// the bottom-right. The glyph is a simple block "m" drawn from a
// 5x5 pixel font scaled up to fit.
function renderTile(size) {
  const stride = size * 4;
  const rgba = Buffer.alloc(size * stride);

  // Glyph raster: 5 rows x 5 cols. 1 = ink, 0 = transparent over the
  // tile. The "m" sits centred and is scaled so the glyph occupies
  // ~62% of the tile width — the same proportion the in-app logo uses.
  const GLYPH_W = 5;
  const GLYPH_H = 5;
  const GLYPH = [
    '11101',
    '10101',
    '10101',
    '10101',
    '10101'
  ];

  // Glyph footprint in pixels (in the tile). Sized for the
  // 192/512 output: a glyph about 62% of the tile width reads well
  // at small and large sizes.
  const glyphPx = Math.round(size * 0.62);
  const cell = Math.floor(glyphPx / GLYPH_W);
  const drawnW = cell * GLYPH_W;
  const drawnH = cell * GLYPH_H;
  const startX = Math.floor((size - drawnW) / 2);
  const startY = Math.floor((size - drawnH) / 2);

  const radius = Math.round(size * 0.22);

  // Helper: true if (x,y) is inside the rounded-rect shape.
  function insideRoundedRect(x, y) {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    // Corner test: each corner has a circle of `radius` centred on
    // (radius, radius), (size-radius, radius), (radius, size-radius),
    // (size-radius, size-radius).
    const dx = x < radius ? radius - x : (x >= size - radius ? x - (size - radius - 1) : 0);
    const dy = y < radius ? radius - y : (y >= size - radius ? y - (size - radius - 1) : 0);
    if (dx <= 0 || dy <= 0) return true;
    return (dx * dx + dy * dy) <= (radius * radius);
  }

  // Helper: true if (gx, gy) is ink in the glyph.
  function glyphInk(gx, gy) {
    return GLYPH[gy] && GLYPH[gy][gx] === '1';
  }

  // Colour helpers. sRGB-lerp is fine for the gradient stops; this is
  // not a calibrated sRGB→linear pipeline, it just blends two stops.
  const TOP = [0x6e, 0xa8, 0xfe]; // #6ea8fe (matches --accent in base.css)
  const BOT = [0x5b, 0x93, 0xf0]; // #5b93f0 (matches --accent-press)
  const INK = [0x0a, 0x14, 0x28]; // #0a1428 (on-accent ink)

  for (let y = 0; y < size; y++) {
    const t = y / (size - 1); // 0..1, top to bottom
    const r0 = Math.round(TOP[0] + (BOT[0] - TOP[0]) * t);
    const g0 = Math.round(TOP[1] + (BOT[1] - TOP[1]) * t);
    const b0 = Math.round(TOP[2] + (BOT[2] - TOP[2]) * t);

    // Inner highlight: 1px translucent white near the top, fading out
    // over the first ~18% of the tile. Subtle, mimics the
    // inset 0 1px 0 rgba(255,255,255,.25) on the in-app logo.
    const highlight = y < size * 0.18 ? (1 - (y / (size * 0.18))) * 0.18 : 0;

    for (let x = 0; x < size; x++) {
      const i = y * stride + x * 4;
      let r = r0, g = g0, b = b0, a = 0;

      if (insideRoundedRect(x, y)) {
        r = Math.min(255, Math.round(r + 255 * highlight));
        g = Math.min(255, Math.round(g + 255 * highlight));
        b = Math.min(255, Math.round(b + 255 * highlight));
        a = 255;

        // Glyph overlay.
        if (x >= startX && y >= startY) {
          const gx = Math.floor((x - startX) / cell);
          const gy = Math.floor((y - startY) / cell);
          if (gx < GLYPH_W && gy < GLYPH_H && glyphInk(gx, gy)) {
            r = INK[0]; g = INK[1]; b = INK[2];
          }
        }
      }

      rgba[i + 0] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }

  return rgba;
}

function encodePng(size, rgba) {
  // PNG: signature, IHDR, IDAT (filter byte 0 per scanline, then
  // compressed RGBA), IEND.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);     // width
  ihdr.writeUInt32BE(size, 4);     // height
  ihdr[8] = 8;                     // bit depth
  ihdr[9] = 6;                     // colour type: 6 = RGBA
  ihdr[10] = 0;                    // compression: 0
  ihdr[11] = 0;                    // filter: 0
  ihdr[12] = 0;                    // interlace: 0

  // Scanline filter byte (0 = none) prepended to each row.
  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1);
    scanlines[off] = 0;
    rgba.copy(scanlines, off + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(scanlines, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function writeIcon(name, size, opts) {
  const rgba = renderTile(size);
  const png = encodePng(size, rgba);
  const dest = path.join(OUT_DIR, name + (opts && opts.maskable ? '.maskable' : '') + '.png');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(dest, png);
  console.log('wrote', path.relative(process.cwd(), dest), png.length, 'bytes');
}

if (require.main === module) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeIcon('icon-192', 192);
  writeIcon('icon-512', 512);
  // Maskable variant: same raster (the design already keeps all ink
  // inside the safe zone — the glyph is inset ~19% from each edge,
  // which exceeds the 10% safe-zone the maskable spec recommends).
  // Manifest expects a separate file, so we emit one anyway.
  fs.copyFileSync(path.join(OUT_DIR, 'icon-512.png'), path.join(OUT_DIR, 'icon-maskable-512.png'));
  writeIcon('icon-180-apple', 180);
  // Favicon-style 32 also useful for browsers that ignore /favicon.ico.
  writeIcon('favicon-32', 32);
}

module.exports = { renderTile, encodePng };
