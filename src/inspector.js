'use strict';

// Inspector — server-side bridge to Chrome DevTools Protocol (CDP).
//
// Implements docs/decisions.md section 6: the mobile UI consumes CDP
// events but the server is a thin relay. We do NOT embed the Chrome
// panel in an iframe. The mobile UI is built from scratch on top of
// the CDP wire format, which is plain JSON over WebSocket.
//
// Architecture:
//
//   Browser tab  --ws-->  /api/inspector/proxy?url=...  --ws-->  Chrome
//
//   The proxy is a per-connection WebSocket relay. The browser speaks
//   CDP directly (it knows the protocol); the server only forwards
//   frames. Each browser WS connection is paired with one upstream
//   Chrome WS; closing either side closes the other.
//
//   This is the simplest correct implementation. It keeps the server
//   free of CDP client state (no `chrome-remote-interface` style
//   session bookkeeping), which is what we want for a transparent
//   debug pipe.
//
// Public surface:
//
//   const inspector = require('./inspector.js');
//
//   inspector.fetchInfo(debuggerHost) -> { webSocketDebuggerUrl, ... }
//   inspector.fetchTargets(debuggerHost) -> [ { id, type, url, title, ... }, ... ]
//   inspector.handleProxy(req, socket, head, { debuggerHost })
//       -- wired into http.Server's 'upgrade' event in src/index.js
//
//   inspector.ERROR_CODES  -- typed errors mapped to HTTP status
//
// Configuration:
//
//   The "debugger host" (i.e. the Chrome instance to talk to) is
//   resolved per request from a `host` query string on the proxy URL,
//   defaulting to MOUAIF_CHROME_URL or 'http://127.0.0.1:9222'.
//   The user can paste any reachable Chrome /chrome endpoint from the
//   Inspector tab; the value is remembered in the app settings store.
//
// The default port 9222 is what `chrome --remote-debugging-port=9222`
// opens by default. On Android / iOS Chrome, the same flag works;
// the user is responsible for port-forwarding (adb reverse) on
// physical devices.

const http = require('http');
const https = require('https');
const { URL } = require('url');
// `ws` is required lazily: it is only needed once the Inspector tab (or a
// webpreview capture) opens a CDP socket, so an idle server never pays for it.
let wsMod = null;
function loadWs() { return wsMod || (wsMod = require('ws')); }
const { qs } = require('./util.js');
const settings = require('./settings.js');

const DEFAULT_CHROME_PORT = 9222;
const DEFAULT_CHROME_HOST = '127.0.0.1';
const APP_KEY_DEBUGGER_HOST = 'inspectorDebuggerUrl';

// Default placeholder when nothing is configured. Surfaced to the UI as
// "no debugger host configured yet" rather than silently trying localhost.
function defaultDebuggerUrl() {
  return process.env.MOUAIF_CHROME_URL || ('http://' + DEFAULT_CHROME_HOST + ':' + DEFAULT_CHROME_PORT);
}

function getDebuggerUrl() {
  const app = settings.getApp();
  const raw = app && typeof app[APP_KEY_DEBUGGER_HOST] === 'string' ? app[APP_KEY_DEBUGGER_HOST].trim() : '';
  return raw || defaultDebuggerUrl();
}

function setDebuggerUrl(url) {
  // Stored as-is. Empty string clears the override.
  settings.setApp({ [APP_KEY_DEBUGGER_HOST]: typeof url === 'string' ? url : '' });
}

// ---- Chrome /json/version + /json/list ---------------------------------
// Chrome exposes target metadata over plain HTTP. We use http / https
// modules — fetch is fine too but we keep dependencies low and we want
// to surface non-2xx as typed errors.

function httpGetJson(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (e) { const err = new Error('Invalid URL: ' + targetUrl); err.code = 'EBADURL'; reject(err); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error('Chrome returned HTTP ' + res.statusCode + ' for ' + parsed.pathname);
          err.code = 'EUPSTREAM';
          err.status = res.statusCode;
          err.body = text.slice(0, 2000);
          reject(err);
          return;
        }
        let json;
        try { json = JSON.parse(text); }
        catch (e) {
          const err = new Error('Chrome returned non-JSON for ' + parsed.pathname + ': ' + e.message);
          err.code = 'EPARSE';
          reject(err);
          return;
        }
        resolve(json);
      });
    });
    req.on('error', (e) => {
      const err = new Error('Could not reach Chrome at ' + targetUrl + ': ' + e.message);
      err.code = 'ECHROME_UNREACHABLE';
      err.cause = e;
      reject(err);
    });
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout after ' + timeoutMs + 'ms'));
      });
    }
  });
}

// /json/version returns { webSocketDebuggerUrl, ... }
async function fetchInspectorInfo(debuggerUrl) {
  const base = stripTrailingSlash(debuggerUrl || getDebuggerUrl());
  return httpGetJson(base + '/json/version', 5000);
}

// /json/list returns the array of discoverable targets.
async function fetchInspectorTargets(debuggerUrl) {
  const base = stripTrailingSlash(debuggerUrl || getDebuggerUrl());
  const list = await httpGetJson(base + '/json/list', 5000);
  if (!Array.isArray(list)) {
    const err = new Error('Expected array from /json/list, got ' + typeof list);
    err.code = 'EPARSE';
    throw err;
  }
  return list;
}

// openInspectorTarget — opens `pageUrl` in a fresh tab of the debug
// Chrome and returns its target record ({ id, url, webSocketDebuggerUrl,
// ... }). Used by the "inspect this URL" flow and by the inspector
// header's "open in a new tab" action.
//
// Modern Chrome (137+) removed the /json/new HTTP endpoint (it 404s),
// so the primary path is the CDP `Target.createTarget` command sent over
// the browser-level WebSocket from /json/version. Older Chrome still
// accepts PUT /json/new?<url>, kept as a fallback. GET on /json/new was
// dropped for CSRF reasons, so only PUT is ever attempted.
async function openInspectorTarget(debuggerUrl, pageUrl) {
  const base = stripTrailingSlash(debuggerUrl || getDebuggerUrl());
  // The CDP browser WS id is read fresh from /json/version each call,
  // but Chrome may have restarted between that fetch and the moment we
  // open the WS — the old browser-level id then returns 404 "not found"
  // from Chrome itself. Retry once with a freshly re-fetched id before
  // giving up; this covers the real-world "Chrome restarted" race.
  let cdpErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await openTargetViaCdp(base, pageUrl);
    } catch (e) {
      cdpErr = e;
      // "no browser is open" is not a stale id: Chrome has no window to
      // put a tab in (typical for a headless/--incognito Chrome whose
      // default-profile window is gone). Retrying the same call is
      // pointless; handled below with newWindow + /json/new.
      if (isNoBrowserError(e)) break;
      // The fallback path is handled below; retryable errors get one
      // more CDP attempt, everything else surfaces immediately.
      if (!e || !e.__cdpRetryable) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (isNoBrowserError(cdpErr)) {
    // Ask Chrome for a new window instead of a tab in a (missing) one.
    try { return await openTargetViaCdp(base, pageUrl, { newWindow: true }); }
    catch (e) { cdpErr = e; }
    // Last resort: the HTTP endpoint, which Chrome serves by creating
    // a window when none exists.
    cdpErr.__cdpFallback = true;
  }
  // Fall back to the classic HTTP endpoint for older Chrome builds —
  // but only when the CDP path itself isn't the thing that's broken
  // (e.g. Chrome reachable but /json/version lacks a browser WS, or a
  // real network failure). Masking a genuine CDP error with a /json/new
  // 404 would make the modern-path failure harder to diagnose.
  if (cdpErr && cdpErr.__cdpFallback) {
    try {
      const target = await httpRequestJson(base + '/json/new?' + encodeURIComponent(pageUrl), { method: 'PUT' }, 5000);
      if (!target || typeof target !== 'object' || !target.id) {
        const err = new Error('Unexpected /json/new response: ' + typeof target);
        err.code = 'EPARSE';
        throw err;
      }
      return target;
    } catch (e) {
      // Modern Chrome 137+ removed /json/new — it 404s with "not found".
      // If the fallback also fails, surface a clear, actionable error
      // instead of the raw "not found" from Chrome.
      if (e && e.status === 404) {
        const err = new Error('This Chrome build does not expose the /json/new endpoint. Open the page manually in the debug Chrome, or use an existing tab from the target list.');
        err.code = 'EUPSTREAM';
        throw err;
      }
      throw e;
    }
  }
  throw cdpErr;
}

// openTargetViaCdp — sends Target.createTarget over the browser-level
// CDP WebSocket. Requires /json/version to expose webSocketDebuggerUrl;
// returns the fresh target record (Chrome /json/new would return the
// same shape). Rejects with a typed error on any failure.
function isNoBrowserError(e) {
  return !!(e && /no browser is open/i.test(String(e.message || '')));
}

async function openTargetViaCdp(base, pageUrl, opts) {
  const newWindow = !!(opts && opts.newWindow);
  const info = await httpGetJson(base + '/json/version', 5000);
  const wsUrl = info && info.webSocketDebuggerUrl;
  if (!wsUrl || !String(wsUrl).trim()) {
    // Old Chrome may expose /json/version without a browser-level WS (or
    // a remote-debugging mode where only per-page WS is offered). That's
    // exactly when the PUT /json/new fallback is the right call.
    const err = new Error('Chrome /json/version has no webSocketDebuggerUrl; cannot open a tab via CDP');
    err.code = 'EUPSTREAM';
    err.__cdpFallback = true;
    throw err;
  }
  const { WebSocket } = loadWs();
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl, { perMessageDeflate: false }); }
    catch (e) {
      const err = new Error('Could not open browser WebSocket at ' + wsUrl + ': ' + e.message);
      err.code = 'ECHROME_UNREACHABLE';
      reject(err); return;
    }
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      const err = new Error('Timeout waiting for browser WebSocket at ' + wsUrl);
      err.code = 'ECHROME_UNREACHABLE';
      reject(err);
    }, 5000);
    ws.on('open', () => {
      const id = 1;
      ws.send(JSON.stringify({
        id,
        method: 'Target.createTarget',
        params: { url: pageUrl, newWindow }
      }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (msg.error) {
        const err = new Error('Target.createTarget failed: ' + (msg.error.message || 'unknown CDP error'));
        err.code = 'EUPSTREAM';
        // A stale browser WS id (Chrome restarted between /json/version
        // and the WS open) fails with an error like "not found" — retry
        // once with a fresh id from /json/version.
        err.__cdpRetryable = true;
        reject(err);
        return;
      }
      const targetId = msg.result && msg.result.targetId;
      if (!targetId) {
        const err = new Error('Target.createTarget returned no targetId');
        err.code = 'EPARSE';
        reject(err);
        return;
      }
      // Return the same shape /json/new would have returned, so callers
      // (REST handler, UI) treat both paths identically.
      resolve({
        id: targetId,
        type: 'page',
        url: pageUrl,
        title: '',
        webSocketDebuggerUrl: base + '/devtools/page/' + encodeURIComponent(targetId)
      });
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      const err = new Error('Browser WebSocket error: ' + (e && e.message || e));
      err.code = 'ECHROME_UNREACHABLE';
      // 404 from Chrome for an unknown /devtools/browser/<id> also means
      // the id went stale — retry with a fresh one.
      err.__cdpRetryable = true;
      reject(err);
    });
    ws.on('close', () => {
      clearTimeout(timer);
    });
  });
}

// sendBrowserCommand — sends a single CDP method over the browser-level
// WebSocket (from /json/version) and resolves with the result. Used for
// browser-domain commands such as Target.closeTarget. Mirrors
// openTargetViaCdp's retry behavior for a stale browser WS id (Chrome
// restarted) — retries once with a freshly re-fetched id.
async function sendBrowserCommand(debuggerUrl, method, params) {
  const base = stripTrailingSlash(debuggerUrl || getDebuggerUrl());
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await sendBrowserCommandOnce(base, method, params);
    } catch (e) {
      lastErr = e;
      if (!e || !e.__cdpRetryable) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

async function sendBrowserCommandOnce(base, method, params) {
  const info = await httpGetJson(base + '/json/version', 5000);
  const wsUrl = info && info.webSocketDebuggerUrl;
  if (!wsUrl || !String(wsUrl).trim()) {
    const err = new Error('Chrome /json/version has no webSocketDebuggerUrl; cannot send browser command');
    err.code = 'EUPSTREAM';
    throw err;
  }
  const { WebSocket } = loadWs();
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl, { perMessageDeflate: false }); }
    catch (e) {
      const err = new Error('Could not open browser WebSocket at ' + wsUrl + ': ' + e.message);
      err.code = 'ECHROME_UNREACHABLE';
      reject(err); return;
    }
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      const err = new Error('Timeout waiting for browser WebSocket at ' + wsUrl);
      err.code = 'ECHROME_UNREACHABLE';
      reject(err);
    }, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (msg.error) {
        const err = new Error(method + ' failed: ' + (msg.error.message || 'unknown CDP error'));
        err.code = 'EUPSTREAM';
        err.__cdpRetryable = true;
        reject(err);
        return;
      }
      resolve(msg.result || {});
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      const err = new Error('Browser WebSocket error: ' + (e && e.message || e));
      err.code = 'ECHROME_UNREACHABLE';
      err.__cdpRetryable = true;
      reject(err);
    });
    ws.on('close', () => { clearTimeout(timer); });
  });
}

// sendTargetCommand — sends a single CDP method over a *target*-level
// WebSocket (resolved from the targetId via /json/list). Used for
// page-domain commands such as Page.reload and Page.navigate. Rejects
// with a typed error when the target is gone or unreachable.
async function sendTargetCommand(debuggerUrl, targetId, method, params) {
  const base = stripTrailingSlash(debuggerUrl || getDebuggerUrl());
  const list = await httpGetJson(base + '/json/list', 5000);
  const t = list.find((x) => x && x.id === targetId);
  if (!t || !t.webSocketDebuggerUrl) {
    const err = new Error('target not found: ' + targetId);
    err.code = 'ETARGET_NOT_FOUND';
    throw err;
  }
  const { WebSocket } = loadWs();
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false }); }
    catch (e) {
      const err = new Error('Could not open target WebSocket: ' + e.message);
      err.code = 'ECHROME_UNREACHABLE';
      reject(err); return;
    }
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      const err = new Error('Timeout waiting for target WebSocket at ' + t.webSocketDebuggerUrl);
      err.code = 'ECHROME_UNREACHABLE';
      reject(err);
    }, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (msg.error) {
        const err = new Error(method + ' failed: ' + (msg.error.message || 'unknown CDP error'));
        err.code = 'EUPSTREAM';
        reject(err);
        return;
      }
      resolve(msg.result || {});
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      const err = new Error('Target WebSocket error: ' + (e && e.message || e));
      err.code = 'ECHROME_UNREACHABLE';
      reject(err);
    });
    ws.on('close', () => { clearTimeout(timer); });
  });
}

// closeInspectorTarget — closes a tab (Target.closeTarget, browser-level).
async function closeInspectorTarget(debuggerUrl, targetId) {
  await sendBrowserCommand(debuggerUrl, 'Target.closeTarget', { targetId });
  return { ok: true };
}

// reloadInspectorTarget — reloads a tab (Page.reload, target-level).
async function reloadInspectorTarget(debuggerUrl, targetId) {
  await sendTargetCommand(debuggerUrl, targetId, 'Page.reload', { ignoreCache: false });
  return { ok: true };
}

// navigateInspectorTarget — navigates a tab to a new URL (Page.navigate,
// target-level). Returns the navigation result (frameId, loaderId).
async function navigateInspectorTarget(debuggerUrl, targetId, url) {
  return sendTargetCommand(debuggerUrl, targetId, 'Page.navigate', { url });
}
// historyInspectorTarget — the attached tab's session history
// (Page.getNavigationHistory, target-level), shaped for the Inspector's nav
// row. `canGoBack` / `canGoForward` are what let the two history arrows be
// *disabled* instead of reporting "no page to go back to" only after the
// tap. `entries` carries only what a history list needs to draw itself
// (id, url, title) so a long-lived tab cannot ship a huge payload.
async function historyInspectorTarget(debuggerUrl, targetId) {
  const history = await sendTargetCommand(debuggerUrl, targetId, 'Page.getNavigationHistory', {});
  const list = Array.isArray(history && history.entries) ? history.entries : [];
  const index = history && typeof history.currentIndex === 'number' ? history.currentIndex : -1;
  return {
    index,
    canGoBack: index > 0 && !!list[index - 1],
    canGoForward: index >= 0 && !!list[index + 1],
    // `entryId` is Chrome's own field name (CDP `Page.navigateToHistoryEntry`
    // takes `{ entryId }`). Only entries carrying a usable id are published:
    // a missing or non-numeric id would otherwise reach the step below as an
    // argument Chrome rejects, turning "go back" into a hard failure instead
    // of the no-op it should be.
    entries: list
      .filter((e) => e && Number.isFinite(e.id))
      .map((e) => ({ entryId: e.id, url: e.url || '', title: e.title || '' }))
  };
}

// stepHistory — move the history cursor `delta` entries (negative = back,
// positive = forward) and report whether it actually moved. One helper for
// both directions so forward cannot drift from back. A step with nowhere to
// go is a friendly no-op, not an error: the caller turns `moved: false` into
// its own wording and no request is sent to Chrome.
async function stepHistory(debuggerUrl, targetId, delta) {
  const history = await historyInspectorTarget(debuggerUrl, targetId);
  const wanted = history.index >= 0 ? history.entries[history.index + delta] : null;
  if (!wanted) return { ok: true, moved: false };
  await sendTargetCommand(debuggerUrl, targetId, 'Page.navigateToHistoryEntry', { entryId: wanted.entryId });
  return { ok: true, moved: true };
}

// goBackInspectorTarget — navigates a tab one entry back in its history.
// Returns { ok: true, wentBack: <bool> } so the UI can tell "went back"
// from "nothing to go back to" without treating the latter as an error.
async function goBackInspectorTarget(debuggerUrl, targetId) {
  const r = await stepHistory(debuggerUrl, targetId, -1);
  return { ok: true, wentBack: r.moved };
}

// goForwardInspectorTarget — the same step in the other direction, for a tab
// the user has already navigated back from. Returns { ok, wentForward }.
async function goForwardInspectorTarget(debuggerUrl, targetId) {
  const r = await stepHistory(debuggerUrl, targetId, 1);
  return { ok: true, wentForward: r.moved };
}
// httpRequestJson — httpGetJson generalized to any method (Chrome's
// /json/new requires PUT). Same typed-error behavior as httpGetJson.
function httpRequestJson(targetUrl, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (e) { const err = new Error('Invalid URL: ' + targetUrl); err.code = 'EBADURL'; reject(err); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, { method: (opts && opts.method) || 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error('Chrome returned HTTP ' + res.statusCode + ' for ' + parsed.pathname);
          err.code = 'EUPSTREAM';
          err.status = res.statusCode;
          err.body = text.slice(0, 2000);
          reject(err);
          return;
        }
        let json;
        try { json = JSON.parse(text); }
        catch (e) {
          const err = new Error('Chrome returned non-JSON for ' + parsed.pathname + ': ' + e.message);
          err.code = 'EPARSE';
          reject(err);
          return;
        }
        resolve(json);
      });
    });
    req.on('error', (e) => {
      const err = new Error('Could not reach Chrome at ' + targetUrl + ': ' + e.message);
      err.code = 'ECHROME_UNREACHABLE';
      err.cause = e;
      reject(err);
    });
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout after ' + timeoutMs + 'ms'));
      });
    }
    req.end();
  });
}

function stripTrailingSlash(s) { return String(s || '').replace(/\/+$/, ''); }

// ---- Proxy: WebSocket <-> WebSocket ------------------------------------
//
// The browser opens a WS to the mouaif server. We accept the upgrade,
// immediately open a WS to the target Chrome /devtools/page/<id>, and
// pipe messages both ways. The browser then speaks CDP directly.
//
// We support two proxy URL shapes:
//
//   ws://host/api/inspector/proxy?ws=ws%3A%2F%2F127.0.0.1%3A9222%2Fdevtools%2Fpage%2FAB12CD
//       -- direct passthrough; the browser already knows the target.
//
//   ws://host/api/inspector/proxy?host=http%3A%2F%2F127.0.0.1%3A9222&targetId=AB12CD
//       -- we look up the target's webSocketDebuggerUrl server-side and
//          connect on the browser's behalf. Used by the "tap a target"
//          UI flow so the mobile app never has to talk to /json/list
//          over a second WebSocket.
//
// Both shapes are equivalent on the wire; the only difference is which
// side does the /json/list call.

async function handleProxy(req, socket, head, opts) {
  const q = (req.url && req.url.indexOf('?') >= 0)
    ? Object.fromEntries(new URL(req.url, 'http://placeholder').searchParams)
    : {};

  // Prefer the explicit ws URL if provided. Fall back to host+targetId.
  let upstreamWsUrl = typeof q.ws === 'string' ? q.ws : '';
  if (!upstreamWsUrl) {
    const host = typeof q.host === 'string' && q.host ? q.host : (opts && opts.debuggerUrl) || getDebuggerUrl();
    const targetId = qs(q, 'targetId');
    if (!targetId) {
      writeProxyError(socket, 400, 'EBADINPUT', 'either ?ws=<wsUrl> or ?targetId=<id> is required');
      return;
    }
    try {
      const list = await fetchInspectorTargets(host);
      const t = list.find((x) => x && x.id === targetId);
      if (!t || !t.webSocketDebuggerUrl) {
        writeProxyError(socket, 404, 'ETARGET_NOT_FOUND', 'target not found: ' + targetId);
        return;
      }
      upstreamWsUrl = t.webSocketDebuggerUrl;
    } catch (e) {
      const status = e.code === 'ECHROME_UNREACHABLE' ? 502 : (e.status || 500);
      writeProxyError(socket, status, e.code || 'EUPSTREAM', e.message);
      return;
    }
  }

  let upstreamWs;
  try {
    upstreamWs = new (loadWs().WebSocket)(upstreamWsUrl, { perMessageDeflate: false });
  } catch (e) {
    writeProxyError(socket, 502, 'EWS_OPEN_FAILED', e && e.message || 'WebSocket open failed');
    return;
  }

  let browserWs;
  try {
    // The noServer WebSocketServer lets us complete the upgrade on the
    // browser side ourselves. `opts.wss.handleUpgrade` performs the
    // handshake and hands us a ready WebSocket in the callback.
    if (!opts || !opts.wss) {
      writeProxyError(socket, 500, 'EUPGRADE_NO_WSS', 'inspector: no WebSocketServer on the upgrade handler');
      try { upstreamWs.terminate(); } catch { /* ignore */ }
      return;
    }
    opts.wss.handleUpgrade(req, socket, head, (ws) => {
      // Now that the browser side is upgraded, finish the upstream
      // handshake and start piping.
      wirePair(ws, upstreamWs);
    });
  } catch (e) {
    try { upstreamWs.terminate(); } catch { /* ignore */ }
    writeProxyError(socket, 500, 'EUPGRADE_FAILED', e && e.message || 'upgrade failed');
    return;
  }
}

function writeProxyError(socket, status, code, message) {
  // The HTTP upgrade response is just headers; we can't send a JSON
  // body over a failed upgrade. Send a 4xx-style status line and a
  // tiny text body so the browser's WS open handler can show a useful
  // error in its onerror.
  let payload;
  try {
    payload = JSON.stringify({ code, error: message });
  } catch { payload = '{"code":"' + code + '","error":"' + String(message).replace(/"/g, '\\"') + '"}'; }
  const reason = code + ': ' + message;
  try {
    socket.write(
      'HTTP/1.1 ' + status + ' ' + (http.STATUS_CODES[status] || 'Error') + '\r\n' +
      'Content-Type: application/json\r\n' +
      'Connection: close\r\n' +
      'Content-Length: ' + Buffer.byteLength(payload) + '\r\n\r\n' +
      payload
    );
    socket.end();
  } catch {
    try { socket.destroy(); } catch { /* ignore */ }
  }
}

function wirePair(browserWs, upstreamWs) {
  const { WebSocket } = loadWs();
  // Open the upstream socket if it isn't already.
  let opened = upstreamWs.readyState === WebSocket.OPEN;
  const pendingFromBrowser = [];

  function flushPendingToUpstream() {
    while (pendingFromBrowser.length && upstreamWs.readyState === WebSocket.OPEN) {
      const data = pendingFromBrowser.shift();
      try { upstreamWs.send(data); }
      catch { /* socket closed */ }
    }
  }

  if (!opened) {
    upstreamWs.on('open', () => {
      opened = true;
      flushPendingToUpstream();
    });
  }

  upstreamWs.on('message', (data, isBinary) => {
    if (browserWs.readyState !== WebSocket.OPEN) return;
    // `data` from ws@8 is a Buffer; send accepts Buffer / string / ArrayBuffer.
    try { browserWs.send(data, { binary: isBinary }); }
    catch { /* socket closed */ }
  });

  browserWs.on('message', (data, isBinary) => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      try { upstreamWs.send(data, { binary: isBinary }); }
      catch { /* socket closed */ }
    } else {
      // Buffer frames until the upstream opens. This is uncommon — the
      // browser typically waits for the proxy handshake before sending
      // any commands — but it keeps the protocol honest.
      if (isBinary) {
        // We don't expect CDP clients to send binary; ignore safely.
        return;
      }
      pendingFromBrowser.push(typeof data === 'string' ? data : data.toString('utf-8'));
    }
  });

  function closeBoth(reason) {
    try { browserWs.close(1000, reason || 'upstream closed'); } catch { /* ignore */ }
    try { upstreamWs.close(1000, reason || 'browser closed'); } catch { /* ignore */ }
  }
  upstreamWs.on('close', (code, reason) => {
    closeBoth(reason && reason.toString ? reason.toString() : 'upstream closed');
  });
  upstreamWs.on('error', () => {
    closeBoth('upstream error');
  });
  browserWs.on('close', () => {
    try { upstreamWs.close(1000, 'browser closed'); } catch { /* ignore */ }
  });
  browserWs.on('error', () => {
    try { upstreamWs.close(1000, 'browser error'); } catch { /* ignore */ }
  });
}

// Create a noServer WebSocketServer so the http server can delegate
// upgrades to it. Called lazily on the first inspector upgrade so an idle
// server never loads `ws`.
function makeNoServerWss() {
  return new (loadWs().WebSocketServer)({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
}

module.exports = {
  // config
  APP_KEY_DEBUGGER_HOST,
  defaultDebuggerUrl,
  getDebuggerUrl,
  setDebuggerUrl,
  // fetchers (used by REST routes and tests)
  fetchInspectorInfo,
  fetchInspectorTargets,
  openInspectorTarget,
  closeInspectorTarget,
  sendTargetCommand,
  reloadInspectorTarget,
  navigateInspectorTarget,
  historyInspectorTarget,
  goBackInspectorTarget,
  goForwardInspectorTarget,
  // WS proxy
  handleProxy,
  makeNoServerWss,
  // constants
  DEFAULT_CHROME_HOST,
  DEFAULT_CHROME_PORT
};
