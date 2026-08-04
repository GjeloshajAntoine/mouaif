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
  const pageUrlInput = useRef(null);
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
      return;
    }
    targets.current = r.body.targets || [];
    phase.current = 'targets';
    if (statusEl.current) statusEl.current.textContent = targets.current.length + ' targets';
    rerender();
  }

  // openAttachedPageInNewTab — "open in a new tab" for the page currently
  // being inspected. The header URL of the attached target is an anchor;
  // tapping it opens that same URL in a FRESH Chrome tab via
  // POST /api/inspector/open (Chrome /json/new) and reports the outcome
  // on the status line. We do NOT attach to the new tab and do NOT switch
  // the current connection — the user asked for a new tab, not a new
  // inspection. No new button: the existing URL line is the affordance.
  async function openAttachedPageInNewTab() {
    const target = currentTarget.current;
    if (!target || !target.url) return;
    const url = target.url;
    if (statusEl.current) statusEl.current.textContent = 'opening ' + url + ' in a new tab…';
    let r;
    try {
      r = await fetchJson('/api/inspector/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    } catch (e) {
      if (statusEl.current) statusEl.current.textContent = 'network error opening new tab';
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.target) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = 'new tab failed: ' + msg;
      return;
    }
    if (statusEl.current) statusEl.current.textContent = 'opened ' + url + ' in a new tab';
  }

  // attachByPageUrl — one-step inspect: the user types a page URL and
  // the server tells Chrome to OPEN it in a fresh tab (Chrome /json/new),
  // then we attach straight to that brand-new target. No pre-opening the
  // tab yourself, no picking from the target list.
  async function attachByPageUrl() {
    const input = pageUrlInput.current;
    if (!input) return;
    let wanted = (input.value || '').trim();
    if (!wanted) { if (statusEl.current) statusEl.current.textContent = 'enter a page url first'; return; }
    // Convenience: bare hosts like "localhost:3000" get http:// so the
    // user doesn't have to type the scheme.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(wanted)) wanted = 'http://' + wanted;
    if (statusEl.current) statusEl.current.textContent = 'opening ' + wanted + '…';
    let r;
    try {
      r = await fetchJson('/api/inspector/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: wanted }) });
    } catch (e) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200 || !r.body || !r.body.target) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = msg;
      return;
    }
    connect(r.body.target);
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
        h('p', { class: 'hint' }, 'Type a page URL and Chrome opens it in a new tab with the inspector attached. Or tap a target below. Connection is over ', h('code', null, 'ws://'), ' via mouaif (port ' + String(window.location.port || 5732) + '); data flows both ways in real time.'),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'inspectorPageUrl' }, 'Page URL'),
          h('input', { ref: pageUrlInput, class: 'input', id: 'inspectorPageUrl', type: 'url', placeholder: 'http://localhost:3000', onKeydown: (e) => { if (e.key === 'Enter') attachByPageUrl(); } })
        ),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn btn--primary', type: 'button', onClick: attachByPageUrl }, 'Open & inspect'),
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Refresh targets')
        ),
        h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
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
      h('p', { class: 'hint' }, h('code', null, (t && t.type) || 'page'), ' — ',
        h('a', {
          href: (t && t.url) || '#',
          class: 'inspector__target-url inspector__target-url--link',
          title: 'Open this page in a new Chrome tab',
          'aria-label': 'Open ' + ((t && t.url) || 'the page') + ' in a new Chrome tab',
          onClick: (e) => {
            // Don't navigate the inspector / app away — this is a
            // Chrome-side action performed through the mouaif server.
            e.preventDefault();
            e.stopPropagation();
            openAttachedPageInNewTab();
          }
        }, (t && t.url) || '')
      ),
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