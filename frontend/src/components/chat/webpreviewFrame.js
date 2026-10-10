// mouaif web — webpreview Live (iframe) mode helpers
//
// Pure functions used by WebpreviewModal.jsx and WebpreviewDock.jsx; kept
// free of Preact so scripts/test-webpreview-iframe.mjs can import them.
// See docs/features/webpreview.md (Live mode).

// Permissions delegated to the live frame. Live mode is unrestricted: no
// sandbox, no referrer policy, and every powerful feature the page may ask
// for is delegated so it behaves as it would in its own tab.
export const FRAME_ALLOW = [
  'accelerometer', 'autoplay', 'camera', 'clipboard-read', 'clipboard-write',
  'display-capture', 'encrypted-media', 'fullscreen', 'geolocation', 'gyroscope',
  'magnetometer', 'microphone', 'midi', 'payment', 'picture-in-picture',
  'screen-wake-lock', 'web-share', 'xr-spatial-tracking'
].join('; ');

// A preview payload is live when the agent (or user) asked for it. Live
// payloads carry no screenshot; the page itself is framed.
export function isLivePayload(payload) {
  return !!payload && payload.mode === 'live' && typeof payload.url === 'string' && !!payload.url;
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

// ---- Local preview proxy -----------------------------------------------
//
// A Live preview is loaded by *your* browser, so `http://localhost:5173/` is
// resolved by the phone you are holding — where no dev server runs. For a
// local address the frame is loaded through mouaif's own preview proxy
// (`/api/preview/http/<host>/<path>`) instead, which fetches the page on the
// machine running mouaif and streams it back from the app's origin. See
// docs/features/local-preview-proxy.md.
//
// This mirrors `isLocalHost` / `proxyPathFor` in src/previewProxy.js; the two
// lists have to agree, and the server refuses anything it does not recognize.
// It is a *display* decision, not a security boundary: the server re-checks
// every request.
export const PREVIEW_PROXY_PREFIX = '/api/preview/';

export function isLocalPreviewHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'host.docker.internal' || h === 'host.containers.internal' || h === 'gateway.docker.internal') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('::ffff:')) return isLocalPreviewHost(h.slice(7));
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h === '0.0.0.0';
}

// previewProxyPath(url) — the proxy path for a local http(s) URL, else null.
// Path, query and fragment are copied byte for byte, so the proxied page asks
// for exactly what the URL named.
export function previewProxyPath(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!isLocalPreviewHost(u.hostname)) return null;
  return PREVIEW_PROXY_PREFIX + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
}

// frameSource(url) — what to put in the Live frame's `src`: the proxy path for
// a local page, the URL itself for everything else.
export function frameSource(url) {
  return previewProxyPath(url) || url;
}
