// mouaif web — InspectorView (main component)
//
// Three-phase UI:
//   1. Setup — configure the Chrome debugger URL
//   2. Targets — pick a tab to attach to
//   3. Inspect — live console, network, preview, and overview tabs
//
// Sub-modules live in the inspector/ directory.
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, route } from '../api.js';
import { ConsolePanel, NetworkPanel, PreviewPanel, OverviewPanel, DetailSheet, createCdpConnection } from './inspector/index.js';
import { createEventHandlers } from './inspector/events.js';

export function InspectorView() {
  const urlInput = useRef(null);
  const saveBtn = useRef(null);
  const statusEl = useRef(null);
  const targetsList = useRef(null);

  const phase = useRef('setup');
  const debuggerUrl = useRef('');
  const defaultUrl = useRef('');
  const targets = useRef([]);
  const targetsFailed = useRef(false);
  const currentTarget = useRef(null);
  const panel = useRef('console');
  const detailItem = useRef(null);
  const stateTick = useRef(0);
  const consoleEntries = useRef([]);
  const networkEntries = useRef([]);
  const consoleVL = useRef(null);
  const networkVL = useRef(null);
  const reqMap = useRef(new Map());

  function rerender() { stateTick.current++; forceUpdate(); }

  const conn = useRef(null);
  const eventHandlers = useRef(null);

  function initCdp() {
    conn.current = createCdpConnection();
    const state = {
      consoleEntries, networkEntries, reqMap, consoleVL, networkVL, statusEl,
      cdpSend: conn.current.cdpSend,
      rerender
    };
    eventHandlers.current = createEventHandlers(state);
    return conn.current;
  }

  function disconnect() {
    if (conn.current) conn.current.disconnect();
    conn.current = null;
    eventHandlers.current = null;
    reqMap.current.clear();
    currentTarget.current = null;
    consoleEntries.current = [];
    networkEntries.current = [];
    detailItem.current = null;
    if (consoleVL.current) { try { consoleVL.current.setData([]); } catch { /* ignore */ } }
    if (networkVL.current) { try { networkVL.current.setData([]); } catch { /* ignore */ } }
    if (statusEl.current) statusEl.current.textContent = '';
  }

  function connect(target) {
    if (conn.current) disconnect();
    const c = initCdp();
    const handlers = eventHandlers.current;
    currentTarget.current = target;
    panel.current = 'console';
    phase.current = 'inspect';
    consoleEntries.current = [];
    networkEntries.current = [];
    if (statusEl.current) statusEl.current.textContent = 'connecting…';
    const result = c.connect(debuggerUrl.current, target.id);
    if (result.error) {
      if (statusEl.current) statusEl.current.textContent = result.error;
      return;
    }
    result.ws.addEventListener('open', () => {
      if (statusEl.current) statusEl.current.textContent = 'connected to ' + (target.title || target.url || target.id);
      c.cdpSend('Runtime.enable').catch((err) => { if (statusEl.current) statusEl.current.textContent = 'Runtime.enable failed: ' + err.message; });
      c.cdpSend('Network.enable').catch((err) => { if (statusEl.current) statusEl.current.textContent = 'Network.enable failed: ' + err.message; });
      c.cdpSend('Page.enable').catch(() => { /* preview unavailable */ });
      c.cdpSend('Performance.enable').catch(() => { /* metrics unavailable */ });
      c.cdpOn('Runtime.consoleAPICalled', handlers.onConsoleEvent);
      c.cdpOn('Runtime.exceptionThrown', handlers.onExceptionEvent);
      c.cdpOn('Network.requestWillBeSent', handlers.onRequestWillBeSent);
      c.cdpOn('Network.responseReceived', handlers.onResponseReceived);
      c.cdpOn('Network.loadingFinished', handlers.onLoadingFinished);
      c.cdpOn('Network.loadingFailed', handlers.onLoadingFailed);
    });
    result.ws.addEventListener('close', (ev) => {
      if (statusEl.current) {
        const code = ev && typeof ev.code === 'number' ? ev.code : 0;
        statusEl.current.textContent = 'disconnected (code ' + code + ')';
      }
    });
    result.ws.addEventListener('error', () => {
      if (statusEl.current) statusEl.current.textContent = 'WebSocket error';
    });
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
      targets.current = [];
      targetsFailed.current = true;
      phase.current = 'targets';
      rerender();
      return;
    }
    targets.current = r.body.targets || [];
    targetsFailed.current = false;
    phase.current = 'targets';
    if (statusEl.current) statusEl.current.textContent = targets.current.length + ' targets';
    rerender();
  }

  useEffect(() => { loadConfig(); return () => { disconnect(); }; }, []);

  // Shared URL editing controls used by both the setup phase and the
  // targets phase. The targets screen reuses the same input so the user
  // can type a new debugger URL (or fix a typo) without going back to
  // the setup screen — an empty target list previously left them stuck
  // with no way to type.
  function urlControls(showDiscoverHint) {
    return h(Fragment, null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'inspectorUrl' }, 'Chrome debugger URL'),
        h('input', { ref: urlInput, class: 'input', id: 'inspectorUrl', type: 'text', placeholder: 'http://127.0.0.1:9222' })
      ),
      h('div', { class: 'row row--actions' },
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' }),
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: () => { saveConfig().then(loadTargets); } }, 'Save & discover'),
        h('button', { class: 'btn', type: 'button', onClick: loadTargets }, showDiscoverHint ? 'Discover' : 'Refresh targets')
      )
    );
  }

  if (phase.current === 'setup') {
    return h(Fragment, null,
      h('section', null,
        h('p', { class: 'hint' }, 'Start Chrome with ', h('code', null, '--remote-debugging-port=9222'), ' and paste its debugger URL below.'),
        urlControls(true)
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
        li.textContent = targetsFailed.current
          ? 'Chrome is not reachable at this URL. Check that Chrome is running with --remote-debugging-port=9222, fix the URL above, then tap "Save & discover".'
          : 'No targets found. Open a tab in Chrome and tap "Refresh targets".';
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
        urlControls(false),
        h('ul', { ref: targetsList, class: 'inspector__targets', 'aria-label': 'Discoverable targets' })
      )
    );
  }

  const t = currentTarget.current;
  const activePanel = panel.current;
  const handlers = eventHandlers.current;
  const subtab = (id, label) => h('button', {
    class: 'inspector__subtab' + (activePanel === id ? ' is-active' : ''),
    type: 'button', role: 'tab', 'aria-selected': String(activePanel === id),
    onClick: () => { panel.current = id; rerender(); }
  }, label);

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
        ? h(PreviewPanel, { capture: handlers && handlers.captureScreenshot })
        : activePanel === 'console'
          ? h(ConsolePanel, { onRowTap: onListTap, onReady: (vl) => { consoleVL.current = vl; if (handlers) handlers.pushConsole(); } })
          : activePanel === 'network'
            ? h(NetworkPanel, { onRowTap: onListTap, onReady: (vl) => { networkVL.current = vl; if (handlers) handlers.pushNetwork(); } })
            : h(OverviewPanel, { metrics: () => handlers ? handlers.fetchMetrics() : Promise.resolve({}) })
    ),
    h(DetailSheet, {
      item: detailItem.current,
      onClose: () => { detailItem.current = null; rerender(); },
      onLoadBody: () => handlers && handlers.loadResponseBody(detailItem.current)
    })
  );
}

function forceUpdate() { route.value = Object.assign({}, route.value); }