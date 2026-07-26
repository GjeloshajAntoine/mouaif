// Inspector CDP event handlers — translate CDP events into entries
// for the console and network virtual lists.
import { argToString } from './format.js';

export function createEventHandlers(state) {
  const { consoleEntries, networkEntries, reqMap, consoleVL, networkVL, statusEl, cdpSend } = state;

  function touchEntry(e) { e.rev = (e.rev || 0) + 1; }

  function pushConsole() {
    const vl = consoleVL.current;
    if (vl) {
      const data = consoleEntries.current.slice(-2000);
      try { vl.setData(data); vl.scrollToIndex(data.length - 1); } catch { /* vl destroyed */ consoleVL.current = null; }
    }
  }

  function pushNetwork() {
    const vl = networkVL.current;
    if (vl) {
      const data = networkEntries.current.slice(-2000);
      try { vl.setData(data); } catch { /* vl destroyed */ networkVL.current = null; }
    }
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

  function captureScreenshot() {
    return cdpSend('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
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

  return {
    onConsoleEvent, onExceptionEvent, onRequestWillBeSent,
    onResponseReceived, onLoadingFinished, onLoadingFailed,
    pushConsole, pushNetwork, captureScreenshot, fetchMetrics,
    loadResponseBody
  };
}