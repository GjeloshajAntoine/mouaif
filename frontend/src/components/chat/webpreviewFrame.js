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
