// mouaif web — InspectorView (main component)
//
// Three-phase UI:
//   1. Setup — configure the Chrome debugger URL
//   2. Targets — pick a tab to attach to
//   3. Inspect — live console, network, preview, and overview tabs
//
// Sub-modules live in the inspector/ directory.
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, route } from '../api.js';
import { ConsolePanel, NetworkPanel, PreviewPanel, OverviewPanel, DetailSheet, createCdpConnection } from './inspector/index.js';
import { createEventHandlers } from './inspector/events.js';
// Short human label for a Chrome DevTools target type. Chrome uses a
// handful of types: `page` (a normal tab), `iframe`, `service_worker`,
// `background_page` (extension), and a few rarely-seen ones
// (`worker`, `shared_worker`, `other`). The chip color follows the
// type so the list reads at a glance.
const TYPE_META = {
  page:            { label: 'TAB',    short: 'tab', tone: 'accent'  },
  iframe:          { label: 'FRAME',  short: 'frame', tone: 'accent'  },
  service_worker:  { label: 'SW',     short: 'sw',  tone: 'warning' },
  background_page: { label: 'BG',     short: 'bg',  tone: 'muted'   },
  worker:          { label: 'WORKER', short: 'wrk', tone: 'warning' },
  shared_worker:   { label: 'SHARED', short: 'shr', tone: 'warning' },
  other:           { label: 'OTHER',  short: '?',   tone: 'muted'   }
};
function targetMeta(t) {
  const type = (t && t.type) || 'other';
  return TYPE_META[type] || TYPE_META.other;
}
// hostOf — extract `host[:port]` from a target URL so we can show it
// as a subtitle alongside the title. Returns '' for non-http(s) targets
// (chrome:// pages, bare webSocketDebuggerUrl, etc.).
function hostOf(t) {
  const u = (t && t.url) || '';
  if (!u || !/^https?:\/\//i.test(u)) return '';
  try { return new URL(u).host; } catch { return ''; }
}
export function InspectorView() {
  const urlInput = useRef(null);
  const pageUrlInput = useRef(null);
  const navUrlInput = useRef(null);
  const saveBtn = useRef(null);
  const statusEl = useRef(null);
  const [debuggerUrl, setDebuggerUrl] = useState('');
  const [defaultUrl, setDefaultUrl] = useState('');
  const [targets, setTargets] = useState([]);
  const [currentTarget, setCurrentTarget] = useState(null);
  const [panel, setPanel] = useState('console');
  const [detailItem, setDetailItem] = useState(null);
  const [phase, setPhase] = useState('setup');
  const [, setTick] = useState(0);
  const consoleEntries = useRef([]);
  const networkEntries = useRef([]);
  const consoleVL = useRef(null);
  const networkVL = useRef(null);
  const reqMap = useRef(new Map());

  function rerender() { setTick(t => t + 1); }

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
    setCurrentTarget(null);
    consoleEntries.current = [];
    networkEntries.current = [];
    setDetailItem(null);
    if (consoleVL.current) { try { consoleVL.current.setData([]); } catch { /* ignore */ } }
    if (networkVL.current) { try { networkVL.current.setData([]); } catch { /* ignore */ } }
    if (statusEl.current) statusEl.current.textContent = '';
  }

  function connect(target) {
    if (conn.current) disconnect();
    const c = initCdp();
    const handlers = eventHandlers.current;
    setCurrentTarget(target);
    setPanel('console');
    setPhase('inspect');
    consoleEntries.current = [];
    networkEntries.current = [];
    if (statusEl.current) statusEl.current.textContent = 'connecting…';
    const result = c.connect(debuggerUrl, target.id);
    if (result.error) {
      if (statusEl.current) statusEl.current.textContent = result.error;
      return;
    }
    result.ws.addEventListener('open', () => {
      if (statusEl.current) statusEl.current.textContent = 'connected to ' + (target.title || target.url || target.id);
      c.cdpSend('Runtime.enable').catch((err) => { if (statusEl.current) statusEl.current.textContent = 'Runtime.enable failed: ' + err.message; });
      c.cdpSend('Network.enable').catch((err) => { if (statusEl.current) statusEl.current.textContent = 'Network.enable failed: ' + err.message; });
      c.cdpSend('Page.enable').catch(() => { /* preview unavailable */ });
      c.cdpSend('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => { /* emulation unavailable */ });
      c.cdpSend('Performance.enable').catch(() => { /* metrics unavailable */ });
      c.cdpOn('Runtime.consoleAPICalled', handlers.onConsoleEvent);
      c.cdpOn('Runtime.exceptionThrown', handlers.onExceptionEvent);
      c.cdpOn('Network.requestWillBeSent', handlers.onRequestWillBeSent);
      c.cdpOn('Network.responseReceived', handlers.onResponseReceived);
      c.cdpOn('Network.loadingFinished', handlers.onLoadingFinished);
      c.cdpOn('Network.loadingFailed', handlers.onLoadingFailed);
      // Seed the Network panel with the page's pre-existing resources.
      // Chrome does not replay requests that finished before Network.enable,
      // so without this an attach to an already-open tab shows an empty
      // network log. See backfillResources in inspector/events.js.
      handlers.backfillResources();
    });
    result.ws.addEventListener('close', (ev) => {
      if (statusEl.current) {
        const code = ev && typeof ev.code === 'number' ? ev.code : 0;
        statusEl.current.textContent = 'disconnected (code ' + code + ')';
      }
    });
    result.ws.addEventListener('error', () => {
      // The browser WS error event carries no message. If the server
      // rejected the upgrade it sent a typed JSON body as the close
      // reason — show that instead of the generic "WebSocket error".
      const proxyMsg = c.lastProxyError && c.lastProxyError.current;
      if (statusEl.current) statusEl.current.textContent = proxyMsg || 'WebSocket error';
    });
    rerender();
  }

  async function loadConfig() {
    let r;
    try {
      r = await fetchJson('/api/inspector/config');
      if (r.status !== 200) { if (statusEl.current) statusEl.current.textContent = 'HTTP ' + r.status; return; }
      setDebuggerUrl(r.body.url || '');
      setDefaultUrl(r.body.defaultUrl || '');
      if (urlInput.current) urlInput.current.value = r.body.url || '';
      if (statusEl.current) statusEl.current.textContent = (r.body.url || '') ? ('current: ' + r.body.url) : 'using default: ' + r.body.defaultUrl;
      rerender();
      // Auto-discover on mount when a debugger URL is already saved.
      // Returning users land on the targets list directly instead of
      // being sent back to the setup screen on every visit. Deferred
      // to the next tick so the targets phase's statusEl <div> is
      // mounted by the time loadTargets writes to it — the setup
      // phase's <span> would otherwise receive the message.
      if (r.body.url) setTimeout(loadTargets, 0);
    } catch (e) {
      // Outer catch: an exception in any of the state setters or DOM
      // writes below (e.g. from a mid-fetch unmount) would otherwise
      // surface as an unhandled rejection that the user can't see and
      // that also aborts the auto-discovery chain. Surface it on the
      // status line instead.
      if (statusEl.current) statusEl.current.textContent = 'inspector: ' + (e && e.message || String(e));
    }
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
    setDebuggerUrl(r.body.url || next);
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
    setTargets(r.body.targets || []);
    setPhase('targets');
    if (statusEl.current) statusEl.current.textContent = (r.body.targets || []).length + ' targets';
    rerender();
  }

  // actionTarget — Reload / Close for a row in the targets list. Works
  // from the target record alone (no connection needed); the server
  // talks CDP directly to the debug Chrome.
  async function actionTarget(t, action) {
    if (!t || !t.id) return;
    if (action === 'close') {
      const name = t.title || t.url || 'this tab';
      if (!window.confirm('Close tab “' + name + '”?')) return;
    }
    if (statusEl.current) statusEl.current.textContent = (action === 'close' ? 'closing ' : 'reloading ') + (t.title || t.url || 'tab') + '…';
    let r;
    try {
      r = await fetchJson('/api/inspector/' + (action === 'close' ? 'close' : 'reload'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: t.id }) });
    } catch (e) {
      if (statusEl.current) statusEl.current.textContent = 'network error';
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = (action === 'close' ? 'close' : 'reload') + ' failed: ' + msg;
      return;
    }
    if (action === 'close') {
      if (statusEl.current) statusEl.current.textContent = 'closed';
      loadTargets(); // the closed tab disappears from the list
    } else if (statusEl.current) {
      statusEl.current.textContent = 'reloaded';
    }
  }

  // openAttachedPageInNewTab — "open in a new tab" for the page currently
  // being inspected. The header's "New tab" button sends the target's URL
  // to POST /api/inspector/open (Chrome Target.createTarget / json/new)
  // and reports the outcome on the status line. We do NOT attach to the
  // new tab and do NOT switch the current connection — the user asked for
  // a new tab, not a new inspection.
  async function openAttachedPageInNewTab() {
    const target = currentTarget;
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

  // closeAttachedTarget — deletes the tab being inspected. Confirms with
  // the user first (deleting a tab cannot be undone), then asks the
  // server to close it (POST /api/inspector/close), walks back to the
  // targets list and refreshes it. While the close is in flight the
  // current connection stays open so we can report the outcome; it is
  // torn down right before going back to the target list.
  async function closeAttachedTarget() {
    const target = currentTarget;
    if (!target || !target.id) return;
    const name = target.title || target.url || 'this tab';
    if (!window.confirm('Close tab “' + name + '”?')) return;
    if (statusEl.current) statusEl.current.textContent = 'closing tab…';
    let r;
    try {
      r = await fetchJson('/api/inspector/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
    } catch (e) {
      if (statusEl.current) statusEl.current.textContent = 'network error closing tab';
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = 'close failed: ' + msg;
      return;
    }
    disconnect();
    setPhase('targets');
    rerender();
    loadTargets();
  }

  // reloadAttachedTarget — reloads the tab being inspected (POST
  // /api/inspector/reload, CDP Page.reload on the target). The existing
  // connection survives; the page is gone for a moment, then comes back
  // and the preview / console / network panels keep streaming.
  async function reloadAttachedTarget() {
    const target = currentTarget;
    if (!target || !target.id) return;
    if (statusEl.current) statusEl.current.textContent = 'reloading…';
    let r;
    try {
      r = await fetchJson('/api/inspector/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
    } catch (e) {
      if (statusEl.current) statusEl.current.textContent = 'network error reloading';
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = 'reload failed: ' + msg;
      return;
    }
    if (statusEl.current) statusEl.current.textContent = 'reloaded';
  }

  // navigateAttachedTarget — navigates the tab being inspected to a new
  // URL (POST /api/inspector/navigate, CDP Page.navigate on the target).
  // The connection survives the navigation; the panels keep streaming.
  async function navigateAttachedTarget() {
    const target = currentTarget;
    const input = navUrlInput.current;
    if (!target || !target.id || !input) return;
    let wanted = (input.value || '').trim();
    if (!wanted) { if (statusEl.current) statusEl.current.textContent = 'enter a url first'; return; }
    // Convenience: bare hosts like "localhost:3000" get http:// so the
    // user doesn't have to type the scheme.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(wanted)) wanted = 'http://' + wanted;
    if (statusEl.current) statusEl.current.textContent = 'navigating to ' + wanted + '…';
    let r;
    try {
      r = await fetchJson('/api/inspector/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id, url: wanted }) });
    } catch (e) {
      if (statusEl.current) statusEl.current.textContent = 'network error navigating';
      return;
    }
    if (r.status !== 200 || !r.body || (typeof r.body.frameId !== 'string' && !r.body.errorText)) {
      const msg = (r.body && (r.body.error || r.body.errorText)) ? (r.body.error || r.body.errorText) : ('HTTP ' + r.status);
      if (statusEl.current) statusEl.current.textContent = 'navigate failed: ' + msg;
      return;
    }
    if (statusEl.current) statusEl.current.textContent = 'navigating to ' + wanted + '…';
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

  if (phase === 'setup') {
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

  if (phase === 'targets') {
    // TargetMenu — overflow popover attached to each row. Same pattern as
    // the project-card menu in Projects.jsx: a single `…` button that
    // opens a small list of actions. Kept inside the targets phase so
    // it can close on outside-click and on row-dismiss.
    const TargetMenu = function (props) {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        if (!open) return;
        function onDocClick() { setOpen(false); }
        // setTimeout to avoid the same click that opened the menu from
        // closing it on the same event.
        const id = setTimeout(() => document.addEventListener('click', onDocClick), 0);
        return () => {
          clearTimeout(id);
          document.removeEventListener('click', onDocClick);
        };
      }, [open]);
      const t = props.target;
      const meta = targetMeta(t);
      const canManage = t && t.id && t.type === 'page';
      return h('div', { class: 'inspector__row-menu' },
        h('button', {
          class: 'icon-btn inspector__row-menu-btn',
          type: 'button',
          'aria-haspopup': 'true',
          'aria-expanded': String(open),
          'aria-label': 'Target options',
          onClick: (e) => { e.stopPropagation(); setOpen(!open); }
        }, '⋯'),
        h('div', {
          class: 'inspector__row-menu-pop',
          hidden: !open,
          role: 'menu',
          onClick: (e) => e.stopPropagation()
        },
          h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onConnect(t); } }, 'Connect'),
          canManage ? h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onReload(t); } }, 'Reload') : null,
          canManage ? h('button', { type: 'button', role: 'menuitem', 'data-danger': '1', onClick: () => { setOpen(false); props.onClose(t); } }, 'Close tab') : null,
          h('div', { class: 'inspector__row-menu-meta' },
            h('span', null, meta.label),
            h('span', null, t && t.id ? t.id : '')
          )
        )
      );
    };
    // TargetRow — one declarative card per Chrome target. Tapping the
    // body connects; the `…` button opens the overflow menu with the
    // destructive actions (Reload / Close) that used to live as tiny
    // icon buttons next to the title. The type chip + host subtitle
    // make it obvious at a glance what the row represents.
    const TargetRow = function (props) {
      const t = props.target;
      const meta = targetMeta(t);
      const title = (t && (t.title || t.url || t.id)) || '';
      const subtitle = hostOf(t) || (t && (t.url || t.webSocketDebuggerUrl || t.id)) || '';
      return h('li', { class: 'inspector__row-target inspector__row-target--' + meta.tone, key: t && t.id },
        h('button', {
          class: 'inspector__row-target-main',
          type: 'button',
          'aria-label': 'Connect to ' + title,
          onClick: () => connect(t)
        },
          h('span', { class: 'inspector__row-target-chip' }, meta.label),
          h('span', { class: 'inspector__row-target-body' },
            h('span', { class: 'inspector__row-target-title' }, title),
            subtitle && subtitle !== title
              ? h('span', { class: 'inspector__row-target-sub' }, subtitle)
              : null
          )
        ),
        h(TargetMenu, {
          target: t,
          onConnect: connect,
          onReload: actionTarget.bind(null, 'reload'),
          onClose: actionTarget.bind(null, 'close')
        })
      );
    };
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to inspector setup', onClick: (e) => { e.preventDefault(); disconnect(); setPhase('setup'); rerender(); } }, '←'),
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
        targets.length
          ? h('ul', { class: 'inspector__row-targets', 'aria-label': 'Discoverable targets' },
              targets.map((t) => h(TargetRow, { target: t, key: t && t.id }))
            )
          : h('div', { class: 'inspector__row-targets-empty', role: 'status' },
              h('p', null, 'No targets found.'),
              h('p', { class: 'inspector__row-targets-empty-hint' }, 'Open a tab in Chrome and tap ', h('strong', null, 'Refresh targets'), ' to discover it.')
            )
      )
    );
  }

  const t = currentTarget;
  const activePanel = panel;
  const handlers = eventHandlers.current;
  const subtab = (id, label) => h('button', {
    class: 'inspector__subtab' + (activePanel === id ? ' is-active' : ''),
    type: 'button', role: 'tab', 'aria-selected': String(activePanel === id),
    onClick: () => { setPanel(id); rerender(); }
  }, label);

  function onListTap(ev) {
    const vl = panel === 'console' ? consoleVL.current : networkVL.current;
    if (!vl) return;
    let node = ev.target;
    while (node && node !== ev.currentTarget && !node.__sig) node = node.parentNode;
    if (!node || !node.__sig) return;
    const sigId = node.__sig.split('|')[0];
    const data = vl.getData();
    const item = data.find((x) => x.id === sigId);
    if (!item) return;
    setDetailItem(item);
    rerender();
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to targets', onClick: (e) => { e.preventDefault(); disconnect(); setPhase('targets'); rerender(); } }, '←'),
      h('h2', { class: 'view-title inspector__title' }, t && (t.title || t.url || 'target'))
    ),
    h('section', null,
      h('div', { class: 'inspector__head' },
        h('p', { class: 'hint' }, h('code', null, (t && t.type) || 'page'), ' — ', h('code', null, (t && t.url) || '')),
        h('button', {
          class: 'btn inspector__newtab',
          type: 'button',
          title: 'Open this page in a new Chrome tab',
          'aria-label': 'Open ' + ((t && t.url) || 'the page') + ' in a new Chrome tab',
          onClick: openAttachedPageInNewTab
        }, 'New tab')
      ),
      h('div', { class: 'inspector__nav' },
        h('button', {
          class: 'btn btn--small',
          type: 'button',
          title: 'Reload this tab',
          'aria-label': 'Reload this tab',
          onClick: reloadAttachedTarget
        }, 'Reload'),
        h('input', {
          ref: navUrlInput,
          class: 'input inspector__nav-input',
          type: 'url',
          placeholder: 'http://localhost:3000',
          enterkeyhint: 'go',
          value: (t && t.url) || '',
          onKeydown: (e) => { if (e.key === 'Enter') navigateAttachedTarget(); }
        }),
        h('button', {
          class: 'btn btn--small btn--primary',
          type: 'button',
          title: 'Go to this URL in the inspected tab',
          'aria-label': 'Go to this URL in the inspected tab',
          onClick: navigateAttachedTarget
        }, 'Go'),
        h('button', {
          class: 'btn btn--small btn--danger',
          type: 'button',
          title: 'Close this tab',
          'aria-label': 'Close this tab',
          onClick: closeAttachedTarget
        }, 'Close')
      ),
      h('div', { class: 'inspector__subtabs', role: 'tablist' },
        subtab('preview', 'Preview'),
        subtab('console', 'Console'),
        subtab('network', 'Network'),
        subtab('overview', 'Info')
      ),
      h('div', { ref: statusEl, class: 'status inspector__status', 'aria-live': 'polite' }),
      activePanel === 'preview'
        ? h(PreviewPanel, { capture: handlers && handlers.captureScreenshot, clickAt: handlers && handlers.clickAt })
        : activePanel === 'console'
          ? h(ConsolePanel, { onRowTap: onListTap, onReady: (vl) => { consoleVL.current = vl; if (handlers) handlers.pushConsole(); } })
          : activePanel === 'network'
            ? h(NetworkPanel, { onRowTap: onListTap, onReady: (vl) => { networkVL.current = vl; if (handlers) handlers.pushNetwork(); } })
            : h(OverviewPanel, { metrics: () => handlers ? handlers.fetchMetrics() : Promise.resolve({}) })
    ),
    h(DetailSheet, {
      item: detailItem,
      onClose: () => { setDetailItem(null); rerender(); },
      onLoadBody: () => handlers && handlers.loadResponseBody(detailItem)
    })
  );
}

function forceUpdate() { route.value = Object.assign({}, route.value); }