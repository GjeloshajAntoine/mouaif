// mouaif web — InspectorView, ConsolePanel, NetworkPanel
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, route, setStatus } from '../api.js';
import { createVirtualList } from '../virtual-list.js';

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}
function statusLabel(s) {
  if (s === 'pending') return '···';
  if (s === 'failed') return 'FAIL';
  return String(s);
}
function statusClass(s) {
  if (s === 'pending') return 'pending';
  if (s === 'failed') return 'failed';
  const n = Number(s);
  if (!isNaN(n) && n >= 400) return 'error';
  if (!isNaN(n) && n >= 300) return 'redirect';
  if (!isNaN(n) && n >= 200) return 'ok';
  return 'other';
}

function fmtBytes(n) {
  if (typeof n !== 'number' || isNaN(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
function fmtDur(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return '';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

// Render one CDP RemoteObject as DOM. Falls back to description / value.
// Objects get a compact "{a: 1, b: 2}" inline preview from their
// `preview` payload when available.
function appendRemoteObject(host, arg) {
  if (!arg) return;
  const span = document.createElement('span');
  span.className = 'inspector__arg inspector__arg--' + (arg.type || 'unknown');
  if (arg.type === 'object' && arg.preview && Array.isArray(arg.preview.properties)) {
    const props = arg.preview.properties;
    const shown = props.slice(0, 5).map((p) => p.name + ': ' + (p.value !== undefined ? p.value : (p.type || ''))).join(', ');
    span.textContent = (arg.className === 'Array' ? '[' : '{') + shown + (props.length > 5 ? ', …' : '') + (arg.className === 'Array' ? ']' : '}');
    span.title = arg.description || '';
  } else if (arg.type === 'string') {
    span.textContent = String(arg.value !== undefined ? arg.value : (arg.description || ''));
  } else if (typeof arg.value !== 'undefined') {
    span.textContent = String(arg.value);
  } else if (typeof arg.description !== 'undefined') {
    span.textContent = arg.description;
  } else if (arg.type === 'function') {
    span.textContent = 'ƒ ' + (arg.description || '');
  } else {
    span.textContent = arg.type || '';
  }
  host.appendChild(span);
}

function ConsolePanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 52,
      overscan: 6,
      key: (item) => item.id,
      render: (item, node) => {
        // Diff by signature: same id + same revision -> keep existing DOM.
        const sig = item.id + '|' + (item.rev || 0);
        if (node.__sig === sig) return;
        node.__sig = sig;
        node.className = 'inspector__row inspector__row--console inspector__row--' + (item.level || 'log');
        const time = document.createElement('span');
        time.className = 'inspector__row-time';
        time.textContent = fmtTime(item.ts);
        const level = document.createElement('span');
        level.className = 'inspector__row-level';
        level.textContent = (item.level || 'log').toUpperCase();
        const body = document.createElement('span');
        body.className = 'inspector__row-body';
        const text = document.createElement('span');
        text.className = 'inspector__row-text';
        if (Array.isArray(item.args) && item.args.length) {
          for (let i = 0; i < item.args.length; i++) {
            if (i) text.appendChild(document.createTextNode(' '));
            appendRemoteObject(text, item.args[i]);
          }
        } else {
          text.textContent = item.text || '';
        }
        body.appendChild(text);
        const meta = document.createElement('span');
        meta.className = 'inspector__row-meta';
        const bits = [];
        if (item.url) {
          bits.push(item.url.replace(/^.*\//, '') + (item.line ? ':' + item.line : ''));
        }
        if (item.stack) bits.push('stack');
        meta.textContent = bits.join(' · ');
        if (meta.textContent) body.appendChild(meta);
        if (item.stack) {
          node.classList.add('inspector__row--expandable');
          node.title = 'tap for stack trace';
        }
        node.replaceChildren(time, level, body);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller inspector__scroller--console', 'aria-label': 'Console output', onClick: props.onRowTap });
}

function NetworkPanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 52,
      overscan: 6,
      key: (item) => item.id,
      render: (item, node) => {
        const sig = item.id + '|' + (item.rev || 0) + '|' + String(item.status) + '|' + String(item.size) + '|' + String(item.duration);
        if (node.__sig === sig) return;
        node.__sig = sig;
        node.className = 'inspector__row inspector__row--network inspector__row--expandable';
        const top = document.createElement('div');
        top.className = 'inspector__net-top';
        const method = document.createElement('span');
        method.className = 'inspector__row-method';
        method.textContent = item.method || '';
        const status = document.createElement('span');
        status.className = 'inspector__row-status inspector__row-status--' + statusClass(item.status);
        status.textContent = statusLabel(item.status);
        const url = document.createElement('span');
        url.className = 'inspector__row-text';
        url.textContent = item.url || '';
        top.appendChild(method); top.appendChild(status); top.appendChild(url);
        const meta = document.createElement('div');
        meta.className = 'inspector__net-meta';
        const bits = [];
        if (item.type) bits.push(item.type);
        if (item.mimeType) bits.push(item.mimeType.split(';')[0]);
        if (item.size != null) bits.push(fmtBytes(item.size));
        if (item.duration != null) bits.push(fmtDur(item.duration));
        if (item.ip) bits.push(item.ip);
        meta.textContent = bits.join(' · ');
        node.replaceChildren(top, meta);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller inspector__scroller--network', 'aria-label': 'Network log', onClick: props.onRowTap });
}

// Live page preview: periodically pulls Page.captureScreenshot and paints
// the JPEG into an <img>. `props.active` gates the capture loop so we only
// burn CDP cycles while the Preview tab is visible.
function PreviewPanel(props) {
  const imgRef = useRef(null);
  const noteRef = useRef(null);
  useEffect(() => {
    let stop = false;
    let timer = null;
    let inFlight = false;
    let objUrl = null;
    async function tick() {
      if (stop || inFlight) return;
      inFlight = true;
      try {
        const r = await props.capture();
        if (stop) return;
        if (r && r.data) {
          const bin = atob(r.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          const next = URL.createObjectURL(blob);
          if (imgRef.current) imgRef.current.src = next;
          if (objUrl) URL.revokeObjectURL(objUrl);
          objUrl = next;
          if (noteRef.current) noteRef.current.textContent = 'live · ' + new Date().toLocaleTimeString();
        }
      } catch (e) {
        if (noteRef.current) noteRef.current.textContent = 'screenshot failed: ' + (e && e.message || e);
      } finally {
        inFlight = false;
        if (!stop) timer = setTimeout(tick, 1200);
      }
    }
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, []);
  return h('div', { class: 'inspector__preview' },
    h('div', { class: 'inspector__preview-frame' },
      h('img', { ref: imgRef, class: 'inspector__preview-img', alt: 'Live page preview' })
    ),
    h('div', { ref: noteRef, class: 'status inspector__status', 'aria-live': 'polite' }, 'capturing…')
  );
}

// Overview: page vitals pulled via Performance + Runtime.evaluate on a
// slow poll while the Overview tab is active.
function OverviewPanel(props) {
  const gridRef = useRef(null);
  useEffect(() => {
    let stop = false;
    let timer = null;
    async function tick() {
      if (stop) return;
      try {
        const m = await props.metrics();
        if (stop || !gridRef.current) return;
        gridRef.current.innerHTML = '';
        const rows = [
          ['Documents', m.documents], ['Frames', m.frames], ['Nodes', m.nodes],
          ['Listeners', m.listeners], ['JS heap', fmtBytes(m.jsHeap)], ['Layout', m.layoutCount],
          ['Recalc style', m.recalcCount], ['Requests (session)', m.netCount]
        ];
        for (const [k, v] of rows) {
          const cell = document.createElement('div');
          cell.className = 'inspector__metric';
          const val = document.createElement('div');
          val.className = 'inspector__metric-value';
          val.textContent = (v === undefined || v === null || v === '') ? '—' : String(v);
          const key = document.createElement('div');
          key.className = 'inspector__metric-key';
          key.textContent = k;
          cell.appendChild(val); cell.appendChild(key);
          gridRef.current.appendChild(cell);
        }
      } catch { /* leave stale */ }
      if (!stop) timer = setTimeout(tick, 2500);
    }
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, []);
  return h('div', { ref: gridRef, class: 'inspector__metrics', 'aria-label': 'Page metrics' });
}

// Bottom-sheet detail for a tapped console row or network row. Rendered
// as a plain overlay; closed by tapping the backdrop or the close button.
function DetailSheet(props) {
  const item = props.item;
  if (!item) return null;
  const isNet = item.kind === 'request';
  function kv(list) {
    return h('dl', { class: 'inspector__kv' }, list.map(([k, v]) =>
      h(Fragment, { key: k },
        h('dt', null, k),
        h('dd', null, v === undefined || v === null || v === '' ? '—' : String(v))
      )
    ));
  }
  function headersBlock(title, obj) {
    if (!obj || !Object.keys(obj).length) return null;
    return h(Fragment, null,
      h('h3', { class: 'inspector__sheet-h' }, title),
      h('pre', { class: 'inspector__headers' }, Object.keys(obj).map((k) => k + ': ' + obj[k]).join('\n'))
    );
  }
  return h('div', { class: 'inspector__overlay', onClick: props.onClose },
    h('div', { class: 'inspector__sheet', role: 'dialog', 'aria-label': 'Details', onClick: (e) => e.stopPropagation() },
      h('div', { class: 'inspector__sheet-head' },
        h('strong', { class: 'inspector__sheet-title' }, isNet ? (item.method + ' ' + statusLabel(item.status)) : (item.level || 'log').toUpperCase()),
        h('button', { class: 'btn inspector__sheet-close', type: 'button', onClick: props.onClose }, 'Close')
      ),
      isNet
        ? h(Fragment, null,
            kv([
              ['URL', item.url],
              ['Type', item.type],
              ['MIME', item.mimeType],
              ['Size', fmtBytes(item.size)],
              ['Encoded', fmtBytes(item.encodedSize)],
              ['Duration', fmtDur(item.duration)],
              ['Remote', item.ip ? item.ip + (item.port ? ':' + item.port : '') : ''],
              ['Protocol', item.protocol],
              ['From cache', item.fromCache ? 'yes' : 'no'],
              ['Error', item.statusText]
            ]),
            headersBlock('Request headers', item.requestHeaders),
            headersBlock('Response headers', item.responseHeaders),
            h('h3', { class: 'inspector__sheet-h' }, 'Response body'),
            h('pre', { class: 'inspector__body' }, item.bodyLoading ? 'loading…' : (item.body !== undefined && item.body !== null && item.body !== '' ? item.body : '(no body captured)')),
            h('button', { class: 'btn', type: 'button', onClick: props.onLoadBody }, 'Fetch body')
          )
        : h(Fragment, null,
            kv([
              ['Time', fmtTime(item.ts)],
              ['Level', item.level],
              ['Source', item.url ? item.url + (item.line ? ':' + item.line : '') : '']
            ]),
            h('h3', { class: 'inspector__sheet-h' }, 'Message'),
            h('pre', { class: 'inspector__body' }, item.text || ''),
            item.stack ? h(Fragment, null,
              h('h3', { class: 'inspector__sheet-h' }, 'Stack trace'),
              h('pre', { class: 'inspector__body' }, item.stack)
            ) : null
          )
    )
  );
}

export function InspectorView() {
  const urlInput = useRef(null);
  const saveBtn = useRef(null);
  const statusEl = useRef(null);
  const targetsList = useRef(null);

  const phase = useRef('setup');
  const debuggerUrl = useRef('');
  const defaultUrl = useRef('');
  const targets = useRef([]);
  const currentTarget = useRef(null);
  const panel = useRef('console');
  const detailItem = useRef(null);
  const stateTick = useRef(0);
  const wsRef = useRef(null);
  const cmdId = useRef(1);
  const pending = useRef(new Map());
  const listeners = useRef(new Map());
  const consoleEntries = useRef([]);
  const networkEntries = useRef([]);
  const consoleVL = useRef(null);
  const networkVL = useRef(null);
  const reqMap = useRef(new Map());

  function rerender() { stateTick.current++; forceUpdate(); }

  function cdpSend(method, params) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('not connected'));
    const id = cmdId.current++;
    const msg = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      try { ws.send(msg); }
      catch (e) { pending.current.delete(id); reject(e); }
    });
  }

  function cdpOn(eventName, handler) {
    let set = listeners.current.get(eventName);
    if (!set) { set = new Set(); listeners.current.set(eventName, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  function wsOnMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    if (typeof msg.id === 'number') {
      const slot = pending.current.get(msg.id);
      if (slot) {
        pending.current.delete(msg.id);
        if (msg.error) slot.reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: msg.error.code }));
        else slot.resolve(msg.result || {});
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const set = listeners.current.get(msg.method);
      if (set) for (const fn of set) { try { fn(msg.params || {}); } catch { /* ignore handler errors */ } }
    }
  }

  function disconnect() {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try { ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
    }
    for (const slot of pending.current.values()) {
      try { slot.reject(new Error('disconnected')); } catch { /* ignore */ }
    }
    pending.current.clear();
    listeners.current.clear();
    reqMap.current.clear();
    currentTarget.current = null;
    consoleEntries.current = [];
    networkEntries.current = [];
    detailItem.current = null;
    if (consoleVL.current) { try { consoleVL.current.setData([]); } catch { /* ignore */ } }
    if (networkVL.current) { try { networkVL.current.setData([]); } catch { /* ignore */ } }
    if (statusEl.current) statusEl.current.textContent = '';
  }

  // Bump the revision on an entry so the virtual list re-renders its row
  // even though the object identity is unchanged.
  function touchEntry(e) { e.rev = (e.rev || 0) + 1; }

  function connect(target) {
    if (wsRef.current) disconnect();
    currentTarget.current = target;
    panel.current = 'console';
    phase.current = 'inspect';
    consoleEntries.current = [];
    networkEntries.current = [];
    const host = encodeURIComponent(debuggerUrl.current);
    const tid = encodeURIComponent(target.id);
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const proxyUrl = proto + '//' + window.location.host + '/api/inspector/proxy?host=' + host + '&targetId=' + tid;
    let ws;
    try { ws = new WebSocket(proxyUrl); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'WebSocket open failed: ' + (e.message || e); return; }
    wsRef.current = ws;
    if (statusEl.current) statusEl.current.textContent = 'connecting…';
    ws.addEventListener('open', () => onWsOpen(target));
    ws.addEventListener('message', wsOnMessage);
    ws.addEventListener('close', (ev) => onWsClose(ws, ev));
    ws.addEventListener('error', () => {
      if (wsRef.current === ws && statusEl.current) statusEl.current.textContent = 'WebSocket error';
    });
    rerender();
  }

  function onWsOpen(target) {
    if (statusEl.current) statusEl.current.textContent = 'connected to ' + (target.title || target.url || target.id);
    cdpSend('Runtime.enable').catch((err) => { if (statusEl.current) statusEl.current.textContent = 'Runtime.enable failed: ' + err.message; });
    cdpSend('Network.enable').catch((err) => { if (statusEl.current) statusEl.current.textContent = 'Network.enable failed: ' + err.message; });
    // Page + Performance power the Preview and Overview tabs. Failures are
    // non-fatal — the console / network panels keep working.
    cdpSend('Page.enable').catch(() => { /* preview unavailable */ });
    cdpSend('Performance.enable').catch(() => { /* metrics unavailable */ });
    cdpOn('Runtime.consoleAPICalled', onConsoleEvent);
    cdpOn('Runtime.exceptionThrown', onExceptionEvent);
    cdpOn('Network.requestWillBeSent', onRequestWillBeSent);
    cdpOn('Network.responseReceived', onResponseReceived);
    cdpOn('Network.loadingFinished', onLoadingFinished);
    cdpOn('Network.loadingFailed', onLoadingFailed);
  }

  function onWsClose(ws, ev) {
    if (wsRef.current !== ws) return;
    if (statusEl.current) {
      const code = ev && typeof ev.code === 'number' ? ev.code : 0;
      statusEl.current.textContent = 'disconnected (code ' + code + ')';
    }
    wsRef.current = null;
    for (const slot of pending.current.values()) {
      try { slot.reject(new Error('disconnected')); } catch { /* ignore */ }
    }
    pending.current.clear();
    listeners.current.clear();
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
  function pushConsole() {
    const vl = consoleVL.current;
    if (vl) {
      const data = consoleEntries.current.slice(-2000);
      try { vl.setData(data); vl.scrollToIndex(data.length - 1); } catch { /* vl destroyed */ consoleVL.current = null; }
    }
  }
  function argToString(arg) {
    if (!arg) return '';
    if (typeof arg.value !== 'undefined') return String(arg.value);
    if (typeof arg.description !== 'undefined') return arg.description;
    if (arg.type === 'function') return 'ƒ ' + (arg.description || '');
    return arg.type || '';
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
  function pushNetwork() {
    const vl = networkVL.current;
    if (vl) {
      const data = networkEntries.current.slice(-2000);
      try { vl.setData(data); } catch { /* vl destroyed */ networkVL.current = null; }
    }
  }

  // ---- CDP helpers for the new tabs -------------------------------------

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
    rerender();
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
      rerender();
    }
  }

  // Tap a row -> open the detail sheet. Wired once per scroller via the
  // panel's onReady; we delegate through event.target.closest.
  function onListTap(ev) {
    const vl = panel.current === 'console' ? consoleVL.current : networkVL.current;
    if (!vl) return;
    let node = ev.target;
    while (node && node !== ev.currentTarget && !node.__sig) node = node.parentNode;
    if (!node || !node.__sig) return;
    const sigId = node.__sig.split('|')[0];
    const data = vl.getData();
    const item = data.find((x) => x.id === sigId);
    if (!item) return;
    detailItem.current = item;
    rerender();
  }

  async function loadConfig() {
    let r;
    try { r = await fetchJson('/api/inspector/config'); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) { if (statusEl.current) statusEl.current.textContent = 'HTTP ' + r.status; return; }
    debuggerUrl.current = r.body.url || '';
    defaultUrl.current = r.body.defaultUrl || '';
    if (urlInput.current) urlInput.current.value = debuggerUrl.current;
    if (statusEl.current) statusEl.current.textContent = debuggerUrl.current ? ('current: ' + debuggerUrl.current) : 'using default: ' + defaultUrl.current;
    rerender();
  }
  async function saveConfig() {
    if (!urlInput.current) return;
    const next = (urlInput.current.value || '').trim();
    if (!next) { if (statusEl.current) statusEl.current.textContent = 'url is required'; return; }
    saveBtn.current.disabled = true;
    if (statusEl.current) statusEl.current.textContent = 'saving…';
    let r;
    try { r = await fetchJson('/api/inspector/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: next }) }); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'network error'; if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { if (statusEl.current) statusEl.current.textContent = 'HTTP ' + r.status; return; }
    debuggerUrl.current = r.body.url || next;
    if (statusEl.current) statusEl.current.textContent = 'saved.';
  }
  async function loadTargets() {
    if (statusEl.current) statusEl.current.textContent = 'fetching targets…';
    let r;
    try { r = await fetchJson('/api/inspector/targets'); }
    catch (e) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = msg;
      return;
    }
    targets.current = r.body.targets || [];
    phase.current = 'targets';
    if (statusEl.current) statusEl.current.textContent = targets.current.length + ' targets';
    rerender();
  }

  useEffect(() => { loadConfig(); return () => { disconnect(); }; }, []);

  if (phase.current === 'setup') {
    return h(Fragment, null,
      h('section', null,
        h('p', { class: 'hint' }, 'Start Chrome with ', h('code', null, '--remote-debugging-port=9222'), ' and paste its debugger URL below.'),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'inspectorUrl' }, 'Chrome debugger URL'),
          h('input', { ref: urlInput, class: 'input', id: 'inspectorUrl', type: 'text', placeholder: 'http://127.0.0.1:9222' })
        ),
        h('div', { class: 'row row--actions' },
          h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' }),
          h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: () => { saveConfig().then(loadTargets); } }, 'Save & discover'),
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Discover')
        )
      ),
      h('p', { class: 'hint hint--compact' }, 'Phone tip: ', h('code', null, 'adb reverse tcp:9222 tcp:9222'), ' then ', h('code', null, 'http://127.0.0.1:9222'), '.')
    );
  }

  if (phase.current === 'targets') {
    function renderTargets() {
      if (!targetsList.current) return;
      targetsList.current.innerHTML = '';
      if (!targets.current.length) {
        const li = document.createElement('li');
        li.className = 'inspector__empty';
        li.textContent = 'no targets. Open a tab in Chrome and tap "Refresh targets".';
        targetsList.current.appendChild(li);
        return;
      }
      for (const t of targets.current) {
        const li = document.createElement('li');
        li.className = 'inspector__target';
        const top = document.createElement('div');
        top.className = 'inspector__target-top';
        const title = document.createElement('div');
        title.className = 'inspector__target-title';
        title.textContent = t.title || t.url || t.id;
        const type = document.createElement('span');
        type.className = 'inspector__target-type';
        type.textContent = t.type || 'page';
        top.appendChild(title); top.appendChild(type);
        const url = document.createElement('div');
        url.className = 'inspector__target-url';
        url.textContent = t.url || t.webSocketDebuggerUrl || t.id;
        const btn = document.createElement('button');
        btn.className = 'inspector__target-btn btn btn--primary';
        btn.type = 'button';
        btn.textContent = 'Connect';
        btn.addEventListener('click', () => connect(t));
        li.appendChild(top); li.appendChild(url); li.appendChild(btn);
        targetsList.current.appendChild(li);
      }
    }
    setTimeout(renderTargets, 0);
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to inspector setup', onClick: (e) => { e.preventDefault(); disconnect(); phase.current = 'setup'; rerender(); } }, '←'),
        h('h2', { class: 'view-title' }, 'Pick a target')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'Tap a target to attach the inspector to it. Connection is over ', h('code', null, 'ws://'), ' via mouaif (port ' + String(window.location.port || 5732) + '); data flows both ways in real time.'),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Refresh targets')
        ),
        h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
        h('ul', { ref: targetsList, class: 'inspector__targets', 'aria-label': 'Discoverable targets' })
      )
    );
  }

  const t = currentTarget.current;
  const activePanel = panel.current;
  const subtab = (id, label) => h('button', {
    class: 'inspector__subtab' + (activePanel === id ? ' is-active' : ''),
    type: 'button', role: 'tab', 'aria-selected': String(activePanel === id),
    onClick: () => { panel.current = id; rerender(); }
  }, label);
  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to targets', onClick: (e) => { e.preventDefault(); disconnect(); phase.current = 'targets'; rerender(); } }, '←'),
      h('h2', { class: 'view-title inspector__title' }, t && (t.title || t.url || 'target'))
    ),
    h('section', null,
      h('p', { class: 'hint' }, h('code', null, (t && t.type) || 'page'), ' — ', h('code', null, t && t.url || '')),
      h('div', { class: 'inspector__subtabs', role: 'tablist' },
        subtab('preview', 'Preview'),
        subtab('console', 'Console'),
        subtab('network', 'Network'),
        subtab('overview', 'Info')
      ),
      h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
      activePanel === 'preview'
        ? h(PreviewPanel, { capture: captureScreenshot })
        : activePanel === 'console'
          ? h(ConsolePanel, { onRowTap: onListTap, onReady: (vl) => { consoleVL.current = vl; pushConsole(); } })
          : activePanel === 'network'
            ? h(NetworkPanel, { onRowTap: onListTap, onReady: (vl) => { networkVL.current = vl; pushNetwork(); } })
            : h(OverviewPanel, { metrics: fetchMetrics })
    ),
    h(DetailSheet, {
      item: detailItem.current,
      onClose: () => { detailItem.current = null; rerender(); },
      onLoadBody: () => loadResponseBody(detailItem.current)
    })
  );
}

function forceUpdate() { route.value = Object.assign({}, route.value); }