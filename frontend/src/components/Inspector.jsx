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
import { useClickOutside } from '../hooks/useClickOutside.js';
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
// Optional-panel model
// --------------------
// The Inspector is a from-scratch mobile DevTools UI. Instead of the
// previous single-active subtab (Preview / Console / Network / Info)
// the user now picks *which* of the four panels are visible. The
// toggled-on panels are stacked vertically and share the available
// height; toggled-off panels are unmounted, which also stops their
// capture loops (preview screenshots, metrics polling) and the
// virtual-list renderers, so the user pays only for what they look at.
//
// `PANELS` is the canonical ordered list of panel IDs and labels.
// `loadPanelState()` hydrates the visibility set from localStorage
// (the key lives in `PANEL_STATE_KEY`) so the user's choice
// persists across sessions and across inspected targets. The first
// visit (no saved state) shows all four panels — the new
// design's default is to surface every signal, and the user narrows
// it down on demand.
const PANELS = [
  { id: 'preview',  label: 'Preview' },
  { id: 'console',  label: 'Console' },
  { id: 'network',  label: 'Network' },
  { id: 'overview', label: 'Info'    }
];
const PANEL_STATE_KEY = 'mouaif:inspector:panels';
// Viewport size presets — device-metrics overrides the user can apply
// to the inspected page from the preview toolbar. `null` (the
// "Auto" / native-size entry) clears the override so the page renders
// at the real browser window size again. Presets mirror common
// responsive breakpoints: a small phone, a large phone, a tablet, and
// a laptop. `mobile: true` is only set for the phone entries because
// it flips the viewport meta / DPR behaviour that modern sites key
// responsive design off; tablet and laptop stay desktop-style so
// sites don't unexpectedly switch their media queries.
const VIEWPORT_PRESETS = [
{ id: 'auto',   label: 'Auto', width: null, height: null },
{ id: 'phone',  label: 'Phone', width: 375, height: 667, mobile: true },
{ id: 'phone+', label: 'Phone+', width: 414, height: 896, mobile: true },
{ id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
{ id: 'laptop', label: 'Laptop', width: 1280, height: 800 }
];
const VIEWPORT_STATE_KEY = 'mouaif:inspector:viewport';
function loadPanelState() {
  try {
    const raw = localStorage.getItem(PANEL_STATE_KEY);
    if (!raw) return new Set(PANELS.map((p) => p.id));
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set(PANELS.map((p) => p.id));
    const known = new Set(PANELS.map((p) => p.id));
    const next = new Set(arr.filter((id) => known.has(id)));
    // Guard against an all-hidden state: a UI with zero panels is
    // useless, and re-mounting after picking "hide all" would trap
    // the user. Reset to the default instead.
    return next.size ? next : new Set(PANELS.map((p) => p.id));
  } catch { return new Set(PANELS.map((p) => p.id)); }
}
function savePanelState(set) {
  try { localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}
// Hoisted sub-components (module scope) so their identity is stable
// across InspectorView re-renders. Defining them *inside* the render
// function gave every render a brand-new component type, so Preact
// unmounted + remounted the whole subtree on each state change — e.g.
// toggling a panel chip tore down the preview capture loop and reset
// the live preview, and any CDP-triggered rerender lost the open menu
// state. Hoisting keeps the preview <img>, the virtual lists, and the
// menu open-state alive across re-renders; parent data/actions flow in
// as props instead of via closure over the parent render.
function TargetMenu(props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  useClickOutside(menuRef, () => setOpen(false), open);
  const t = props.target;
  const meta = targetMeta(t);
  const canManage = t && t.id && t.type === 'page';
  return h('div', { ref: menuRef, class: 'inspector__row-menu' },
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
}

function TargetRow(props) {
  const t = props.target;
  const meta = targetMeta(t);
  const title = (t && (t.title || t.url || t.id)) || '';
  const subtitle = hostOf(t) || (t && (t.url || t.webSocketDebuggerUrl || t.id)) || '';
  return h('li', { class: 'inspector__row-target inspector__row-target--' + meta.tone, key: t && t.id },
    h('button', {
      class: 'inspector__row-target-main',
      type: 'button',
      'aria-label': 'Connect to ' + title,
      onClick: () => props.onConnect(t)
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
      onConnect: props.onConnect,
      onReload: props.onReload,
      onClose: props.onClose
    })
  );
}

function PanelCard(props) {
  const isVisible = props.isVisible;
  const toggleAria = isVisible ? 'Hide ' + props.label + ' panel' : 'Show ' + props.label + ' panel';
  return h('div', {
    class: 'inspector__panel' + (props.grow ? ' inspector__panel--grow' : '') + (props.span ? ' inspector__panel--span' : ''),
    'data-panel': props.id
  },
    h('div', { class: 'inspector__panel-head' },
      h('span', { class: 'inspector__panel-label' }, props.label),
      h('button', {
        class: 'inspector__panel-eye' + (isVisible ? ' is-visible' : ''),
        type: 'button',
        'aria-label': toggleAria,
        'aria-pressed': String(isVisible),
        title: toggleAria,
        onClick: () => props.onToggle(props.id)
      },
        // Eye-open glyph when the panel is visible, eye-closed
        // when it's hidden. Drawn as inline SVG so it inherits
        // the current color and matches the rest of the chrome
        // iconography.
        isVisible
          ? h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
              h('path', { d: 'M12 5C5 5 1 12 1 12s4 7 11 7 11-7 11-7-4-7-11-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z', fill: 'currentColor' }),
              h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor' })
            )
          : h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
              h('path', { d: 'M2 5l2-2 18 18-2 2-3.4-3.4A12.8 12.8 0 0 1 12 19c-7 0-11-7-11-7a18.6 18.6 0 0 1 4.1-4.5L2 5Zm10 4a3 3 0 0 1 3 3l-3-3Zm0-4c7 0 11 7 11 7a18.4 18.4 0 0 1-3.3 3.9l-2.5-2.5A4 4 0 0 0 12 8a4 4 0 0 0-.6 0L9.3 5.9A11.5 11.5 0 0 1 12 5Z', fill: 'currentColor' })
            )
      )
    ),
    h('div', { class: 'inspector__panel-body' },
      isVisible ? props.children : null
    )
  );
}

// StatusPill — colored leading-dot pill that surfaces the current
// connection state. The previous design was a muted <span ref>;
// the new one uses Preact state so the tone updates on every
// change and the user can read the connection at a glance. The
// tone is derived from the text by classifyStatus, so callers
// keep their imperative `setStatus("saved.")` shape.
function classifyStatus(msg) {
  if (!msg) return 'idle';
  const m = String(msg).toLowerCase();
  if (/fail|error|disconnected|reject|abort|invalid|missing|denied|unknown/.test(m)) return 'danger';
  if (/warn/.test(m)) return 'warn';
  if (/reload|saved|connected|navigat|opened|closed|fetching|loading|saving|connecting|navigating|opening/.test(m)) return 'busy';
  if (/targets/.test(m)) return 'ok';
  return 'info';
}
function StatusPill(props) {
  const tone = classifyStatus(props.text);
  return h('span', {
    class: 'inspector__statuspill inspector__statuspill--' + tone,
    role: 'status',
    'aria-live': 'polite'
  },
    h('span', { class: 'inspector__statuspill-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'inspector__statuspill-text' }, props.text || '')
  );
}
function InspectActionsMenu(props) {
  const [open, setOpen] = useState(false);
  const actionsRef = useRef(null);
  useClickOutside(actionsRef, () => setOpen(false), open);
  return h('div', { ref: actionsRef, class: 'inspector__actions' },
    h('button', {
      class: 'icon-btn inspector__actions-btn',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': String(open),
      'aria-label': 'Tab actions',
      title: 'Tab actions',
      onClick: (e) => { e.stopPropagation(); setOpen(!open); }
    }, '…'),
    h('div', {
      class: 'inspector__actions-pop',
      hidden: !open,
      role: 'menu',
      onClick: (e) => e.stopPropagation()
    },
      h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onReload(); } }, 'Reload'),
      h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onOpenInNewTab(); } }, 'Open in new tab'),
      h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onShowAll(); } }, 'Show all panels'),
      h('div', { class: 'inspector__actions-pop-sep' }),
      h('button', { type: 'button', role: 'menuitem', 'data-danger': '1', onClick: () => { setOpen(false); props.onClose(); } }, 'Close tab')
    )
  );
}

// Panel chip icons. Inline SVG keeps the panelbar a single 36 px
// row at 360 px (4 icon chips + gaps ≈ 152 px) instead of the
// previous text-label design that wrapped the chips onto a
// second line for "Show all" (104 px tall on a phone). Each
// chip keeps its text label as a tooltip + aria-label for
// screen readers; on screen only the glyph shows, the iOS
// DevTools-style segmented-control pattern.
const PANEL_ICONS = {
  preview: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 0v14h14V5H5Zm2 10h10v-2H7v2Zm0-4h10V9H7v2Zm0-4h6V5H7v2Z', fill: 'currentColor' })
  ),
  console: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M3 4h18v3H3V4Zm0 5h12v2H3V9Zm0 4h18v2H3v-2Zm0 4h12v3H3v-3Z', fill: 'currentColor' })
  ),
  network: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M12 3a9 9 0 0 0-9 9h2a7 7 0 0 1 14 0h2a9 9 0 0 0-9-9Zm0 4a5 5 0 0 0-5 5h2a3 3 0 0 1 6 0h2a5 5 0 0 0-5-5Zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-9 6h18v2H3v-2Z', fill: 'currentColor' })
  ),
  overview: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M3 4h7v7H3V4Zm0 9h7v7H3v-7Zm9-9h9v4h-9V4Zm0 6h9v10h-9V10Z', fill: 'currentColor' })
  )
};
export function InspectorView() {
  const urlInput = useRef(null);
  const pageUrlInput = useRef(null);
  const navUrlInput = useRef(null);
  const saveBtn = useRef(null);
  // status pill — Preact state instead of a DOM ref. The previous
  // design wrote text directly to a muted <span ref>; the new one is
  // a colored leading-dot pill that re-renders on every change so the
  // user can read the connection state at a glance. The imperative
  // call paths (save / load / navigate / open new tab / close tab /
  // reload) still say `setStatus('saved.')`; classifyStatus picks a
  // tone from the text.
  const [statusText, setStatusText] = useState('');
  function setStatus(value) { setStatusText(value == null ? '' : String(value)); }
  // setStatusRef / countRefs — refs the events.js side hooks into. The
  // state lives in a ref-shape because the previous upgrade was
  // mechanical from a DOM ref. Wrapping setStatus this way also lets
  // render closures (the panelbar badges, the events.js backfill
  // summary) all share one definition of the pill's text. We populate
  // them in render (not useEffect) so the very first event the WS
  // delivers — often before the first effect tick — already finds the
  // callback attached.
  const setStatusRef = useRef(setStatus);
  setStatusRef.current = setStatus;
  const [consoleCount, setConsoleCount] = useState(0);
  const [networkCount, setNetworkCount] = useState(0);
  const consoleCountRef = useRef((n) => setConsoleCount(n | 0));
  const networkCountRef = useRef((n) => setNetworkCount(n | 0));
  consoleCountRef.current = (n) => setConsoleCount(n | 0);
  networkCountRef.current = (n) => setNetworkCount(n | 0);
  const [debuggerUrl, setDebuggerUrl] = useState('');
  const [defaultUrl, setDefaultUrl] = useState('');
  const [targets, setTargets] = useState([]);
  const [currentTarget, setCurrentTarget] = useState(null);
  // visiblePanels: a Set of panel IDs currently rendered. Hydrated from
  // localStorage on mount; updated by the per-panel toggle. The single
  // 'panel' state from the previous design is gone — the new UI does
  // not switch between panels, it shows all toggled-on panels stacked.
  const [visiblePanels, setVisiblePanels] = useState(() => loadPanelState());
  const [detailItem, setDetailItem] = useState(null);
  // viewportId — the active device-metrics preset for the inspected
  // page ('auto' clears the override). Persisted to localStorage so the
  // user's last preview size survives re-attach and reload.
  const [viewportId, setViewportId] = useState(() => {
    try { return localStorage.getItem(VIEWPORT_STATE_KEY) || 'auto'; } catch { return 'auto'; }
  });
  const [phase, setPhase] = useState('setup');
  const [, setTick] = useState(0);
  const consoleEntries = useRef([]);
  const networkEntries = useRef([]);
  const consoleVL = useRef(null);
  const networkVL = useRef(null);
  const reqMap = useRef(new Map());

// When a panel becomes hidden the corresponding virtual-list
// child unmounts and runs its own `vl.destroy()` cleanup, but
// the parent's `consoleVL.current` / `networkVL.current` still
// point at the destroyed list. The next CDP event would call
// `vl.setData(...)` on the destroyed instance — a no-op, but
// wasteful. Clear the refs eagerly on visibility transitions so
// events.js's `if (vl)` short-circuit fires instead.
useEffect(() => {
  if (!visiblePanels.has('console') && consoleVL.current) {
    try { consoleVL.current.setData([]); } catch { /* destroyed */ }
    consoleVL.current = null;
  }
}, [visiblePanels]);
useEffect(() => {
  if (!visiblePanels.has('network') && networkVL.current) {
    try { networkVL.current.setData([]); } catch { /* destroyed */ }
    networkVL.current = null;
  }
}, [visiblePanels]);

  function rerender() { setTick(t => t + 1); }

  const conn = useRef(null);
  const eventHandlers = useRef(null);

  function onTargetNavigated(newUrl, newTitle) {
    if (!newUrl) return;
    setCurrentTarget((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        url: newUrl,
        title: newTitle || newUrl
      };
    });
    if (navUrlInput.current) {
      navUrlInput.current.value = newUrl;
    }
    // Query the page document.title via CDP Runtime.evaluate to get the real title
    if (conn.current && conn.current.cdpSend) {
      conn.current.cdpSend('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
        .then((r) => {
          const t = r && r.result && r.result.value;
          if (t && typeof t === 'string') {
            setCurrentTarget((prev) => prev ? { ...prev, title: t } : prev);
          }
        })
        .catch(() => {});
    }
    rerender();
  }

  function initCdp() {
    conn.current = createCdpConnection();
    const state = {
      consoleEntries, networkEntries, reqMap, consoleVL, networkVL,
      cdpSend: conn.current.cdpSend,
      onNavigate: onTargetNavigated,
      rerender,
      // setStatusRef — wraps the imperative setStatus so the event layer
      // can also surface connection-side messages (notably the backfill
      // summary) on the same status pill. Passed by-ref so the events
      // module reads .current on every call and bridges to the latest
      // setter without a stale-closure trap.
      setStatusRef, consoleCountRef, networkCountRef
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
    setStatus('');
  }

  // applyViewport — push the chosen size preset to the inspected page
  // via CDP Emulation.setDeviceMetricsOverride (or clear it for 'auto').
  // Persists the choice so re-attach / reload restore the same size.
  function applyViewport(id) {
    const next = id || 'auto';
    setViewportId(next);
    try { localStorage.setItem(VIEWPORT_STATE_KEY, next); } catch { /* ignore */ }
    const handlers = eventHandlers.current;
    const preset = VIEWPORT_PRESETS.find((p) => p.id === next);
    if (handlers && handlers.setViewportSize) {
      handlers.setViewportSize(preset && preset.width ? preset : null).catch(() => { /* emulation unavailable */ });
    }
  }

  function connect(target) {
    if (conn.current) disconnect();
    const c = initCdp();
    const handlers = eventHandlers.current;
    setCurrentTarget(target);
    setPhase('inspect');
    consoleEntries.current = [];
    networkEntries.current = [];
    setStatus('connecting…');
    const result = c.connect(debuggerUrl, target.id);
    if (result.error) {
      setStatus(result.error);
      return;
    }
    result.ws.addEventListener('open', () => {
      setStatus('connected to ' + (target.title || target.url || target.id));
      c.cdpSend('Runtime.enable').catch((err) => { setStatus('Runtime.enable failed: ' + err.message); });
      c.cdpSend('Network.enable').catch((err) => { setStatus('Network.enable failed: ' + err.message); });
      c.cdpSend('Page.enable').catch(() => { /* preview unavailable */ });
// Restore the user's last preview size (device-metrics override).
// Runs right after Page.enable so the override is applied before the
// first screenshot capture. 'auto' clears any previous override.
applyViewport(viewportId);
      c.cdpSend('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => { /* emulation unavailable */ });
      c.cdpSend('Performance.enable').catch(() => { /* metrics unavailable */ });
      c.cdpOn('Runtime.consoleAPICalled', handlers.onConsoleEvent);
      c.cdpOn('Runtime.exceptionThrown', handlers.onExceptionEvent);
      c.cdpOn('Network.requestWillBeSent', handlers.onRequestWillBeSent);
      c.cdpOn('Network.responseReceived', handlers.onResponseReceived);
      c.cdpOn('Network.loadingFinished', handlers.onLoadingFinished);
      c.cdpOn('Network.loadingFailed', handlers.onLoadingFailed);
      c.cdpOn('Page.frameNavigated', handlers.onFrameNavigated);
      c.cdpOn('Page.navigatedWithinDocument', handlers.onNavigatedWithinDocument);
      // Seed the Network panel with the page's pre-existing resources.
      // Chrome does not replay requests that finished before Network.enable,
      // so without this an attach to an already-open tab shows an empty
      // network log. See backfillResources in inspector/events.js.
      handlers.backfillResources();
    });
    result.ws.addEventListener('close', (ev) => {
      const code = ev && typeof ev.code === 'number' ? ev.code : 0;
        setStatus('disconnected (code ' + code + ')');
      
    });
    result.ws.addEventListener('error', () => {
      // The browser WS error event carries no message. If the server
      // rejected the upgrade it sent a typed JSON body as the close
      // reason — show that instead of the generic "WebSocket error".
      const proxyMsg = c.lastProxyError && c.lastProxyError.current;
      setStatus(proxyMsg || 'WebSocket error');
    });
    rerender();
  }

  async function loadConfig() {
    let r;
    try {
      r = await fetchJson('/api/inspector/config');
      if (r.status !== 200) { setStatus('HTTP ' + r.status); return; }
      setDebuggerUrl(r.body.url || '');
      setDefaultUrl(r.body.defaultUrl || '');
      if (urlInput.current) urlInput.current.value = r.body.url || '';
      setStatus((r.body.url || '') ? ('current: ' + r.body.url) : 'using default: ' + r.body.defaultUrl);
      rerender();
      // Auto-discover on mount when a debugger URL is already saved.
      // Returning users land on the targets list directly instead of
      // being sent back to the setup screen on every visit. Deferred
      // to the next tick so the targets phase's StatusPill is
      // mounted by the time loadTargets writes to it — the setup
      // phase's <span> would otherwise receive the message.
      if (r.body.url) setTimeout(loadTargets, 0);
    } catch (e) {
      // Outer catch: an exception in any of the state setters or DOM
      // writes below (e.g. from a mid-fetch unmount) would otherwise
      // surface as an unhandled rejection that the user can't see and
      // that also aborts the auto-discovery chain. Surface it on the
      // status line instead.
      setStatus('inspector: ' + (e && e.message || String(e)));
    }
  }

  async function saveConfig() {
    if (!urlInput.current) return;
    const next = (urlInput.current.value || '').trim();
    if (!next) { setStatus('url is required'); return; }
    saveBtn.current.disabled = true;
    setStatus('saving…');
    let r;
    try { r = await fetchJson('/api/inspector/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: next }) }); }
    catch (e) { setStatus('network error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { setStatus('HTTP ' + r.status); return; }
    setDebuggerUrl(r.body.url || next);
    setStatus('saved.');
  }

  async function loadTargets() {
    setStatus('fetching targets…');
    let r;
    try { r = await fetchJson('/api/inspector/targets'); }
    catch (e) { setStatus('network error'); return; }
    if (r.status !== 200) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus(msg);
      return;
    }
    setTargets(r.body.targets || []);
    setPhase('targets');
    setStatus((r.body.targets || []).length + ' targets');
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
    setStatus((action === 'close' ? 'closing ' : 'reloading ') + (t.title || t.url || 'tab') + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/' + (action === 'close' ? 'close' : 'reload'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: t.id }) });
    } catch (e) {
      setStatus('network error');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus((action === 'close' ? 'close' : 'reload') + ' failed: ' + msg);
      return;
    }
    if (action === 'close') {
      setStatus('closed');
      loadTargets(); // the closed tab disappears from the list
    } else setStatus('reloaded');
      
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
    setStatus('opening ' + url + ' in a new tab…');
    let r;
    try {
      r = await fetchJson('/api/inspector/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    } catch (e) {
      setStatus('network error opening new tab');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.target) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('new tab failed: ' + msg);
      return;
    }
    setStatus('opened ' + url + ' in a new tab');
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
    setStatus('closing tab…');
    let r;
    try {
      r = await fetchJson('/api/inspector/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
    } catch (e) {
      setStatus('network error closing tab');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('close failed: ' + msg);
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
    setStatus('reloading…');
    let r;
    try {
      r = await fetchJson('/api/inspector/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
    } catch (e) {
      setStatus('network error reloading');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('reload failed: ' + msg);
      return;
    }
    setStatus('reloaded');
  }

  // navigateAttachedTarget — navigates the tab being inspected to a new
  // URL (POST /api/inspector/navigate, CDP Page.navigate on the target).
  // The connection survives the navigation; the panels keep streaming.
  async function navigateAttachedTarget() {
    const target = currentTarget;
    const input = navUrlInput.current;
    if (!target || !target.id || !input) return;
    let wanted = (input.value || '').trim();
    if (!wanted) { setStatus('enter a url first'); return; }
    // Convenience: bare hosts like "localhost:3000" get http:// so the
    // user doesn't have to type the scheme.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(wanted)) wanted = 'http://' + wanted;
    setStatus('navigating to ' + wanted + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id, url: wanted }) });
    } catch (e) {
      setStatus('network error navigating');
      return;
    }
    if (r.status !== 200 || !r.body || (typeof r.body.frameId !== 'string' && !r.body.errorText)) {
      const msg = (r.body && (r.body.error || r.body.errorText)) ? (r.body.error || r.body.errorText) : ('HTTP ' + r.status);
      setStatus('navigate failed: ' + msg);
      return;
    }
    setStatus('navigating to ' + wanted + '…');
  }

  // attachByPageUrl — one-step inspect: the user types a page URL and
  // the server tells Chrome to OPEN it in a fresh tab (Chrome /json/new),
  // then we attach straight to that brand-new target. No pre-opening the
  // tab yourself, no picking from the target list.
  async function attachByPageUrl() {
    const input = pageUrlInput.current;
    if (!input) return;
    let wanted = (input.value || '').trim();
    if (!wanted) { setStatus('enter a page url first'); return; }
    // Convenience: bare hosts like "localhost:3000" get http:// so the
    // user doesn't have to type the scheme.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(wanted)) wanted = 'http://' + wanted;
    setStatus('opening ' + wanted + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: wanted }) });
    } catch (e) { setStatus('network error'); return; }
    if (r.status !== 200 || !r.body || !r.body.target) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus(msg);
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
          h(StatusPill, { text: statusText }),
          h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: () => { saveConfig().then(loadTargets); } }, 'Save & discover'),
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Discover')
        )
      ),
      h('p', { class: 'hint hint--compact' }, 'Phone tip: ', h('code', null, 'adb reverse tcp:9222 tcp:9222'), ' then ', h('code', null, 'http://127.0.0.1:9222'), '.')
    );
  }

  if (phase === 'targets') {
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
        h(StatusPill, { text: statusText }),
        targets.length
          ? h('ul', { class: 'inspector__row-targets', 'aria-label': 'Discoverable targets' },
              targets.map((t) => h(TargetRow, {
                target: t,
                key: t && t.id,
                onConnect: connect,
                onReload: actionTarget.bind(null, 'reload'),
                onClose: actionTarget.bind(null, 'close')
              }))
            )
          : h('div', { class: 'inspector__row-targets-empty', role: 'status' },
              h('p', null, 'No targets found.'),
              h('p', { class: 'inspector__row-targets-empty-hint' }, 'Open a tab in Chrome and tap ', h('strong', null, 'Refresh targets'), ' to discover it.')
            )
      )
    );
  }

  const t = currentTarget;
  const handlers = eventHandlers.current;
  // onListTap — unified tap handler for both the console and the
  // network virtual lists. Identifies the row by the `__sig` we set
  // in the panel renderers (a `|`-separated id+rev), then walks the
  // matching virtual list for the row's full data record. The new
  // design renders both lists simultaneously when both panels are
  // visible, so the handler needs to know which list to look in
  // from the panel id rather than the previous single-active-tab
  // selector.
  function onListTap(panelId, ev) {
    const vl = panelId === 'console' ? consoleVL.current : networkVL.current;
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
  // togglePanel — flip a panel's visibility. The user's choice is
  // persisted to localStorage so it survives a reload and a new
  // target. If the user hides the last visible panel we keep it
  // visible (loadPanelState would also re-default on next load;
  // doing it here keeps the UI from being empty for a frame).
  function togglePanel(id) {
    setVisiblePanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size === 1) return prev; // keep at least one visible
        next.delete(id);
      } else {
        next.add(id);
      }
      savePanelState(next);
      return next;
    });
    rerender();
  }
  // showAllPanels — reset to the default "everything visible".
  // Wired to a button in the empty-state hint and to the toolbar's
  // reset action. Kept cheap (one state setter + persist) because
  // the panels remount on visibility change anyway.
  function showAllPanels() {
    const all = new Set(PANELS.map((p) => p.id));
    savePanelState(all);
    setVisiblePanels(all);
    rerender();
  }
  // PanelCard — one optional panel rendered as a card. The header
  // shows the panel label + a live eye toggle (showing the next
  // state, not the current one: open eye = "currently visible",
  // closed eye = "tap to hide"). The body is a flex child that
  // takes whatever vertical space remains; the `grow` prop tells
  // the first visible panel to take the leftover height, so a user
  // with one panel open gets a single full-height panel, and a
  // user with all four open gets four equal-height panels.
  const visibleIds = PANELS.map((p) => p.id).filter((id) => visiblePanels.has(id));
  const noPanelsVisible = visibleIds.length === 0;
  // Render the optional panels. Each card has its own header +
  // body; the first visible card also gets `grow` so the preview
  // (or whatever the user kept) fills the leftover height.
  // Console and Network each keep their own internal virtual-list
  // scroller — their body height is bounded by CSS so a busy page
  // doesn't force-grow the panel past the available viewport.
  const renderPanelBody = (id) => {
    if (id === 'preview') return h(PreviewPanel, { capture: handlers && handlers.captureScreenshot, clickAt: handlers && handlers.clickAt, subscribe: conn.current && conn.current.cdpOn });
    if (id === 'console') return h(ConsolePanel, { onRowTap: (ev) => onListTap('console', ev), onReady: (vl) => { consoleVL.current = vl; if (handlers) handlers.pushConsole(); }, onEvaluate: (code) => { if (handlers) handlers.evaluateExpression(code); }, getEval: (desc, params) => { if (conn.current) return conn.current.cdpSend('Runtime.evaluate', params); return Promise.reject(new Error('not connected')); } });
    if (id === 'network') return h(NetworkPanel, { onRowTap: (ev) => onListTap('network', ev), onReady: (vl) => { networkVL.current = vl; if (handlers) handlers.pushNetwork(); } });
    return h(OverviewPanel, { metrics: () => handlers ? handlers.fetchMetrics() : Promise.resolve({}) });
  };
  // InspectActionsMenu — overflow menu attached to the right side of
  // the view-head. Holds the less-frequent chrome actions (Reload,
  // Open in new tab, Close tab) so the most common action — typing a
  // URL and pressing Go — sits in the always-visible nav row below.
  // The `…` button mirrors the same overflow pattern used by the
  // target rows in TargetMenu and the project cards in Projects.jsx.
  return h(Fragment, null,
    h('div', { class: 'view-head inspector__viewhead' },
      h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to targets', onClick: (e) => { e.preventDefault(); disconnect(); setPhase('targets'); rerender(); } }, '←'),
      h('h2', { class: 'view-title inspector__title' }, t && (t.title || t.url || 'target')),
      h(InspectActionsMenu, {
        onReload: reloadAttachedTarget,
        onOpenInNewTab: openAttachedPageInNewTab,
        onShowAll: showAllPanels,
        onClose: closeAttachedTarget
      })
    ),
    // Single-line target subtitle — type chip + host URL, truncated.
    // Replaces the old standalone `.inspector__head` row (50 px tall)
    // so the user keeps the URL visible without burning a whole row
    // for it. The host URL is ellipsised rather than wrapping so the
    // row stays a single 32 px line on every viewport.
    h('div', { class: 'inspector__sub' },
      h('span', { class: 'inspector__sub-chip inspector__sub-chip--' + (targetMeta(t).tone) }, targetMeta(t).label),
      h('span', { class: 'inspector__sub-host' }, hostOf(t) || (t && t.url) || '')
    ),
    h('section', null,
      h('div', { class: 'inspector__nav' },
        // Icon-only Reload button. The text-button Reload (a 44 px
        // button labelled "Reload") was moved into the view-head
        // overflow menu (InspectActionsMenu) so the nav row carries
        // only what the user does every few seconds: type a URL
        // and tap Go. The icon button keeps the 32 px glyph size
        // so the URL field stays the widest flex child.
        h('button', {
          class: 'icon-btn inspector__nav-reload',
          type: 'button',
          title: 'Reload this tab',
          'aria-label': 'Reload this tab',
          onClick: reloadAttachedTarget
        },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M12 4V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8Z', fill: 'currentColor' })
          )
        ),
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
          class: 'btn btn--primary inspector__nav-go',
          type: 'button',
          title: 'Go to this URL in the inspected tab',
          'aria-label': 'Go to this URL in the inspected tab',
          onClick: navigateAttachedTarget
        }, 'Go')
        // Close button moved to InspectActionsMenu so the nav row
        // carries only the URL field + Go (the most common action).
      ),
      // Viewport size bar — device-size presets applied to the inspected
      // page via CDP emulation. Mobile-first segmented control: the active
      // preset is accent-filled, the others are muted chips. 'Auto' clears
      // the override and returns the page to its real browser size.
      h('div', { class: 'inspector__sizes', role: 'group', 'aria-label': 'Preview size' },
        VIEWPORT_PRESETS.map((p) => h('button', {
          class: 'inspector__sizechip' + (viewportId === p.id ? ' is-on' : ''),
          type: 'button',
          'aria-pressed': String(viewportId === p.id),
          title: p.width ? (p.label + ' · ' + p.width + '×' + p.height) : (p.label + ' — native size'),
          'data-size-id': p.id,
          onClick: () => applyViewport(p.id)
        }, p.label))
      ),
      // Panelbar — 2-line chips with a corner entry-count badge for
      // the row-shaped panels (console, network). Preview/Info are not
      // countable so they stay unbadged but still print the label under
      // the glyph, so the whole row reads identically at a glance — no
      // icon-only buttons hiding behind aria-labels.
      h('div', { class: 'inspector__panelbar', role: 'group', 'aria-label': 'Optional panels' },
        PANELS.map((p) => {
          const on = visiblePanels.has(p.id);
          const count = p.id === 'console' ? consoleCount
            : p.id === 'network' ? networkCount
            : 0;
          const badgeText = count > 999 ? '999+' : String(count);
          const showBadge = on && count > 0;
          return h('button', {
            class: 'inspector__panelchip' + (on ? ' is-on' : '') + (showBadge ? ' has-badge' : ''),
            type: 'button',
            'aria-label': (on ? 'Hide ' : 'Show ') + p.label + (showBadge ? ' (' + badgeText + ' entries)' : ''),
            'aria-pressed': String(on),
            title: (on ? 'Hide ' : 'Show ') + p.label,
            'data-panel-id': p.id,
            onClick: () => togglePanel(p.id)
          },
            h('span', { class: 'inspector__panelchip-icon', 'aria-hidden': 'true' }, PANEL_ICONS[p.id]),
            h('span', { class: 'inspector__panelchip-label' }, p.label),
            showBadge
              ? h('span', { class: 'inspector__panelchip-badge', 'aria-hidden': 'true' }, badgeText)
              : null
          );
        })
      ),
      h(StatusPill, { text: statusText }),
      noPanelsVisible
        ? h('div', { class: 'inspector__panels-empty', role: 'status' },
            h('p', null, 'No panels visible.'),
            h('p', { class: 'inspector__panels-empty-hint' }, 'Tap a panel name above to show it.'),
            h('button', { class: 'btn', type: 'button', onClick: showAllPanels }, 'Show all panels')
          )
        : h('div', { class: 'inspector__panels' },
            visibleIds.map((id, idx) => h(PanelCard, {
              id,
              label: PANELS.find((p) => p.id === id).label,
              grow: idx === 0,
              isVisible: visiblePanels.has(id),
              onToggle: togglePanel,
              key: id
            }, renderPanelBody(id)))
          )
    ),
    h(DetailSheet, {
      item: detailItem,
      onClose: () => { setDetailItem(null); rerender(); },
      onLoadBody: () => handlers && handlers.loadResponseBody(detailItem)
    })
  );
}

function forceUpdate() { route.value = Object.assign({}, route.value); }
