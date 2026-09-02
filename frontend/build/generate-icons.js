// Generate the mouaif PWA icon set into frontend/public/icons/. Run on
// `prebuild` (via package.json) and on `npm run icons` so the icons are
// always in sync with this source file.
//
// The icons are plain PNGs (no canvas dependency at build time, no
// dev-time image editor required). Each icon is an RGBA raster of a
// rounded-square tile painted with the brand gradient and a centred
// lowercase "mouaif" wordmark (single bold "m" on the 32px favicon),
// mirroring the in-app `.app__logo` design token. The mark is drawn as
// anti-aliased round-capped stroke outlines — no image library.
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
// the bottom-right. The mark is the full "mouaif" wordmark drawn from
// a hand-rolled 5px-tall pixel font, in the same ink as the in-app
// logo (layout.css .app__logo).
//
// `markScale` is the fraction of the tile side the wordmark should
// span (0..1). Do not pass more than ~0.8 for "maskable" icons: the
// manifest safe zone keeps graphic content inside a circle ~80% of the
// tile side, so a wordmark at 0.85 would be clipped. The default
// 0.85 is for always-flat "any" icons.
function renderTile(size, opts) {
const markScale = (opts && opts.markScale) ?? 0.86;
const stride = size * 4;
const rgba = Buffer.alloc(size * stride);

// Smooth lowercase wordmark ("mouaif"), drawn as round-capped stroked
// outlines instead of the old 5px pixel font. Letterforms live in local
// units: x=0 is the letter's left edge, y=0 is the top of the x-height
// and y=1.0 is the baseline; negative y is the ascender zone (f). Each
// letter has an advance width and a list of polyline subpaths. The
// o/a bowls are sampled ellipses so they stay smooth at any scale.
function ellipsePoints(cx, cy, rx, ry) {
const pts = [];
const N = 22;
for (let i = 0; i < N; i++) {
const t = (i / N) * Math.PI * 2;
pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
}
return pts;
}
const GLYPHS = {
m: { adv: 1.34, sub: [
[[0.16,1.00],[0.16,0.18]],
[[0.16,0.18],[0.22,0.00],[0.44,0.00],[0.56,0.10]],
[[0.56,0.10],[0.56,0.50]],
[[0.56,0.50],[0.62,0.00],[1.04,0.00],[1.16,0.10]],
[[1.16,0.10],[1.16,1.00]]
]},
o: { adv: 0.86, sub: [ellipsePoints(0.43, 0.50, 0.36, 0.47)] },
u: { adv: 0.86, sub: [
[[0.14,0.24],[0.14,0.62],[0.34,1.00],[0.68,1.00],[0.86,0.62],[0.86,0.24]],
[[0.86,0.24],[0.86,1.00]]
]},
a: { adv: 0.90, sub: [
ellipsePoints(0.45, 0.50, 0.40, 0.48),
[[0.82,0.00],[0.82,1.00]]
]},
i: { adv: 0.36, sub: [
[[0.18,0.28],[0.18,1.00]],
[[0.18,0.04],[0.18,0.05]]
]},
f: { adv: 0.74, sub: [
[[0.58,-0.38],[0.38,-0.40],[0.24,-0.22],[0.24,0.00],[0.24,1.00]],
[[0.70,0.24],[0.18,0.24]]
]}
};
const WORD = 'mouaif';
const GAP = 0.13;
let wordW = 0;
// The full six-letter wordmark only stays legible when each letter is a
// few pixels wide. Below ~48px the tiles fall back to a single bold
// "m" (the in-app logo mark), so the launcher icon always reads clearly.
const USE_WORDMARK = size >= 48;
const string_ = USE_WORDMARK ? WORD : 'm';
const glyphs = USE_WORDMARK ? GLYPHS : { m: GLYPHS.m };
for (const ch of string_) wordW += glyphs[ch].adv;
wordW += GAP * (string_.length - 1);

// Map the wordmark onto the tile. x-height (1.0 unit) is centred
// vertically; the f ascender extends above it. The stroke width is
// expressed in glyph units (0.20 of the x-height) so it scales with the
// tile.
const targetW = size * markScale;
const scale = targetW / wordW;
const baselineY = size / 2 + (1.0 * scale) / 2; // centre the x-height band
const startX = (size - targetW) / 2;
const STROKE = 0.20;             // glyph units (half-width 0.10)
const EDGE = 1 / scale;          // ~1px soft edge, in glyph units

// Stroke coverage: distance from a sample point to a round-capped
// segment, thresholded with a soft edge for anti-aliasing.
function distToSegment(px, py, ax, ay, bx, by) {
const dx = bx - ax, dy = by - ay;
const len2 = dx * dx + dy * dy;
let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
t = Math.max(0, Math.min(1, t));
const ex = ax + t * dx, ey = ay + t * dy;
const ox = px - ex, oy = py - ey;
return Math.sqrt(ox * ox + oy * oy);
}
function inkCoverage(x, y) {
// x,y are in final pixel space; convert to glyph-local units.
const gx = (x - startX) / scale;
const gy = (y - baselineY) / scale;
// find the letter that owns this x
let cx = 0;
for (const ch of string_) {
const g = glyphs[ch];
const pad = STROKE + EDGE;
if (gx >= cx - pad && gx <= cx + g.adv + pad) {
for (const sub of g.sub) {
for (let i = 0; i < sub.length - 1; i++) {
const ax = sub[i][0] + cx, ay = sub[i][1];
const bx = sub[i + 1][0] + cx, by = sub[i + 1][1];
const d = distToSegment(gx, gy, ax, ay, bx, by);
if (d <= STROKE / 2 + EDGE) {
return Math.max(0, Math.min(1, (STROKE / 2 - d) / EDGE));
}
}
}
}
cx += g.adv + GAP;
}
return 0;
}
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

        // Glyph overlay (anti-aliased stroke coverage).
        const cov = inkCoverage(x, y);
        if (cov > 0) {
          r = Math.round(INK[0] + (r - INK[0]) * (1 - cov));
          g = Math.round(INK[1] + (g - INK[1]) * (1 - cov));
          b = Math.round(INK[2] + (b - INK[2]) * (1 - cov));
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
  const rgba = renderTile(size, opts);
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
  // Maskable variant: the same raster but with the wordmark kept
  // inside the maskable safe zone. The manifest safe zone is a circle
  // whose diameter is 80% of the tile side, so an "any"-style
  // wordmark spanning ~85% of the tile would be clipped by Android's
  // adaptive-icon mask. We inset the mark to span ~66% so all the ink
  // stays comfortably inside the ~80% circle. The manifest expects a
  // separate file, so we emit one.
  writeIcon('icon-maskable-512', 512, { markScale: 0.66 });
  writeIcon('icon-180-apple', 180);
  // Favicon-style 32 also useful for browsers that ignore /favicon.ico.
  writeIcon('favicon-32', 32);
}

module.exports = { renderTile, encodePng };
