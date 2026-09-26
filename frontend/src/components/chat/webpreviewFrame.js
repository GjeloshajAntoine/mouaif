// mouaif web — webpreview Live (iframe) mode helpers
//
// Pure functions used by WebpreviewModal.jsx; kept free of Preact so
// scripts/test-webpreview-iframe.mjs can import them directly.
// See docs/features/webpreview.md (Live mode).

// Only http(s) pages can be framed by the app (CSP frame-src); file:, data:
// and about: stay screenshot-only.
export function canFrameUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
// Sandbox tokens for the live frame. A page on the app's own origin (e.g. the
// mouaif UI itself) never gets allow-same-origin: with allow-scripts that
// would let it reach the parent document and the /api surface. A
// cross-origin page keeps its own origin either way, so it may have it.
export function frameSandbox(url, appOrigin) {
  const tokens = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-modals'];
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* opaque */ }
  if (origin && origin !== appOrigin) tokens.unshift('allow-same-origin');
  return tokens.join(' ');
}
export function viewportDims(value, preview, presets = []) {
  const preset = presets.find((p) => p.id === value);
  if (preset) return { width: preset.width, height: preset.height };
  const match = typeof value === 'string' && value.match(/^(\d+)x(\d+)$/);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  return { width: (preview && preview.width) || 375, height: (preview && preview.height) || 667 };
}
// Scale that fits a WIDTHxHEIGHT frame inside the body box minus `pad`
// pixels, never upscaling. Returns 1 until the box has been measured.
export function frameScale(dims, box, pad = 0) {
  if (!dims || !box || !box.width || !box.height) return 1;
  const s = Math.min(1, (box.width - pad) / dims.width, (box.height - pad) / dims.height);
  return s > 0 && isFinite(s) ? s : 1;
}
