// Inspector CDP event handlers — translate CDP events into entries
// for the console and network virtual lists.
import { argToString } from './format.js';

export function createEventHandlers(state) {
  const { consoleEntries, networkEntries, reqMap, consoleVL, networkVL, cdpSend, onNavigate } = state;

  // countRefs — optional refs the InspectorView supplies so pushConsole /
  // pushNetwork can fire a single number on every event. The state lives
  // in a ref so a CDP burst doesn't queue 2000 Preact rerenders; the
  // parent reads the count and calls setCount in its own microtask.
  // Tests that don't pass refs in still work — fall back to silent stubs.
  const consoleCountRef = state.consoleCountRef || { current: null };
  const networkCountRef = state.networkCountRef || { current: null };
  // setStatusRef — optional wrapper the InspectorView supplies so the
  // event layer can surface connection-side messages (e.g. the backfill
  // summary) on the same status pill as the HTTP/WS layers. Ref shape
  // ( .current = fn ) keeps the upgrade mechanical from its DOM-ref predecessor.
  const setStatusRef = state.setStatusRef || { current: null };

  function touchEntry(e) { e.rev = (e.rev || 0) + 1; }

  function pushConsole() {
    const vl = consoleVL.current;
    if (vl) {
      const data = consoleEntries.current.slice(-2000);
      try { vl.setData(data); vl.scrollToIndex(data.length - 1); } catch { /* vl destroyed */ consoleVL.current = null; }
    }
    if (consoleCountRef.current) consoleCountRef.current(data.length);
  }

  function pushNetwork() {
    const vl = networkVL.current;
    if (vl) {
      const data = networkEntries.current.slice(-2000);
      try { vl.setData(data); } catch { /* vl destroyed */ networkVL.current = null; }
    }
    if (networkCountRef.current) networkCountRef.current(data.length);
  }

  function onConsoleEvent(params) {
    const args = params.args || [];
    const text = args.map(argToString).join(' ');
    const ts = Date.now();
    const entry = {
      id: 'c' + ts + '-' + consoleEntries.current.length,
      kind: 'console',
      level: params.type || 'log',
      text,
      args: args.slice(0, 8),
      url: null, line: null, stack: null,
      ts
    };
    const st = params.stackTrace && params.stackTrace.callFrames;
    if (st && st.length) {
      entry.url = st[0].url || null;
      entry.line = st[0].lineNumber != null ? st[0].lineNumber + 1 : null;
      entry.stack = st.map((f) => '  at ' + (f.functionName || '(anon)') + ' (' + (f.url || '') + ':' + ((f.lineNumber || 0) + 1) + ':' + ((f.columnNumber || 0) + 1) + ')').join('\n');
    }
    consoleEntries.current.push(entry);
    pushConsole();
  }

    // evaluateExpression — run a snippet the user typed in the editable
  // JavaScript console (JsConsole) inside the inspected page. Uses
  // includeCommandLineAPI so `$0`, `$`, `$$`, `inspect` etc. behave like
  // the real DevTools console. The result is appended to the console log
  // as an entry — either the JSON-serialised value (for value types) or
  // the RemoteObject description (for objects/functions) — and a thrown
  // exception is reported as an error row instead of failing silently.
  // Returns the result value/description so the caller can act on it.
  async function evaluateExpression(expression) {
    const ts = Date.now();
    const mkId = () => 'c' + ts + '-' + consoleEntries.current.length;
    if (!cdpSend || !expression || !String(expression).trim()) return null;
    let entry;
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: String(expression),
        includeCommandLineAPI: true,
        returnByValue: true,
        awaitPromise: true,
        objectGroup: 'mouaif-console'
      });
      entry = {
        id: mkId(),
        kind: 'console',
        level: 'info',
        text: '',
        args: [],
        url: null, line: null, stack: null,
        ts
      };
      const result = r && r.result;
      if (r && r.exceptionDetails) {
        const ex = r.exceptionDetails;
        entry.level = 'error';
        entry.text = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'Uncaught exception';
        if (ex.exception) entry.args = [ex.exception];
        const st = ex.stackTrace && ex.stackTrace.callFrames;
        if (st && st.length) {
          entry.url = st[0].url || null;
          entry.line = st[0].lineNumber != null ? st[0].lineNumber + 1 : null;
          entry.stack = st.map((f) => '  at ' + (f.functionName || '(anon)') + ' (' + (f.url || '') + ':' + ((f.lineNumber || 0) + 1) + ':' + ((f.columnNumber || 0) + 1) + ')').join('\n');
        }
      } else if (result && typeof result.value !== 'undefined') {
        // Value types come back serialised by returnByValue; show them
        // as plain text (matching how console.log renders primitives).
        // JSON.stringify can throw on circular structures — fall back
        // to the CDP description instead of dropping the row.
        let asText;
        try {
          asText = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
        } catch {
          asText = result.description || String(result.value);
        }
        entry.text = asText;
        if (typeof result.value === 'string') entry.args = [{ type: 'string', value: result.value }];
      } else if (result && (result.description || result.objectId)) {
        // Objects / functions: keep the RemoteObject so the row renderer
        // can paint a preview just like a live console.log(object).
        entry.text = result.description || '';
        entry.args = [result];
      } else {
        entry.text = 'undefined';
        entry.args = [{ type: 'undefined' }];
      }
    } catch (e) {
      entry = {
        id: mkId(),
        kind: 'console',
        level: 'error',
        text: 'Runtime.evaluate failed: ' + (e && e.message || e),
        args: [],
        url: null, line: null, stack: null,
        ts
      };
    }
    consoleEntries.current.push(entry);
    pushConsole();
    return entry;
  }

  function onExceptionEvent(params) {
    const ex = params.exceptionDetails || {};
    const text = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'exception';
    const ts = Date.now();
    const entry = {
      id: 'c' + ts + '-' + consoleEntries.current.length,
      kind: 'exception',
      level: 'error',
      text,
      args: ex.exception ? [ex.exception] : [],
      url: ex.url || null,
      line: ex.lineNumber != null ? ex.lineNumber + 1 : null,
      stack: null,
      ts
    };
    const st = ex.stackTrace && ex.stackTrace.callFrames;
    if (st && st.length) {
      entry.stack = st.map((f) => '  at ' + (f.functionName || '(anon)') + ' (' + (f.url || '') + ':' + ((f.lineNumber || 0) + 1) + ':' + ((f.columnNumber || 0) + 1) + ')').join('\n');
    }
    consoleEntries.current.push(entry);
    pushConsole();
  }

  function onRequestWillBeSent(params) {
    const req = params.request || {};
    const entry = {
      id: 'n' + (params.requestId || '') + '-' + reqMap.current.size,
      requestId: params.requestId,
      kind: 'request',
      method: req.method || 'GET',
      url: req.url || '',
      status: 'pending',
      type: (params.type || '').toLowerCase() || null,
      initiator: params.initiator && params.initiator.url || null,
      requestHeaders: req.headers || null,
      ts: Date.now(),
      _start: typeof params.timestamp === 'number' ? params.timestamp : null,
      duration: null,
      size: null,
      encodedSize: null,
      mimeType: null,
      ip: null, port: null, protocol: null,
      fromCache: false,
      body: null,
      bodyLoading: false
    };
    reqMap.current.set(params.requestId, entry);
    networkEntries.current.push(entry);
    pushNetwork();
  }

  function onResponseReceived(params) {
    const r = params.response || {};
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.status = r.status || 0;
    entry.statusText = r.statusText || '';
    entry.type = (params.type || '').toLowerCase() || entry.type;
    entry.mimeType = r.mimeType || null;
    entry.responseHeaders = r.headers || null;
    entry.encodedSize = typeof r.encodedDataLength === 'number' ? r.encodedDataLength : null;
    entry.ip = r.remoteIPAddress || null;
    entry.port = r.remotePort || null;
    entry.protocol = r.protocol || null;
    entry.fromCache = !!(r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache);
    touchEntry(entry);
    pushNetwork();
  }

  function onLoadingFinished(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.duration = (typeof params.timestamp === 'number' && entry._start != null) ? Math.round((params.timestamp - entry._start) * 1000) : null;
    if (typeof params.encodedDataLength === 'number') {
      entry.encodedSize = params.encodedDataLength;
      entry.size = params.encodedDataLength;
    }
    touchEntry(entry);
    pushNetwork();
  }

  function onLoadingFailed(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.status = 'failed';
    entry.statusText = params.errorText || 'failed';
    touchEntry(entry);
    pushNetwork();
  }

  // backfill — Chrome does not replay requests that finished before the
  // Network domain was enabled (Network.enable on an already-loaded page
  // emits nothing, and there is no getRequestHistory API). The only
  // client-visible record of the page's existing resources is the DOM
  // resource tree: Page.getResourceTree gives the main frame + subframe
  // documents and their resource URLs. We surface those as rows so an
  // attach to a tab that is already open (the common case) does not show
  // an empty Network panel. Rows are tagged `backfilled: true` so the
  // detail sheet can say the entry is pre-attach and per-resource sizes /
  // bodies stay unavailable (Chrome has no API to fetch body or size for
  // a resource without a live requestId). Live traffic keeps flowing on
  // top; a subsequent navigation replaces these entries with real events.
  async function backfillResources() {
    if (!state.cdpSend) return;
    let tree = null;
    try {
      const r = await state.cdpSend('Page.getResourceTree');
      tree = r && r.frameTree;
    } catch { /* Page domain unavailable — skip the backfill */ return; }
    if (!tree) return;
    const seen = new Set();
    const pending = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      const frame = node.frame;
      const url = frame && typeof frame.url === 'string' && frame.url ? frame.url : null;
      if (url && !seen.has(url)) { seen.add(url); pending.push({ url, type: 'document' }); }
      const resources = Array.isArray(node.resources) ? node.resources : [];
      for (const r of resources) {
        const u = r && typeof r.url === 'string' ? r.url : '';
        if (!u || seen.has(u)) continue;
        seen.add(u);
        pending.push({
          url: u,
          type: (r.type || 'other').toLowerCase()
        });
      }
      for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) walk(child);
    })(tree);
    if (!pending.length) return;
    const host = (typeof window !== 'undefined' && window.location && window.location.host) || '';
    const entries = pending
      .map((p) => ({
        id: 'bf' + p.url + '-' + reqMap.current.size,
        requestId: null,
        kind: 'request',
        method: 'GET',
        url: p.url,
        status: 'backfilled',
        type: p.type,
        initiator: null,
        requestHeaders: null,
        ts: Date.now(),
        _start: null,
        duration: null,
        size: null,
        encodedSize: null,
        mimeType: null,
        ip: null, port: null, protocol: null,
        fromCache: false,
        body: null,
        bodyLoading: false,
        backfilled: true,
        host: (function () {
          try {
            const u = new URL(p.url);
            return u.host;
          } catch { return null; }
        })()
      }))
      .filter((e) => !host || e.host !== host)
      .slice(-500);
    if (!entries.length) return;
    // Insert the backfill BEFORE any live events captured in the race
    // between Network.enable and this call, so the timeline stays
    // chronological: pre-attach resources first, live traffic after.
    networkEntries.current = entries.concat(networkEntries.current);
    pushNetwork();
    if (setStatusRef.current) {
      const n = entries.length;
      setStatusRef.current('connected — ' + n + ' pre-attach resource' + (n === 1 ? '' : 's') + ' backfilled from the loaded page');
    }
  }

  function captureScreenshot() {
    return cdpSend('Page.captureScreenshot', { format: 'jpeg', quality: 55, captureBeyondViewport: true });
  }

  // clickAt — forward a tap on the live preview to the page. The x/y here
  // are device-pixel coordinates within the full-page screenshot
  // (captureBeyondViewport), computed by PreviewPanel from the image's
  // naturalWidth/naturalHeight. Input.dispatchMouseEvent expects CSS
  // pixels relative to the viewport, so we (1) divide by the page's
  // devicePixelRatio to get page CSS coordinates, then (2) offset by the
  // page's current scroll position to get viewport coordinates. Anything
  // tapped outside the current viewport (e.g. below the fold) is first
  // scrolled into view so the click actually lands on the target element.
  async function clickAt(x, y) {
    let scrollX = 0, scrollY = 0, dpr = 1;
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: '({ sx: window.scrollX || 0, sy: window.scrollY || 0, dpr: window.devicePixelRatio || 1 })',
        returnByValue: true
      });
      const o = r && r.result && r.result.value;
      if (o && typeof o === 'object') {
        scrollX = o.sx || 0;
        scrollY = o.sy || 0;
        dpr = o.dpr || 1;
      }
    } catch { /* keep defaults */ }

    const pageX = x / dpr;
    const pageY = y / dpr;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;

    let vx = Math.round(pageX - scrollX);
    let vy = Math.round(pageY - scrollY);
    let targetScrollY = scrollY;

    // If the tapped point is outside the live viewport, scroll it into
    // view (roughly centered) so the dispatched click hits the element.
    if (vh > 0 && (vy < 0 || vy > vh)) {
      targetScrollY = Math.max(0, Math.round(pageY - vh / 2));
    }
    if (targetScrollY !== scrollY) {
      try {
        await cdpSend('Runtime.evaluate', { expression: 'window.scrollTo(0, ' + targetScrollY + ')' });
        vy = Math.round(pageY - targetScrollY);
      } catch { /* fall through with the original vy */ }
    }

    return cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: vx, y: vy, button: 'left', clickCount: 1 })
      .then(() => cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vx, y: vy, button: 'left', clickCount: 1 }))
      .then(() => true)
      .catch((e) => { throw e; });
  }

  async function fetchMetrics() {
    const out = { netCount: networkEntries.current.length };
    try {
      const m = await cdpSend('Performance.getMetrics');
      const list = (m && m.metrics) || [];
      const byName = {};
      for (const x of list) byName[x.name] = x.value;
      out.documents = byName.Documents;
      out.frames = byName.Frames;
      out.nodes = byName.Nodes;
      out.listeners = byName.JSEventListeners;
      out.jsHeap = byName.JSHeapUsedSize;
      out.layoutCount = byName.LayoutCount;
      out.recalcCount = byName.RecalcStyleCount;
    } catch { /* Performance domain off */ }
    return out;
  }

  async function loadResponseBody(item) {
    if (!item || !item.requestId || item.bodyLoading) return;
    item.bodyLoading = true;
    touchEntry(item);
    if (state.rerender) state.rerender();
    try {
      const r = await cdpSend('Network.getResponseBody', { requestId: item.requestId });
      let body = r && typeof r.body === 'string' ? r.body : '';
      if (r && r.base64Encoded) {
        try { body = decodeURIComponent(escape(atob(body))); } catch { body = atob(body); }
      }
      item.body = body.length > 200000 ? body.slice(0, 200000) + '\n… (truncated)' : body;
    } catch (e) {
      item.body = '(failed to fetch body: ' + (e && e.message || e) + ')';
    } finally {
      item.bodyLoading = false;
      touchEntry(item);
      if (state.rerender) state.rerender();
    }
  }

  function onFrameNavigated(params) {
    const frame = params && params.frame;
    if (!frame) return;
    // Main frame navigation: frame.parentId is missing or null
    if (!frame.parentId && typeof onNavigate === 'function') {
      onNavigate(frame.url || '', frame.name || '');
    }
  }

  function onNavigatedWithinDocument(params) {
    if (params && params.url && typeof onNavigate === 'function') {
      onNavigate(params.url, '');
    }
  }

  return {
    onConsoleEvent, onExceptionEvent, onRequestWillBeSent,
    onResponseReceived, onLoadingFinished, onLoadingFailed,
    onFrameNavigated, onNavigatedWithinDocument,
    pushConsole, pushNetwork, captureScreenshot, clickAt, fetchMetrics,
    loadResponseBody, backfillResources, evaluateExpression
  };
}