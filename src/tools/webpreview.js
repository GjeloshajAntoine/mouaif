'use strict';

// Native `webpreview` tool — capture a small screenshot of a URL.
//
// Implements docs/features/webpreview.md.
//
// The tool reuses the same Chrome DevTools Protocol bridge as the
// Inspector tab ([src/inspector.js](../../src/inspector.js)): it opens
// the URL in a debug-managed tab, waits for the page to settle, and
// then captures a single small JPEG screenshot via `Page.captureScreenshot`.
// The result is returned to the chat as { url, title, thumbnail, ... }
// so the UI can render a thumbnail card next to the tool call and
// re-use the same image inline in the modal that opens on tap.
//
// Per-call lifecycle:
//   1. Open the URL in a fresh tab via inspector.openInspectorTarget.
//   2. Wait for `Page.loadEventFired` (timeout 10s).
//   3. Give layout / paint a tiny grace window so a static snapshot
//      isn't the empty pre-load frame.
//   4. Call `Page.captureScreenshot` with a viewport clamp (640x480 max)
//      so the result stays well under the model-feedback cap (the image
//      is also sent back to the model as a `image_url` block).
//   5. Close the tab (`Target.closeTarget`) so server restarts don't leak
//      preview tabs. A failed capture still closes the tab.
//
// The tool is project-scope-free: there is no working-directory check
// (the inspector handles its own auth shape). Authorization gates the
// runner; the off/ask/allowlist modes follow the same rules as
// `shell`, with the URL allowlist matching by hostname (or full URL,
// when wildcards are present).
//
// Public surface:
//   SPEC                    — the OpenAI-compatible tool spec (used by
//                              the AI client when collecting tool specs).
//   runWebpreview({ url, signal })
//                            -> Promise<{ ok, content, result }>
//                              where `content` is the string fed to the
//                              model as the `tool` message and `result`
//                              is the richer object surfaced to the UI
//                              in the tool_result SSE event.

const { openInspectorTarget, sendTargetCommand, closeInspectorTarget } = require('../inspector.js');

// Thumbnail dimensions: width is fixed, height is proportionally scaled
// from the captured viewport (so a tall page stays tall). Capped so a
// pathological aspect ratio doesn't bloat the result.
const THUMB_WIDTH_MAX = 640;
const THUMB_HEIGHT_MAX = 480;

// Largest image we accept from CDP. CDP returns either base64-encoded
// data or a binary stream; either way we re-validate against this cap
// before returning the image to the chat. 2 MiB is enough for a 640x480
// JPEG at quality ~0.85 and well under any model-feedback rail.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Default polling cadence while waiting for the load event. The CDP
// `Page.loadEventFired` event is the clean signal so we subscribe, but
// Chrome can drop the subscription if our session is rebuilt; the
// timeout is the fallback so the tool always settles.
const LOAD_TIMEOUT_MS = 10_000;
const POST_LOAD_GRACE_MS = 250;

// Default viewport used when `Page.getLayoutMetrics` is missing
// (some Chrome builds omit the field). 800x600@1x is the Inspector
// default and matches the chat thumbnail card's typical slot.
const DEFAULT_VIEWPORT = { width: 800, height: 600, dpr: 1 };

const err = (code, message, extra) => Object.assign(new Error(message), { code, ...(extra || {}) });

// Validate a URL the model supplied. Accept http(s) only — ftp, file,
// chrome-extension, view-source, javascript:, data: are all rejected
// because they are either not real web pages (`file:`, `data:`) or
// they would surprise the user (`javascript:`) or are obviously out of
// scope (`view-source:`, `chrome-extension:`).
function parseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw err('EBADINPUT', 'url is required');
  }
  let url;
  try { url = new URL(raw.trim()); }
  catch { throw err('EBADINPUT', 'url is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw err('EBADINPUT', 'url must use http or https (got ' + url.protocol + ')');
  }
  return url;
}

// Wait for `Page.loadEventFired` over the target WebSocket (or until
// the timeout). Implemented as a one-shot Promise that resolves on
// the first loadEventFired frame, so the caller doesn't need to
// manage a CDP subscription of its own. Soft-fails on any non-load
// outcome so the caller can still attempt a screenshot.
function waitForLoad(wsUrl, signal) {
  const { WebSocket } = require('ws');
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(wsUrl, { perMessageDeflate: false }); }
    catch (e) { resolve({ ok: false, error: e.message || String(e) }); return; }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve({ ok: false, error: 'timeout waiting for page load (' + LOAD_TIMEOUT_MS + 'ms)' });
    }, LOAD_TIMEOUT_MS);
    if (timer && timer.unref) timer.unref();

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(value);
    }

    ws.on('open', () => {
      // Enable Page domain so loadEventFired frames reach us. The
      // detector is opened bare; no Page.captureScreenshot call is
      // made here because the target endpoint (used for the
      // capture) might have vanished — the runner does a separate
      // sendTargetCommand below.
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
      } catch (e) { finish({ ok: false, error: e.message || String(e) }); }
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      // Skip our `Page.enable` response (which has msg.id === 1 and
      // no method); only Page.loadEventFired events resolve the
      // load gate.
      if (msg && msg.method === 'Page.loadEventFired' && !msg.id) {
        finish({ ok: true, params: msg.params || {} });
      }
    });
    ws.on('error', (e) => {
      // Connection failures are common (Chrome restarts mid-call).
      // Surface as a soft fail so the caller falls through to the
      // capture phase; a partial page is better than nothing for a
      // preview thumbnail.
      finish({ ok: false, error: (e && e.message) || 'ws error' });
    });
    ws.on('close', () => { finish({ ok: false, error: 'ws closed before load' }); });

    if (signal) {
      if (signal.aborted) finish({ ok: false, error: 'aborted' });
      else signal.addEventListener('abort', () => finish({ ok: false, error: 'aborted' }), { once: true });
    }
  });
}

// A short, blocking sleep used for the post-load grace window.
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && t.unref) t.unref();
  });
}

// Compose a positive integer ≤ max from any value (NaN/negative -> max).
function clampPositive(value, max) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return max;
  return Math.min(Math.round(n), max);
}

// runWebpreview — open URL, wait for load, screenshot, close tab.
//
// `opts.signal` is the parent AbortSignal (the AI client's running
// chat). A signal abort unwinds the WS-less waits before the next
// CDP round-trip; we still close the opened tab in `finally` so the
// session never leaks Chrome tabs on a cancelled run.
async function runWebpreview(opts) {
  const url = parseUrl(opts && opts.url);
  const finalUrl = url.href;

  let target;
  try {
    target = await openInspectorTarget(null, finalUrl);
  } catch (e) {
    return {
      ok: false,
      content: JSON.stringify({ error: { code: e.code || 'EUPSTREAM', message: 'Could not open ' + finalUrl + ': ' + (e.message || String(e)) } }),
      result: { error: (e.message || String(e)), code: e.code || 'EUPSTREAM', url: finalUrl }
    };
  }
  const targetId = target && target.id;
  const wsUrl = target && target.webSocketDebuggerUrl;
  if (!targetId || !wsUrl) {
    return {
      ok: false,
      content: JSON.stringify({ error: { code: 'EUPSTREAM', message: 'Chrome target missing webSocketDebuggerUrl' } }),
      result: { error: 'missing webSocketDebuggerUrl', url: finalUrl, targetId: targetId || null }
    };
  }

  try {
    const loadResult = await waitForLoad(wsUrl, opts && opts.signal);
    // Soft-fail: a timeout or ws error here does not abort the
    // capture. The page may have rendered before we subscribed to
    // Page events (Chrome refreshed /json/version mid-call, or we
    // attached just after the load event fired). A thumbnail of the
    // current viewport is the right fallback.
    if (!loadResult.ok) {
      // no-op; documented above.
    }
    // Post-load grace. Tiny enough to feel instant, enough that
    // fonts and one line of async content has settled.
    await sleep(POST_LOAD_GRACE_MS);

    let viewport = DEFAULT_VIEWPORT;
    try {
      const metrics = await sendTargetCommand(null, targetId, 'Page.getLayoutMetrics');
      const layout = (metrics && metrics.layoutViewport) || {};
      const width = clampPositive(layout.clientWidth, DEFAULT_VIEWPORT.width) || DEFAULT_VIEWPORT.width;
      const height = clampPositive(layout.clientHeight, DEFAULT_VIEWPORT.height) || DEFAULT_VIEWPORT.height;
      const dpr = clampPositive(metrics && metrics.devicePixelRatio, 4) || 1;
      viewport = { width, height, dpr };
    } catch { /* keep defaults if getLayoutMetrics isn't supported */ }

    // Capture a viewport-sized JPEG. The clip rectangle is in CSS
    // pixels, scaled by 1/devicePixelRatio so a HiDPI page is
    // captured at its CSS size, not its raw pixel size (which would
    // blow past THUMB_WIDTH_MAX for a 2x DPR display).
    const capW = Math.min(THUMB_WIDTH_MAX, viewport.width);
    const capH = Math.min(THUMB_HEIGHT_MAX, viewport.height);
    const capResult = await sendTargetCommand(null, targetId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70,
      clip: {
        x: 0, y: 0, width: capW, height: capH,
        scale: 1 / Math.max(1, viewport.dpr)
      }
    }).catch((e) => ({ __capError: e }));

    if (!capResult || capResult.__capError) {
      const msg = (capResult && capResult.__capError && capResult.__capError.message) || 'capture failed';
      return {
        ok: false,
        content: JSON.stringify({ error: { code: 'EUPSTREAM', message: 'screenshot failed: ' + msg } }),
        result: { error: 'screenshot failed: ' + msg, url: finalUrl, targetId }
      };
    }

    const data = capResult && capResult.data;
    if (!data || typeof data !== 'string') {
      return {
        ok: false,
        content: JSON.stringify({ error: { code: 'EUPSTREAM', message: 'CDP returned no screenshot data' } }),
        result: { error: 'no screenshot data', url: finalUrl, targetId }
      };
    }

    // Decode the base64 payload to enforce a size cap before
    // round-tripping it back through the model. We never echo raw
    // CDP output; if the cap is exceeded the user-facing error is
    // explicit so they can retry with a smaller window.
    let decoded;
    try { decoded = Buffer.from(data, 'base64'); }
    catch { /* malformed base64 — fall through to typed error */ }
    if (!decoded || !decoded.length) {
      return {
        ok: false,
        content: JSON.stringify({ error: { code: 'EPARSE', message: 'screenshot data was not base64' } }),
        result: { error: 'invalid base64', url: finalUrl, targetId }
      };
    }
    if (decoded.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        content: JSON.stringify({ error: { code: 'ETOOLARGE', message: 'screenshot exceeded ' + MAX_IMAGE_BYTES + ' bytes', size: decoded.length } }),
        result: { error: 'screenshot too large', size: decoded.length, url: finalUrl, targetId }
      };
    }

    // Pick a friendly title from the captured page; modern Chrome's
    // /json/list refreshes the target record on navigation, but
    // freshly-opened tabs may still report ''. Fall back to the
    // hostname so the chat card never shows an empty label.
    const title = (target && target.title) || url.hostname;
    const dataUrl = 'data:image/jpeg;base64,' + data;

    // Result shape the chat UI renders: thumbnail + meta. The
    // model-facing tool message is a short text envelope (so its
    // 64 KiB feedback cap isn't eaten by image bytes); the image
    // rides alongside as an `image_url` part attached to the same
    // tool message (see postToolImageMessages in src/ai-stream.js),
    // which the multimodal providers (Anthropic / OpenAI-shaped /
    // Gemini / Ollama) all accept as a multimodal input.
    const result = {
      ok: true,
      url: finalUrl,
      title,
      sizeBytes: decoded.length,
      width: capW,
      height: capH,
      capturedAt: new Date().toISOString(),
      thumbnail: dataUrl,
      targetId
    };
    const summary = { ok: true, url: finalUrl, title, sizeBytes: decoded.length, width: capW, height: capH, targetId };

    // Expose the inline image for both the chat UI (result.thumbnail)
    // and the model-facing image_url feed. The image_parts helper in
    // src/ai-stream.js walks `result.content`; we mirror the chunk
    // shape MCP image results use so a single line dispatches both
    // the thumbnail card and the multimodal follow-up.
    result.content = [{
      type: 'image',
      mimeType: 'image/jpeg',
      // The model-feedback loader strips out `thumbnail` so we keep
      // it on `result` only; the model-facing image block lives on
      // `content[*].data` as a CDN-safe data URL.
      data: dataUrl
    }];

    return { ok: true, content: JSON.stringify(summary), result };
  } finally {
    // Don't leak Chrome tabs. Closing is best-effort; a failure
    // (Chrome already restarted the target) does not change the
    // result we return.
    try { await closeInspectorTarget(null, targetId); }
    catch { /* tab might have been closed already */ }
  }
}

const SPEC = {
  type: 'function',
  function: {
    name: 'webpreview',
    // Description lists the contract the model sees: which URL
    // shapes are accepted, where the screenshot comes from, and
    // how the user is going to see it. Keep the wording sharp —
    // it is part of the model's tool-pick decision tree.
    description: 'Open a web URL in the debug Chrome used by the Inspector tab and return a small screenshot of what is on the page. ' +
      'Use this when you want to inspect what a URL actually looks like (visual layout, error overlays, ' +
      'preview imagery, styling) instead of guessing from text. The chat UI renders the thumbnail in a card; the user can tap it to open the full screenshot in a modal. ' +
      'Only http and https URLs are accepted.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL to load. Required.' }
      },
      required: ['url'],
      additionalProperties: false
    }
  }
};

module.exports = {
  SPEC,
  runWebpreview,
  // exported for tests
  parseUrl,
  THUMB_WIDTH_MAX,
  THUMB_HEIGHT_MAX,
  MAX_IMAGE_BYTES
};
