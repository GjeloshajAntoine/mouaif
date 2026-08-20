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
// so the UI can render a small dock between the transcript and composer and
// re-use the same image in the full viewer that opens on a user tap.
//
// Per-call lifecycle:
//   1. Open the URL in a fresh tab via inspector.openInspectorTarget.
//   2. Wait for `Page.loadEventFired` (timeout 10s).
//   3. Apply the Inspector's small-phone viewport (375 × 667) and give
//      responsive layout / paint a tiny grace window.
//   4. Call `Page.captureScreenshot` for that mobile viewport so the
//      reduced chat image has the same proportions as Inspector. The
//      screenshot bytes are not appended to the model conversation.
//   5. Close the tab (`Target.closeTarget`) so server restarts don't leak
//      preview tabs. A failed capture still closes the tab. Calling the tool
//      again for the same URL opens a fresh tab and acts as an agent-triggered
//      reload of the user-facing preview.
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

const { openInspectorTarget, sendTargetCommand, closeInspectorTarget, fetchInspectorTargets } = require('../inspector.js');

// Match the Inspector's small-phone viewport preset. Keeping this capture
// mobile-sized makes the reduced chat image a faithful miniature of the
// Inspector preview instead of a landscape desktop crop.
const THUMB_WIDTH_MAX = 375;
const THUMB_HEIGHT_MAX = 667;

// Largest image we accept from CDP. CDP returns either base64-encoded
// data or a binary stream; either way we re-validate against this cap
// before returning the image to the chat. 2 MiB is ample for a 375 × 667
// JPEG at quality 70 and well under any model-feedback rail.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Default polling cadence while waiting for the load event. The CDP
// `Page.loadEventFired` event is the clean signal so we subscribe, but
// Chrome can drop the subscription if our session is rebuilt; the
// timeout is the fallback so the tool always settles.
const LOAD_TIMEOUT_MS = 10_000;
const POST_LOAD_GRACE_MS = 250;

// The capture uses the same small-phone dimensions as Inspector's Phone
// preset. This is also the fallback when a Chrome build omits layout metrics.
const DEFAULT_VIEWPORT = { width: THUMB_WIDTH_MAX, height: THUMB_HEIGHT_MAX, dpr: 1 };

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
    // Use the same emulated viewport as Inspector's Phone preset. Applying a
    // metrics override triggers responsive media-query reflow immediately, so a
    // reload is unnecessary and would add another load-timeout cycle.
    try {
      await sendTargetCommand(null, targetId, 'Emulation.setDeviceMetricsOverride', {
        width: THUMB_WIDTH_MAX,
        height: THUMB_HEIGHT_MAX,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: THUMB_WIDTH_MAX,
        screenHeight: THUMB_HEIGHT_MAX
      });
    } catch { /* capture still works at the native viewport */ }
    // Post-emulation grace. Tiny enough to feel instant, enough that
    // responsive layout, fonts, and one line of async content have settled.
    await sleep(POST_LOAD_GRACE_MS);

    let viewport = DEFAULT_VIEWPORT;
    try {
      const metrics = await sendTargetCommand(null, targetId, 'Page.getLayoutMetrics');
      const layout = (metrics && metrics.layoutViewport) || {};
      const width = clampPositive(layout.clientWidth, DEFAULT_VIEWPORT.width) || DEFAULT_VIEWPORT.width;
      const height = clampPositive(layout.clientHeight, DEFAULT_VIEWPORT.height) || DEFAULT_VIEWPORT.height;
      // devicePixelRatio is absent from some Chrome builds (e.g. the
      // headless shell used for the Inspector). Default to 1 so the
      // clip scale below stays 1:1 instead of shrinking to a fraction.
      const dpr = (metrics && metrics.devicePixelRatio > 0)
        ? clampPositive(metrics.devicePixelRatio, 4)
        : 1;
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

    // Pick a friendly title from the captured page. The open-time
    // target record often reports '' for a fresh tab, so re-fetch the
    // target list after load — Chrome refreshes the record's title once
    // the page has navigated. Fall back to the hostname only when no
    // title is discoverable so the chat card never shows an empty label.
    let title = (target && target.title) || '';
    if (!title) {
      try {
        const list = await fetchInspectorTargets(null);
        const live = Array.isArray(list) && list.find((x) => x && x.id === targetId);
        if (live && typeof live.title === 'string' && live.title.trim()) title = live.title;
      } catch { /* title is cosmetic; keep the hostname fallback */ }
    }
    if (!title) title = url.hostname;
    const dataUrl = 'data:image/jpeg;base64,' + data;

    // Result shape the chat UI renders: thumbnail + meta. The screenshot is
    // user-facing only: src/ai-stream.js emits the rich result to the UI but does
    // not append its image bytes to the model conversation. The model receives
    // the compact summary below and can call webpreview again to refresh it.
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
    description: 'Refresh the user-facing preview of a web URL in the debug Chrome used by the Inspector tab. ' +
      'The screenshot is shown only to the user in a small dock between the chat scroll and textbox; tapping it opens the full image. ' +
      'Call this tool again with the URL whenever the user preview should reload. The screenshot is not returned to you for visual analysis. ' +
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
