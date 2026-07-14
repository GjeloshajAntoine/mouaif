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

function ConsolePanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 44,
      overscan: 6,
      render: (item, node) => {
        node.className = 'inspector__row inspector__row--console inspector__row--' + (item.level || 'log');
        const time = document.createElement('span');
        time.className = 'inspector__row-time';
        time.textContent = fmtTime(item.ts);
        const level = document.createElement('span');
        level.className = 'inspector__row-level';
        level.textContent = (item.level || 'log').toUpperCase();
        const text = document.createElement('span');
        text.className = 'inspector__row-text';
        text.textContent = item.text || '';
        node.replaceChildren(time, level, text);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller', 'aria-label': 'Console output' });
}

function NetworkPanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 48,
      overscan: 6,
      render: (item, node) => {
        node.className = 'inspector__row inspector__row--network';
        const method = document.createElement('span');
        method.className = 'inspector__row-method';
        method.textContent = item.method || '';
        const status = document.createElement('span');
        status.className = 'inspector__row-status inspector__row-status--' + statusClass(item.status);
        status.textContent = statusLabel(item.status);
        const url = document.createElement('span');
        url.className = 'inspector__row-text';
        url.textContent = item.url || '';
        node.replaceChildren(method, status, url);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller', 'aria-label': 'Network log' });
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
    if (consoleVL.current) { try { consoleVL.current.setData([]); } catch { /* ignore */ } }
    if (networkVL.current) { try { networkVL.current.setData([]); } catch { /* ignore */ } }
    if (statusEl.current) statusEl.current.textContent = '';
  }

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
    cdpSend('Runtime.enable').catch((e) => { if (statusEl.current) statusEl.current.textContent = 'Runtime.enable failed: ' + e.message; });
    cdpSend('Network.enable').catch((e) => { if (statusEl.current) statusEl.current.textContent = 'Network.enable failed: ' + e.message; });
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
    const text = (params.args || []).map(argToString).join(' ');
    const ts = Date.now();
    consoleEntries.current.push({ id: 'c' + ts + '-' + consoleEntries.current.length, kind: 'console', level: params.type || 'log', text, ts });
    pushConsole();
  }
  function onExceptionEvent(params) {
    const ex = params.exceptionDetails || {};
    const text = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'exception';
    const ts = Date.now();
    consoleEntries.current.push({ id: 'c' + ts + '-' + consoleEntries.current.length, kind: 'exception', level: 'error', text, ts });
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
      kind: 'request',
      method: req.method || 'GET',
      url: req.url || '',
      status: 'pending',
      type: (params.type || '').toLowerCase() || null,
      initiator: params.initiator && params.initiator.url || null,
      ts: Date.now(),
      _start: typeof params.timestamp === 'number' ? params.timestamp : null,
      duration: null
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
    entry.type = r.type || entry.type;
    pushNetwork();
  }
  function onLoadingFinished(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.duration = (typeof params.timestamp === 'number' && entry._start != null) ? Math.round((params.timestamp - entry._start) * 1000) : null;
    pushNetwork();
  }
  function onLoadingFailed(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.status = 'failed';
    entry.statusText = params.errorText || 'failed';
    pushNetwork();
  }
  function pushNetwork() {
    const vl = networkVL.current;
    if (vl) {
      const data = networkEntries.current.slice(-2000);
      try { vl.setData(data); } catch { /* vl destroyed */ networkVL.current = null; }
    }
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
        h('p', { class: 'hint' }, 'Connect to a Chrome instance started with ', h('code', null, '--remote-debugging-port=9222'), '. The address below is the HTTP base of that instance (used to discover page targets); the WebSocket itself is proxied through mouaif.'),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'inspectorUrl' }, 'Chrome debugger URL'),
          h('input', { ref: urlInput, class: 'input', id: 'inspectorUrl', type: 'text', placeholder: 'http://127.0.0.1:9222' })
        ),
        h('div', { class: 'row row--actions' },
          h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: () => { saveConfig().then(loadTargets); } }, 'Save & discover'),
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Discover only')
        ),
        h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
        h('p', { class: 'hint' }, 'Tip: on a phone, run ', h('code', null, 'adb reverse tcp:9222 tcp:9222'), ' and point the URL at ', h('code', null, 'http://127.0.0.1:9222'), '. The address is stored in the app SQLite store.')
      )
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
  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to targets', onClick: (e) => { e.preventDefault(); disconnect(); phase.current = 'targets'; rerender(); } }, '←'),
      h('h2', { class: 'view-title inspector__title' }, t && (t.title || t.url || 'target'))
    ),
    h('section', null,
      h('p', { class: 'hint' }, h('code', null, (t && t.type) || 'page'), ' — ', h('code', null, t && t.url || '')),
      h('div', { class: 'inspector__subtabs', role: 'tablist' },
        h('button', { class: 'inspector__subtab' + (activePanel === 'console' ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(activePanel === 'console'), onClick: () => { panel.current = 'console'; rerender(); } }, 'Console'),
        h('button', { class: 'inspector__subtab' + (activePanel === 'network' ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(activePanel === 'network'), onClick: () => { panel.current = 'network'; rerender(); } }, 'Network')
      ),
      h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
      activePanel === 'console'
        ? h(ConsolePanel, { vlRef: consoleVL, onReady: (vl) => { consoleVL.current = vl; pushConsole(); } })
        : h(NetworkPanel, { vlRef: networkVL, onReady: (vl) => { networkVL.current = vl; pushNetwork(); } })
    )
  );
}

function forceUpdate() { route.value = Object.assign({}, route.value); }